//! Оркестратор выдачи: очередь ботов, WS для poll (порт 8790), Go для привязки.
//! Боты офлайн, пока нет дела. Приходит заказ — заходит держатель денег (`order[0]`), выдаёт `/pay`.
//! После 2 выдач покупателям он третьим переводом отдаёт остаток следующему (тот заходит только
//! принять) и уходит в конец очереди. Времени смены нет, лимит только по числу переводов.
//! Непривязанные перезаходят снова и снова (раз в SPAWN_GAP), пока их не привяжут.

mod config;
mod rotation;
mod session;
mod topup;

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

const HANDOFF_RETRY_GAP: Duration = Duration::from_secs(15);
const HANDOFF_MAX_TRIES: u32 = 3;
/// После неудачной передачи не пробуем снова столько. Выдачи с этого ника всё равно нет,
/// пока остаток не уйдёт следующему.
const HANDOFF_BLOCK: Duration = Duration::from_secs(30);
/// Бот не смог зайти (2FA/привязка/пароль/прокси) — столько не выбираем его получателем передачи.
const LOGIN_FAIL_SKIP: Duration = Duration::from_secs(30 * 60);

impl Orch {
    /// Нельзя брать получателем передачи: забанен или недавно не смог зайти (и с тех пор не заходил).
    fn unusable(&self, n: &str) -> bool {
        self.bans.contains_key(n)
            || self.stuck_2fa.contains(n)
            || (!self.ready.contains(n)
                && self.login_fail.get(n).map_or(false, |t| t.elapsed() < LOGIN_FAIL_SKIP))
    }

    /// Кому отдать остаток. Передача обязана состояться: сначала бот, который недавно заходил нормально;
    /// если таких нет — любой не забаненный и без 2FA, даже с недавней неудачей входа (попробуем ещё раз).
    /// `None` только когда все остальные забанены или ждут 2FA.
    fn handoff_target(&self) -> Option<String> {
        self.queue
            .next_alive(&|n| self.unusable(n))
            .or_else(|| self.queue.next_alive(&|n| self.bans.contains_key(n) || self.stuck_2fa.contains(n)))
            .map(|s| s.to_string())
    }
}
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
    /// Обычная смена: `None` = отправитель текущий держатель. Спасение залипших денег: `Some(nick)`.
    from: Option<String>,
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
        Self {
            to,
            from: None,
            started: Instant::now(),
            sent_at: None,
            not_before: None,
            tries: 0,
            sent_amount: None,
            received: None,
        }
    }

    fn rescue(from: String, to: String) -> Self {
        Self {
            to,
            from: Some(from),
            started: Instant::now(),
            sent_at: None,
            not_before: None,
            tries: 0,
            sent_amount: None,
            received: None,
        }
    }

    fn sender<'a>(&'a self, duty: Option<&'a str>) -> Option<&'a str> {
        self.from.as_deref().or(duty)
    }
}

/// Допуск при сверке суммы (округление).
const VERIFY_TOLERANCE: f64 = 0.98;
/// Меньше — не принимаем «успешную» передачу (ошибка чтения баланса, как 1 монета).
const MIN_HANDOFF_ACCEPT: f64 = 2_000_000.0;
/// Перевод ушёл, а сообщения «получено» нет столько секунд — всё равно передаём очередь (отправитель пуст).
const RECEIPT_WAIT: Duration = Duration::from_secs(60);

/// Журнал денег: каждая выдача и передача (одна строка JSON). Нужен, чтобы после сбоя понять, где деньги.
/// id заказов с `delivery_ok` в ledger.jsonl.
fn load_delivered(farm: &Path) -> HashSet<String> {
    let mut out = HashSet::new();
    if let Ok(raw) = std::fs::read_to_string(farm.join("ledger.jsonl")) {
        for line in raw.lines() {
            if let Ok(v) = serde_json::from_str::<Value>(line) {
                if v.get("ev").and_then(|x| x.as_str()) == Some("delivery_ok") {
                    if let Some(o) = v.get("order").and_then(|x| x.as_str()) {
                        if !o.is_empty() {
                            out.insert(o.to_string());
                        }
                    }
                }
            }
        }
    }
    out
}

/// Одноразовый триггер без Go: `sellbot-rust/rescue.pending.json` → `{"from":"…","to":"…"}` (to опционален).
fn take_rescue_pending(farm: &Path) -> Option<(String, String)> {
    let p = farm.join("rescue.pending.json");
    let raw = std::fs::read_to_string(&p).ok()?;
    let _ = std::fs::remove_file(&p);
    let v: Value = serde_json::from_str(&raw).ok()?;
    let from = v.get("from")?.as_str()?.trim().to_string();
    if from.is_empty() {
        return None;
    }
    let to = v
        .get("to")
        .and_then(|x| x.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    Some((from, to.unwrap_or_default()))
}

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
    handoff_aborts: u32,
    /// Когда последний раз запускали воркера (чтобы непривязанные не переподключались чаще раза в SPAWN_GAP).
    last_spawn: HashMap<String, Instant>,
    sell_clients: HashSet<usize>,
    next_client: usize,
    client_tx: HashMap<usize, mpsc::UnboundedSender<String>>,
    go_out: Option<mpsc::UnboundedSender<Value>>,
    /// Последний известный баланс каждого бота: ник → (сумма, unix мс). Хранится в balances.json, чтобы пережить перезапуск.
    balances: HashMap<String, (f64, u64)>,
    /// Кнопка «принять перевод» во вкладке Go: держатель сидит онлайн, пока ему не придёт перевод.
    wait_pay: Option<WaitPay>,
    /// Последний принятый держателем перевод (для вкладки): ник, от кого, сколько, когда.
    last_payment: Option<(String, String, f64, u64)>,
    /// Забаненные на FunTime боты выдачи: ник → (причина, unix мс). Показываются на странице банов в Go.
    bans: HashMap<String, (String, u64)>,
    /// Сбои входа: ник → (kind: proxy_error | bad_password, причина, unix мс).
    faults: HashMap<String, (String, String, u64)>,
    /// Последний неудачный вход (нужен 2FA / привязка / пароль / прокси). Такого бота не берём
    /// получателем передачи остатка `LOGIN_FAIL_SKIP` или пока он не зайдёт (`funauth_verified`).
    login_fail: HashMap<String, Instant>,
    /// Уже выданные заказы (из ledger.jsonl + текущий запуск). Повторно присланный такой заказ
    /// не платим второй раз, а сразу подтверждаем выдачу poll'у (его delivery_ok мог потеряться).
    delivered: HashSet<String>,
    /// FunTime просит подтвердить вход через Telegram (2FA), а Go не знает его Telegram-аккаунт:
    /// бот привязан, но зайти не может. Не запускаем и не берём в ротацию, пока не зайдёт сам
    /// (рестарт sell-orch даёт одну попытку) или ник не заменят.
    stuck_2fa: HashSet<String>,
    /// Когда заказ впервые увидели в очереди на выдачу; уведомление «бот решает капчу» шлём один раз на заказ.
    wait_seen: HashMap<String, Instant>,
    wait_notified: HashSet<String>,
    /// Пополнение анархий фермы (настройки и список анархий присылает Go).
    topup_cfg: topup::Cfg,
    /// Идущее сейчас пополнение: держатель заходит на анархию фермы и платит казначею.
    topup: Option<topup::Job>,
    /// До какого момента не пополняем анархию снова.
    topup_cool: HashMap<u16, Instant>,
    /// Последние пополнения для панели.
    topup_log: VecDeque<Value>,
}

