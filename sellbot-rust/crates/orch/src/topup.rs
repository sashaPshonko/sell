//! Пополнение анархий фермы: когда на анархии мало денег, держатель выдачи заходит на неё и платит казначею.
//! Это обычный перевод держателя: он идёт в счётчик выдач (лимит две выдачи до передачи остатка).
//! Платим только казначею анархии, остальным ботам не переводим — казначей сам раздаёт деньги.
//! Откуда список анархий и сумма: Go (вкладка «Автопродажа») присылает `sell_topup`.

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

/// Префикс id перевода-пополнения (отличает его от заказов покупателей).
pub const PREFIX: &str = "topup-";
/// Список от Go старше этого — считаем устаревшим (Go присылает его каждые ~20 с).
pub const CFG_TTL: Duration = Duration::from_secs(120);
/// Сколько даём держателю, чтобы зайти на анархию фермы и дойти до перевода.
pub const START_TIMEOUT: Duration = Duration::from_secs(240);
/// Команда перевода ушла, а ответа нет столько — считаем сорвавшимся.
pub const PAY_TIMEOUT: Duration = Duration::from_secs(90);
/// Пауза до следующего пополнения той же анархии после успеха (балансы в Go обновляются не сразу).
pub const COOLDOWN_OK: Duration = Duration::from_secs(40 * 60);
/// Пауза после неудачи (казначей не на анархии, не зашёл и т. п.).
pub const COOLDOWN_FAIL: Duration = Duration::from_secs(15 * 60);
/// После пополнения у держателя должно остаться не меньше (монет): деньги покупателей важнее.
pub const RESERVE_COINS: f64 = 300_000_000.0;
pub const MIN_KK: f64 = 5.0;
pub const MAX_KK: f64 = 500.0;
pub const DEFAULT_KK: f64 = 50.0;

#[derive(Debug, Clone, PartialEq)]
pub struct Target {
    pub anarchy: u16,
    /// Ник казначея анархии.
    pub to: String,
}

#[derive(Debug, Clone)]
pub struct Cfg {
    pub enabled: bool,
    pub amount_kk: f64,
    pub targets: Vec<Target>,
    /// Когда Go прислал данные последний раз.
    pub at: Option<Instant>,
}

impl Default for Cfg {
    fn default() -> Self {
        Self { enabled: false, amount_kk: DEFAULT_KK, targets: Vec::new(), at: None }
    }
}

impl Cfg {
    pub fn fresh(&self, now: Instant) -> bool {
        self.at.map_or(false, |t| now.duration_since(t) <= CFG_TTL)
    }
}

/// Сумма из панели: в пределах разумного.
pub fn clamp_kk(v: f64) -> f64 {
    if v.is_finite() { v.clamp(MIN_KK, MAX_KK) } else { DEFAULT_KK }
}

#[derive(Debug, Clone)]
pub struct Job {
    pub order_id: String,
    pub anarchy: u16,
    pub to: String,
    pub amount_kk: f64,
    /// Держатель, который платит (если роль сменилась — пополнение отменяем).
    pub duty: String,
    pub started: Instant,
    /// Когда ушла команда перевода (`None` — ещё заходим на анархию).
    pub sent_at: Option<Instant>,
}

pub fn is_topup(order_id: &str) -> bool {
    order_id.starts_with(PREFIX)
}

/// Первая по списку анархия без паузы. Go присылает список от самой бедной к самой богатой.
pub fn pick_target(targets: &[Target], cool: &HashMap<u16, Instant>, now: Instant) -> Option<Target> {
    targets
        .iter()
        .find(|t| !t.to.trim().is_empty() && cool.get(&t.anarchy).map_or(true, |until| now >= *until))
        .cloned()
}

/// Хватает ли денег у держателя: после перевода должен остаться запас.
pub fn enough_money(balance_coins: Option<f64>, amount_kk: f64) -> bool {
    balance_coins.map_or(false, |b| b >= amount_kk * 1_000_000.0 + RESERVE_COINS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(an: u16, to: &str) -> Target {
        Target { anarchy: an, to: to.into() }
    }

    #[test]
    fn picks_first_without_cooldown() {
        let now = Instant::now();
        let mut cool = HashMap::new();
        let targets = vec![t(503, "a"), t(507, "b"), t(508, "c")];
        assert_eq!(pick_target(&targets, &cool, now), Some(t(503, "a")));
        cool.insert(503, now + Duration::from_secs(60));
        assert_eq!(pick_target(&targets, &cool, now), Some(t(507, "b")));
        cool.insert(507, now + Duration::from_secs(60));
        cool.insert(508, now + Duration::from_secs(60));
        assert_eq!(pick_target(&targets, &cool, now), None);
        // пауза кончилась
        assert_eq!(pick_target(&targets, &cool, now + Duration::from_secs(61)), Some(t(503, "a")));
    }

    #[test]
    fn target_without_treasurer_is_skipped() {
        let now = Instant::now();
        let targets = vec![t(503, ""), t(504, "  "), t(505, "x")];
        assert_eq!(pick_target(&targets, &HashMap::new(), now), Some(t(505, "x")));
    }

    #[test]
    fn money_reserve_is_kept() {
        assert!(!enough_money(None, 50.0));
        assert!(!enough_money(Some(340_000_000.0), 50.0));
        assert!(enough_money(Some(350_000_000.0), 50.0));
    }

    #[test]
    fn amount_is_clamped() {
        assert_eq!(clamp_kk(50.0), 50.0);
        assert_eq!(clamp_kk(0.0), MIN_KK);
        assert_eq!(clamp_kk(100_000.0), MAX_KK);
        assert_eq!(clamp_kk(f64::NAN), DEFAULT_KK);
    }

    #[test]
    fn config_goes_stale() {
        let now = Instant::now();
        let mut c = Cfg::default();
        assert!(!c.fresh(now));
        c.at = Some(now);
        assert!(c.fresh(now + Duration::from_secs(60)));
        assert!(!c.fresh(now + CFG_TTL + Duration::from_secs(1)));
    }

    #[test]
    fn topup_ids_are_recognized() {
        assert!(is_topup("topup-503-1795000000"));
        assert!(!is_topup("AB12CD34"));
    }
}
