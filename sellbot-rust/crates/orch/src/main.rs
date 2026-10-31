//! Orch на Rust: process-per-bot (как 502b.mjs).
//! Конфиг: `orch.json`. Боты/прокси: `farm_root/bots/{an}b.json`, `ip.json`.
//! `clan-owners.json` — только для `myNick` (my_nick_seen), отдельного овнера нет.
//!
//! **Казначей** — роль на farm-боте. Орк раз в 30с вычисляет казначея:
//! farm-бот с `is_active` и **max `next_break_at`** (дольше всех до сна),
//! причём до сна должно быть **больше `TREASURER_MIN_RUNUP`** — иначе
//! казначей сменится через 2 минуты и начнётся дёрготня flush-циклов.
//! Шлёт всем `OrchCmd::TreasurerRole { username }` при смене.
//! Казначею шлёт `OrchCmd::BalancesSnapshot { balances }` раз в 30с
//! (чтобы тот раздавал излишек в `sell_pass`).
//!
//! **Перед сном казначея** (по schedule) — орк НЕ убивает его, пока тот
//! не отдаст всё `bal - KEEP_SUM` новому казначею. Шлёт `FlushToTreasurer`,
//! ждёт `WorkerMsg { name: "treasurer_flushed" }` **без таймаута**.
//! Пока ждёт — `schedule tick` пропускает `kill_worker` для этого бота.
//! Если `treasurer_flushed` так и не пришёл (бот завис) — орк **продолжает
//! ждать** (по твоему требованию «без таймаута»). Но если процесс умер —
//! орк считает, что flush провалился, и запоминает `owes_treasurer`
//! в `OrchState`, чтобы после респавна дослать.
//!
//! **`owes_treasurer`** — источник истины «этот бот должен отдать деньги
//! вот этому казначею». Ставится при смене казначея, при смерти воркера
//! во время flush, сохраняется при `treasurer_flushed { ok: false }`.
//! Снимается при `ok: true` или при досылке `FlushToTreasurer`.
//!
//! **`flush_waiting`** — множество ников, от которых ждём `treasurer_flushed`.
//! `schedule tick` не убивает такого бота.
//!
//! **`bindings.json`** (`farm_root/bindings.json`) — **системный** файл.
//! Пользователь его **не трогает**. Формат: `{ "nick": true/false }`.
//!   - **Нет записи** — не знаем, привязан ли. **Спавним на 5с** (проверка).
//!     В перерыве **НЕ убиваем** (перерыва нет, пока не узнаем).
//!   - **`true`** — привязан. В перерыве убиваем (отдыхает по расписанию).
//!   - **`false`** — не привязан. В перерыве **НЕ убиваем** (перерыва нет).
//! После 5с проверки:
//!   - `success = true` и нет `funauth_bind`/`funauth_2fa`/`auth_fault` → `true`;
//!   - иначе → `false`.
//! При `funauth_bind`/`funauth_2fa`/`auth_fault` — сразу пишем `false`
//! (привязки нет, перерыва нет).

mod config;
mod listing_store;
mod schedule;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
};

use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use ipc::{
    pretty_log::{self, LineKind},
    BotBoot, OrchCmd, WorkerMsg,
};
use schedule::{Schedule, ScheduleConfig};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, Mutex},
    time::sleep,
};
use tokio_tungstenite::{connect_async, tungstenite::Message};
use tracing::{error, info, warn};

// ============ farm-боты ============

#[derive(Debug, Clone, Deserialize)]
struct BotJson {
    username: String,
    password: String,
    anarchy: u16,
    #[serde(default)]
    item: String,
    #[serde(rename = "goType")]
    go_type: String,
    ip: String,
}

#[derive(Debug)]
struct BotRuntime {
    cfg: BotJson,
    proxy: String,
    success: bool,
    on_anarchy: bool,
    banned: bool,
    manual_stop: bool,
    unstable_until: Option<std::time::Instant>,
    pricing_edges: std::collections::VecDeque<std::time::Instant>,
    last_pricing_ok: bool,
    items: Value,
    inventory: Value,
    balance: Option<f64>,
    balance_at: Option<std::time::Instant>,
    banned_at: Option<String>,
    banned_reason: Option<String>,
    auth_fault: Option<String>,
    auth_fault_at: Option<String>,
    auth_fault_reason: Option<String>,
    spawning: bool,
}

// ============ workers ============

struct WorkerHandle {
    child: Child,
    stdin: ChildStdin,
}

#[derive(Debug, Clone)]
struct PendingPay {
    to_bot: String,
    amount: i64,
    at: std::time::Instant,
}

// ============ state ============

struct OrchState {
    bots: HashMap<String, BotRuntime>,
    my_nick: Option<String>,
    workers: HashMap<String, WorkerHandle>,
    bot_bin: PathBuf,
    bots_path: PathBuf,
    shutting_down: bool,
    items_buying: Value,
    listings: listing_store::ListingStore,
    last_catalog: Vec<Value>,
    pending_pays: HashMap<u64, PendingPay>,
    next_req_id: u64,

    restart_tx: mpsc::UnboundedSender<String>,

    schedule: Arc<Schedule>,
    bot_order: Vec<String>,

    // ============================================================
    // BINDINGS (funauth привязка) — системный файл
    // ============================================================

    /// Ник → привязан? Источник истины — `bindings.json`.
    /// - **нет записи** — не знаем (спавним на 5с проверить).
    /// - `true` — привязан (в перерыве убиваем).
    /// - `false` — не привязан (в перерыве НЕ убиваем).
    bindings: HashMap<String, bool>,
    bindings_path: PathBuf,

    // ============================================================
    // КАЗНАЧЕЙ
    // ============================================================

    /// Текущий казначей (nick). `None` — ещё не определён.
    treasurer_nick: Option<String>,

    /// Кто-то должен отдать излишек казначею — но не смог. После
    /// респавна `spawn_worker_inner` проверит и дошлёт `FlushToTreasurer`.
    owes_treasurer: HashMap<String, String>,

    /// `username` → ждём `treasurer_flushed` от него (flush в полёте).
    flush_waiting: std::collections::HashSet<String>,

    /// Разбуженные досрочно для приёма денег: nick → конец их планового сна.
    early_wake: HashMap<String, u64>,
}

type GoTx = mpsc::UnboundedSender<Value>;
type RestartTx = mpsc::UnboundedSender<String>;

