//! Оркестратор выдачи: очередь ботов, WS для poll (порт 8790), Go для привязки.
//! Боты офлайн, пока нет дела. Приходит заказ — заходит держатель денег (`order[0]`), выдаёт `/pay`.
//! После 2 выдач покупателям он третьим переводом отдаёт остаток следующему (тот заходит только
//! принять) и уходит в конец очереди. Времени смены нет, лимит только по числу переводов.
//! Непривязанные перезаходят снова и снова (раз в SPAWN_GAP), пока их не привяжут.

mod config;
mod rotation;
mod session;

use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use futures_util::{SinkExt, StreamExt};
use ipc::{pretty_log::{self, LineKind}, BotBoot, OrchCmd, WorkerMsg};
use rotation::QueueState;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::TcpListener,
    process::{Child, ChildStdin, Command},
    sync::{mpsc, Mutex},
    time::sleep,
};
use tokio_tungstenite::{accept_async, connect_async, tungstenite::Message};
use tracing::{info, warn};

/// Сколько ждём, пока и держатель, и следующий зайдут для передачи остатка.
const HANDOFF_READY_TIMEOUT: Duration = Duration::from_secs(240);
/// Сколько ждём `handoff_done` после команды.
const HANDOFF_DONE_TIMEOUT: Duration = Duration::from_secs(90);
const HANDOFF_RETRY_GAP: Duration = Duration::from_secs(15);
const HANDOFF_MAX_TRIES: u32 = 3;
/// После неудачной передачи не пробуем снова столько (держатель продолжает выдавать).
const HANDOFF_BLOCK: Duration = Duration::from_secs(600);
/// Минимальный интервал между запусками одного бота. Непривязанный перезаходит снова и снова
/// (бот сам выходит после запроса привязки), но не чаще, чем раз в это время.
const SPAWN_GAP: Duration = Duration::from_secs(20);

#[derive(Debug, Clone, Deserialize)]
struct BotFile {
    username: String,
    password: String,
    #[serde(default)]
    anarchy: u16,
    #[serde(default)]
    proxy: String,
}

struct WorkerHandle {
    child: Child,
    stdin: ChildStdin,
}

struct Rt {
    cfg: BotFile,
    bound: Option<bool>,
}

#[derive(Debug, Clone)]
struct Pending {
    order_id: String,
    nick: String,
    amount: f64,
    /// Повтор не раньше этого момента (после неудачной попытки).
    not_before: Option<Instant>,
}

/// Сколько раз пробуем выдать один заказ, если подтверждения «Успешно! Игроку … отправлено» не было.
const MAX_DELIVERY_TRIES: u32 = 5;
const RETRY_DELAY: Duration = Duration::from_secs(20);

/// Передача остатка: следующий заходит и ждёт, держатель переводит, следующий сообщает «получено».
struct Handoff {
    to: String,
    started: Instant,
    sent_at: Option<Instant>,
    not_before: Option<Instant>,
    tries: u32,
    /// Сколько отправитель отчитался, что перевёл.
    sent_amount: Option<f64>,
    /// Сколько получатель увидел в чате («От игрока … получено +$…»).
    received: Option<f64>,
}

impl Handoff {
    fn new(to: String) -> Self {
        Self { to, started: Instant::now(), sent_at: None, not_before: None, tries: 0, sent_amount: None, received: None }
    }
}

/// Допуск при сверке суммы (округление).
const VERIFY_TOLERANCE: f64 = 0.98;
/// Перевод ушёл, а сообщения «получено» нет столько секунд — всё равно передаём очередь (отправитель пуст).
const RECEIPT_WAIT: Duration = Duration::from_secs(60);