struct WaitPay {
    since_ms: u64,
    nick: String,
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

    let balances0 = load_balances(&farm);
    let bans0 = load_bans(&farm);
    let delivered0 = load_delivered(&farm);

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
        handoff_aborts: 0,
        last_spawn: HashMap::new(),
        sell_clients: HashSet::new(),
        next_client: 0,
        client_tx: HashMap::new(),
        go_out: None,
        balances: balances0,
        wait_pay: None,
        last_payment: None,
        bans: bans0,
        faults: HashMap::new(),
        login_fail: HashMap::new(),
        delivered: delivered0,
        stuck_2fa: HashSet::new(),
        wait_seen: HashMap::new(),
        wait_notified: HashSet::new(),
        topup_cfg: topup::Cfg::default(),
        topup: None,
        topup_cool: HashMap::new(),
        topup_log: VecDeque::new(),
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
                topup_tick(&st).await;
                notify_waiting(&st).await;
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
        .filter(|(n, rt)| rt.bound != Some(true) && !g.bans.contains_key(*n))
        .map(|(n, _)| n.clone())
        .collect();
    if let Some(duty) = g.queue.duty() {
        // баланс держателя неизвестен (первый запуск): один раз заходим, чтобы вкладка «Автопродажа» его показала
        let unknown_balance = !g.balances.contains_key(duty);
        if unknown_balance || g.wait_pay.is_some() || !g.pending.is_empty() || g.in_flight.is_some() || g.handoff.is_some() || g.topup.is_some() {
            out.insert(duty.to_string());
        }
    }
    if let Some(h) = &g.handoff {
        out.insert(h.to.clone());
        if let Some(from) = h.from.as_ref() {
            out.insert(from.clone());
        }
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
        SendHandoff(String, String),
        Done { to: String, amount: f64, got: Option<f64> },
        Deliver(String, Pending),
    }
    let act = {
        let mut g = state.lock().await;
        let now = Instant::now();
        let duty = g.queue.duty().map(|s| s.to_string());
        let mut act = Act::None;
        if g.handoff.is_none() {
            if let Some((from, mut to)) = take_rescue_pending(&g.farm_root) {
                if to.is_empty() {
                    to = g.queue.duty().map(|s| s.to_string()).unwrap_or_default();
                }
                if !from.is_empty() && to != from && g.bots.contains_key(&from) {
                    info!("rescue.pending: {from} → {to}");
                    ledger(&g.farm_root, json!({ "ev": "rescue_start", "from": from, "to": to, "via": "file" }));
                    g.handoff = Some(Handoff::rescue(from.clone(), to));
                    save_state(&g);
                }
            }
        }
        if let Some(h) = g.handoff.as_ref() {
            let sender = h.sender(duty.as_deref()).map(|s| s.to_string());
            let both = sender.as_ref().map(|s| g.ready.contains(s)).unwrap_or(false) && g.ready.contains(&h.to);
            if let Some(amount) = h.sent_amount {
                // перевод ушёл: ждём, пока получатель увидит «получено»
                if let Some(got) = h.received {
                    act = Act::Done { to: h.to.clone(), amount, got: Some(got) };
                } else if h.sent_at.map_or(false, |t| t.elapsed() > RECEIPT_WAIT) {
                    act = Act::Done { to: h.to.clone(), amount, got: None };
                }
            } else if h.sent_at.is_none() && both && h.not_before.map_or(true, |t| now >= t) {
                if let Some(from) = sender {
                    act = Act::SendHandoff(from, h.to.clone());
                }
            }
        } else if g.in_flight.is_none() {
            let block = g.rotate_block_until.map_or(false, |t| now < t);
            let next_alive = g.handoff_target();
            if g.queue.rotation_due() && !block && next_alive.is_some() {
                if let Some(to) = next_alive {
                    info!("{} выдачи у {} → третий перевод {to}", rotation::PAYS_BEFORE_ROTATE, duty.clone().unwrap_or_default());
                    g.handoff = Some(Handoff::new(to));
                    save_state(&g);
                }
            } else if let Some(d) = duty.clone() {
                // Две выдачи уже были — с этого ника больше не платим, пока остаток не уйдёт следующему.
                // Без исключений: даже если принять остаток сейчас некому, третью выдачу не делаем.
                let worn_out = g.queue.limit_reached();
                if worn_out && next_alive.is_none() && !g.pending.is_empty() {
                    warn!("лимит выдач у {d} исчерпан, а принять остаток некому (все остальные забанены или ждут 2FA) — заказы ждут");
                }
                if worn_out && !g.pending.is_empty() {
                    warn_once_worn(&d);
                }
                // Пока держатель на анархии фермы (пополнение), заказы покупателям ему не отдаём: он не там.
                if g.ready.contains(&d) && !worn_out && g.topup.is_none() {
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
        Act::Done { to, amount, got } => {
            let (duty, sender, rescue) = {
                let g = state.lock().await;
                let duty = g.queue.duty().map(|s| s.to_string()).unwrap_or_default();
                let sender = g
                    .handoff
                    .as_ref()
                    .and_then(|h| h.sender(g.queue.duty()))
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| duty.clone());
                let rescue = g.handoff.as_ref().and_then(|h| h.from.clone());
                (duty, sender, rescue)
            };
            let mut ok = got.map_or(false, |g| g >= amount * VERIFY_TOLERANCE);
            if ok && amount > 0.0 && amount < MIN_HANDOFF_ACCEPT {
                warn!(
                    "передача остатка: подозрительно мало ({}) — не считаем успехом",
                    fmt_money(amount)
                );
                ok = false;
            }
            if ok {
                info!("{to}: получил {} от {sender}", fmt_money(got.unwrap_or(0.0)));
            } else {
                warn!(
                    "{to}: не подтвердил получение {} от {sender} (получено: {}) — см. ledger.jsonl",
                    fmt_money(amount),
                    got.map(fmt_money).unwrap_or_else(|| "нет сообщения".into())
                );
            }
            {
                let g = state.lock().await;
                ledger(
                    &g.farm_root,
                    json!({
                        "ev": if ok { "handoff_ok" } else { "handoff_mismatch" },
                        "from": sender,
                        "to": to,
                        "sent": amount,
                        "received": got,
                        "rescue": rescue.is_some(),
                    }),
                );
            }
            if rescue.is_some() {
                if ok {
                    let _ = finish_rescue(state, &sender).await;
                } else {
                    let mut g = state.lock().await;
                    g.handoff = None;
                    save_state(&g);
                }
            } else {
                // отправитель уже пуст: в любом случае передаём очередь, расхождение остаётся в журнале
                let _ = finish_rotate(state, &sender).await;
            }
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

/// Убрать воркера (он вернётся на основную анархию, когда понадобится).
fn kill_worker(g: &mut Orch, nick: &str) {
    if let Some(mut w) = g.workers.remove(nick) {
        let _ = w.child.start_kill();
        // не поднимаем заново раньше SPAWN_GAP: старый воркер должен успеть отчитаться об уходе
        g.last_spawn.insert(nick.to_string(), Instant::now());
    }
    g.ready.remove(nick);
}

/// Закрыть пополнение: пауза по анархии, запись для панели и в ledger, держатель уходит с анархии фермы.
/// Без `ok` и с причиной «пришёл заказ» / «выключено» паузу не ставим (это не сбой).
fn topup_close(g: &mut Orch, ok: bool, reason: &str) {
    let Some(job) = g.topup.take() else { return };
    let neutral = !ok && (reason == "пришёл заказ" || reason == "выключено");
    if !neutral {
        let pause = if ok { topup::COOLDOWN_OK } else { topup::COOLDOWN_FAIL };
        g.topup_cool.insert(job.anarchy, Instant::now() + pause);
    }
    let level = if ok { "ok" } else { "fail" };
    if ok {
        info!("пополнение an{}: {} → {} {}kk — готово", job.anarchy, job.duty, job.to, job.amount_kk);
    } else {
        warn!("пополнение an{} → {} не вышло: {reason}", job.anarchy, job.to);
    }
    g.topup_log.push_back(json!({
        "at": session::fmt_msk(session::now_unix_ms()),
        "anarchy": job.anarchy, "to": job.to, "amount_kk": job.amount_kk, "from": job.duty,
        "result": level, "reason": reason,
    }));
    while g.topup_log.len() > 8 {
        g.topup_log.pop_front();
    }
    ledger(&g.farm_root, json!({
        "ev": if ok { "topup_ok" } else { "topup_fail" },
        "from": job.duty, "to": job.to, "anarchy": job.anarchy, "amount_kk": job.amount_kk, "reason": reason,
    }));
    kill_worker(g, &job.duty);
}

/// Раз в секунду: начать пополнение анархии фермы или довести идущее.
async fn topup_tick(state: &Arc<Mutex<Orch>>) {
    let pay_job = {
        let mut g = state.lock().await;
        let now = Instant::now();
        let mut to_pay: Option<topup::Job> = None;
        if let Some(job) = g.topup.clone() {
            let duty = g.queue.duty().map(|s| s.to_string());
            if job.sent_at.is_some() {
                if job.sent_at.map_or(false, |t| now.duration_since(t) > topup::PAY_TIMEOUT) {
                    g.in_flight = None;
                    topup_close(&mut g, false, "нет ответа о переводе");
                }
            } else if !g.topup_cfg.enabled {
                topup_close(&mut g, false, "выключено");
            } else if !g.pending.is_empty() {
                topup_close(&mut g, false, "пришёл заказ");
            } else if duty.as_deref() != Some(job.duty.as_str()) || g.handoff.is_some() || g.queue.limit_reached() {
                topup_close(&mut g, false, "смена держателя или передача остатка");
            } else if now.duration_since(job.started) > topup::START_TIMEOUT {
                topup_close(&mut g, false, "держатель не зашёл на анархию");
            } else if g.ready.contains(&job.duty) && g.in_flight.is_none() {
                g.in_flight = Some(job.order_id.clone());
                if let Some(j) = g.topup.as_mut() {
                    j.sent_at = Some(now);
                }
                let mut sent_job = job;
                sent_job.sent_at = Some(now);
                to_pay = Some(sent_job);
            }
        } else {
            // начать: всё тихо, настройки свежие, есть кому платить и есть чем
            let cfg_ok = g.topup_cfg.enabled && g.topup_cfg.fresh(now) && !g.topup_cfg.targets.is_empty();
            let quiet = g.pending.is_empty()
                && g.in_flight.is_none()
                && g.handoff.is_none()
                && g.wait_pay.is_none()
                && g.rotate_block_until.map_or(true, |t| now >= t);
            if cfg_ok && quiet {
                if let Some(duty) = g.queue.duty().map(|s| s.to_string()) {
                    // после перевода дальше должна быть возможна передача остатка (лимит две выдачи)
                    let can_rotate = g.queue.pays + 1 < rotation::PAYS_BEFORE_ROTATE || g.handoff_target().is_some();
                    let bal = g.balances.get(&duty).map(|b| b.0);
                    if !g.queue.limit_reached()
                        && can_rotate
                        && !g.unusable(&duty)
                        && topup::enough_money(bal, g.topup_cfg.amount_kk)
                    {
                        if let Some(t) = topup::pick_target(&g.topup_cfg.targets, &g.topup_cool, now) {
                            let amount = g.topup_cfg.amount_kk;
                            let order_id = format!("{}{}-{}", topup::PREFIX, t.anarchy, session::now_unix_ms() / 1000);
                            info!("пополнение an{}: {duty} зайдёт и заплатит {} {amount}kk", t.anarchy, t.to);
                            ledger(&g.farm_root, json!({
                                "ev": "topup_start", "from": duty, "to": t.to, "anarchy": t.anarchy, "amount_kk": amount,
                            }));
                            g.topup = Some(topup::Job {
                                order_id,
                                anarchy: t.anarchy,
                                to: t.to,
                                amount_kk: amount,
                                duty: duty.clone(),
                                started: now,
                                sent_at: None,
                            });
                            // если держатель уже сидит на основной анархии — перезаходит на анархию фермы
                            kill_worker(&mut g, &duty);
                        }
                    }
                }
            }
        }
        to_pay
    };
    if let Some(job) = pay_job {
        topup_pay(state, job).await;
    }
}

async fn topup_pay(state: &Arc<Mutex<Orch>>, job: topup::Job) {
    info!("пополнение an{}: {} → {} {}kk", job.anarchy, job.duty, job.to, job.amount_kk);
    let cmd = OrchCmd::Deliver { order_id: job.order_id.clone(), nick: job.to.clone(), amount: job.amount_kk };
    if send_cmd(state, &job.duty, &cmd).await.is_err() {
        let mut g = state.lock().await;
        g.in_flight = None;
        topup_close(&mut g, false, "нет связи с воркером");
    }
}

/// Подтверждения выдачи не было → перевода не было → пробуем ещё раз (до MAX_DELIVERY_TRIES).
/// `true` — заказ вернулся в очередь, `false` — попытки кончились.
fn requeue(g: &mut Orch, oid: &str) -> bool {
    g.in_flight = None;
    if topup::is_topup(oid) {
        // перевод-пополнение повторно не шлём: просто закрываем (пауза до следующей попытки)
        topup_close(g, false, "воркер упал или бан во время перевода");
        return true;
    }
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
    let (boot, bin, handoff_party) = {
        let g = state.lock().await;
        if g.workers.contains_key(&username) {
            return Ok(());
        }
        // Участник передачи остатка (получатель или отправитель): боту нельзя сдаться после одного таймаута захода.
        let handoff_party = g.handoff.as_ref().map_or(false, |h| {
            h.to == username
                || h.from.as_deref() == Some(username.as_str())
                || (h.from.is_none() && g.queue.duty() == Some(username.as_str()))
        });
        let rt = g.bots.get(&username).context("unknown bot")?;
        let boot = BotBoot {
            username: rt.cfg.username.clone(),
            password: rt.cfg.password.clone(),
            anarchy: match &g.topup {
                // пополнение: держатель заходит сразу на анархию фермы
                Some(t) if g.queue.duty() == Some(username.as_str()) => t.anarchy,
                _ if rt.cfg.anarchy == 0 => g.anarchy,
                _ => rt.cfg.anarchy,
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
        (boot, g.bot_bin.clone(), handoff_party)
    };
    if !bin.is_file() {
        bail!("нет {} — cargo build -p bot --release", bin.display());
    }
    pretty_log::line(&username, LineKind::Info, "spawn");
    let mut cmd = Command::new(&bin);
    if handoff_party {
        cmd.env("SELL_BOOT_WAIT", "forever");
    }
    let mut child = cmd
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
                g.login_fail.remove(username);
                if g.stuck_2fa.remove(username) {
                    g.faults.remove(username);
                }
                (g.farm_root.clone(), first)
            };
            save_binding(&farm, username, true);
            if first {
                info!("{username}: на анархии, готов");
            }
            // не держим блокировку состояния в теле `if let`: повторный `lock()` внутри вешал весь оркестратор
            let (go, an) = {
                let g = state.lock().await;
                (g.go_out.clone(), g.anarchy)
            };
            if let Some(tx) = go {
                let _ = tx.send(json!({
                    "action": "funauth_verified",
                    "anarchy": an,
                    "nick": username,
                }));
            }
        }
        "banned" => {
            let reason = msg.reason.clone().unwrap_or_else(|| "бан".into());
            warn!("{username}: БАН на FunTime — {reason}");
            let gave_up = {
                let mut g = state.lock().await;
                g.bans.insert(username.to_string(), (reason.clone(), session::now_unix_ms()));
                save_bans(&g.farm_root, &g.bans);
                g.ready.remove(username);
                // Получатель передачи забанен — отменяем её сразу, следующий тик возьмёт другого.
                if g.handoff.as_ref().map_or(false, |h| h.to == username && h.sent_at.is_none()) {
                    warn!("{username}: получатель передачи забанен — выбираю следующего");
                    g.handoff = None;
                    g.rotate_block_until = None;
                    save_state(&g);
                }
                ledger(&g.farm_root, json!({ "ev": "bot_banned", "bot": username, "reason": reason }));
                let mut gave_up = None;
                if g.queue.duty() == Some(username) {
                    // Перевод остатка уже ушёл — дорабатывает обычная передача (подтверждение получателя → finish_rotate).
                    let transfer_sent = g.handoff.as_ref().map_or(false, |h| h.sent_at.is_some() || h.sent_amount.is_some());
                    if !transfer_sent {
                        // Забаненный держатель отдать остаток не может: роль сразу следующему, без передачи.
                        if let Some(oid) = g.in_flight.clone() {
                            warn!("{username}: бан посреди выдачи {} — заказ вернётся в очередь", &oid[..oid.len().min(8)]);
                            if !requeue(&mut g, &oid) {
                                gave_up = Some(oid);
                            }
                        }
                        g.handoff = None;
                        let now = session::now_unix_ms();
                        let skip: std::collections::HashSet<String> =
                            g.bans.keys().cloned().chain(g.stuck_2fa.iter().cloned()).collect();
                        g.queue.rotate_skipping(now, &|n| skip.contains(n));
                        g.rotate_block_until = None;
                        g.handoff_aborts = 0;
                        if let Some(mut w) = g.workers.remove(username) {
                            let _ = w.child.start_kill();
                        }
                        save_state(&g);
                        ledger(&g.farm_root, json!({
                            "ev": "duty_banned_rotate", "from": username,
                            "to": g.queue.duty().unwrap_or(""),
                        }));
                        warn!(
                            "держатель {username} забанен — роль без передачи остатка → {} · порядок: {}",
                            g.queue.duty().unwrap_or("?"),
                            g.queue.order.join(" → ")
                        );
                    }
                }
                gave_up
            };
            if let Some(oid) = gave_up {
                give_up(state, &oid, "max_retries").await;
            }
        }
        "proxy_ok" => {
            let mut g = state.lock().await;
            if g.faults.get(username).map_or(false, |f| f.0 == "proxy_error") {
                g.faults.remove(username);
                info!("{username}: прокси снова рабочий");
            }
        }
        "auth_fault" if msg.data.as_ref().and_then(|d| d.get("kind")).and_then(|k| k.as_str()) == Some("proxy_error") => {
            // сбой прокси ничего не говорит о привязке аккаунта: bound не трогаем, только показываем в Go
            let reason = msg.reason.clone().unwrap_or_default();
            warn!("{username}: прокси не работает — {reason}");
            let mut g = state.lock().await;
            g.faults.insert(username.to_string(), ("proxy_error".into(), reason, session::now_unix_ms()));
            mark_login_fail(&mut g, username);
        }
        "funauth_2fa" => {
            // Аккаунт ПРИВЯЗАН (иначе FunTime просил бы привязку), но вход надо подтвердить в Telegram.
            // Один раз просим Go подтвердить; бота больше не запускаем и не берём в очередь.
            let (go, an, first) = {
                let mut g = state.lock().await;
                if let Some(rt) = g.bots.get_mut(username) {
                    rt.bound = Some(true);
                }
                g.ready.remove(username);
                mark_login_fail(&mut g, username);
                let first = g.stuck_2fa.insert(username.to_string());
                g.faults.insert(
                    username.to_string(),
                    ("2fa".into(), "FunTime просит подтвердить вход через Telegram, а Telegram-аккаунт ника неизвестен".into(), session::now_unix_ms()),
                );
                let an = g.bots.get(username).map(|rt| if rt.cfg.anarchy == 0 { g.anarchy } else { rt.cfg.anarchy }).unwrap_or(g.anarchy);
                (g.go_out.clone(), an, first)
            };
            if first {
                if let Some(tx) = go {
                    let _ = tx.send(json!({ "action": "funauth_2fa", "nick": username, "anarchy": an }));
                }
                warn!("{username}: нужен 2FA через Telegram — бот исключён из очереди и не перезапускается (замени ник или подтверди вход)");
            }
        }
        "funauth_bind" | "auth_fault" => {
            let (farm, go, pw, an) = {
                let mut g = state.lock().await;
                if let Some(rt) = g.bots.get_mut(username) {
                    rt.bound = Some(false);
                }
                g.ready.remove(username);
                mark_login_fail(&mut g, username);
                let (pw, an) = g
                    .bots
                    .get(username)
                    .map(|rt| (rt.cfg.password.clone(), if rt.cfg.anarchy == 0 { g.anarchy } else { rt.cfg.anarchy }))
                    .unwrap_or((String::new(), g.anarchy));
                (g.farm_root.clone(), g.go_out.clone(), pw, an)
            };
            save_binding(&farm, username, false);
            if msg.name == "auth_fault" {
                let reason = msg.reason.clone().unwrap_or_default();
                state.lock().await.faults.insert(username.to_string(), ("bad_password".into(), reason, session::now_unix_ms()));
            }
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
        "balance" => {
            if let Some(b) = msg.balance {
                let now = session::now_unix_ms();
                let mut g = state.lock().await;
                g.balances.insert(username.to_string(), (b, now));
                save_balances(&g.farm_root, &g.balances);
            }
        }
        "payment_received" => {
            let from = msg.extra.get("from").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let amount = msg.extra.get("amount").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let mut g = state.lock().await;
            let duty = g.queue.duty().map(|s| s.to_string());
            if duty.as_deref() == Some(username) {
                g.last_payment = Some((username.to_string(), from.clone(), amount, session::now_unix_ms()));
                if g.wait_pay.take().is_some() {
                    info!("{username}: перевод получен ({}) — кнопка «принять перевод» снята", fmt_money(amount));
                    ledger(&g.farm_root, json!({ "ev": "wait_pay_done", "nick": username, "from": from, "amount": amount }));
                }
            }
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
            if topup::is_topup(&oid) {
                // пополнение анархии фермы: считается выдачей держателя, но покупателю/poll ничего не шлём
                let mut g = state.lock().await;
                if g.in_flight.as_deref() == Some(oid.as_str()) {
                    g.in_flight = None;
                }
                if g.queue.duty() == Some(username) {
                    g.queue.on_delivery_ok();
                    info!("{username}: выдач {}/{} (пополнение)", g.queue.pays, rotation::PAYS_BEFORE_ROTATE);
                }
                topup_close(&mut g, true, "");
                save_state(&g);
                return Ok(());
            }
            {
                let mut g = state.lock().await;
                if g.in_flight.as_deref() == Some(oid.as_str()) {
                    g.in_flight = None;
                }
                g.jobs.remove(&oid);
                g.attempts.remove(&oid);
                if !oid.is_empty() {
                    g.delivered.insert(oid.clone());
                }
                if g.queue.duty() == Some(username) {
                    g.queue.on_delivery_ok();
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
            if topup::is_topup(&oid) {
                let mut g = state.lock().await;
                if g.in_flight.as_deref() == Some(oid.as_str()) {
                    g.in_flight = None;
                }
                topup_close(&mut g, false, &reason);
                return Ok(());
            }
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
            let mut ok = ok;
            if ok && amount > 0.0 && amount < MIN_HANDOFF_ACCEPT {
                warn!(
                    "{username}: передача остатка {amount} — подозрительно мало, отклоняем"
                );
                ok = false;
            }
            if ok {
                info!("{username}: перевод остатка ушёл ({}) — сверяю у получателя", fmt_money(amount));
                if amount <= 0.0 {
                    let rescue = state.lock().await.handoff.as_ref().and_then(|h| h.from.clone());
                    if rescue.is_some() {
                        finish_rescue(state, username).await?;
                    } else {
                        finish_rotate(state, username).await?;
                    }
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

/// Бот не смог зайти. Если он получатель ещё не отправленной передачи — берём следующего.
fn mark_login_fail(g: &mut Orch, username: &str) {
    g.login_fail.insert(username.to_string(), Instant::now());
    if g.handoff.as_ref().map_or(false, |h| h.to == username && h.sent_at.is_none() && h.sent_amount.is_none()) {
        warn!("{username}: получатель передачи не может зайти — выбираю следующего");
        g.handoff = None;
        g.rotate_block_until = None;
        save_state(g);
    }
}

fn warn_once_worn(duty: &str) {
    static LAST: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
    let mut l = LAST.lock().unwrap();
    if l.map_or(true, |t| t.elapsed() > Duration::from_secs(60)) {
        warn!("{duty}: лимит выдач выработан, заказ ждёт передачи остатка");
        *l = Some(Instant::now());
    }
}

/// Застрявший остаток у не-дежурного бота → дежурному, очередь не крутим.
async fn finish_rescue(state: &Arc<Mutex<Orch>>, from: &str) -> Result<()> {
    let mut g = state.lock().await;
    g.handoff = None;
    save_state(&g);
    info!("спасение остатка: {from} офлайн");
    if g.bots.get(from).map(is_bound).unwrap_or(false) {
        if let Some(mut w) = g.workers.remove(from) {
            let _ = w.child.start_kill();
        }
        g.ready.remove(from);
    }
    Ok(())
}

/// Остаток ушёл следующему: он становится держателем, бывший уходит в конец и офлайн.
async fn finish_rotate(state: &Arc<Mutex<Orch>>, old: &str) -> Result<()> {
    let mut g = state.lock().await;
    let now = session::now_unix_ms();
    // Держателем становится тот, кому ушёл остаток (боты между ним и прежним уходят в конец).
    let to = g.handoff.as_ref().map(|h| h.to.clone());
    match to {
        Some(to) if g.queue.order.iter().any(|n| *n == to) => {
            g.queue.rotate_skipping(now, &|n| n != to);
        }
        _ => {
            let bans: std::collections::HashSet<String> = g.bans.keys().cloned().collect();
            g.queue.rotate_skipping(now, &|n| bans.contains(n));
        }
    }
    g.handoff = None;
    g.rotate_block_until = None;
    g.handoff_aborts = 0;
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

/// Заказ ждёт держателя дольше `WAIT_NOTICE_AFTER` — бот ещё заходит (капча, привязка): один раз просим покупателя подождать.
const WAIT_NOTICE_AFTER: Duration = Duration::from_secs(40);

async fn notify_waiting(state: &Arc<Mutex<Orch>>) {
    let due: Vec<String> = {
        let mut g = state.lock().await;
        let ids: Vec<String> = g.pending.iter().map(|p| p.order_id.clone()).collect();
        g.wait_seen.retain(|k, _| ids.contains(k));
        g.wait_notified.retain(|k| ids.contains(k));
        let duty_ready = g.queue.duty().map_or(false, |d| g.ready.contains(d));
        let mut due = Vec::new();
        for id in ids {
            let seen = *g.wait_seen.entry(id.clone()).or_insert_with(Instant::now);
            if !duty_ready && seen.elapsed() >= WAIT_NOTICE_AFTER && !g.wait_notified.contains(&id) {
                g.wait_notified.insert(id.clone());
                due.push(id);
            }
        }
        due
    };
    for oid in due {
        emit_sell(state, json!({ "type": "delivery_waiting", "orderId": oid, "reason": "captcha" })).await;
    }
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
            let already = state.lock().await.delivered.contains(&oid);
            if already {
                warn!(
                    "заказ {} уже выдан (ledger) — второй раз не плачу, подтверждаю выдачу poll",
                    &oid[..oid.len().min(8)]
                );
                emit_sell(state, json!({ "type": "delivery_ok", "orderId": oid, "nick": nick })).await;
                return;
            }
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

/// Секунды из текста «Разбан через: 13 д, 9 ч, 50 м, 13 с».
fn ban_duration_secs(reason: &str) -> Option<u64> {
    let i = reason.find("Разбан через")?;
    let tail = &reason[i..];
    let tail = tail.split('\n').next().unwrap_or(tail);
    let mut total = 0u64;
    let mut num = String::new();
    let mut found = false;
    for ch in tail.chars() {
        if ch.is_ascii_digit() {
            num.push(ch);
        } else if ch.is_whitespace() {
            continue;
        } else if !num.is_empty() {
            let n: u64 = num.parse().unwrap_or(0);
            let mult = match ch {
                'д' => 86_400,
                'ч' => 3_600,
                'м' => 60,
                'с' => 1,
                _ => 0,
            };
            if mult > 0 {
                total += n * mult;
                found = true;
            }
            num.clear();
        }
    }
    found.then_some(total)
}

/// Баны переживают рестарт; истёкшие отбрасываются (срок берём из текста бана, иначе 24 ч).
fn load_bans(farm: &Path) -> HashMap<String, (String, u64)> {
    let now = session::now_unix_ms();
    std::fs::read_to_string(farm.join("bans.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<HashMap<String, (String, u64)>>(&s).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|(_, (r, at))| {
            let secs = ban_duration_secs(r).unwrap_or(86_400);
            at + secs * 1000 > now
        })
        .collect()
}

fn save_bans(farm: &Path, b: &HashMap<String, (String, u64)>) {
    if let Ok(s) = serde_json::to_string(b) {
        let _ = std::fs::write(farm.join("bans.json"), s);
    }
}

fn load_balances(farm: &Path) -> HashMap<String, (f64, u64)> {
    std::fs::read_to_string(farm.join("balances.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<HashMap<String, (f64, u64)>>(&s).ok())
        .unwrap_or_default()
}

fn save_balances(farm: &Path, b: &HashMap<String, (f64, u64)>) {
    if let Ok(s) = serde_json::to_string(b) {
        let _ = std::fs::write(farm.join("balances.json"), s);
    }
}

/// Состояние автопродажи для вкладки «Автопродажа» в Go: активный селлер, балансы, очередь, заказы.
async fn sell_state_msg(state: &Arc<Mutex<Orch>>) -> Value {
    let g = state.lock().await;
    let duty = g.queue.duty().map(|s| s.to_string());
    let bal = |n: &str| g.balances.get(n).copied();
    let queue: Vec<Value> = g
        .queue
        .order
        .iter()
        .enumerate()
        .map(|(i, n)| {
            let b = bal(n);
            json!({
                "nick": n,
                "pos": i,
                "balance": b.map(|x| x.0),
                "balance_at_ms": b.map(|x| x.1),
                "online": g.workers.contains_key(n),
                "ready": g.ready.contains(n),
                "bound": g.bots.get(n).and_then(|rt| rt.bound),
                "fault": g.faults.get(n).map(|f| f.0.clone()),
            })
        })
        .collect();
    let total: f64 = g.queue.order.iter().filter_map(|n| bal(n)).map(|x| x.0).sum();
    let handoff = g.handoff.as_ref().map(|h| {
        json!({
            "from": h.from,
            "to": h.to,
            "sent_amount": h.sent_amount,
            "received": h.received,
            "tries": h.tries,
            "age_s": h.started.elapsed().as_secs(),
            "rescue": h.from.is_some(),
        })
    });
    json!({
        "action": "sell_state",
        "anarchy": g.anarchy,
        "duty": duty,
        "duty_balance": duty.as_deref().and_then(|d| bal(d)).map(|x| x.0),
        "duty_balance_at_ms": duty.as_deref().and_then(|d| bal(d)).map(|x| x.1),
        "pays": g.queue.pays,
        "pays_before_rotate": rotation::PAYS_BEFORE_ROTATE,
        "shift_no": g.queue.shift_no,
        "pending": g.pending.len(),
        "in_flight": g.in_flight,
        "handoff": handoff,
        "total_balance": total,
        // только ники, которые сейчас в конфиге селла (заменённые боты в панели не показываем)
        "banned": g.bans.iter().filter(|(n, _)| g.bots.contains_key(*n)).map(|(n, (r, t))| json!({
            "username": n, "anarchy": g.anarchy, "go_type": "netherite-1.21", "reason": r,
            "banned_at": session::fmt_msk(*t), "source": "sell",
            "ip": g.bots.get(n).map(|rt| proxy_host_only(&rt.cfg.proxy)).unwrap_or_default(),
        })).collect::<Vec<_>>(),
        "auth_faults": g.faults.iter().map(|(n, (k, r, t))| json!({
            "username": n, "anarchy": g.anarchy, "go_type": "netherite-1.21", "kind": k, "reason": r,
            "at": session::fmt_msk(*t),
            "ip": g.bots.get(n).map(|rt| proxy_host_only(&rt.cfg.proxy)).unwrap_or_default(),
        })).collect::<Vec<_>>(),
        "topup": json!({
            "enabled": g.topup_cfg.enabled,
            "amount_kk": g.topup_cfg.amount_kk,
            "targets": g.topup_cfg.targets.iter().map(|t| json!({ "anarchy": t.anarchy, "to": t.to })).collect::<Vec<_>>(),
            "data_fresh": g.topup_cfg.fresh(Instant::now()),
            "active": g.topup.as_ref().map(|t| json!({
                "anarchy": t.anarchy, "to": t.to, "amount_kk": t.amount_kk,
                "paying": t.sent_at.is_some(), "age_s": t.started.elapsed().as_secs(),
            })),
            "log": g.topup_log.iter().cloned().collect::<Vec<_>>(),
        }),
        "wait_pay": g.wait_pay.as_ref().map(|w| json!({ "nick": w.nick, "since_ms": w.since_ms })),
        "last_payment": g.last_payment.as_ref().map(|(n, f, a, t)| json!({ "nick": n, "from": f, "amount": a, "at_ms": t })),
        "queue": queue,
        "at_ms": session::now_unix_ms(),
    })
}

/// Команды из Go (вкладка «Автопродажа»): `sell_wait`, `sell_rescue`.
async fn on_go_command(state: &Arc<Mutex<Orch>>, text: &str) {
    let Ok(v) = serde_json::from_str::<Value>(text) else { return };
    match v.get("action").and_then(|a| a.as_str()) {
        Some("sell_wait") => {
            let on = v.get("on").and_then(|x| x.as_bool()).unwrap_or(true);
            let mut g = state.lock().await;
            if on {
                let Some(duty) = g.queue.duty().map(|s| s.to_string()) else { return };
                if g.wait_pay.is_none() {
                    info!("{duty}: кнопка «принять перевод» — заходит и ждёт");
                    ledger(&g.farm_root, json!({ "ev": "wait_pay_start", "nick": duty }));
                    g.wait_pay = Some(WaitPay { since_ms: session::now_unix_ms(), nick: duty });
                }
            } else if g.wait_pay.take().is_some() {
                info!("кнопка «принять перевод» снята вручную");
            }
        }
        Some("sell_topup") => {
            let mut g = state.lock().await;
            g.topup_cfg.enabled = v.get("enabled").and_then(|x| x.as_bool()).unwrap_or(false);
            g.topup_cfg.amount_kk = topup::clamp_kk(v.get("amount_kk").and_then(|x| x.as_f64()).unwrap_or(topup::DEFAULT_KK));
            g.topup_cfg.targets = v
                .get("targets")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|t| {
                            let anarchy = t.get("anarchy").and_then(|x| x.as_u64())? as u16;
                            let to = t.get("to").and_then(|x| x.as_str())?.trim().to_string();
                            Some(topup::Target { anarchy, to })
                        })
                        .collect()
                })
                .unwrap_or_default();
            g.topup_cfg.at = Some(Instant::now());
        }
        Some("sell_rescue") => {
            let from = v
                .get("from")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if from.is_empty() {
                return;
            }
            let mut g = state.lock().await;
            if g.handoff.is_some() {
                warn!("sell_rescue: уже идёт передача остатка");
                return;
            }
            let Some(to) = v
                .get("to")
                .and_then(|x| x.as_str())
                .map(|s| s.trim().to_string())
                .or_else(|| g.queue.duty().map(|s| s.to_string()))
            else {
                warn!("sell_rescue: нет держателя");
                return;
            };
            if from == to {
                warn!("sell_rescue: from==to");
                return;
            }
            if !g.bots.contains_key(&from) {
                warn!("sell_rescue: неизвестный {from}");
                return;
            }
            info!("sell_rescue: {from} → {to}");
            ledger(&g.farm_root, json!({ "ev": "rescue_start", "from": from, "to": to }));
            g.handoff = Some(Handoff::rescue(from, to));
            save_state(&g);
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
                    let mut tick_n: u32 = 0;
                    loop {
                        tokio::select! {
                            Some(v) = rx.recv() => {
                                if sink.send(Message::Text(v.to_string().into())).await.is_err() {
                                    break;
                                }
                            }
                            m = src.next() => {
                                match m {
                                    None => break,
                                    Some(Ok(Message::Text(t))) => on_go_command(&state, t.as_str()).await,
                                    Some(Ok(_)) => {}
                                    Some(Err(_)) => break,
                                }
                            }
                            _ = sleep(Duration::from_secs(5)) => {
                                let st = sell_state_msg(&state).await;
                                if sink.send(Message::Text(st.to_string().into())).await.is_err() {
                                    break;
                                }
                                tick_n += 1;
                                if tick_n % 4 == 0 {
                                    fleet = fleet_msg(&state).await;
                                    if sink.send(Message::Text(fleet.to_string().into())).await.is_err() {
                                        break;
                                    }
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
    // Прокси выдачи — отсюда, а не с диска Go: Go живёт отдельно и файлов селла не видит. Только хост, без логина и пароля.
    let proxies: Vec<Value> = g
        .bots
        .values()
        .filter(|rt| !rt.cfg.proxy.trim().is_empty())
        .map(|rt| json!({ "slot": rt.cfg.username, "kind": "sell", "ip": proxy_host_only(&rt.cfg.proxy) }))
        .collect();
    json!({ "action": "fleet", "bots": bots, "types": ["netherite-1.21"], "proxies": proxies })
}

/// `socks5://user:pass@host:port` → `host:port`.
fn proxy_host_only(proxy: &str) -> String {
    let p = proxy.trim();
    let p = p.split_once("://").map_or(p, |(_, rest)| rest);
    p.rsplit_once('@').map_or(p, |(_, host)| host).to_string()
}

#[cfg(test)]
mod proxy_host_tests {
    use super::proxy_host_only;
    #[test]
    fn strips_credentials() {
        assert_eq!(proxy_host_only("socks5://u:p@1.2.3.4:8000"), "1.2.3.4:8000");
        assert_eq!(proxy_host_only("1.2.3.4:8000"), "1.2.3.4:8000");
    }
}


#[cfg(test)]
mod ban_tests {
    #[test]
    fn ban_duration_parses() {
        let r = "ВЫ ЗАБАНЕНЫ!\nРазбан через: 13 д, 9 ч, 50 м, 13 с\n\nОбжаловать";
        assert_eq!(super::ban_duration_secs(r), Some(13 * 86_400 + 9 * 3_600 + 50 * 60 + 13));
        assert_eq!(super::ban_duration_secs("бан"), None);
    }
}