const MIN_BOT_BALANCE: f64 = 13_000_000.0;
const HIGH_BALANCE_TRIGGER: f64 = 30_000_000.0;
/// Сентинел «баланс неизвестен» — совпадает с owner::BALANCE_UNKNOWN.
const BALANCE_UNKNOWN: f64 = -1.0;
/// Как часто пересчитываем казначея.
const TREASURER_TICK: Duration = Duration::from_secs(30);
/// Казначеем не может стать бот, которому до сна меньше этого.
const TREASURER_MIN_RUNUP_MS: u64 = 2 * 60 * 1000;
/// Максимальная задержка начала длинного сна, если нет замены.
const MAX_SLEEP_DEFER_MS: u64 = 90 * 60 * 1000;
// `BIND_CHECK_SECS` больше не используется — `bindings = true`
// ставит `funauth_verified` (воркер уже ждёт 5с от `success`).
#[tokio::main]
async fn main() -> Result<()> {
    pretty_log::init_orch();

    let loaded = config::load()?;
    let farm_root = loaded.farm_root.clone();
    let anarchy = loaded.cfg.anarchy;
    let ws_url = loaded.cfg.go_ws.clone();
    let bot_bin = config::bot_bin_path()?;
    info!("bot={}", bot_bin.display());

    let bots_path = farm_root.join(format!("bots/{anarchy}b.json"));
    let ip_path = farm_root.join("ip.json");
    let (bots, bot_order) = load_bots(&bots_path, &ip_path)?;

    let bots_filename = format!("{anarchy}b");
    let schedule_cfg = ScheduleConfig::load(&farm_root);
    let schedule = Arc::new(Schedule::new(
        anarchy,
        &bots_filename,
        bot_order.len(),
        &schedule_cfg,
    ));
    info!(
        "schedule: an{anarchy} ({bots_filename}) — {} ботов",
        bot_order.len()
    );

    let my_nick = load_my_nick(&farm_root)?;
    info!("myNick={:?}", my_nick);

    let listings = listing_store::ListingStore::new(listing_store::default_dir(&farm_root));

    // ============ bindings.json ============
    let bindings_path = farm_root.join("bindings.json");
    let bindings = load_bindings(&bindings_path);
    info!(
        "bindings.json: {} записей (привязано: {})",
        bindings.len(),
        bindings.values().filter(|v| **v).count()
    );

    let (go_tx, go_rx) = mpsc::unbounded_channel::<Value>();
    let (restart_tx, mut restart_rx) = mpsc::unbounded_channel::<String>();

    let state = Arc::new(Mutex::new(OrchState {
        bots,
        my_nick,
        workers: HashMap::new(),
        bot_bin,
        bots_path,
        shutting_down: false,
        items_buying: json!([]),
        listings,
        last_catalog: Vec::new(),
        pending_pays: HashMap::new(),
        next_req_id: 0,

        restart_tx: restart_tx.clone(),

        schedule: schedule.clone(),
        bot_order,

        bindings,
        bindings_path,

        treasurer_nick: None,
        owes_treasurer: HashMap::new(),
        flush_waiting: std::collections::HashSet::new(),
        early_wake: HashMap::new(),
    }));

    tokio::spawn(go_ws_loop(state.clone(), go_tx.clone(), go_rx, ws_url));

    // Рестарт farm-ботов.
    let st_r = state.clone();
    let go_r = go_tx.clone();
    let restart_tx_loop = restart_tx.clone();
    tokio::spawn(async move {
        while let Some(name) = restart_rx.recv().await {
            sleep(Duration::from_secs(15)).await;
            info!("рестарт {name}");
            if let Err(e) =
                spawn_worker(st_r.clone(), go_r.clone(), restart_tx_loop.clone(), name.clone())
                    .await
            {
                error!("restart {name}: {e:#}");
            }
        }
    });

    // TTL pending_pays (120с) — раз в 30с
    let st_ttl = state.clone();
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(30)).await;
            let mut g = st_ttl.lock().await;
            let now = std::time::Instant::now();
            let before = g.pending_pays.len();
            g.pending_pays
                .retain(|_, p| now.duration_since(p.at) < Duration::from_secs(120));
            let removed = before - g.pending_pays.len();
            if removed > 0 {
                tracing::debug!("pending_pays: TTL вычистил {removed}");
            }
        }
    });

    sleep(Duration::from_secs(2)).await;
    start_all(state.clone(), go_tx.clone(), restart_tx.clone()).await;

    let st2 = state.clone();
    let go2 = go_tx.clone();
    tokio::spawn(async move {
        loop {
            sleep(Duration::from_secs(30)).await;
            let _ = push_presence(&st2, &go2).await;
        }
    });

    // ============ тикер расписания перерывов ============
    let st_sched = state.clone();
    let go_sched = go_tx.clone();
    let restart_sched = restart_tx.clone();
    tokio::spawn(async move {
        sleep(Duration::from_secs(30)).await;
        loop {
            let (order, schedule_arc, alive, ready, an, flush_waiting, treasurer, bindings) = {
                let g = st_sched.lock().await;
                let an = g.bots.values().next().map(|b| b.cfg.anarchy).unwrap_or(0);
                let alive: std::collections::HashSet<String> =
                    g.workers.keys().cloned().collect();
                // «Готов принять деньги»: живой и не спит сейчас.
                let now0 = schedule::now_unix_ms();
                let ready: std::collections::HashSet<String> = g
                    .bot_order
                    .iter()
                    .enumerate()
                    .filter(|(i, n)| {
                        g.workers.contains_key(*n) && !g.schedule.is_in_long_break(*i, now0)
                    })
                    .map(|(_, n)| n.clone())
                    .collect();
                (
                    g.bot_order.clone(),
                    g.schedule.clone(),
                    alive,
                    ready,
                    an,
                    g.flush_waiting.clone(),
                    g.treasurer_nick.clone(),
                    g.bindings.clone(),
                )
            };
            let now = schedule::now_unix_ms();
            for idx in 0..order.len() {
                info!("schedule an{an}: {}", schedule_arc.debug_state(idx, now));
            }
            let active_vec: Vec<_> = (0..order.len())
                .map(|i| (i, schedule_arc.is_active(i, now)))
                .collect();
            let n_active = active_vec.iter().filter(|(_, a)| *a).count();
            info!(
                "schedule tick an{an}: active={} / {} — {:?}",
                n_active,
                order.len(),
                active_vec
            );
            for (idx, name) in order.iter().enumerate() {
                let active = schedule_arc.is_active(idx, now);
                let running = alive.contains(name);
                let binding = bindings.get(name).copied();
                // Есть привязка? `None` = не знаем.
                let is_bound = binding == Some(true);
                // Знаем, что привязан? Если `None` — надо проверить.
                let needs_check = binding.is_none() || !is_bound;

                if active && !running {
                    info!("schedule an{an}: {name} (idx={idx}) возвращается");
                    if let Err(e) = spawn_worker(
                        st_sched.clone(),
                        go_sched.clone(),
                        restart_sched.clone(),
                        name.clone(),
                    )
                    .await
                    {
                        error!("schedule spawn {name}: {e:#}");
                    }
                } else if !active && !running {
                    // Бот в перерыве, не работает.
                    if needs_check {
                        // Не знаем привязку или не привязан — пробуем зайти.
                        info!(
                            "schedule an{an}: {name} (idx={idx}) в перерыве, но привязка={:?} — пробую зайти (проверка)",
                            binding,
                        );
                        if let Err(e) = spawn_worker(
                            st_sched.clone(),
                            go_sched.clone(),
                            restart_sched.clone(),
                            name.clone(),
                        )
                        .await
                        {
                            error!("schedule spawn-check {name}: {e:#}");
                        }
                    }
                    // Если привязан (`true`) — не спавним, отдыхает.
                } else if !active && running {
                    // Бот в перерыве, работает.
                    // A2. Текущий казначей — не убиваем.
                    if treasurer.as_deref() == Some(name.as_str()) {
                        info!(
                            "schedule an{an}: {name} (idx={idx}) в перерыве, но это КАЗНАЧЕЙ — не убиваем"
                        );
                        continue;
                    }
                    // Казначей не уходит в сон, пока не отдал flush.
                    if flush_waiting.contains(name) {
                        info!(
                            "schedule an{an}: {name} (idx={idx}) в перерыве, но flush в полёте — НЕ убиваем"
                        );
                        continue;
                    }
                    // Разбужен досрочно для передачи денег — не убиваем.
                    if st_sched.lock().await.early_wake.contains_key(name) {
                        info!(
                            "schedule an{an}: {name} разбужен досрочно для передачи денег — не убиваю"
                        );
                        continue;
                    }
                    // Если привязка не `true` — не убиваем (у бота нет перерыва).
                    if !is_bound {
                        info!(
                            "schedule an{an}: {name} (idx={idx}) в перерыве, но привязка={:?} — не убиваем (перерыва нет)",
                            binding,
                        );
                        continue;
                    }
                    // Ворота: если пора спать (или уже спит по плану), но
                    // замены нет — откладываем сон до MAX_SLEEP_DEFER_MS.
                    if let Some((sleep_start, _)) = schedule_arc.long_break_span(idx, now) {
                        let replacement = order.iter().enumerate().any(|(j, n)| {
                            n != name
                                && ready.contains(n)
                                && !schedule_arc.is_in_long_break(j, now)
                        });
                        let overdue = now.saturating_sub(sleep_start);
                        if !replacement && overdue < MAX_SLEEP_DEFER_MS {
                            info!(
                                "schedule an{an}: {name} (idx={idx}) пора спать, замены нет — откладываю ({}м из 90)",
                                overdue / 60_000
                            );
                            continue;
                        }
                    }
                    info!("schedule an{an}: {name} (idx={idx}) уходит в перерыв (привязан)");
                    kill_worker(&st_sched, name).await;
                }
            }

            // Казначей спит по плану дольше лимита, замены нет → будим того,
            // у кого сон кончается раньше.
            if let Some(t) = treasurer.as_deref() {
                if let Some(ti) = order.iter().position(|n| n == t) {
                    if let Some((s, _)) = schedule_arc.long_break_span(ti, now) {
                        let has_repl = order.iter().enumerate().any(|(j, n)| {
                            n != t
                                && ready.contains(n)
                                && !schedule_arc.is_in_long_break(j, now)
                        });
                        if !has_repl && now.saturating_sub(s) >= MAX_SLEEP_DEFER_MS {
                            let pick = {
                                let g = st_sched.lock().await;
                                if !g.early_wake.is_empty() {
                                    None // уже будим кого-то
                                } else {
                                    order
                                        .iter()
                                        .enumerate()
                                        .filter(|(j, n)| {
                                            *j != ti
                                                && !alive.contains(*n)
                                                && g.bots.get(*n).map_or(false, |b| {
                                                    !b.banned && !b.manual_stop
                                                })
                                        })
                                        .filter_map(|(j, n)| {
                                            schedule_arc
                                                .long_break_span(j, now)
                                                .map(|(_, e)| (n.clone(), e))
                                        })
                                        .min_by_key(|(_, e)| *e)
                                }
                            };
                            if let Some((nick, end)) = pick {
                                warn!(
                                    "schedule an{an}: казначей {t} застрял, будим досрочно {nick} (до {end})"
                                );
                                st_sched.lock().await.early_wake.insert(nick.clone(), end);
                                let _ = spawn_worker(
                                    st_sched.clone(),
                                    go_sched.clone(),
                                    restart_sched.clone(),
                                    nick,
                                )
                                .await;
                            }
                        }
                    }
                }
            }

            sleep(Duration::from_secs(60)).await;
        }
    });

    // ============ казначей: тикер ============
    let st_treas = state.clone();
    tokio::spawn(async move {
        sleep(Duration::from_secs(5)).await;
        loop {
            let now = schedule::now_unix_ms();
            let (order, schedule_arc, alive, early) = {
                let mut g = st_treas.lock().await;
                g.early_wake.retain(|_, end| *end > now); // после конца сна — обычный режим
                let alive: std::collections::HashSet<String> =
                    g.workers.keys().cloned().collect();
                (
                    g.bot_order.clone(),
                    g.schedule.clone(),
                    alive,
                    g.early_wake.clone(),
                )
            };

            // «Спит» с учётом досрочного пробуждения.
            let asleep = |idx: usize, name: &str| {
                schedule_arc.is_in_long_break(idx, now) && !early.contains_key(name)
            };
            // Запас до следующего длинного сна; у разбуженного отсчёт от
            // конца текущего сна.
            let runup_of = |idx: usize, name: &str| {
                let from = early.get(name).copied().unwrap_or(now);
                schedule_arc
                    .next_long_break_at(idx, from)
                    .saturating_sub(now)
            };

            let mut best: Option<(usize, String, u64)> = None;
            for (idx, name) in order.iter().enumerate() {
                if asleep(idx, name) {
                    continue;
                }
                if !alive.contains(name) {
                    continue;
                }
                let runup = runup_of(idx, name);
                if runup < TREASURER_MIN_RUNUP_MS {
                    continue;
                }
                // Для сравнения «кто дольше протянет» используем абсолютное
                // время конца сна/следующего сна.
                let next_break = now + runup;
                match &best {
                    None => best = Some((idx, name.clone(), next_break)),
                    Some((_, _, b)) if next_break > *b => {
                        best = Some((idx, name.clone(), next_break));
                    }
                    _ => {}
                }
            }

            let new_treasurer = best.map(|(_, n, _)| n);
            let (old_treasurer, changed, need_flush_to) = {
                let mut g = st_treas.lock().await;
                let old = g.treasurer_nick.clone();
                let changed = old != new_treasurer;
                let need_flush_to = if changed {
                    if let Some(old_nick) = old.as_ref() {
                        if let Some(new_nick) = new_treasurer.as_ref() {
                            if old_nick != new_nick {
                                if g.flush_waiting.contains(old_nick) {
                                    warn!(
                                        "treasurer change: {old_nick} уже в flush_waiting — не дублирую FlushToTreasurer"
                                    );
                                    None
                                } else {
                                    g.owes_treasurer
                                        .insert(old_nick.clone(), new_nick.clone());
                                    Some((old_nick.clone(), new_nick.clone()))
                                }
                            } else {
                                None
                            }
                        } else {
                            warn!(
                                "treasurer change: {old_nick} отдал бы деньги, но новый казначей = None"
                            );
                            None
                        }
                    } else {
                        None
                    }
                } else {
                    None
                };
                if changed {
                    if let Some(n) = new_treasurer.as_ref() {
                        g.owes_treasurer.remove(n); // новый казначей никому не должен
                    }
                    g.treasurer_nick = new_treasurer.clone();
                }
                (old, changed, need_flush_to)
            };

            if changed {
                info!(
                    "treasurer an{}: {:?} → {:?}",
                    anarchy, old_treasurer, new_treasurer
                );
                let role_cmd = OrchCmd::TreasurerRole {
                    username: new_treasurer.clone().unwrap_or_default(),
                };
                let _ = broadcast_cmd(&st_treas, &role_cmd).await;
            }

            if let Some((old_nick, to)) = need_flush_to {
                info!("treasurer flush: {old_nick} → {to} (перед сном)");
                let cmd = OrchCmd::FlushToTreasurer { to: to.clone() };
                if let Err(e) = send_cmd_to(&st_treas, &old_nick, &cmd).await {
                    warn!("FlushToTreasurer → {old_nick}: {e:#}");
                } else {
                    let mut g = st_treas.lock().await;
                    g.flush_waiting.insert(old_nick.clone());
                }
            }

            if let Some(treasurer) = new_treasurer.as_ref() {
                let snapshot: Vec<(String, f64)> = {
                    let g = st_treas.lock().await;
                    g.bots
                        .values()
                        .filter(|rt| !rt.banned && rt.success && rt.on_anarchy)
                        .map(|rt| {
                            (
                                rt.cfg.username.clone(),
                                rt.balance.unwrap_or(BALANCE_UNKNOWN),
                            )
                        })
                        .collect()
                };
                if !snapshot.is_empty() {
                    let cmd = OrchCmd::BalancesSnapshot { balances: snapshot };
                    if let Err(e) = send_cmd_to(&st_treas, treasurer, &cmd).await {
                        warn!("BalancesSnapshot → {treasurer}: {e:#}");
                    }
                }
            }

            sleep(TREASURER_TICK).await;
        }
    });

    tokio::signal::ctrl_c().await?;
    info!("ctrl-c → shutdown");
    {
        let mut g = state.lock().await;
        g.shutting_down = true;
        for (name, _wh) in g.workers.drain() {
            info!("stop {name}");
        }
    }
    Ok(())
}

