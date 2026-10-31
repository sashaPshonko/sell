//! Оркестратор выдачи: очередь ботов, WS для poll (порт 8790), Go для привязки.
//! Дежурный выдаёт `/pay`×2. После 2 выдач — хэндофф остатка следующему.
//! Непривязанные не усыпляем.

mod config;
mod rotation;
mod session;

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
    sync::Arc,
    time::Duration,
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

struct Orch {
    farm_root: PathBuf,
    bot_bin: PathBuf,
    go_ws: String,
    schedule_salt: String,
    anarchy: u16,
    bots: HashMap<String, Rt>,
    workers: HashMap<String, WorkerHandle>,
    queue: QueueState,
    sell_clients: HashSet<usize>,
    next_client: usize,
    client_tx: HashMap<usize, mpsc::UnboundedSender<String>>,
    rotating: bool,
    restart: Option<mpsc::UnboundedSender<String>>,
    want_spawn: Vec<String>,
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
    let queue = QueueState::load_or_init(&farm, &nicks);
    let bot_bin = farm.join("target/release/sell-bot");
    let bot_bin = if bot_bin.is_file() {
        bot_bin
    } else {
        farm.join("target/debug/sell-bot")
    };

    info!(
        "sell-orch · {} ботов · дежурный={} · go={} · bin={}",
        nicks.len(),
        queue.duty().unwrap_or("?"),
        cfg.go_ws,
        bot_bin.display()
    );

    let state = Arc::new(Mutex::new(Orch {
        farm_root: farm,
        bot_bin,
        go_ws: cfg.go_ws,
        schedule_salt: cfg.schedule_salt,
        anarchy: cfg.anarchy,
        bots,
        workers: HashMap::new(),
        queue,
        sell_clients: HashSet::new(),
        next_client: 0,
        client_tx: HashMap::new(),
        rotating: false,
        restart: None,
        want_spawn: Vec::new(),
        go_out: None,
    }));

    let (restart_tx, mut restart_rx) = mpsc::unbounded_channel::<String>();
    state.lock().await.restart = Some(restart_tx.clone());
    let go_tx = spawn_go(state.clone());
    state.lock().await.go_out = Some(go_tx);
    spawn_sell_ws(state.clone());

    {
        let st = state.clone();
        let rtx = restart_tx.clone();
        tokio::spawn(async move {
            loop {
                let _ = maybe_session_rotate(&st).await;
                let _ = tick_spawns(st.clone(), rtx.clone()).await;
                sleep(Duration::from_secs(5)).await;
            }
        });
    }