/// Журнал денег: каждая выдача и передача (одна строка JSON). Нужен, чтобы после сбоя понять, где деньги.
fn ledger(farm: &Path, mut ev: Value) {
    use std::io::Write;
    if let Some(o) = ev.as_object_mut() {
        o.insert("t".into(), json!(session::fmt_msk(session::now_unix_ms())));
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(farm.join("ledger.jsonl"))
    {
        let _ = writeln!(f, "{ev}");
    }
}

struct Orch {
    farm_root: PathBuf,
    bot_bin: PathBuf,
    go_ws: String,
    anarchy: u16,
    bots: HashMap<String, Rt>,
    workers: HashMap<String, WorkerHandle>,
    /// Воркеры, которые зашли на анку и прошли привязку (`funauth_verified`) — им можно слать команды.
    ready: HashSet<String>,
    queue: QueueState,
    /// Заказы, ждущие, пока держатель зайдёт.
    pending: VecDeque<Pending>,
    /// Заказ, который сейчас выдаёт держатель.
    in_flight: Option<String>,
    /// Все незакрытые заказы по id (чтобы повторить выдачу, если подтверждения не было).
    jobs: HashMap<String, Pending>,
    /// Сколько раз уже пробовали выдать заказ.
    attempts: HashMap<String, u32>,
    handoff: Option<Handoff>,
    rotate_block_until: Option<Instant>,
    /// Когда последний раз запускали воркера (чтобы непривязанные не переподключались чаще раза в SPAWN_GAP).
    last_spawn: HashMap<String, Instant>,
    sell_clients: HashSet<usize>,
    next_client: usize,
    client_tx: HashMap<usize, mpsc::UnboundedSender<String>>,
    go_out: Option<mpsc::UnboundedSender<Value>>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info".into()),
        )
        .init();

    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let cfg: config::OrchConfig = std::fs::read_to_string(cwd.join("orch.json"))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    let farm = if Path::new(&cfg.farm_root).is_absolute() {
        PathBuf::from(&cfg.farm_root)
    } else {
        cwd.join(&cfg.farm_root)
    };
    let bots_path = {
        let a = farm.join("bots/sell.json");
        let b = farm.join("../sellbot/bot.json");
        if a.is_file() {
            a
        } else if b.is_file() {
            b
        } else {
            bail!("нет bots/sell.json и sellbot/bot.json");
        }
    };
    let list: Vec<BotFile> = serde_json::from_str(&std::fs::read_to_string(&bots_path)?)?;
    if list.is_empty() {
        bail!("bots/sell.json пуст");
    }
    let nicks: Vec<String> = list.iter().map(|b| b.username.clone()).collect();
    let mut bots = HashMap::new();
    let bindings = load_bindings(&farm);
    for b in list {
        let bound = bindings.get(&b.username).copied();
        bots.insert(
            b.username.clone(),
            Rt {
                cfg: b,
                bound,
            },
        );
    }
    let queue = QueueState::load_or_init(&farm, &nicks, &cfg.schedule_salt);
    if std::env::args().any(|a| a == "--schedule") {
        print!("{}", status_text(&queue));
        return Ok(());
    }
    queue.save(&farm);
    write_schedule_file(&farm, &queue, 0, false);
    info!("очередь:\n{}", status_text(&queue));
    let bot_bin = farm.join("target/release/sell-bot");
    let bot_bin = if bot_bin.is_file() {
        bot_bin
    } else {
        farm.join("target/debug/sell-bot")
    };

    info!(
        "sell-orch · {} ботов · держатель={} · go={} · bin={}",
        nicks.len(),
        queue.duty().unwrap_or("?"),
        cfg.go_ws,
        bot_bin.display()
    );

    let state = Arc::new(Mutex::new(Orch {
        farm_root: farm,
        bot_bin,
        go_ws: cfg.go_ws,
        anarchy: cfg.anarchy,
        bots,
        workers: HashMap::new(),
        ready: HashSet::new(),
        queue,
        pending: VecDeque::new(),
        in_flight: None,
        jobs: HashMap::new(),
        attempts: HashMap::new(),
        handoff: None,
        rotate_block_until: None,
        last_spawn: HashMap::new(),
        sell_clients: HashSet::new(),
        next_client: 0,
        client_tx: HashMap::new(),
        go_out: None,
    }));

    let (restart_tx, mut restart_rx) = mpsc::unbounded_channel::<String>();
    let go_tx = spawn_go(state.clone());
    state.lock().await.go_out = Some(go_tx);
    spawn_sell_ws(state.clone());

    {
        let st = state.clone();
        let rtx = restart_tx.clone();
        tokio::spawn(async move {
            loop {
                pump(&st).await;
                let _ = tick_spawns(st.clone(), rtx.clone()).await;
                sleep(Duration::from_secs(1)).await;
            }
        });
    }

    while let Some(nick) = restart_rx.recv().await {
        on_worker_exit(&state, &nick).await;
        let _ = tick_spawns(state.clone(), restart_tx.clone()).await;
    }
    Ok(())
}