// ============ load: bindings.json ============

fn load_bindings(path: &Path) -> HashMap<String, bool> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    match serde_json::from_str::<HashMap<String, bool>>(&raw) {
        Ok(m) => m,
        Err(e) => {
            warn!("bindings.json parse: {e} — пустой");
            HashMap::new()
        }
    }
}

fn save_bindings(path: &Path, map: &HashMap<String, bool>) {
    if let Ok(raw) = serde_json::to_string_pretty(map) {
        let _ = std::fs::write(path, raw);
    }
}

// ============ load: farm ============

fn load_bots(
    bots_path: &Path,
    ip_path: &Path,
) -> Result<(HashMap<String, BotRuntime>, Vec<String>)> {
    let raw = std::fs::read_to_string(bots_path)?;
    let list: Vec<BotJson> = serde_json::from_str(&raw)?;
    let ip_map: HashMap<String, String> =
        serde_json::from_str(&std::fs::read_to_string(ip_path)?)?;
    let remembered = load_remembered_bans(&bans_memory_path(bots_path));
    let mut out = HashMap::new();
    let mut order = Vec::new();
    for b in list {
        order.push(b.username.clone());
        let proxy = ip_map
            .get(&b.ip)
            .cloned()
            .with_context(|| format!("farm {}: нет proxy для ip-слота {}", b.username, b.ip))?;
        let key = b.username.to_lowercase();
        let remembered_ban = remembered.get(&key).cloned();
        let banned = remembered_ban.is_some();
        out.insert(
            b.username.clone(),
            BotRuntime {
                cfg: b,
                proxy,
                success: false,
                on_anarchy: false,
                banned,
                manual_stop: banned,
                unstable_until: None,
                pricing_edges: std::collections::VecDeque::new(),
                last_pricing_ok: false,
                items: json!({}),
                inventory: json!([]),
                balance: None,
                balance_at: None,
                banned_at: remembered_ban.as_ref().and_then(|v| {
                    v.get("banned_at")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string())
                }),
                banned_reason: remembered_ban.as_ref().and_then(|v| {
                    v.get("reason")
                        .and_then(|x| x.as_str())
                        .map(|s| s.to_string())
                }),
                auth_fault: None,
                auth_fault_at: None,
                auth_fault_reason: None,
                spawning: false,
            },
        );
    }
    info!(
        "bots.json: {} farm-ботов (бан в памяти: {})",
        out.len(),
        out.values().filter(|b| b.banned).count()
    );
    Ok((out, order))
}

// ============ load: my_nick ============

fn load_my_nick(farm_root: &Path) -> Result<Option<String>> {
    let path = farm_root.join("clan-owners.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        warn!("нет {} — myNick = None", path.display());
        return Ok(None);
    };
    let v: Value = serde_json::from_str(&raw)
        .with_context(|| format!("парсить {}", path.display()))?;
    let my_nick = v
        .get("myNick")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string());
    Ok(my_nick)
}

// ============ ban-memory ============

fn bans_memory_path(bots_path: &Path) -> PathBuf {
    bots_path
        .parent()
        .unwrap_or(Path::new("."))
        .join("banned-memory.json")
}

fn load_remembered_bans(path: &Path) -> HashMap<String, Value> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HashMap::new();
    };
    let Ok(map) = serde_json::from_str::<HashMap<String, Value>>(&raw) else {
        return HashMap::new();
    };
    map
}

