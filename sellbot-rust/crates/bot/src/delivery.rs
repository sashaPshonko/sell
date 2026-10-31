//! Выдача валюты через `/pay` дважды (старый sell на GitHub).
//! Смена очереди: `Handoff` — весь остаток следующему боту.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use azalea::prelude::*;
use ipc::{emit, BotBoot, WorkerMsg};
use parking_lot::Mutex;
use serde_json::json;
use tracing::{info, warn};

use crate::{
    afk, anarchy, cmd,
    state::{BotState, PayOutcome},
};

const PAY_LOOP_WAIT: Duration = Duration::from_millis(2000);
const PAY_GAP: Duration = Duration::from_millis(700);
const DELIVER_TIMEOUT: Duration = Duration::from_secs(60);
const IDLE_QUIT: Duration = Duration::from_secs(25);
const HANDOFF_KEEP: f64 = 0.0;

pub fn on_chat(state: &Arc<Mutex<BotState>>, text: &str) {
    if text.contains("[✔] Успешно") || (text.contains("Успешно!") && text.contains("отправлено"))
    {
        state.lock().pay_outcome = Some(PayOutcome::Ok);
        return;
    }
    if text.contains("Указанный игрок не найден") {
        state.lock().pay_outcome = Some(PayOutcome::Offline);
        return;
    }
    if text.to_lowercase().contains("ник не найден") {
        state.lock().pay_outcome = Some(PayOutcome::Invalid);
        return;
    }
    if text.contains("недостаточно денег") {
        state.lock().pay_outcome = Some(PayOutcome::Insufficient);
    }
}

fn coins(amount_kk: f64) -> i64 {
    (amount_kk * 1_000_000.0).round() as i64
}

async fn pay_twice(bot: &Client, nick: &str, amount: i64) {
    cmd::say(bot, format!("/pay {nick} {amount}"));
    tokio::time::sleep(PAY_GAP).await;
    cmd::say(bot, format!("/pay {nick} {amount}"));
}