fn load_bindings(farm: &Path) -> HashMap<String, bool> {
    let p = farm.join("bindings.json");
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_binding(farm: &Path, nick: &str, v: bool) {
    let p = farm.join("bindings.json");
    let mut m: HashMap<String, bool> = std::fs::read_to_string(&p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();
    m.insert(nick.to_string(), v);
    if let Ok(s) = serde_json::to_string_pretty(&m) {
        let _ = std::fs::write(p, s);
    }
}

fn is_bound(rt: &Rt) -> bool {
    rt.bound == Some(true)
}

fn status_text(queue: &QueueState) -> String {
    format!(
        "  держатель: {} · выдач {}/{} · дальше: {}\n  порядок: {}\n",
        queue.duty().unwrap_or("?"),
        queue.pays,
        rotation::PAYS_BEFORE_ROTATE,
        queue.next().unwrap_or("—"),
        queue.order.join(" → "),
    )
}

/// `schedule.json` — кто держит деньги, сколько выдач, сколько заказов ждёт.
fn write_schedule_file(farm: &Path, queue: &QueueState, pending: usize, rotating: bool) {
    let doc = json!({
        "now_msk": session::fmt_msk(session::now_unix_ms()),
        "duty": queue.duty(),
        "next": queue.next(),
        "order": queue.order,
        "pays": queue.pays,
        "pays_before_rotate": rotation::PAYS_BEFORE_ROTATE,
        "handoffs_done": queue.shift_no,
        "last_handoff_msk": if queue.shift_start_ms > 0 { Some(session::fmt_msk(queue.shift_start_ms)) } else { None },
        "pending_orders": pending,
        "rotating": rotating,
    });
    if let Ok(s) = serde_json::to_string_pretty(&doc) {
        let _ = std::fs::write(farm.join("schedule.json"), s);
    }
}

fn save_state(g: &Orch) {
    g.queue.save(&g.farm_root);
    write_schedule_file(&g.farm_root, &g.queue, g.pending.len(), g.handoff.is_some());
}

/// Кого держим онлайн: непривязанных (им нужна привязка), держателя пока есть работа,
/// и пару «держатель + следующий» на время передачи остатка.
fn needed(g: &Orch) -> HashSet<String> {
    let mut out: HashSet<String> = g
        .bots
        .iter()
        .filter(|(_, rt)| rt.bound != Some(true))
        .map(|(n, _)| n.clone())
        .collect();
    if let Some(duty) = g.queue.duty() {
        if !g.pending.is_empty() || g.in_flight.is_some() || g.handoff.is_some() {
            out.insert(duty.to_string());
        }
    }
    if let Some(h) = &g.handoff {
        out.insert(h.to.clone());
    }
    out
}

/// Поднимаем нужных. Усыпляет сам воркер (`idle_quit`, см. on_worker_line), здесь только запуск.
async fn tick_spawns(
    state: Arc<Mutex<Orch>>,
    restart_tx: mpsc::UnboundedSender<String>,
) -> Result<()> {
    let need: Vec<String> = {
        let g = state.lock().await;
        needed(&g)
            .into_iter()
            .filter(|n| !g.workers.contains_key(n))
            .filter(|n| g.last_spawn.get(n).map_or(true, |t| t.elapsed() >= SPAWN_GAP))
            .collect()
    };
    for n in need {
        spawn_one(state.clone(), restart_tx.clone(), n).await?;
    }
    Ok(())
}

/// Раз в секунду: передача остатка и раздача заказов держателю.
async fn pump(state: &Arc<Mutex<Orch>>) {
    enum Act {
        None,
        Abort(String),
        SendHandoff(String, String),
        Done { to: String, amount: f64, got: Option<f64> },
        Deliver(String, Pending),
    }
    let act = {
        let mut g = state.lock().await;
        let now = Instant::now();
        let duty = g.queue.duty().map(|s| s.to_string());
        let mut act = Act::None;
        if let Some(h) = g.handoff.as_ref() {
            let both = duty.as_ref().map(|d| g.ready.contains(d)).unwrap_or(false) && g.ready.contains(&h.to);
            if let Some(amount) = h.sent_amount {
                // перевод ушёл: ждём, пока получатель увидит «получено»
                if let Some(got) = h.received {
                    act = Act::Done { to: h.to.clone(), amount, got: Some(got) };
                } else if h.sent_at.map_or(false, |t| t.elapsed() > RECEIPT_WAIT) {
                    act = Act::Done { to: h.to.clone(), amount, got: None };
                }
            } else if let Some(sent) = h.sent_at {
                if sent.elapsed() > HANDOFF_DONE_TIMEOUT {
                    act = Act::Abort("передача остатка не подтвердилась".into());
                }
            } else if h.started.elapsed() > HANDOFF_READY_TIMEOUT {
                act = Act::Abort("участники передачи не зашли за отведённое время".into());
            } else if both && h.not_before.map_or(true, |t| now >= t) {
                act = Act::SendHandoff(duty.clone().unwrap_or_default(), h.to.clone());
            }
        } else if g.in_flight.is_none() {
            let block = g.rotate_block_until.map_or(false, |t| now < t);
            if g.queue.rotation_due() && !block {
                if let Some(to) = g.queue.next().map(|s| s.to_string()) {
                    info!("{} выдачи у {} → третий перевод {to}", rotation::PAYS_BEFORE_ROTATE, duty.clone().unwrap_or_default());
                    g.handoff = Some(Handoff::new(to));
                    save_state(&g);
                }
            } else if let Some(d) = duty.clone() {
                if g.ready.contains(&d) {
                    let pos = g.pending.iter().position(|p| p.not_before.map_or(true, |t| now >= t));
                    if let Some(i) = pos {
                        let job = g.pending.remove(i).unwrap();
                        g.in_flight = Some(job.order_id.clone());
                        act = Act::Deliver(d, job);
                    }
                }
            }
        }
        act
    };
    match act {
        Act::None => {}
        Act::Abort(why) => {
            let mut g = state.lock().await;
            warn!("передача остатка отменена: {why}; держатель остаётся, повтор через {} мин", HANDOFF_BLOCK.as_secs() / 60);
            ledger(&g.farm_root, json!({ "ev": "handoff_abort", "from": g.queue.duty(), "why": why }));
            g.handoff = None;
            g.rotate_block_until = Some(Instant::now() + HANDOFF_BLOCK);
            save_state(&g);
        }
        Act::Done { to, amount, got } => {
            let duty = state.lock().await.queue.duty().map(|s| s.to_string()).unwrap_or_default();
            let ok = got.map_or(false, |g| g >= amount * VERIFY_TOLERANCE);
            if ok {
                info!("{to}: получил {} от {duty}", fmt_money(got.unwrap_or(0.0)));
            } else {
                warn!("{to}: не подтвердил получение {} от {duty} (получено: {}) — см. ledger.jsonl", fmt_money(amount), got.map(fmt_money).unwrap_or_else(|| "нет сообщения".into()));
            }
            {
                let g = state.lock().await;
                ledger(&g.farm_root, json!({
                    "ev": if ok { "handoff_ok" } else { "handoff_mismatch" },
                    "from": duty, "to": to, "sent": amount, "received": got,
                }));
            }
            // отправитель уже пуст: в любом случае передаём очередь, расхождение остаётся в журнале
            let _ = finish_rotate(state, &duty).await;
        }
        Act::SendHandoff(duty, to) => {
            info!("{duty}: передаю остаток → {to}");
            let ok = send_cmd(state, &duty, &OrchCmd::Handoff { to }).await.is_ok();
            let mut g = state.lock().await;
            if let Some(h) = g.handoff.as_mut() {
                if ok {
                    h.sent_at = Some(Instant::now());
                } else {
                    h.not_before = Some(Instant::now() + HANDOFF_RETRY_GAP);
                }
            }
        }
        Act::Deliver(duty, job) => {
            info!("заказ {} → {duty}", &job.order_id[..job.order_id.len().min(8)]);
            let cmd = OrchCmd::Deliver {
                order_id: job.order_id.clone(),
                nick: job.nick.clone(),
                amount: job.amount,
            };
            if send_cmd(state, &duty, &cmd).await.is_err() {
                let mut g = state.lock().await;
                g.in_flight = None;
                g.pending.push_front(job);
            }
        }
    }
}

/// Подтверждения выдачи не было → перевода не было → пробуем ещё раз (до MAX_DELIVERY_TRIES).
/// `true` — заказ вернулся в очередь, `false` — попытки кончились.
fn requeue(g: &mut Orch, oid: &str) -> bool {
    g.in_flight = None;
    let n = g.attempts.entry(oid.to_string()).or_insert(0);
    *n += 1;
    if *n >= MAX_DELIVERY_TRIES {
        return false;
    }
    if let Some(mut job) = g.jobs.get(oid).cloned() {
        job.not_before = Some(Instant::now() + RETRY_DELAY);
        warn!("заказ {}: подтверждения выдачи не было — повтор {}/{} через {} с", &oid[..oid.len().min(8)], *n + 1, MAX_DELIVERY_TRIES, RETRY_DELAY.as_secs());
        g.pending.push_front(job);
        true
    } else {
        false
    }
}

fn fmt_money(v: f64) -> String {
    if v.is_nan() {
        return "?".into();
    }
    format!("{:.1}kk", v / 1_000_000.0)
}

/// Воркер завершился (сам, по idle_quit или упал).
async fn on_worker_exit(state: &Arc<Mutex<Orch>>, nick: &str) {
    let gave_up = {
        let mut g = state.lock().await;
        g.workers.remove(nick);
        g.ready.remove(nick);
        // держатель умер посреди выдачи: подтверждения «отправлено» не было, значит перевода не было — повторяем
        if g.queue.duty() == Some(nick) {
            if let Some(oid) = g.in_flight.clone() {
                warn!("{nick}: воркер умер во время выдачи {}", &oid[..oid.len().min(8)]);
                if requeue(&mut g, &oid) { None } else { Some(oid) }
            } else {
                None
            }
        } else {
            None
        }
    };
    if let Some(oid) = gave_up {
        give_up(state, &oid, "max_retries").await;
    } else {
        warn!("{nick}: воркер завершился");
    }
}

/// Попытки кончились: сообщаем PlayerOK, что заказ не выдан.
async fn give_up(state: &Arc<Mutex<Orch>>, oid: &str, reason: &str) {
    {
        let mut g = state.lock().await;
        g.jobs.remove(oid);
        g.attempts.remove(oid);
        ledger(&g.farm_root, json!({ "ev": "delivery_gave_up", "order": oid, "reason": reason }));
    }
    emit_sell(state, json!({ "type": "delivery_failed", "orderId": oid, "reason": reason })).await;
}

async fn spawn_one(
    state: Arc<Mutex<Orch>>,
    restart_tx: mpsc::UnboundedSender<String>,
    username: String,
) -> Result<()> {
    let (boot, bin) = {
        let g = state.lock().await;
        if g.workers.contains_key(&username) {
            return Ok(());
        }
        let rt = g.bots.get(&username).context("unknown bot")?;
        let boot = BotBoot {
            username: rt.cfg.username.clone(),
            password: rt.cfg.password.clone(),
            anarchy: if rt.cfg.anarchy == 0 {
                g.anarchy
            } else {
                rt.cfg.anarchy
            },
            item: "sell".into(),
            go_type: "netherite-1.21".into(),
            proxy: rt.cfg.proxy.clone(),
            server: "mc.funtime.su".into(),
            my_nick: None,
            owner_nick: None,
            owner_reason: None,
            treasurer_nick: None,
        };
        (boot, g.bot_bin.clone())
    };
    if !bin.is_file() {
        bail!("нет {} — cargo build -p bot --release", bin.display());
    }
    pretty_log::line(&username, LineKind::Info, "spawn");
    let mut child = Command::new(&bin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()?;
    let mut stdin = child.stdin.take().context("stdin")?;
    let stdout = child.stdout.take().context("stdout")?;
    let line = serde_json::to_string(&boot)? + "\n";
    stdin.write_all(line.as_bytes()).await?;
    stdin.flush().await?;
    {
        let mut g = state.lock().await;
        g.last_spawn.insert(username.clone(), Instant::now());
        g.workers.insert(username.clone(), WorkerHandle { child, stdin });
    }
    let st = state.clone();
    let uname = username.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if let Err(e) = on_worker_line(&st, &uname, &line).await {
                warn!("{uname}: worker line: {e:#}");
            }
        }
        let _ = restart_tx.send(uname);
    });
    Ok(())
}
async fn send_cmd(state: &Arc<Mutex<Orch>>, nick: &str, cmd: &OrchCmd) -> Result<()> {
    let mut g = state.lock().await;
    let Some(w) = g.workers.get_mut(nick) else {
        bail!("нет воркера {nick}");
    };
    let line = serde_json::to_string(cmd)? + "\n";
    w.stdin.write_all(line.as_bytes()).await?;
    w.stdin.flush().await?;
    Ok(())
}

