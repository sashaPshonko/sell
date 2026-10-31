use std::time::Instant;

use ipc::{BotBoot, OrchCmd};
use serde_json::Value;

use crate::listing::ListingMemory;
use crate::warp::PromenadeState;

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

#[derive(Debug, Clone, Default)]
pub struct BuyingItem {
    pub id: String,
    pub price: f64,
    pub buy_price: f64,
    pub nacenka: f64,
    pub enchants: Value,
    pub durability: Option<f64>,
}

pub struct BotState {
    /// Ник из boot — для IPC без прокидывания Boot везде.
    pub username: String,

    pub catalog: Vec<Value>,
    pub catalog_all: Vec<Value>,
    pub items_buying: Value,

    pub last_window_title: String,
    pub last_window_id: i32,
    pub window_tick: Option<Instant>,

    pub shutdown: bool,

    pub max_buy_price: Option<f64>,
    pub capital_keep: Option<f64>,
    pub balance: Option<f64>,

    pub afk: bool,

    pub sell_ack: SellAck,
    pub need_sell_price: Option<f64>,

    pub listings: ListingMemory,

    /// Go сменил priceSell категории → сброс витрины через хранилище.
    pub need_reset: bool,

    /// «Пора продать / раздать излишек». Ставится:
    ///   - после покупки (`[☃] Вы успешно купили`);
    ///   - после продажи (`[☃] У Вас купили`);
    ///   - когда казначей увидел myNick в табе/чате (см. main.rs).
    /// `ah::run_loop` увидит флаг и вызовет `sell_pass`.
    pub need_sell: bool,
    pub need_reload_ah: bool,

    pub need_rtp: bool,
    pub has_dangerous_trash: bool,

    pub last_storage_reset: Instant,

    /// Временное окно для текущей обработки хранилища.
    /// Используется main.rs, поэтому поле пока сохраняем.
    pub storage_unlist_until: Option<Instant>,

    /// Как JS storageStaleUnlist* — один и тот же слот/GUI
    /// не снимается → reload 50.
    pub storage_stale_unlist_streak: u32,
    pub storage_stale_unlist_slot: i32,
    pub storage_stale_unlist_key: String,

    /// Прочность предмета в руке при /ah sell
    /// (FunTime max < 90% → skip).
    pub held_durability: Option<f64>,

    /// UUID уже ушедшие в книгу АХ.
    pub ah_book_sent_uuids: std::collections::HashSet<String>,

    pub funauth_verified: bool,

    /// Уже уходим на рестарт из-за funauth —
    /// не спамить exit на каждое сообщение.
    pub funauth_restarting: bool,

    pub captcha_busy: bool,
    pub captcha_ok: bool,
    pub captcha_wrong: bool,

    pub last_try_sell_price: Option<f64>,

    /// Scoreboard с номером анки.
    pub on_anarchy: bool,
    pub anarchy_joined_at: Option<Instant>,

    /// Последний пакет скорборда, где видели номер анки.
    pub last_anarchy_board_at: Option<Instant>,

    /// Старт воркера (игнор ⚡ первые 60с).
    pub worker_started_at: Instant,

    pub banned: bool,

    /// Заказ на /pay (очередь выдачи).
    pub delivery: Option<DeliveryJob>,
    pub handoff_to: Option<String>,
    pub pay_outcome: Option<PayOutcome>,
    /// Уже отдали по этому заказу — второй `/pay` не шлём.
    pub paid_order_ids: std::collections::HashSet<String>,

    pub buying_item: BuyingItem,

    pub promenade: PromenadeState,

    /// Каталог id предмета в руке при max/min FunTime.
    pub held_sell_id: Option<String>,
    pub held_sell_price: Option<f64>,
    pub held_nacenka: Option<f64>,
    pub held_book_floor: Option<f64>,
    pub held_book_mid: Option<f64>,

    pub storage_presence_sent: bool,

    /// UUID уже виденных myNick в табе — дедуп, чтобы не триггерить
    /// owner несколько раз при каждом обновлении PlayerInfo.
    pub seen_my_nicks: std::collections::HashSet<uuid::Uuid>,

    /// Когда в последний раз owner платил myNick (CD 60с).
    pub last_my_nick_pay: Option<Instant>,

    /// Дедуп my_nick_seen из чата: не чаще раза в 60с.
    /// Сейчас **не используется** — чат-путь шлёт без дедупа,
    /// орк гасит дубли через `owner_running`. Поле оставлено для будущего.
    pub last_my_nick_seen: Option<Instant>,

    /// Онлайн-ники из таба. Заполняется из PlayerInfoUpdate (ADD_PLAYER),
    /// очищается из PlayerInfoRemove (uuid). Lowercase для сравнения.
    /// Овнер/казначей использует это, чтобы не палиться `/pay` в пустоту.
    pub tab_names: std::collections::HashSet<String>,