pub async fn run_loop(bot: Client, boot: Arc<BotBoot>, state: Arc<Mutex<BotState>>) {
    let mut idle_since = Instant::now();
    loop {
        if state.lock().banned || state.lock().shutdown {
            return;
        }

        if !state.lock().on_anarchy {
            if !anarchy::wait_until_on_anarchy(&bot, &boot, &state).await {
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
            continue;
        }

        if state.lock().afk {
            afk::un_afk(&bot).await;
        }

        if let Some(to) = state.lock().handoff_to.clone() {
            run_handoff(&bot, &state, &to).await;
            idle_since = Instant::now();
            continue;
        }

        let job = state.lock().delivery.clone();
        if let Some(job) = job {
            idle_since = Instant::now();
            deliver_one(&bot, &boot, &state, job.order_id, job.nick, job.amount_kk).await;
            continue;
        }

        if idle_since.elapsed() >= IDLE_QUIT {
            info!("idle {}с → выход (не сидим 24/7)", IDLE_QUIT.as_secs());
            emit(&WorkerMsg {
                name: "idle_quit".into(),
                username: Some(boot.username.clone()),
                ..empty()
            });
            return;
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

async fn deliver_one(
    bot: &Client,
    boot: &Arc<BotBoot>,
    state: &Arc<Mutex<BotState>>,
    order_id: String,
    nick: String,
    amount_kk: f64,
) {
    let amount = coins(amount_kk);
    if amount <= 0 {
        fail(boot, &order_id, "invalid_amount");
        state.lock().delivery = None;
        return;
    }
    info!("выдача {}… {nick} {amount_kk}kk", &order_id[..order_id.len().min(8)]);
    let deadline = Instant::now() + DELIVER_TIMEOUT;
    state.lock().pay_outcome = None;

    while Instant::now() < deadline {
        if state.lock().banned || state.lock().shutdown {
            return;
        }
        if state.lock().delivery.as_ref().map(|j| j.order_id.as_str()) != Some(order_id.as_str()) {
            return;
        }
        let nick = state
            .lock()
            .delivery
            .as_ref()
            .map(|j| j.nick.clone())
            .unwrap_or_else(|| nick.clone());

        match state.lock().pay_outcome.clone() {
            Some(PayOutcome::Ok) => {
                emit(&WorkerMsg {
                    name: "delivery_ok".into(),
                    username: Some(boot.username.clone()),
                    id: Some(order_id.clone()),
                    extra: json!({ "orderId": order_id, "nick": nick, "amountKk": amount_kk }),
                    ..empty()
                });
                state.lock().delivery = None;
                state.lock().pay_outcome = None;
                return;
            }
            Some(PayOutcome::Offline) => {
                fail(boot, &order_id, "player_offline");
                state.lock().delivery = None;
                return;
            }
            Some(PayOutcome::Invalid) => {
                fail(boot, &order_id, "invalid_nick");
                state.lock().delivery = None;
                return;
            }
            Some(PayOutcome::Insufficient) => {
                fail(boot, &order_id, "insufficient_funds");
                state.lock().delivery = None;
                return;
            }
            Some(PayOutcome::Fail) => {
                fail(boot, &order_id, "fail");
                state.lock().delivery = None;
                return;
            }
            None => {}
        }

        if state.lock().afk {
            tokio::time::sleep(PAY_LOOP_WAIT).await;
            continue;
        }

        state.lock().pay_outcome = None;
        pay_twice(bot, &nick, amount).await;
        tokio::time::sleep(PAY_LOOP_WAIT).await;
    }

    if state.lock().delivery.as_ref().map(|j| j.order_id.as_str()) == Some(order_id.as_str()) {
        fail(boot, &order_id, "timeout");
        state.lock().delivery = None;
    }
}

async fn run_handoff(bot: &Client, state: &Arc<Mutex<BotState>>, to: &str) {
    info!("хэндофф остатка → {to}");
    cmd::say(bot, "/balance");
    tokio::time::sleep(Duration::from_secs(2)).await;
    let bal = state.lock().balance.unwrap_or(0.0);
    let send = (bal - HANDOFF_KEEP).floor() as i64;
    if send <= 0 {
        info!("хэндофф: пустой баланс");
        emit_handoff(state, to, true, 0.0);
        state.lock().handoff_to = None;
        return;
    }
    state.lock().pay_outcome = None;
    let deadline = Instant::now() + Duration::from_secs(90);
    while Instant::now() < deadline {
        if state.lock().banned || state.lock().shutdown {
            emit_handoff(state, to, false, bal);
            return;
        }
        if state.lock().pay_outcome == Some(PayOutcome::Ok) {
            emit_handoff(state, to, true, send as f64);
            state.lock().handoff_to = None;
            return;
        }
        if state.lock().pay_outcome == Some(PayOutcome::Offline) {
            warn!("хэндофф: {to} не в сети, повтор");
            state.lock().pay_outcome = None;
        }
        pay_twice(bot, to, send).await;
        tokio::time::sleep(PAY_LOOP_WAIT).await;
    }
    emit_handoff(state, to, false, bal);
}

fn emit_handoff(state: &Arc<Mutex<BotState>>, to: &str, ok: bool, amount: f64) {
    let user = state.lock().username.clone();
    emit(&WorkerMsg {
        name: "handoff_done".into(),
        username: Some(user),
        extra: json!({ "ok": ok, "to": to, "amount": amount }),
        ..empty()
    });
}

fn fail(boot: &Arc<BotBoot>, order_id: &str, reason: &str) {
    warn!("выдача fail {reason} {order_id}");
    emit(&WorkerMsg {
        name: "delivery_failed".into(),
        username: Some(boot.username.clone()),
        reason: Some(reason.into()),
        id: Some(order_id.into()),
        extra: json!({ "orderId": order_id, "reason": reason }),
        ..empty()
    });
}

fn empty() -> WorkerMsg {
    WorkerMsg {
        name: String::new(),
        username: None,
        reason: None,
        items: None,
        data: None,
        id: None,
        price: None,
        balance: None,
        lots: None,
        extra: json!({}),
    }
}