async fn on_worker_line(state: &Arc<Mutex<Orch>>, username: &str, line: &str) -> Result<()> {
    let line = line.trim();
    if line.is_empty() {
        return Ok(());
    }
    if line.starts_with('"') {
        pretty_log::line(username, LineKind::Info, line.trim_matches('"'));
        return Ok(());
    }
    let msg: WorkerMsg = match serde_json::from_str(line) {
        Ok(m) => m,
        Err(_) => {
            pretty_log::line(username, LineKind::Info, line);
            return Ok(());
        }
    };
    match msg.name.as_str() {
        "funauth_verified" => {
            let (farm, first) = {
                let mut g = state.lock().await;
                if let Some(rt) = g.bots.get_mut(username) {
                    rt.bound = Some(true);
                }
                let first = g.ready.insert(username.to_string());
                (g.farm_root.clone(), first)
            };
            save_binding(&farm, username, true);
            if first {
                info!("{username}: на анархии, готов");
            }
            if let Some(tx) = state.lock().await.go_out.clone() {
                let an = state.lock().await.anarchy;
                let _ = tx.send(json!({
                    "action": "funauth_verified",
                    "anarchy": an,
                    "nick": username,
                }));
            }
        }
        "funauth_bind" | "funauth_2fa" | "auth_fault" => {
            let (farm, go, pw, an) = {
                let mut g = state.lock().await;
                if let Some(rt) = g.bots.get_mut(username) {
                    rt.bound = Some(false);
                }
                g.ready.remove(username);
                let (pw, an) = g
                    .bots
                    .get(username)
                    .map(|rt| (rt.cfg.password.clone(), if rt.cfg.anarchy == 0 { g.anarchy } else { rt.cfg.anarchy }))
                    .unwrap_or((String::new(), g.anarchy));
                (g.farm_root.clone(), g.go_out.clone(), pw, an)
            };
            save_binding(&farm, username, false);
            // как у фермы: просим Go привязать ник (Telegram-аккаунты Go), он сам не даёт запустить второй job на ник
            if let Some(tx) = go {
                match msg.name.as_str() {
                    "funauth_bind" if !pw.is_empty() => {
                        let _ = tx.send(json!({ "action": "funauth_bind", "nick": username, "password": pw, "anarchy": an }));
                        warn!("{username}: нужна привязка → Go (funauth_bind), перезайдёт через {} с", SPAWN_GAP.as_secs());
                    }
                    "funauth_2fa" => {
                        let _ = tx.send(json!({ "action": "funauth_2fa", "nick": username, "anarchy": an }));
                        warn!("{username}: нужен 2FA → Go (funauth_2fa), перезайдёт через {} с", SPAWN_GAP.as_secs());
                    }
                    _ => warn!("{username}: {} — Go не просим", msg.name),
                }
            } else {
                warn!("{username}: нужна привязка, но Go не подключён — перезайдёт через {} с", SPAWN_GAP.as_secs());
            }
        }
        "payment_received" => {
            let from = msg.extra.get("from").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let amount = msg.extra.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let mut g = state.lock().await;
            let duty = g.queue.duty().map(|s| s.to_string());
            if let Some(h) = g.handoff.as_mut() {
                if h.to == username && duty.as_deref().map_or(false, |d| d.eq_ignore_ascii_case(&from)) {
                    h.received = Some(h.received.unwrap_or(0.0) + amount);
                    info!("{username}: пришёл перевод от {from}: {}", fmt_money(amount));
                }
            }
        }
        "delivery_ok" => {
            let oid = msg
                .id
                .clone()
                .or_else(|| msg.extra.get("orderId").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .unwrap_or_default();
            {
                let mut g = state.lock().await;
                if g.in_flight.as_deref() == Some(oid.as_str()) {
                    g.in_flight = None;
                }
                g.jobs.remove(&oid);
                g.attempts.remove(&oid);
                if g.queue.duty() == Some(username) {
                    g.queue.on_delivery_ok();
                    if g.queue.order.len() < 2 && g.queue.pays >= rotation::PAYS_BEFORE_ROTATE {
                        g.queue.pays = 0; // единственный бот: некому передавать
                    }
                    info!("{username}: выдач {}/{}", g.queue.pays, rotation::PAYS_BEFORE_ROTATE);
                }
                save_state(&g);
                ledger(&g.farm_root, json!({
                    "ev": "delivery_ok", "bot": username, "order": oid,
                    "nick": msg.extra.get("nick"), "amount_kk": msg.extra.get("amountKk"),
                }));
            }
            emit_sell(
                state,
                json!({ "type": "delivery_ok", "orderId": oid, "nick": msg.extra.get("nick") }),
            )
            .await;
        }
        "delivery_failed" => {
            let oid = msg.id.clone().unwrap_or_default();
            let reason = msg.reason.clone().unwrap_or_else(|| "fail".into());
            // «timeout» = подтверждения выдачи не было и баланс не упал: перевода не было, пробуем снова
            if reason == "timeout" {
                let again = {
                    let mut g = state.lock().await;
                    if g.in_flight.as_deref() == Some(oid.as_str()) { requeue(&mut g, &oid) } else { false }
                };
                if again {
                    return Ok(());
                }
                give_up(state, &oid, "max_retries").await;
                return Ok(());
            }
            {
                let mut g = state.lock().await;
                if g.in_flight.as_deref() == Some(oid.as_str()) {
                    g.in_flight = None;
                }
                g.jobs.remove(&oid);
                g.attempts.remove(&oid);
            }
            let typ = match reason.as_str() {
                "player_offline" | "offline" => "player_offline",
                "invalid_nick" => "invalid_nick",
                _ => "delivery_failed",
            };
            emit_sell(
                state,
                json!({ "type": typ, "orderId": oid, "reason": reason }),
            )
            .await;
        }
        "handoff_done" => {
            let ok = msg.extra.get("ok").and_then(|v| v.as_bool()).unwrap_or(false);
            let amount = msg.extra.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0);
            if ok {
                info!("{username}: перевод остатка ушёл ({}) — сверяю у получателя", fmt_money(amount));
                if amount <= 0.0 {
                    // нечего переводить (у держателя пусто): сверять нечего
                    finish_rotate(state, username).await?;
                } else {
                    let mut g = state.lock().await;
                    if let Some(h) = g.handoff.as_mut() {
                        h.sent_amount = Some(amount);
                    }
                }
            } else {
                let mut g = state.lock().await;
                let abort = if let Some(h) = g.handoff.as_mut() {
                    h.tries += 1;
                    h.sent_at = None;
                    h.not_before = Some(Instant::now() + HANDOFF_RETRY_GAP);
                    h.tries >= HANDOFF_MAX_TRIES
                } else {
                    false
                };
                warn!("{username}: передача остатка не удалась");
                ledger(&g.farm_root, json!({ "ev": "handoff_fail", "from": username, "bal": amount }));
                if abort {
                    warn!("передача остатка: {HANDOFF_MAX_TRIES} неудачи подряд — отмена, повтор через {} мин", HANDOFF_BLOCK.as_secs() / 60);
                    g.handoff = None;
                    g.rotate_block_until = Some(Instant::now() + HANDOFF_BLOCK);
                    save_state(&g);
                }
            }
        }
        "idle_quit" => {
            let mut g = state.lock().await;
            let bound = g.bots.get(username).map(is_bound).unwrap_or(false);
            if bound && !needed(&g).contains(username) {
                info!("{username}: дел нет → выход");
                if let Some(mut w) = g.workers.remove(username) {
                    let _ = w.child.start_kill();
                }
                g.ready.remove(username);
            }
        }
        "success" => pretty_log::line(username, LineKind::Ok, "на анархии"),
        _ => {}
    }
    Ok(())
}