    while let Some(nick) = restart_rx.recv().await {
        warn!("{nick}: воркер умер → респавн если нужен");
        {
            let mut g = state.lock().await;
            g.workers.remove(&nick);
        }
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

fn queue_index(order: &[String], nick: &str) -> usize {
    order
        .iter()
        .position(|n| n.eq_ignore_ascii_case(nick))
        .unwrap_or(0)
}

fn bot_awake(g: &Orch, nick: &str, now: u64) -> bool {
    let n = g.queue.order.len();
    let idx = queue_index(&g.queue.order, nick);
    session::is_awake(nick, idx, n, &g.schedule_salt, now)
}

/// Спавним: непривязанных (привязка) + дежурного, если он в смене или ещё не привязан.
/// Привязанных не-дежурных в смене не держим — не 24/7.
async fn tick_spawns(
    state: Arc<Mutex<Orch>>,
    restart_tx: mpsc::UnboundedSender<String>,
) -> Result<()> {
    let now = session::now_unix_ms();
    let (need, kill) = {
        let mut g = state.lock().await;
        let duty = g.queue.duty().map(|s| s.to_string());
        let mut need = Vec::new();
        let mut kill = Vec::new();
        let nicks: Vec<String> = g.bots.keys().cloned().collect();
        for n in nicks {
            let unbound = g.bots.get(&n).map(|rt| rt.bound != Some(true)).unwrap_or(true);
            let is_duty = duty.as_deref() == Some(n.as_str());
            let running = g.workers.contains_key(&n);
            let awake = bot_awake(&g, &n, now);
            let want = unbound
                || (is_duty && awake)
                || g.want_spawn.iter().any(|x| x == &n);
            if want && !running {
                need.push(n.clone());
            }
            // привязанный вне своей смены — сон (дежурный тоже, если окно кончилось)
            if running && !unbound && !g.rotating && !(is_duty && awake) {
                kill.push(n.clone());
            }
        }
        g.want_spawn.clear();
        (need, kill)
    };
    for n in kill {
        let mut g = state.lock().await;
        if g.queue.duty() == Some(n.as_str()) || g.rotating {
            continue;
        }
        if g.bots.get(&n).map(|rt| rt.bound != Some(true)).unwrap_or(true) {
            continue;
        }
        info!("{n}: не дежурный и привязан → сон");
        if let Some(mut w) = g.workers.remove(&n) {
            let _ = w.child.start_kill();
        }
    }
    for n in need {
        spawn_one(state.clone(), restart_tx.clone(), n).await?;
    }
    Ok(())
}

/// Смена кончилась у привязанного дежурного — отдаём следующему, кто в окне.
async fn maybe_session_rotate(state: &Arc<Mutex<Orch>>) -> Result<()> {
    let now = session::now_unix_ms();
    let (duty, next, rotating) = {
        let g = state.lock().await;
        if g.rotating {
            return Ok(());
        }
        let duty = g.queue.duty().map(|s| s.to_string());
        let Some(duty) = duty else {
            return Ok(());
        };
        let unbound = g.bots.get(&duty).map(|rt| rt.bound != Some(true)).unwrap_or(true);
        if unbound || bot_awake(&g, &duty, now) {
            return Ok(());
        }
        let n = g.queue.order.len();
        let next = g.queue.order.iter().skip(1).find(|nick| {
            let unbound = g.bots.get(*nick).map(|rt| rt.bound != Some(true)).unwrap_or(true);
            unbound || bot_awake(&g, nick, now)
        }).cloned();
        (duty, next, g.rotating)
    };
    let _ = rotating;
    let Some(next) = next else {
        info!("смена {duty} кончилась, следующего в окне нет → сон");
        let mut g = state.lock().await;
        if let Some(mut w) = g.workers.remove(&duty) {
            let _ = w.child.start_kill();
        }
        return Ok(());
    };
    info!("смена {duty} кончилась → {next}");
    {
        let mut g = state.lock().await;
        g.rotating = true;
        g.want_spawn.push(next.clone());
        g.queue.save(&g.farm_root.clone());
    }
    let _ = send_cmd(state, &duty, &OrchCmd::Handoff { to: next }).await;
    Ok(())
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
            let farm = {
                let mut g = state.lock().await;
                if let Some(rt) = g.bots.get_mut(username) {
                    rt.bound = Some(true);
                }
                g.farm_root.clone()
            };
            save_binding(&farm, username, true);
            info!("{username}: привязан");
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
            let farm = {
                let mut g = state.lock().await;
                if let Some(rt) = g.bots.get_mut(username) {
                    rt.bound = Some(false);
                }
                g.farm_root.clone()
            };
            save_binding(&farm, username, false);
            warn!("{username}: нет привязки — очередь не усыпляет");
        }
        "delivery_ok" => {
            let oid = msg
                .id
                .clone()
                .or_else(|| msg.extra.get("orderId").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .unwrap_or_default();
            emit_sell(
                state,
                json!({ "type": "delivery_ok", "orderId": oid, "nick": msg.extra.get("nick") }),
            )
            .await;
            maybe_rotate(state, username).await?;
        }
        "delivery_failed" => {
            let oid = msg.id.clone().unwrap_or_default();
            let reason = msg.reason.clone().unwrap_or_else(|| "fail".into());
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
            info!("{username}: хэндофф готов");
            finish_rotate(state, username).await?;
        }
        "idle_quit" => {
            let kill = {
                let g = state.lock().await;
                g.bots.get(username).map(is_bound).unwrap_or(false)
                    && g.queue.duty() != Some(username)
            };
            if kill {
                let mut g = state.lock().await;
                if let Some(mut w) = g.workers.remove(username) {
                    let _ = w.child.start_kill();
                }
            }
        }
        "success" => pretty_log::line(username, LineKind::Ok, "на анархии"),
        _ => {}
    }
    Ok(())
}

async fn maybe_rotate(state: &Arc<Mutex<Orch>>, username: &str) -> Result<()> {
    let (should, next, farm) = {
        let mut g = state.lock().await;
        if g.queue.duty() != Some(username) {
            return Ok(());
        }
        if !g.queue.on_delivery_ok() {
            g.queue.save(&g.farm_root);
            return Ok(());
        }
        let next = g.queue.next().map(|s| s.to_string());
        g.rotating = true;
        (true, next, g.farm_root.clone())
    };
    let _ = should;
    let Some(next) = next else {
        let mut g = state.lock().await;
        g.queue.pays = 0;
        g.rotating = false;
        g.queue.save(&farm);
        return Ok(());
    };
    info!("2 выдачи у {username} → хэндофф {next}");
    {
        let mut g = state.lock().await;
        if !g.want_spawn.iter().any(|n| n == &next) {
            g.want_spawn.push(next.clone());
        }
    }
    let _ = send_cmd(state, username, &OrchCmd::Handoff { to: next }).await;
    Ok(())
}

async fn finish_rotate(state: &Arc<Mutex<Orch>>, old: &str) -> Result<()> {
    let mut g = state.lock().await;
    g.queue.rotate();
    g.queue.save(&g.farm_root.clone());
    g.rotating = false;
    info!("очередь → дежурный={}", g.queue.duty().unwrap_or("?"));
    if let Some(mut w) = g.workers.remove(old) {
        if g.bots.get(old).map(is_bound).unwrap_or(false) {
            let _ = w.child.start_kill();
        }
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
    let duty = state.lock().await.queue.duty().map(|s| s.to_string());
    let Some(duty) = duty else { return };
    match typ {
        "order" => {
            let oid = msg.get("orderId").and_then(|v| v.as_str()).unwrap_or("");
            let nick = msg.get("nick").and_then(|v| v.as_str()).unwrap_or("");
            let amount = msg
                .get("amount")
                .and_then(|v| v.as_f64())
                .unwrap_or(0.0);
            let _ = send_cmd(
                state,
                &duty,
                &OrchCmd::Deliver {
                    order_id: oid.into(),
                    nick: nick.into(),
                    amount,
                },
            )
            .await;
        }
        "nick_update" => {
            let oid = msg.get("orderId").and_then(|v| v.as_str()).unwrap_or("");
            let nick = msg.get("nick").and_then(|v| v.as_str()).unwrap_or("");
            let _ = send_cmd(
                state,
                &duty,
                &OrchCmd::NickUpdate {
                    order_id: oid.into(),
                    nick: nick.into(),
                },
            )
            .await;
        }
        "cancel_order" => {
            let oid = msg.get("orderId").and_then(|v| v.as_str()).unwrap_or("");
            let _ = send_cmd(
                state,
                &duty,
                &OrchCmd::CancelOrder {
                    order_id: oid.into(),
                },
            )
            .await;
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
