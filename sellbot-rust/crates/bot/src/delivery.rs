//! Выдача валюты: `/pay` дважды (подтверждение FunTime), без повторной пары
//! если деньги уже ушли.

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

const PAY_GAP: Duration = Duration::from_millis(700);
const WAIT_CHAT: Duration = Duration::from_secs(8);
const IDLE_QUIT: Duration = Duration::from_secs(25);
const HANDOFF_KEEP: f64 = 0.0;
/// Страховка: лот в kk, не сырые монеты. 50k kk на витрине не бывает.
const MAX_KK: f64 = 50_000.0;

pub fn on_chat(state: &Arc<Mutex<BotState>>, text: &str) {
    let mut st = state.lock();
    if matches!(
        st.pay_outcome,
        Some(PayOutcome::Ok | PayOutcome::Offline | PayOutcome::Invalid | PayOutcome::Insufficient)
    ) {
        return;
    }
    if text.contains("[✔] Успешно") || (text.contains("Успешно!") && text.contains("отправлено"))
    {
        st.pay_outcome = Some(PayOutcome::Ok);
        return;
    }
    if text.contains("Необходимо подтверждение") {
        st.pay_outcome = Some(PayOutcome::NeedConfirm);
        return;
    }
    if text.contains("Указанный игрок не найден") {
        st.pay_outcome = Some(PayOutcome::Offline);
        return;
    }
    if text.to_lowercase().contains("ник не найден") {
        st.pay_outcome = Some(PayOutcome::Invalid);
        return;
    }
    if text.contains("недостаточно денег") {
        st.pay_outcome = Some(PayOutcome::Insufficient);
    }
}

fn coins(amount_kk: f64) -> i64 {
    (amount_kk * 1_000_000.0).round() as i64
}

fn nick_ok(nick: &str) -> bool {
    let n = nick.trim();
    let len = n.chars().count();
    (3..=16).contains(&len)
        && n.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
}

async fn pay_twice(bot: &Client, nick: &str, amount: i64) {
    cmd::say(bot, format!("/pay {nick} {amount}"));
    tokio::time::sleep(PAY_GAP).await;
    cmd::say(bot, format!("/pay {nick} {amount}"));
}