/// Остаток ушёл следующему: он становится держателем, бывший уходит в конец и офлайн.
async fn finish_rotate(state: &Arc<Mutex<Orch>>, old: &str) -> Result<()> {
    let mut g = state.lock().await;
    let now = session::now_unix_ms();
    g.queue.rotate(now);
    g.handoff = None;
    g.rotate_block_until = None;
    save_state(&g);
    info!(
        "держатель → {} · передач всего {} · порядок: {}",
        g.queue.duty().unwrap_or("?"),
        g.queue.shift_no,
        g.queue.order.join(" → ")
    );
    if g.bots.get(old).map(is_bound).unwrap_or(false) {
        if let Some(mut w) = g.workers.remove(old) {
            let _ = w.child.start_kill();
        }
        g.ready.remove(old);
    }
    Ok(())
}

async fn emit_sell(state: &Arc<Mutex<Orch>>, ev: Value) {
    let payload = json!({ "type": "bot_event", "event": ev }).to_string();
    let txs: Vec<_> = {
        let g = state.lock().await;
        g.client_tx.values().cloned().collect()
    };
    for tx in txs {
        let _ = tx.send(payload.clone());
    }
}

fn spawn_sell_ws(state: Arc<Mutex<Orch>>) {
    tokio::spawn(async move {
        let listener = match TcpListener::bind("0.0.0.0:8790").await {
            Ok(l) => l,
            Err(e) => {
                warn!("WS 8790: {e}");
                return;
            }
        };
        info!("sell ws://0.0.0.0:8790");
        loop {
            let Ok((stream, _)) = listener.accept().await else { continue };
            let st = state.clone();
            tokio::spawn(async move {
                let Ok(ws) = accept_async(stream).await else { return };
                let (mut sink, mut src) = ws.split();
                let (tx, mut rx) = mpsc::unbounded_channel::<String>();
                let id = {
                    let mut g = st.lock().await;
                    let id = g.next_client;
                    g.next_client += 1;
                    g.client_tx.insert(id, tx);
                    g.sell_clients.insert(id);
                    id
                };
                let write = async {
                    while let Some(msg) = rx.recv().await {
                        if sink.send(Message::Text(msg.into())).await.is_err() {
                            break;
                        }
                    }
                };
                let read = async {
                    while let Some(Ok(Message::Text(t))) = src.next().await {
                        if let Ok(v) = serde_json::from_str::<Value>(&t) {
                            on_sell_msg(&st, v).await;
                        }
                    }
                };
                tokio::select! { _ = write => {}, _ = read => {} }
                let mut g = st.lock().await;
                g.client_tx.remove(&id);
                g.sell_clients.remove(&id);
            });
        }
    });
}


