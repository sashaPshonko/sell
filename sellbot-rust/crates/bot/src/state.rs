use std::time::Instant;

use ipc::{BotBoot, OrchCmd};

#[derive(Debug, Clone)]
pub struct DeliveryJob {
    pub order_id: String,
    pub nick: String,
    pub amount_kk: f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PayOutcome {
    Ok,
    NeedConfirm,
    Offline,
    Invalid,
    Insufficient,
    Fail,
}

pub struct BotState {
    pub username: String,
    pub shutdown: bool,
    pub balance: Option<f64>,
    pub afk: bool,
    pub funauth_verified: bool,
    pub funauth_restarting: bool,
    pub captcha_busy: bool,
    pub captcha_ok: bool,
    pub captcha_wrong: bool,
    pub on_anarchy: bool,
    pub anarchy_joined_at: Option<Instant>,
    pub last_anarchy_board_at: Option<Instant>,
    pub worker_started_at: Instant,
    pub banned: bool,
    pub delivery: Option<DeliveryJob>,
    pub handoff_to: Option<String>,
    pub pay_outcome: Option<PayOutcome>,
    pub pay_repeat_cmd: Option<String>,
    pub paid_order_ids: std::collections::HashSet<String>,
}

impl BotState {
    pub fn from_boot(boot: &BotBoot) -> Self {
        Self {
            username: boot.username.clone(),
            shutdown: false,
            balance: None,
            afk: false,
            funauth_verified: false,
            funauth_restarting: false,
            captcha_busy: false,
            captcha_ok: false,
            captcha_wrong: false,
            on_anarchy: false,
            anarchy_joined_at: None,
            last_anarchy_board_at: None,
            worker_started_at: Instant::now(),
            banned: false,
            delivery: None,
            handoff_to: None,
            pay_outcome: None,
            pay_repeat_cmd: None,
            paid_order_ids: std::collections::HashSet::new(),
        }
    }

    pub fn apply_cmd(&mut self, cmd: OrchCmd) {
        match cmd {
            OrchCmd::Shutdown => {
                self.shutdown = true;
            }
            OrchCmd::Deliver {
                order_id,
                nick,
                amount,
            } => {
                if self.delivery.as_ref().map(|j| j.order_id.as_str()) == Some(order_id.as_str()) {
                    return;
                }
                self.pay_outcome = None;
                self.pay_repeat_cmd = None;
                self.delivery = Some(DeliveryJob {
                    order_id,
                    nick,
                    amount_kk: amount,
                });
            }
            OrchCmd::NickUpdate { order_id, nick } => {
                if let Some(job) = self.delivery.as_mut() {
                    if job.order_id == order_id {
                        job.nick = nick;
                        self.pay_outcome = None;
                    }
                }
            }
            OrchCmd::CancelOrder { order_id } => {
                if self
                    .delivery
                    .as_ref()
                    .map(|j| j.order_id == order_id)
                    .unwrap_or(false)
                {
                    self.delivery = None;
                    self.pay_outcome = None;
                }
            }
            OrchCmd::Handoff { to } => {
                self.handoff_to = if to.is_empty() { None } else { Some(to) };
            }
            _ => {}
        }
    }
}