fn remember_ban(path: &Path, username: &str, reason: Option<&str>, banned_at: Option<&str>) {
    let mut map = load_remembered_bans(path);
    map.insert(
        username.to_lowercase(),
        json!({
            "username": username,
            "reason": reason.unwrap_or(""),
            "banned_at": banned_at.unwrap_or(""),
        }),
    );
    if let Ok(raw) = serde_json::to_string_pretty(&map) {
        let _ = std::fs::write(path, raw);
    }
}

// ============ start / spawn ============

async fn start_all(state: Arc<Mutex<OrchState>>, go_tx: GoTx, restart_tx: RestartTx) {
    let (order, schedule_arc, bindings) = {
        let g = state.lock().await;
        (g.bot_order.clone(), g.schedule.clone(), g.bindings.clone())
    };

    let now = schedule::now_unix_ms();
    for (idx, name) in order.iter().enumerate() {
        if idx > 0 {
            sleep(Duration::from_secs(8)).await;
        }
        let is_bound = bindings.get(name).copied() == Some(true);
        let active = schedule_arc.is_active(idx, now);
        // Спавним, если активен ИЛИ привязка не `true` (надо проверить).
        if !active && is_bound {
            info!("{name} (idx={idx}): в перерыве и привязан, spawn пропущен");
            continue;
        }
        if !active {
            info!("{name} (idx={idx}): в перерыве, но привязка не true — spawn (проверка)");
        }
        if let Err(e) =
            spawn_worker(state.clone(), go_tx.clone(), restart_tx.clone(), name.clone()).await
        {
            error!("spawn {name}: {e:#}");
        }
    }
}

async fn kill_worker(state: &Arc<Mutex<OrchState>>, username: &str) {
    let mut g = state.lock().await;
    if let Some(mut wh) = g.workers.remove(username) {
        info!("{username}: kill_worker (перерыв)");
        let _ = wh.child.start_kill();
    }
}

async fn spawn_worker(
    state: Arc<Mutex<OrchState>>,
    go_tx: GoTx,
    restart_tx: RestartTx,
    username: String,
) -> Result<()> {
    let (boot, bot_bin) = {
        let mut g = state.lock().await;
        if g.shutting_down {
            return Ok(());
        }
        let (banned, manual_stop, spawning) = {
            let rt = g.bots.get(&username).context("unknown bot")?;
            (rt.banned, rt.manual_stop, rt.spawning)
        };
        if banned || manual_stop {
            warn!("skip {username} (banned/manual_stop)");
            return Ok(());
        }
        if spawning {
            warn!("{username}: spawn уже идёт — skip");
            return Ok(());
        }
        if let Some(old) = g.workers.remove(&username) {
            let _ = old.child;
        }
        let boot = {
            let my_nick = g.my_nick.clone();
            let treasurer_nick = g.treasurer_nick.clone();
            let rt = g.bots.get_mut(&username).context("unknown bot")?;
            rt.success = false;
            rt.spawning = true;
            BotBoot {
                username: rt.cfg.username.clone(),
                password: rt.cfg.password.clone(),
                anarchy: rt.cfg.anarchy,
                item: rt.cfg.item.clone(),
                go_type: rt.cfg.go_type.clone(),
                proxy: rt.proxy.clone(),
                server: "mc.funtime.su".into(),
                my_nick,
                owner_nick: None,
                owner_reason: None,
                treasurer_nick,
            }
        };
        (boot, g.bot_bin.clone())
    };

    let result =
        spawn_worker_inner(state.clone(), go_tx, restart_tx, boot, bot_bin).await;

    {
        let mut g = state.lock().await;
        if let Some(rt) = g.bots.get_mut(&username) {
            rt.spawning = false;
        }
    }

    result
}

async fn spawn_worker_inner(
    state: Arc<Mutex<OrchState>>,
    go_tx: GoTx,
    restart_tx: RestartTx,
    boot: BotBoot,
    bot_bin: PathBuf,
) -> Result<()> {
    if !bot_bin.exists() {
        bail!("нет бинаря {} — сначала: cargo build -p bot", bot_bin.display());
    }

    pretty_log::line(&boot.username, LineKind::Info, "spawn");
    let mut child = Command::new(&bot_bin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .with_context(|| format!("spawn {}", bot_bin.display()))?;

    let mut stdin = child.stdin.take().context("stdin")?;
    let stdout = child.stdout.take().context("stdout")?;
    let boot_line = serde_json::to_string(&boot)? + "\n";
    stdin.write_all(boot_line.as_bytes()).await?;

    {
        let st = {
            let mut g = state.lock().await;
            g.listings.export_for(&boot.username)
        };
        let cmd = OrchCmd::ListingState { data: st };
        let line = serde_json::to_string(&cmd)? + "\n";
        stdin.write_all(line.as_bytes()).await?;
    }
    stdin.flush().await?;

    let uname = boot.username.clone();
    {
        let mut g = state.lock().await;
        g.workers.insert(uname.clone(), WorkerHandle { child, stdin });
    }

    // B3. owes_treasurer — досылаем FlushToTreasurer.
    {
        let owes_to = {
            let mut g = state.lock().await;
            match g.owes_treasurer.remove(&uname) {
                None => None,
                Some(old_to) => match g.treasurer_nick.clone() {
                    Some(t) if t == uname => None, // сам казначей, долг аннулирован
                    Some(t) => Some(t),            // шлём актуальному казначею
                    None => Some(old_to),
                },
            }
        };
        if let Some(to) = owes_to {
            info!("spawn {uname}: owes_treasurer → {to}, досылаю FlushToTreasurer");
            let cmd = OrchCmd::FlushToTreasurer { to: to.clone() };
            match send_cmd_to(&state, &uname, &cmd).await {
                Ok(()) => {
                    let mut g = state.lock().await;
                    g.flush_waiting.insert(uname.clone());
                }
                Err(e) => {
                    warn!("spawn {uname}: не удалось дослать FlushToTreasurer: {e:#}");
                    let mut g = state.lock().await;
                    g.owes_treasurer.insert(uname.clone(), to);
                }
            }
        }
    }

     // ============================================================
    // `bindings = true` ставит ТОЛЬКО `funauth_verified`
    // (см. `handle_worker_line`). 5с-таймер от spawn не нужен —
    // бот не успевает зайти за 5с (логин + `/an503` + scoreboard),
    // поэтому таймер ставил `false` даже при наличии привязки.
    //
    // `bindings = false` ставит:
    //   - `funauth_bind` (`/vk`) — привязки нет;
    //   - `funauth_2fa` — привязки нет;
    //   - `auth_fault` — привязки/пароля нет.
    //
    // Если бот вообще не зашёл (нет `funauth_verified`), `bindings`
    // остаётся `None` → `schedule tick` будет спавнить на проверку.
    // ============================================================

    let st = state.clone();
    let go = go_tx.clone();
    let restart = restart_tx.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Err(e) = handle_worker_line(&st, &go, &uname, &line).await {
                warn!("{uname} ipc: {e:#}");
            }
        }
        drop(lines);
        let code = {
            let mut g = st.lock().await;
            if let Some(mut wh) = g.workers.remove(&uname) {
                wh.child.try_wait().ok().flatten().and_then(|s| s.code())
            } else {
                None
            }
        };
        pretty_log::line(&uname, LineKind::Warn, &format!("exit code={code:?}"));

        let should_restart = {
            let mut g = st.lock().await;
            let shutting = g.shutting_down;

            let was_waiting_flush = g.flush_waiting.remove(&uname);
            if was_waiting_flush {
                let existing_owes = g.owes_treasurer.get(&uname).cloned();
                let target = existing_owes
                    .or_else(|| g.treasurer_nick.clone().filter(|t| t != &uname));
                if let Some(to) = target {
                    g.owes_treasurer.insert(uname.clone(), to.clone());
                    warn!(
                        "{uname}: умер, не дослав treasurer_flushed → owes {to}, дошлём при респавне"
                    );
                } else {
                    warn!(
                        "{uname}: умер, не дослав treasurer_flushed, treasurer_nick — сам {uname} или None — flush не требуется/потерян"
                    );
                }
            }

            if let Some(rt) = g.bots.get_mut(&uname) {
                rt.success = false;
                rt.on_anarchy = false;
                note_pricing_edge(rt, false);
                rt.items = json!({});
                rt.inventory = json!([]);
                if let Some(kind) = auth_fault_kind_from_exit(code) {
                    let now = chrono_like_now();
                    rt.auth_fault = Some(kind.to_string());
                    rt.auth_fault_at = Some(now);
                    if rt.auth_fault_reason.is_none() {
                        rt.auth_fault_reason = Some(format!("exit {code:?}"));
                    }
                    if kind == "bad_password" {
                        rt.manual_stop = true;
                    }
                }
                let block = rt.manual_stop
                    || rt.banned
                    || rt.auth_fault.as_deref() == Some("bad_password");

                let in_break = {
                    let idx = g.bot_order.iter().position(|n| n == &uname);
                    match idx {
                        Some(i) => {
                            let now = schedule::now_unix_ms();
                            !g.schedule.is_active(i, now)
                        }
                        None => false,
                    }
                };

                !shutting && !block && !in_break
            } else {
                false
            }
        };

        let _ = push_presence(&st, &go).await;
        if should_restart {
            pretty_log::line(&uname, LineKind::Info, "очередь рестарта");
            let _ = restart.send(uname);
        }
    });

    Ok(())
}