async fn on_sell_msg(state: &Arc<Mutex<Orch>>, msg: Value) {
    let typ = msg.get("type").and_then(|v| v.as_str()).unwrap_or("");
    if typ == "register" {
        info!("poll подключился");
        return;
    }
    let oid = msg.get("orderId").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let nick = msg.get("nick").and_then(|v| v.as_str()).unwrap_or("").to_string();
    match typ {
        "order" => {
            let amount = msg.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let mut g = state.lock().await;
            if g.in_flight.as_deref() == Some(oid.as_str()) || g.pending.iter().any(|p| p.order_id == oid) {
                return;
            }
            info!("заказ {} · {nick} · {amount} kk → в очередь (ждёт: {})", &oid[..oid.len().min(8)], g.pending.len() + 1);
            let job = Pending { order_id: oid.clone(), nick, amount, not_before: None };
            g.jobs.insert(oid, job.clone());
            g.pending.push_back(job);
            save_state(&g);
        }
        "nick_update" => {
            let in_flight_to = {
                let mut g = state.lock().await;
                if let Some(j) = g.jobs.get_mut(&oid) {
                    j.nick = nick.clone();
                }
                if let Some(p) = g.pending.iter_mut().find(|p| p.order_id == oid) {
                    p.nick = nick.clone();
                    None
                } else if g.in_flight.as_deref() == Some(oid.as_str()) {
                    g.queue.duty().map(|s| s.to_string())
                } else {
                    None
                }
            };
            if let Some(duty) = in_flight_to {
                let _ = send_cmd(state, &duty, &OrchCmd::NickUpdate { order_id: oid, nick }).await;
            }
        }
        "cancel_order" => {
            let in_flight_to = {
                let mut g = state.lock().await;
                let before = g.pending.len();
                g.pending.retain(|p| p.order_id != oid);
                g.jobs.remove(&oid);
                g.attempts.remove(&oid);
                if g.pending.len() != before {
                    save_state(&g);
                    None
                } else if g.in_flight.as_deref() == Some(oid.as_str()) {
                    g.queue.duty().map(|s| s.to_string())
                } else {
                    None
                }
            };
            if let Some(duty) = in_flight_to {
                let _ = send_cmd(state, &duty, &OrchCmd::CancelOrder { order_id: oid }).await;
            }
        }
        _ => {}
    }
}