    /// Последний полученный перевод от farm-бота (owner слушает в Collect):
    /// (от кого, сумма, когда). Парсится в main.rs из чата
    /// `[$] От игрока <nick> получено +$N`.
    pub last_payment: Option<(String, f64, Instant)>,

    // ============================================================
    // КАЗНАЧЕЙ (роль овнера, передаваемая между farm-ботами)
    // ============================================================

    /// Я сейчас казначей? Обновляется орком через `TreasurerRole`.
    pub is_treasurer: bool,

    /// Ник текущего казначея (может быть не я). Куда слать `/pay`,
    /// когда у меня излишек. Обновляется орком через `TreasurerRole`.
    pub treasurer_nick: Option<String>,

    /// Мне приказано отдать всё (`bal - KEEP_SUM`) этому нику.
    /// Выставляется орком через `FlushToTreasurer` перед сменой роли.
    /// Пока `Some(_)`, фоновый `flush_treasurer` долбит `/pay` до успеха
    /// (без таймаута — орк сам не даст уйти в сон, пока не придёт
    /// `TreasurerFlushed { ok: true }`).
    pub treasurer_flush_to: Option<String>,

    /// Флаг «`flush_treasurer` уже запущен» — чтобы не спавнить второй поток.
    pub treasurer_flush_in_flight: bool,

    /// Последний известный снимок балансов от орка — для redistribute,
    /// когда я казначей. `(nick, balance)`; `-1.0` = «неизвестно».
    pub balances_snapshot: Vec<(String, f64)>,

    /// Сколько последний раз получилось отправить при flush (для отчёта).
    pub treasurer_last_flush_amount: Option<i64>,

    /// Когда последний раз успешно завершили flush (для логов).
    pub treasurer_last_flush_at: Option<Instant>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SellAck {
    #[default]
    Idle,

    Waiting,
    Ok,
    Full,
    Empty,
    Skip,
    Retry,

    /// FunTime: «слишком дорого… введите команду ещё раз»
    Confirm,
}

impl BotState {
    pub fn from_boot(boot: &BotBoot) -> Self {
        Self {
            username: boot.username.clone(),

            catalog: Vec::new(),
            catalog_all: Vec::new(),
            items_buying: Value::Array(vec![]),

            last_window_title: String::new(),
            last_window_id: 0,
            window_tick: None,

            shutdown: false,

            max_buy_price: None,
            capital_keep: None,
            balance: None,

            afk: false,

            sell_ack: SellAck::Idle,
            need_sell_price: None,

            listings: ListingMemory::default(),

            need_reset: false,
            need_sell: false,
            need_reload_ah: false,

            need_rtp: false,
            has_dangerous_trash: false,

            last_storage_reset: Instant::now(),

            storage_unlist_until: None,

            storage_stale_unlist_streak: 0,
            storage_stale_unlist_slot: -1,
            storage_stale_unlist_key: String::new(),

            held_durability: None,

            ah_book_sent_uuids:
                std::collections::HashSet::new(),

            funauth_verified: false,
            funauth_restarting: false,

            captcha_busy: false,
            captcha_ok: false,
            captcha_wrong: false,

            last_try_sell_price: None,

            on_anarchy: false,
            anarchy_joined_at: None,
            last_anarchy_board_at: None,

            worker_started_at: Instant::now(),

            banned: false,

            delivery: None,
            handoff_to: None,
            pay_outcome: None,
            paid_order_ids: std::collections::HashSet::new(),

            buying_item: BuyingItem::default(),

            promenade: PromenadeState::default(),

            held_sell_id: None,
            held_sell_price: None,
            held_nacenka: None,
            held_book_floor: None,
            held_book_mid: None,

            storage_presence_sent: false,

            seen_my_nicks: std::collections::HashSet::new(),
            last_my_nick_pay: None,
            last_my_nick_seen: None,

            tab_names: std::collections::HashSet::new(),

            last_payment: None,

            // казначей: стартовые значения из boot
            is_treasurer: boot.treasurer_nick
                .as_deref()
                .map(|t| t.eq_ignore_ascii_case(&boot.username))
                .unwrap_or(false),
            treasurer_nick: boot.treasurer_nick.clone(),
            treasurer_flush_to: None,
            treasurer_flush_in_flight: false,
            balances_snapshot: Vec::new(),
            treasurer_last_flush_amount: None,
            treasurer_last_flush_at: None,
        }
    }