async fn wait_outcome(state: &Arc<Mutex<BotState>>, d: Duration) -> Option<PayOutcome> {
    let until = Instant::now() + d;
    while Instant::now() < until {
        if let Some(o) = state.lock().pay_outcome.clone() {
            if o != PayOutcome::NeedConfirm {
                return Some(o);
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    state.lock().pay_outcome.clone()
}

async fn refresh_balance(bot: &Client, state: &Arc<Mutex<BotState>>) -> Option<f64> {
    state.lock().balance = None;
    cmd::say(bot, "/balance");
    for _ in 0..25 {
        tokio::time::sleep(Duration::from_millis(200)).await;
        if let Some(b) = state.lock().balance {
            return Some(b);
        }
    }
    None
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
    if state.lock().paid_order_ids.contains(&order_id) {
        info!("заказ {} уже выдан — /pay не повторяем", &order_id[..order_id.len().min(8)]);
        emit_ok(boot, &order_id, &nick, amount_kk);
        clear_job(state, &order_id);
        return;
    }

    let nick = nick.trim().to_string();
    if !nick_ok(&nick) {
        fail(boot, &order_id, "invalid_nick");
        clear_job(state, &order_id);
        return;
    }
    if !(amount_kk.is_finite() && amount_kk >= 1.0 && amount_kk <= MAX_KK) {
        fail(boot, &order_id, "invalid_amount");
        clear_job(state, &order_id);
        return;
    }
    let amount = coins(amount_kk);
    if amount <= 0 {
        fail(boot, &order_id, "invalid_amount");
        clear_job(state, &order_id);
        return;
    }

    info!("выдача {}… {nick} {amount_kk}kk", &order_id[..order_id.len().min(8)]);

    let before = refresh_balance(bot, state).await.unwrap_or(0.0);
    if before + 1.0 < amount as f64 {
        fail(boot, &order_id, "insufficient_funds");
        clear_job(state, &order_id);
        return;
    }

    state.lock().pay_outcome = None;
    pay_twice(bot, &nick, amount).await;
    let mut outcome = wait_outcome(state, WAIT_CHAT).await;

    if outcome == Some(PayOutcome::NeedConfirm) {
        cmd::say(bot, format!("/pay {nick} {amount}"));
        outcome = wait_outcome(state, WAIT_CHAT).await;
    }

    match outcome {
        Some(PayOutcome::Ok) => {
            mark_paid(state, &order_id);
            emit_ok(boot, &order_id, &nick, amount_kk);
            state.lock().pay_outcome = None;
            clear_job(state, &order_id);
            return;
        }
        Some(PayOutcome::Offline) => {
            fail(boot, &order_id, "player_offline");
            clear_job(state, &order_id);
            return;
        }
        Some(PayOutcome::Invalid) => {
            fail(boot, &order_id, "invalid_nick");
            clear_job(state, &order_id);
            return;
        }
        Some(PayOutcome::Insufficient) => {
            fail(boot, &order_id, "insufficient_funds");
            clear_job(state, &order_id);
            return;
        }
        _ => {}
    }

    let after = refresh_balance(bot, state).await.unwrap_or(before);
    let delta = before - after;
    if delta >= (amount as f64) * 0.9 {
        if delta > (amount as f64) * 1.5 {
            warn!(
                "выдача: ушло ~{delta:.0} при сумме {amount} — стоп, второй /pay не шлём"
            );
        }
        mark_paid(state, &order_id);
        emit_ok(boot, &order_id, &nick, amount_kk);
        state.lock().pay_outcome = None;
        clear_job(state, &order_id);
        return;
    }

    fail(boot, &order_id, "timeout");
    clear_job(state, &order_id);
}

async fn run_handoff(bot: &Client, state: &Arc<Mutex<BotState>>, to: &str) {
    info!("хэндофф остатка → {to}");
    if !nick_ok(to) {
        emit_handoff(state, to, false, 0.0);
        state.lock().handoff_to = None;
        return;
    }
    let Some(bal) = refresh_balance(bot, state).await else {
        emit_handoff(state, to, false, 0.0);
        return;
    };
    let send = (bal - HANDOFF_KEEP).floor() as i64;
    if send <= 0 {
        info!("хэндофф: пустой баланс");
        emit_handoff(state, to, true, 0.0);
        state.lock().handoff_to = None;
        return;
    }
    state.lock().pay_outcome = None;
    pay_twice(bot, to, send).await;
    let mut outcome = wait_outcome(state, WAIT_CHAT).await;
    if outcome == Some(PayOutcome::NeedConfirm) {
        cmd::say(bot, format!("/pay {to} {send}"));
        outcome = wait_outcome(state, WAIT_CHAT).await;
    }
    if outcome == Some(PayOutcome::Ok) {
        emit_handoff(state, to, true, send as f64);
        state.lock().handoff_to = None;
        return;
    }
    let after = refresh_balance(bot, state).await.unwrap_or(bal);
    if bal - after >= (send as f64) * 0.9 {
        emit_handoff(state, to, true, send as f64);
        state.lock().handoff_to = None;
        return;
    }
    warn!("хэндофф: не ушло, не крутим повтор");
    emit_handoff(state, to, false, bal);
    state.lock().handoff_to = None;
}

fn mark_paid(state: &Arc<Mutex<BotState>>, order_id: &str) {
    state.lock().paid_order_ids.insert(order_id.to_string());
}

fn clear_job(state: &Arc<Mutex<BotState>>, order_id: &str) {
    let mut st = state.lock();
    if st.delivery.as_ref().map(|j| j.order_id.as_str()) == Some(order_id) {
        st.delivery = None;
    }
}

fn emit_ok(boot: &Arc<BotBoot>, order_id: &str, nick: &str, amount_kk: f64) {
    emit(&WorkerMsg {
        name: "delivery_ok".into(),
        username: Some(boot.username.clone()),
        id: Some(order_id.into()),
        extra: json!({ "orderId": order_id, "nick": nick, "amountKk": amount_kk }),
        ..empty()
    });
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coins_kk() {
        assert_eq!(coins(150.0), 150_000_000);
        assert_eq!(coins(1.0), 1_000_000);
    }

    #[test]
    fn nick_rejects_junk() {
        assert!(nick_ok("Steve"));
        assert!(!nick_ok("a"));
        assert!(!nick_ok("bad nick"));
        assert!(!nick_ok("x; /pay Steve 999"));
    }
}