fn spawn_go(state: Arc<Mutex<Orch>>) -> mpsc::UnboundedSender<Value> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Value>();
    tokio::spawn(async move {
        loop {
            let url = state.lock().await.go_ws.clone();
            match connect_async(&url).await {
                Ok((ws, _)) => {
                    info!("Go WS {url}");
                    let (mut sink, mut src) = ws.split();
                    let mut fleet = fleet_msg(&state).await;
                    let _ = sink.send(Message::Text(fleet.to_string().into())).await;
                    loop {
                        tokio::select! {
                            Some(v) = rx.recv() => {
                                if sink.send(Message::Text(v.to_string().into())).await.is_err() {
                                    break;
                                }
                            }
                            m = src.next() => {
                                if m.is_none() { break; }
                            }
                            _ = sleep(Duration::from_secs(20)) => {
                                fleet = fleet_msg(&state).await;
                                if sink.send(Message::Text(fleet.to_string().into())).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                }
                Err(e) => warn!("Go WS: {e}"),
            }
            sleep(Duration::from_secs(5)).await;
        }
    });
    tx
}

async fn fleet_msg(state: &Arc<Mutex<Orch>>) -> Value {
    let g = state.lock().await;
    let bots: Vec<Value> = g
        .bots
        .values()
        .map(|rt| {
            json!({
                "username": rt.cfg.username,
                "anarchy": if rt.cfg.anarchy == 0 { g.anarchy } else { rt.cfg.anarchy },
                "banned": false,
                "go_type": "netherite-1.21",
                "success": g.workers.contains_key(&rt.cfg.username),
            })
        })
        .collect();
    json!({ "action": "fleet", "bots": bots, "types": ["netherite-1.21"] })
}