// ============ handle worker line ============

async fn handle_worker_line(
    state: &Arc<Mutex<OrchState>>,
    go_tx: &GoTx,
    username: &str,
    line: &str,
) -> Result<()> {
    let line = line.trim();
    if line.is_empty() {
        return Ok(());
    }

    let is_treasurer = {
        let g = state.lock().await;
        g.treasurer_nick.as_deref() == Some(username)
    };

    if line.starts_with('"') {
        pretty_log::line_ex(
            username,
            LineKind::Info,
            line.trim_matches('"'),
            is_treasurer,
        );
        return Ok(());
    }
    let msg: WorkerMsg = serde_json::from_str(line)?;

    match msg.name.as_str() {
        "success" => {
            let mut g = state.lock().await;
            if let Some(rt) = g.bots.get_mut(username) {
                rt.success = true;
                rt.on_anarchy = true;
                rt.auth_fault = None;
                rt.auth_fault_at = None;
                rt.auth_fault_reason = None;
                note_pricing_edge(rt, true);
            }
            pretty_log::line_ex(
                username,
                LineKind::Ok,
                "на анархии → success",
                is_treasurer,
            );
            drop(g);
            let _ = push_presence(state, go_tx).await;
            let _ = send_fleet(state, go_tx).await;
            let _ = go_tx.send(json!({ "action": "info" }));
        }
        "hub" => {
            let why = msg.reason.as_deref().unwrap_or("?");
            pretty_log::line_ex(
                username,
                LineKind::Warn,
                &format!("хаб / не на анке: {why}"),
                is_treasurer,
            );
            let mut g = state.lock().await;
            if let Some(rt) = g.bots.get_mut(username) {
                rt.on_anarchy = false;
                note_pricing_edge(rt, false);
            }
            drop(g);
            let _ = push_presence(state, go_tx).await;
        }
        "items" => {
            let mut g = state.lock().await;
            if let Some(rt) = g.bots.get_mut(username) {
                if let Some(items) = msg.items {
                    rt.items = items;
                }
            }
            drop(g);
            let _ = push_presence(state, go_tx).await;
        }
        "inventory" => {
            let mut g = state.lock().await;
            if let Some(rt) = g.bots.get_mut(username) {
                if let Some(data) = msg.data {
                    rt.inventory = data;
                }
            }
        }
        "kicked" | "banned" => {
            let kind = if msg.name == "banned" { "бан" } else { "кик" };
            pretty_log::line_ex(
                username,
                LineKind::Err,
                &format!("{kind}: {}", msg.reason.as_deref().unwrap_or("?")),
                is_treasurer,
            );
            if msg.name == "banned" {
                let (memory_path, banned_at, reason) = {
                    let mut g = state.lock().await;
                    let path = bans_memory_path(&g.bots_path);
                    if let Some(rt) = g.bots.get_mut(username) {
                        rt.banned = true;
                        rt.manual_stop = true;
                        rt.banned_at = Some(chrono_like_now());
                        rt.banned_reason = msg.reason.clone();
                        (path, rt.banned_at.clone(), rt.banned_reason.clone())
                    } else {
                        (path, None, None)
                    }
                };
                remember_ban(
                    &memory_path,
                    username,
                    reason.as_deref().or(msg.reason.as_deref()),
                    banned_at.as_deref(),
                );
            }
            let _ = push_presence(state, go_tx).await;
            let _ = send_fleet(state, go_tx).await;
        }
        "buy" | "sell" | "try-sell" => {
            forward_trade(go_tx, &msg)?;
        }
        "set_min_price" => {
            let price = msg.price.map(|p| p.round() as i64);
            send_go(
                go_tx,
                json!({ "action": "set_min_price", "type": msg.id, "price": price }),
            )?;
        }
        "buying" => {
            handle_buying_claim(state, go_tx, username, &msg).await?;
        }
        "listing" => {
            let data = msg.data.clone().unwrap_or(json!({}));
            let result = {
                let mut g = state.lock().await;
                g.listings.handle(username, &data)
            };
            let cmd = OrchCmd::ListingRes {
                req_id: data.get("reqId").and_then(|v| v.as_u64()).unwrap_or(0),
                result,
            };
            send_cmd_to(state, username, &cmd).await?;
        }
        "captcha" => {
            pretty_log::line_ex(username, LineKind::Warn, "captcha", is_treasurer);
        }
        "auth_fault" => {
            let kind = msg
                .data
                .as_ref()
                .and_then(|d| d.get("kind"))
                .and_then(|v| v.as_str())
                .unwrap_or("bad_password")
                .to_string();
            {
                let mut g = state.lock().await;
                if let Some(rt) = g.bots.get_mut(username) {
                    rt.auth_fault = Some(kind.clone());
                    rt.auth_fault_at = Some(chrono_like_now());
                    rt.auth_fault_reason = msg.reason.clone();
                    if kind == "bad_password" {
                        rt.manual_stop = true;
                    }
                }
                // auth_fault — привязки нет. Пишем в bindings.json.
                g.bindings.insert(username.to_string(), false);
                save_bindings(&g.bindings_path, &g.bindings);
            }
            pretty_log::line_ex(
                username,
                LineKind::Err,
                &format!("auth_fault {kind}"),
                is_treasurer,
            );
            let _ = push_presence(state, go_tx).await;
        }
        "funauth_bind" => {
            pretty_log::line_ex(
                username,
                LineKind::Warn,
                "funauth bind → Go + рестарт",
                is_treasurer,
            );
            let (anarchy, password) = {
                let g = state.lock().await;
                g.bots
                    .get(username)
                    .map(|rt| (rt.cfg.anarchy, rt.cfg.password.clone()))
                    .unwrap_or((0, String::new()))
            };
            if password.is_empty() {
                warn!("funauth_bind {username}: нет пароля");
            } else {
                send_go(
                    go_tx,
                    json!({
                        "action": "funauth_bind",
                        "nick": username,
                        "password": password,
                        "anarchy": anarchy,
                    }),
                )?;
            }
            let mut g = state.lock().await;
            // funauth_bind — привязки нет. Пишем в bindings.json.
            g.bindings.insert(username.to_string(), false);
            save_bindings(&g.bindings_path, &g.bindings);
            if let Some(wh) = g.workers.get_mut(username) {
                let _ = wh.child.start_kill();
            }
        }
        "funauth_2fa" => {
            pretty_log::line_ex(
                username,
                LineKind::Warn,
                "funauth 2fa → рестарт воркера",
                is_treasurer,
            );
            let anarchy = {
                let g = state.lock().await;
                g.bots.get(username).map(|rt| rt.cfg.anarchy)
            };
            send_go(
                go_tx,
                json!({
                    "action": "funauth_2fa",
                    "nick": username,
                    "anarchy": anarchy,
                }),
            )?;
            let mut g = state.lock().await;
            // funauth_2fa — привязки нет. Пишем в bindings.json.
            g.bindings.insert(username.to_string(), false);
            save_bindings(&g.bindings_path, &g.bindings);
            if let Some(wh) = g.workers.get_mut(username) {
                let _ = wh.child.start_kill();
            }
        }
        "funauth_verified" => {
            let anarchy = {
                let g = state.lock().await;
                g.bots.get(username).map(|rt| rt.cfg.anarchy)
            };
            send_go(
                go_tx,
                json!({
                    "action": "funauth_verified",
                    "nick": username,
                    "anarchy": anarchy,
                }),
            )?;
            // **НОВОЕ:** воркер подтвердил, что 5с на анке прошло без
            // `funauth_bind` / `funauth_2fa` → привязка есть.
            // Ставим `bindings = true` и, если сейчас перерыв — сразу
            // вырубаем (не ждём следующего `schedule tick`).
            let (should_kill, bindings_path) = {
                let mut g = state.lock().await;
                g.bindings.insert(username.to_string(), true);
                let bp = g.bindings_path.clone();
                save_bindings(&bp, &g.bindings);

                let idx = g.bot_order.iter().position(|n| n == username);
                let in_break = match idx {
                    Some(i) => {
                        let now = schedule::now_unix_ms();
                        !g.schedule.is_active(i, now)
                    }
                    None => false,
                };
                let is_treasurer_now = g.treasurer_nick.as_deref() == Some(username);
                let is_flush_waiting = g.flush_waiting.contains(username);
                // Казначея и flush не убиваем — деньги важнее.
                (in_break && !is_treasurer_now && !is_flush_waiting, bp)
            };
            pretty_log::line_ex(
                username,
                LineKind::Ok,
                "bindings.json = true (funauth_verified)",
                is_treasurer,
            );
            if should_kill {
                info!(
                    "{username}: funauth_verified + сейчас перерыв → вырубаю сразу"
                );
                kill_worker(state, username).await;
            }
        }
        "balance" => {
            if let Some(bal) = msg.balance {
                pretty_log::line_ex(
                    username,
                    LineKind::Ok,
                    &format!("баланс {}", format_money(bal)),
                    is_treasurer,
                );
                {
                    let mut g = state.lock().await;
                    if let Some(rt) = g.bots.get_mut(username) {
                        rt.balance = Some(bal);
                        rt.balance_at = Some(std::time::Instant::now());
                    }
                }
                push_capital_plan_to_bots(state).await?;
            }
        }
        "ah_lots" => {
            if let Some(lots) = &msg.lots {
                let lots = coerce_ah_lots_prices(lots);
                let n = lots.as_array().map(|a| a.len()).unwrap_or(0);
                if n > 0 {
                    tracing::info!("ah_lots → Go · {n} лотов");
                }
                send_go(go_tx, json!({ "action": "ah_lots", "lots": lots }))?;
            }
        }
        "staff_check" => {
            let anarchy = {
                let from_data = msg
                    .data
                    .as_ref()
                    .and_then(|d| d.get("anarchy"))
                    .and_then(|v| v.as_u64())
                    .map(|n| n as u16);
                if from_data.is_some() {
                    from_data
                } else {
                    let g = state.lock().await;
                    g.bots.get(username).map(|rt| rt.cfg.anarchy)
                }
            };
            pretty_log::line_ex(
                username,
                LineKind::Warn,
                "проверка читов → Go",
                is_treasurer,
            );
            send_go(
                go_tx,
                json!({
                    "action": "staff_check",
                    "username": username,
                    "anarchy": anarchy,
                    "reason": msg.reason.as_deref().unwrap_or(""),
                }),
            )?;
        }
        "my_nick_seen" => {
            let nick = msg
                .data
                .as_ref()
                .and_then(|d| d.get("nick"))
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            pretty_log::line_ex(
                username,
                LineKind::Info,
                &format!("my_nick_seen: {nick} в табе"),
                is_treasurer,
            );
        }
        "treasurer_flushed" => {
            let ok = msg
                .data
                .as_ref()
                .and_then(|d| d.get("ok"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let to = msg
                .data
                .as_ref()
                .and_then(|d| d.get("to"))
                .and_then(|v| v.as_str())
                .unwrap_or("?");
            let amount = msg
                .data
                .as_ref()
                .and_then(|d| d.get("amount"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            pretty_log::line_ex(
                username,
                if ok { LineKind::Ok } else { LineKind::Err },
                &format!(
                    "treasurer_flushed → {to} ({}), ok={ok}",
                    format_money(amount as f64)
                ),
                is_treasurer,
            );
            let mut g = state.lock().await;
            g.flush_waiting.remove(username);
            if ok {
                g.owes_treasurer.remove(username);
            } else {
                if !g.owes_treasurer.contains_key(username) {
                    if let Some(t) = g.treasurer_nick.clone().filter(|t| t != username) {
                        warn!(
                            "treasurer_flushed ok=false от {username}: owes не было — ставлю на {t}, дошлём при респавне"
                        );
                        g.owes_treasurer.insert(username.to_string(), t);
                    } else {
                        warn!(
                            "treasurer_flushed ok=false от {username}: owes не было, treasurer_nick — сам {username} или None — flush не требуется/потерян"
                        );
                    }
                } else {
                    warn!(
                        "treasurer_flushed ok=false от {username}: owes сохранён, дошлём при респавне"
                    );
                }
            }
        }
        "paid" => {
            let req_id = msg
                .data
                .as_ref()
                .and_then(|d| d.get("reqId"))
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let ok = msg
                .data
                .as_ref()
                .and_then(|d| d.get("ok"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);

            let pending = {
                let mut g = state.lock().await;
                g.pending_pays.remove(&req_id)
            };
            let Some(pending) = pending else {
                warn!("paid: req_id={req_id} не найден в pending_pays");
                return Ok(());
            };
            pretty_log::line_ex(
                username,
                if ok { LineKind::Ok } else { LineKind::Err },
                &format!(
                    "paid req={req_id} → {} ({}) ok={ok}",
                    pending.to_bot,
                    format_money(pending.amount as f64),
                ),
                is_treasurer,
            );
        }
        other => {
            pretty_log::line_ex(
                username,
                LineKind::Info,
                &format!("msg={other}"),
                is_treasurer,
            );
        }
    }
    Ok(())
}

// ============ helpers ============

fn forward_trade(go_tx: &GoTx, msg: &WorkerMsg) -> Result<()> {
    let price = msg.price.map(|p| p.round() as i64);
    let mut payload = json!({
        "action": msg.name,
        "type": msg.id,
        "price": price,
    });
    if let Some(data) = &msg.data {
        if let Some(obj) = payload.as_object_mut() {
            if let Some(ench) = data.get("enchants") {
                obj.insert("enchants".into(), ench.clone());
            }
            if let Some(dur) = data.get("durability") {
                obj.insert("durability".into(), dur.clone());
            }
        }
    }
    send_go(go_tx, payload)
}

async fn handle_buying_claim(
    state: &Arc<Mutex<OrchState>>,
    go_tx: &GoTx,
    username: &str,
    msg: &WorkerMsg,
) -> Result<()> {
    let uuid = msg
        .data
        .as_ref()
        .and_then(|d| d.get("uuid"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let Some(uuid) = uuid else {
        return Ok(());
    };
    let updated = {
        let mut g = state.lock().await;
        let mut list = g.items_buying.as_array().cloned().unwrap_or_default();
        list.retain(|raw| {
            let u = match raw {
                Value::String(s) => s.as_str(),
                Value::Object(o) => o.get("uuid").and_then(|v| v.as_str()).unwrap_or(""),
                _ => "",
            };
            u != uuid
        });
        list.push(json!({ "uuid": uuid, "username": username }));
        g.items_buying = Value::Array(list.clone());
        g.items_buying.clone()
    };
    let cmd = OrchCmd::ItemsBuying { data: updated };
    broadcast_cmd(state, &cmd).await?;
    send_go(go_tx, json!({ "action": "add", "json_data": uuid }))?;
    Ok(())
}

fn coerce_ah_lots_prices(lots: &Value) -> Value {
    let Some(arr) = lots.as_array() else {
        return lots.clone();
    };
    let out: Vec<Value> = arr
        .iter()
        .map(|lot| {
            let mut o = match lot.as_object() {
                Some(m) => m.clone(),
                None => return lot.clone(),
            };
            if let Some(p) = o.get("price") {
                let n = p
                    .as_i64()
                    .or_else(|| p.as_u64().map(|u| u as i64))
                    .or_else(|| p.as_f64().map(|f| f.round() as i64));
                if let Some(n) = n {
                    o.insert("price".into(), json!(n));
                }
            }
            Value::Object(o)
        })
        .collect();
    Value::Array(out)
}

fn send_go(go_tx: &GoTx, v: Value) -> Result<()> {
    let _ = go_tx.send(v);
    Ok(())
}

async fn send_fleet(state: &Arc<Mutex<OrchState>>, go_tx: &GoTx) -> Result<()> {
    let (types, roster, owner_json) = {
        let g = state.lock().await;
        let mut types = Vec::new();
        let mut roster = Vec::new();
        for rt in g.bots.values() {
            if !types.contains(&rt.cfg.go_type) {
                types.push(rt.cfg.go_type.clone());
            }
            roster.push(json!({
                "username": rt.cfg.username,
                "anarchy": rt.cfg.anarchy,
                "go_type": rt.cfg.go_type,
                "success": rt.success,
                "banned": rt.banned,
            }));
        }
        let owner_json: Option<Value> = None;
        (types, roster, owner_json)
    };
    send_go(
        go_tx,
        json!({ "action": "fleet", "types": types, "bots": roster, "owner": owner_json }),
    )
}

async fn push_presence(state: &Arc<Mutex<OrchState>>, _go_tx: &GoTx) -> Result<()> {
    let payload = {
        let mut g = state.lock().await;
        let mut items: HashMap<String, u32> = HashMap::new();
        let mut inventory: HashMap<String, u32> = HashMap::new();
        let mut active_types = Vec::new();
        let mut bots_per_type: HashMap<String, u32> = HashMap::new();
        let mut banned = Vec::new();
        let mut auth_faults = Vec::new();
        let mut roster = Vec::new();
        let mut pricing_n = 0u32;
        let mut live_n = 0u32;
        let mut hub_n = 0u32;
        let mut unstable_n = 0u32;

        let worker_alive: HashMap<String, bool> = g
            .bots
            .keys()
            .map(|u| (u.clone(), g.workers.contains_key(u)))
            .collect();

        for rt in g.bots.values_mut() {
            let live = worker_alive.get(&rt.cfg.username).copied().unwrap_or(false) && rt.success;
            if live {
                live_n += 1;
            }
            let has_stock = bot_has_pricing_stock(rt);
            let unstable = rt
                .unstable_until
                .map(|t| t > std::time::Instant::now())
                .unwrap_or(false);
            if unstable {
                unstable_n += 1;
            }
            if live && !rt.on_anarchy {
                hub_n += 1;
            }
            let include_stock = live && (rt.on_anarchy || has_stock);
            let count_as_bot = live && rt.on_anarchy && !unstable;
            if include_stock {
                accumulate_presence_counts(&rt.items, &mut items);
                accumulate_presence_counts(&rt.inventory, &mut inventory);
            }
            if count_as_bot {
                pricing_n += 1;
                if !active_types.contains(&rt.cfg.go_type) {
                    active_types.push(rt.cfg.go_type.clone());
                }
                *bots_per_type.entry(rt.cfg.go_type.clone()).or_insert(0) += 1;
            }
            if rt.banned {
                banned.push(json!({
                    "username": rt.cfg.username,
                    "anarchy": rt.cfg.anarchy,
                    "go_type": rt.cfg.go_type,
                    "banned_at": rt.banned_at,
                    "reason": rt.banned_reason,
                    "kind": "ban",
                    "ip": proxy_host_hint(&rt.proxy),
                }));
            }
            if let Some(kind) = &rt.auth_fault {
                auth_faults.push(json!({
                    "username": rt.cfg.username,
                    "anarchy": rt.cfg.anarchy,
                    "go_type": rt.cfg.go_type,
                    "kind": kind,
                    "at": rt.auth_fault_at,
                    "reason": rt.auth_fault_reason,
                    "ip": proxy_host_hint(&rt.proxy),
                }));
            }
            roster.push(json!({
                "username": rt.cfg.username,
                "anarchy": rt.cfg.anarchy,
                "go_type": rt.cfg.go_type,
                "success": rt.success,
                "on_anarchy": rt.on_anarchy,
                "banned": rt.banned,
                "unstable": unstable,
                "live": live,
            }));
        }

        let owners_presence: Vec<Value> = g
            .treasurer_nick
            .as_ref()
            .map(|t| vec![json!({ "anarchy": 0, "username": t })])
            .unwrap_or_default();

        if active_types.is_empty() {
            warn!(
                "presence → active_types=[] live={live_n} hub={hub_n} unstable={unstable_n} pricing={pricing_n} (Go на паузе)"
            );
        } else {
            info!(
                "presence → active_types={active_types:?} pricing={pricing_n} live={live_n} hub={hub_n} unstable={unstable_n}"
            );
        }

        json!({
            "action": "presence",
            "items": items,
            "inventory": inventory,
            "active_types": active_types,
            "bots_per_type": bots_per_type,
            "banned": banned,
            "auth_faults": auth_faults,
            "clan_owners": owners_presence,
            "bots": roster,
            "owner": Value::Null,
            "treasurer": g.treasurer_nick,
            "fleet_stats": {
                "live": live_n,
                "pricing": pricing_n,
                "hub": hub_n,
                "unstable": unstable_n,
            },
        })
    };
    send_go(_go_tx, payload)
}

fn note_pricing_edge(rt: &mut BotRuntime, ok: bool) {
    if rt.last_pricing_ok == ok {
        return;
    }
    rt.last_pricing_ok = ok;
    let now = std::time::Instant::now();
    rt.pricing_edges.push_back(now);
    let window = std::time::Duration::from_secs(15 * 60);
    while rt
        .pricing_edges
        .front()
        .map(|t| now.duration_since(*t) > window)
        .unwrap_or(false)
    {
        rt.pricing_edges.pop_front();
    }
    if rt.pricing_edges.len() >= 6 {
        rt.unstable_until = Some(now + std::time::Duration::from_secs(5 * 60));
        pretty_log::line(
            &rt.cfg.username,
            LineKind::Warn,
            &format!(
                "unstable: {} переключений за 15м → 5м вне pricing",
                rt.pricing_edges.len()
            ),
        );
    }
}

fn accumulate_presence_counts(raw: &Value, out: &mut HashMap<String, u32>) {
    match raw {
        Value::Array(arr) => {
            for el in arr {
                match el {
                    Value::String(id) if !id.is_empty() => {
                        *out.entry(id.clone()).or_insert(0) += 1;
                    }
                    Value::Object(o) => {
                        if let Some(id) = o
                            .get("id")
                            .or_else(|| o.get("go_type"))
                            .and_then(|v| v.as_str())
                        {
                            let n = o.get("count").and_then(|v| v.as_u64()).unwrap_or(1) as u32;
                            *out.entry(id.to_string()).or_insert(0) += n.max(1);
                        }
                    }
                    _ => {}
                }
            }
        }
        Value::Object(map) => {
            for (k, v) in map {
                if let Some(n) = v.as_u64() {
                    if n > 0 {
                        *out.entry(k.clone()).or_insert(0) += n as u32;
                    }
                } else if v.as_str().is_some() {
                    *out.entry(k.clone()).or_insert(0) += 1;
                }
            }
        }
        _ => {}
    }
}

fn bot_has_pricing_stock(rt: &BotRuntime) -> bool {
    match &rt.items {
        Value::Array(a) if !a.is_empty() => return true,
        Value::Object(o) if o.values().any(|v| v.as_u64().unwrap_or(0) > 0) => return true,
        _ => {}
    }
    match &rt.inventory {
        Value::Array(a) if !a.is_empty() => return true,
        Value::Object(o) if !o.is_empty() => return true,
        _ => {}
    }
    false
}

// ============ go ws ============

async fn go_ws_loop(
    state: Arc<Mutex<OrchState>>,
    go_tx: GoTx,
    mut go_rx: mpsc::UnboundedReceiver<Value>,
    url: String,
) {
    loop {
        info!("Go WS → {url}");
        match connect_async(&url).await {
            Ok((ws, _)) => {
                let (mut sink, mut stream) = ws.split();
                info!("Go WS open");
                let _ = send_fleet(&state, &go_tx).await;
                let _ = push_presence(&state, &go_tx).await;
                let _ = go_tx.send(json!({ "action": "info" }));

                loop {
                    tokio::select! {
                        msg = stream.next() => {
                            match msg {
                                Some(Ok(Message::Text(t))) => {
                                    if let Ok(v) = serde_json::from_str::<Value>(&t) {
                                        if let Err(e) = on_go_message(&state, &go_tx, v).await {
                                            warn!("go msg: {e:#}");
                                        }
                                    }
                                }
                                Some(Ok(Message::Close(_))) | None => break,
                                Some(Err(e)) => {
                                    error!("go ws: {e}");
                                    break;
                                }
                                _ => {}
                            }
                        }
                        out = go_rx.recv() => {
                            match out {
                                Some(v) => {
                                    if sink.send(Message::Text(v.to_string().into())).await.is_err() {
                                        break;
                                    }
                                }
                                None => return,
                            }
                        }
                    }
                }
            }
            Err(e) => error!("go connect: {e}"),
        }
        sleep(Duration::from_secs(5)).await;
    }
}

async fn on_go_message(
    state: &Arc<Mutex<OrchState>>,
    go_tx: &GoTx,
    v: Value,
) -> Result<()> {
    if v.get("prices").is_some() {
        let merged = merge_go_catalog_prices(&v);
        info!("Go prices → {} позиций в каталоге", merged.len());
        if merged.is_empty() {
            return Ok(());
        }
        let mut g = state.lock().await;
        g.last_catalog = merged.clone();
        let targets: Vec<(String, String)> = g
            .workers
            .keys()
            .filter_map(|name| {
                g.bots.get(name).map(|b| (name.clone(), b.cfg.go_type.clone()))
            })
            .collect();
        for (name, go_type) in targets {
            let bot_items: Vec<Value> = merged
                .iter()
                .filter(|it| {
                    let ty = it.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    let name = it.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    catalog_type_matches_go(ty, &go_type, name)
                })
                .cloned()
                .collect();
            let cmd = OrchCmd::Update { data: bot_items, all: merged.clone() };
            let line = serde_json::to_string(&cmd)? + "\n";
            if let Some(wh) = g.workers.get_mut(&name) {
                if let Err(e) = wh.stdin.write_all(line.as_bytes()).await {
                    warn!("stdin {name}: {e}");
                }
            }
        }
    } else if v.get("action").and_then(|a| a.as_str()) == Some("json_update") {
        if let Some(data) = v.get("data") {
            let merged = {
                let mut g = state.lock().await;
                let merged = merge_go_json_update(&g.items_buying, data);
                g.items_buying = merged.clone();
                merged
            };
            let cmd = OrchCmd::ItemsBuying { data: merged };
            broadcast_cmd(state, &cmd).await?;
        }
    } else if v.get("action").and_then(|a| a.as_str()) == Some("capital_plan")
        || v.get("type").and_then(|a| a.as_str()) == Some("capital_plan")
    {
        let keep = v.get("keepSum").or_else(|| v.get("keep_sum")).and_then(|x| x.as_f64());
        let max_buy = v.get("maxBuyPrice").or_else(|| v.get("max_buy_price")).and_then(|x| x.as_f64());
        let cmd = OrchCmd::CapitalPlan { keep_sum: keep, max_buy_price: max_buy };
        broadcast_cmd(state, &cmd).await?;
    }
    Ok(())
}

fn merge_go_catalog_prices(v: &Value) -> Vec<Value> {
    let prices = match v.get("prices").and_then(|p| p.as_object()) {
        Some(m) => m,
        None => return Vec::new(),
    };
    let catalog = match v.get("catalog").and_then(|c| c.as_array()) {
        Some(c) => c,
        None => return Vec::new(),
    };
    let mut out = Vec::new();
    for item in catalog {
        let id = item.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let sell = prices.get(id).and_then(|p| {
            p.as_f64()
                .or_else(|| p.as_i64().map(|i| i as f64))
                .or_else(|| p.as_u64().map(|u| u as f64))
        });
        let Some(ps) = sell else { continue };
        let mut obj = item.clone();
        if let Some(map) = obj.as_object_mut() {
            map.insert("priceSell".into(), json!(ps));
        }
        out.push(obj);
    }
    out
}

fn catalog_type_matches_go(catalog_type: &str, go_type: &str, catalog_name: &str) -> bool {
    if go_type.is_empty() {
        return true;
    }
    if catalog_type == go_type {
        return true;
    }
    const ARMOR: &str = "netherite_armor-1.21";
    const PIECES: &[(&str, &str)] = &[
        ("netherite_helmet-1.21", "netherite_helmet"),
        ("netherite_chestplate-1.21", "netherite_chestplate"),
        ("netherite_leggings-1.21", "netherite_leggings"),
        ("netherite_boots-1.21", "netherite_boots"),
    ];
    if go_type == ARMOR {
        if PIECES.iter().any(|(t, _)| *t == catalog_type) {
            return true;
        }
        if catalog_type == ARMOR {
            return catalog_name.is_empty()
                || PIECES.iter().any(|(_, n)| *n == catalog_name);
        }
        return false;
    }
    if catalog_type == ARMOR {
        return PIECES.iter().any(|(t, n)| *t == go_type && *n == catalog_name);
    }
    let a = catalog_type.split('-').next().unwrap_or(catalog_type);
    let b = go_type.split('-').next().unwrap_or(go_type);
    a == b
}

fn merge_go_json_update(local: &Value, go_uuids: &Value) -> Value {
    let go_arr = match go_uuids.as_array() {
        Some(a) => a,
        None => {
            return if local.is_array() { local.clone() } else { json!([]) };
        }
    };
    let prev = local.as_array().cloned().unwrap_or_default();
    let mut owner_by_uuid: HashMap<String, String> = HashMap::new();
    for raw in &prev {
        if let Some((u, Some(owner))) = normalize_buying_entry(raw) {
            owner_by_uuid.insert(u, owner);
        }
    }
    let mut in_go = std::collections::HashSet::new();
    let mut out = Vec::new();
    for uuid_v in go_arr {
        let u = match uuid_v {
            Value::String(s) => s.clone(),
            Value::Object(o) => o.get("uuid").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            _ => continue,
        };
        if u.is_empty() {
            continue;
        }
        in_go.insert(u.clone());
        if let Some(owner) = owner_by_uuid.get(&u) {
            out.push(json!({ "uuid": u, "username": owner }));
        } else {
            out.push(json!({ "uuid": u, "username": Value::Null }));
        }
    }
    for raw in &prev {
        if let Some((u, Some(owner))) = normalize_buying_entry(raw) {
            if !in_go.contains(&u) {
                out.push(json!({ "uuid": u, "username": owner }));
            }
        }
    }
    Value::Array(out)
}

fn normalize_buying_entry(raw: &Value) -> Option<(String, Option<String>)> {
    match raw {
        Value::String(s) if !s.is_empty() => Some((s.clone(), None)),
        Value::Object(o) => {
            let u = o.get("uuid").and_then(|v| v.as_str())?.to_string();
            if u.is_empty() {
                return None;
            }
            let owner = o.get("username").and_then(|v| v.as_str()).map(|s| s.to_string());
            Some((u, owner))
        }
        _ => None,
    }
}

fn top_two_sell_keep(catalog: &[Value]) -> Option<f64> {
    let mut prices: Vec<f64> = Vec::new();
    for entry in catalog {
        if let Some(p) = entry.get("priceSell").and_then(|v| v.as_f64()) {
            if p.is_finite() && p > 0.0 {
                prices.push(p);
            }
        }
    }
    if prices.is_empty() {
        return None;
    }
    prices.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    if prices.len() == 1 {
        return Some(prices[0].floor());
    }
    Some((prices[0] + prices[1]).floor())
}

fn top_sell_price(catalog: &[Value]) -> Option<f64> {
    let mut best = 0.0;
    for entry in catalog {
        if let Some(p) = entry.get("priceSell").and_then(|v| v.as_f64()) {
            if p.is_finite() && p > best {
                best = p;
            }
        }
    }
    if best > 0.0 { Some(best) } else { None }
}

async fn push_capital_plan_to_bots(state: &Arc<Mutex<OrchState>>) -> Result<()> {
    let plans: Vec<(String, Option<f64>, Option<f64>)> = {
        let g = state.lock().await;
        let mut out = Vec::new();
        for name in g.workers.keys() {
            let Some(bot) = g.bots.get(name) else { continue };
            let bot_cat: Vec<Value> = g
                .last_catalog
                .iter()
                .filter(|it| {
                    let ty = it.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    let n = it.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    catalog_type_matches_go(ty, &bot.cfg.go_type, n)
                })
                .cloned()
                .collect();
            let keep = top_two_sell_keep(&bot_cat);
            let max_buy = top_sell_price(&bot_cat).map(|t| (t * 0.9).floor());
            out.push((name.clone(), keep, max_buy));
        }
        out
    };
    for (name, keep, max_buy) in plans {
        let cmd = OrchCmd::CapitalPlan { keep_sum: keep, max_buy_price: max_buy };
        let line = serde_json::to_string(&cmd)? + "\n";
        let mut g = state.lock().await;
        if let Some(wh) = g.workers.get_mut(&name) {
            if let Err(e) = wh.stdin.write_all(line.as_bytes()).await {
                warn!("stdin {name}: {e}");
            }
        }
    }
    Ok(())
}

async fn broadcast_cmd(state: &Arc<Mutex<OrchState>>, cmd: &OrchCmd) -> Result<()> {
    let line = serde_json::to_string(cmd)? + "\n";
    let mut g = state.lock().await;
    for (name, wh) in g.workers.iter_mut() {
        if let Err(e) = wh.stdin.write_all(line.as_bytes()).await {
            warn!("stdin {name}: {e}");
        }
    }
    Ok(())
}

async fn send_cmd_to(state: &Arc<Mutex<OrchState>>, username: &str, cmd: &OrchCmd) -> Result<()> {
    let line = serde_json::to_string(cmd)? + "\n";
    let mut g = state.lock().await;
    if let Some(wh) = g.workers.get_mut(username) {
        wh.stdin.write_all(line.as_bytes()).await?;
    }
    Ok(())
}

fn format_money(v: f64) -> String {
    let v = v.abs();
    if v >= 1_000_000.0 {
        let kk = v / 1_000_000.0;
        if (kk - kk.round()).abs() < 0.05 {
            format!("{}kk", kk.round() as i64)
        } else {
            format!("{kk:.1}kk")
        }
    } else if v >= 10_000.0 {
        format!("{}k", (v / 1000.0).round() as i64)
    } else if v >= 1000.0 {
        let k = v / 1000.0;
        if (k - k.round()).abs() < 0.05 {
            format!("{}k", k.round() as i64)
        } else {
            format!("{k:.1}k")
        }
    } else {
        format!("{}", v.round() as i64)
    }
}

fn chrono_like_now() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn auth_fault_kind_from_exit(code: Option<i32>) -> Option<&'static str> {
    match code {
        Some(71) => Some("bad_password"),
        Some(72) => Some("proxy_error"),
        _ => None,
    }
}

fn proxy_host_hint(proxy: &str) -> String {
    if let Some(at) = proxy.rfind('@') {
        return proxy[at + 1..].to_string();
    }
    proxy
        .trim_start_matches("socks5://")
        .trim_start_matches("socks://")
        .to_string()
}