    pub fn apply_cmd(&mut self, cmd: OrchCmd) {
        match cmd {
            OrchCmd::Update { data, all } => {
                if catalog_prices_changed(&self.catalog, &data) {
                    self.need_reset = true;

                    tracing::info!(
                        "цены Go → needReset (изменилась priceSell)"
                    );
                }

                tracing::debug!(
                    "каталог update: {} позиций (all={})",
                    data.len(),
                    all.len()
                );

                self.catalog = data;

                self.catalog_all = if all.is_empty() {
                    self.catalog.clone()
                } else {
                    all
                };
            }

            OrchCmd::ItemsBuying { data } => {
                self.items_buying = data;
            }

            OrchCmd::CapitalPlan {
                keep_sum,
                max_buy_price,
            } => {
                self.capital_keep =
                    keep_sum.filter(|v| *v > 0.0);

                self.max_buy_price =
                    max_buy_price.filter(|v| *v > 0.0);
            }

            OrchCmd::ListingState { data } => {
                self.listings.import_state(&data);

                tracing::debug!(
                    "listing state imported"
                );
            }

            OrchCmd::ListingRes { req_id, result } => {
                let _ = (req_id, result);
            }

            OrchCmd::Pay { .. } => {
                // Обрабатывается в boot::stdin_loop → pay_tx → owner::run_loop.
                // В BotState ничего не делаем.
            }

            OrchCmd::BalancesSnapshot { balances } => {
                // Казначей получает снимок балансов и раздаёт в sell_pass.
                // Сохраняем — `ah::sell_pass` читает.
                self.balances_snapshot = balances;
            }

            OrchCmd::TreasurerRole { username } => {
                // Орк переназначил казначея.
                let new_nick = if username.is_empty() {
                    None
                } else {
                    Some(username)
                };
                self.is_treasurer = new_nick
                    .as_deref()
                    .map(|t| t.eq_ignore_ascii_case(&self.username))
                    .unwrap_or(false);
                self.treasurer_nick = new_nick;

                // Глобальный флаг для логов: все `info!`/`warn!`/`line`
                // этого процесса будут magenta, если я казначей.
                ipc::pretty_log::set_treasurer(self.is_treasurer);
            }

            OrchCmd::FlushToTreasurer { to } => {
                // Орк приказал отдать всё этому нику. Фоновый
                // `flush_treasurer` в main.rs запустится и будет
                // долбить `/pay` до успеха (без таймаута).
                if to.is_empty() {
                    self.treasurer_flush_to = None;
                } else {
                    self.treasurer_flush_to = Some(to);
                }
                // Флаг in-flight не ставим здесь — его выставит main.rs
                // при старте потока, чтобы не плодить второй.
            }

            OrchCmd::MyNickSeen { .. } => {
                // Не используется (нет отдельного овнера).
            }

            OrchCmd::TreasurerBalanceRequest => {
                // Орк просит баланс казначея. Ответ шлёт `flush_treasurer_loop`
                // / `sell_pass` по факту `/balance`. Здесь ничего не делаем.
            }

            OrchCmd::Shutdown => {
                self.shutdown = true;
            }

            OrchCmd::Deliver {
                order_id,
                nick,
                amount,
            } => {
                if self.delivery.as_ref().map(|j| j.order_id.as_str()) == Some(order_id.as_str())
                {
                    return;
                }
                self.pay_outcome = None;
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

            OrchCmd::Other => {}
        }
    }
}

fn catalog_prices_changed(
    prev: &[Value],
    next: &[Value],
) -> bool {
    if next.is_empty() {
        return false;
    }

    let mut prev_by_id =
        std::collections::HashMap::new();

    for item in prev {
        let Some(id) =
            item.get("id").and_then(|v| v.as_str())
        else {
            continue;
        };

        let Some(p) =
            item.get("priceSell").and_then(|v| v.as_f64())
        else {
            continue;
        };

        prev_by_id.insert(id.to_string(), p);
    }

    if prev_by_id.is_empty() {
        return false;
    }

    for item in next {
        let Some(id) =
            item.get("id").and_then(|v| v.as_str())
        else {
            continue;
        };

        let Some(p) =
            item.get("priceSell").and_then(|v| v.as_f64())
        else {
            continue;
        };

        if let Some(&old) = prev_by_id.get(id) {
            if (old - p).abs() > f64::EPSILON {
                return true;
            }
        }
    }

    false
}

pub fn uuid_blocked_by_other(
    items_buying: &Value,
    uuid: &str,
    my_username: &str,
) -> bool {
    let Some(arr) = items_buying.as_array() else {
        return false;
    };

    for raw in arr {
        let (u, owner) = match raw {
            Value::String(s) => (s.as_str(), None),

            Value::Object(o) => (
                o.get("uuid")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),

                o.get("username")
                    .and_then(|v| v.as_str()),
            ),

            _ => continue,
        };

        if u != uuid {
            continue;
        }

        if owner.is_none()
            || owner != Some(my_username)
        {
            return true;
        }
    }

    false
}