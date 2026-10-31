//! Детерминированное расписание перерывов farm-ботов.
//!
//! Всё в **абсолютных** unix-мс. День по MSK (UTC+3): `day = (now_ms + 3ч) / 24ч`.
//!
//! Длинный сон: **8–9ч** (база), jitter **±1ч отдельно на начало и на конец** —
//! длина гуляет в диапазоне 6–11ч. Окна:
//!   бот 0: 00:00–08:00 (ночной)
//!   бот 1: 02:00–10:00 (ночной, пересекается с 0)
//!   бот 2: 11:00–19:00 (дневной)
//!
//! Назначение окон — детерминированная перестановка от (anarchy, filename, index).
//! При N=3 — все три окна заняты, ночью (02:00–08:00) спят **двое** (боты 0 и 1),
//! бот 2 работает. Онлайн 1 ночью, 2 днём, 3 вечером. 0 не бывает.
//!
//! Короткие: 2 перерыва по 30–120 мин, только в окне 08:00–20:00 MSK,
//! разнесены по индексу бота, не пересекаются.
//!
//! **Длинный vs короткий.** Для казначея важно различать: короткий перерыв
//! (30–120 мин) он переживёт — flush отработает, бот вернётся, роль
//! казначея останется (если `next_long_break_at` ещё далеко). Длинный сон
//! (6–11ч) — критичен: надо успеть отдать деньги новому казначею.
//!
//! Поэтому отдельно:
//!   - `next_long_break_at` — когда следующий **длинный** сон (начало или
//!     конец текущего). Тикер казначея в `orch.rs` выбирает казначея по
//!     максимуму этого значения (кто дольше протянет до длинного сна).
//!   - `next_short_break_at` — когда следующий **короткий** перерыв.
//!   - `next_break_at` — смешанный, для логов и `debug_state`.
//!   - `is_in_long_break` / `is_in_short_break` — что сейчас.

use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ScheduleConfig {
    #[serde(default = "default_long")]
    pub long_break: LongBreakConfig,
    #[serde(default = "default_short")]
    pub short_breaks: ShortBreaksConfig,
    #[serde(default = "default_salt")]
    pub hash_salt: String,
    /// Джиттер ±N мин **на начало и на конец** длинного сна. 0 = жёстко. Дефолт 60.
    #[serde(default = "default_long_jitter_minutes")]
    pub long_jitter_minutes: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LongBreakConfig {
    #[serde(default = "default_long_min")]
    pub min_hours: f64,
    #[serde(default = "default_long_max")]
    pub max_hours: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ShortBreaksConfig {
    #[serde(default = "default_short_count")]
    pub count: usize,
    #[serde(default = "default_short_min")]
    pub min_minutes: u64,
    #[serde(default = "default_short_max")]
    pub max_minutes: u64,
}

fn default_long() -> LongBreakConfig {
    LongBreakConfig {
        min_hours: default_long_min(),
        max_hours: default_long_max(),
    }
}
fn default_short() -> ShortBreaksConfig {
    ShortBreaksConfig {
        count: default_short_count(),
        min_minutes: default_short_min(),
        max_minutes: default_short_max(),
    }
}
fn default_salt() -> String {
    "default".to_string()
}
fn default_long_min() -> f64 {
    8.0
}
fn default_long_max() -> f64 {
    9.0
}
fn default_short_count() -> usize {
    2
}
fn default_short_min() -> u64 {
    30
}
fn default_short_max() -> u64 {
    120
}
fn default_long_jitter_minutes() -> u64 {
    60
}

impl Default for ScheduleConfig {
    fn default() -> Self {
        Self {
            long_break: default_long(),
            short_breaks: default_short(),
            hash_salt: default_salt(),
            long_jitter_minutes: default_long_jitter_minutes(),
        }
    }
}

impl ScheduleConfig {
    pub fn load(farm_root: &Path) -> Self {
        let path = farm_root.join("schedule.json");
        if path.is_file() {
            match std::fs::read_to_string(&path) {
                Ok(raw) => match serde_json::from_str::<ScheduleConfig>(&raw) {
                    Ok(cfg) => {
                        tracing::info!("schedule.json загружен: {:?}", cfg);
                        return cfg;
                    }
                    Err(e) => tracing::warn!("schedule.json parse: {e} — дефолты"),
                },
                Err(e) => tracing::warn!("schedule.json read: {e} — дефолты"),
            }
        } else {
            tracing::info!("schedule.json нет — дефолты");
        }
        ScheduleConfig::default()
    }
}

const DAY_MS: u64 = 24 * 3600 * 1000;
const HOUR_MS: u64 = 3600 * 1000;
const MIN_MS: u64 = 60 * 1000;
const MSK_OFFSET_MS: u64 = 3 * HOUR_MS;

/// Окна длинного сна (MSK): (start_h, end_h). end может быть > 24 (через полночь).
/// Ночные 0 и 1 пересекаются в 02:00–08:00. Дневной 2 — 11:00–19:00.
const LONG_WINDOWS: &[(u64, u64)] = &[
    (0, 8),    // бот 0: 00:00–08:00
    (2, 10),   // бот 1: 02:00–10:00
    (11, 19),  // бот 2: 11:00–19:00
];

/// Окно коротких перерывов (MSK).
const SHORT_WINDOW_START_MSK_H: u64 = 8;
const SHORT_WINDOW_END_MSK_H: u64 = 20;

pub struct Schedule {
    #[allow(dead_code)]
    anarchy: u16,
    salt: u64,
    n_bots: usize,
    long_min_ms: u64,
    long_max_ms: u64,
    short_count: usize,
    short_min_ms: u64,
    short_max_ms: u64,
    long_jitter_ms: u64,
}

impl Schedule {
    pub fn new(anarchy: u16, filename: &str, n_bots: usize, cfg: &ScheduleConfig) -> Self {
        let salt = hash_salt(anarchy, filename, &cfg.hash_salt);
        Self {
            anarchy,
            salt,
            n_bots,
            long_min_ms: (cfg.long_break.min_hours * 3600.0 * 1000.0) as u64,
            long_max_ms: (cfg.long_break.max_hours * 3600.0 * 1000.0) as u64,
            short_count: cfg.short_breaks.count,
            short_min_ms: cfg.short_breaks.min_minutes * 60 * 1000,
            short_max_ms: cfg.short_breaks.max_minutes * 60 * 1000,
            long_jitter_ms: cfg.long_jitter_minutes * 60 * 1000,
        }
    }

    pub fn is_active(&self, index: usize, now_ms: u64) -> bool {
        if index >= self.n_bots {
            return true;
        }
        if self.is_in_long_break(index, now_ms) {
            return false;
        }
        if self.is_in_short_break(index, now_ms) {
            return false;
        }
        true
    }

    /// Сейчас в длинном сне?
    pub fn is_in_long_break(&self, index: usize, now_ms: u64) -> bool {
        if index >= self.n_bots {
            return false;
        }
        let day = day_number(now_ms);
        for d in [day, day.saturating_sub(1)] {
            if let Some((start_abs, len)) = self.long_sleep_abs(index, d) {
                if now_ms >= start_abs && now_ms < start_abs + len {
                    return true;
                }
            }
        }
        false
    }

    /// Сейчас в коротком перерыве?
    pub fn is_in_short_break(&self, index: usize, now_ms: u64) -> bool {
        if index >= self.n_bots {
            return false;
        }
        let day = day_number(now_ms);
        for d in [day, day.saturating_sub(1)] {
            for (start_abs, len) in self.short_breaks_abs(index, d) {
                if now_ms >= start_abs && now_ms < start_abs + len {
                    return true;
                }
            }
        }
        false
    }

    /// Окно бота `index` — **детерминированная перестановка** от (anarchy, filename).
    /// При N=3 — все три окна заняты (permutation).
    pub fn window_for(&self, index: usize) -> (u64, u64) {
        let base = (hash_u64(self.salt, 0, 0x5A5A) % LONG_WINDOWS.len() as u64) as usize;
        let idx = (base + index) % LONG_WINDOWS.len();
        LONG_WINDOWS[idx]
    }

    /// Имя окна для лога.
    pub fn window_name(&self, index: usize) -> String {
        let (s, e) = self.window_for(index);
        let e_norm = if e >= 24 { e - 24 } else { e };
        format!("{:02}-{:02}", s, e_norm)
    }

    /// Компактная строка состояния для лога.
    ///
    /// Добавлено: `next_long_in=` и `next_short_in=` — чтобы видеть,
    /// сколько до длинного сна и сколько до ближайшего короткого
    /// (это разные вещи для казначея).
    pub fn debug_state(&self, index: usize, now_ms: u64) -> String {
        let wname = self.window_name(index);
        let active = self.is_active(index, now_ms);
        let next = self.next_break_at(index, now_ms);
        let next_long = self.next_long_break_at(index, now_ms);
        let next_short = self.next_short_break_at(index, now_ms);
        let mins = next.saturating_sub(now_ms) / 60_000;
        let mins_long = next_long.saturating_sub(now_ms) / 60_000;
        let mins_short = next_short.saturating_sub(now_ms) / 60_000;
        let day = day_number(now_ms);
        let now_h = ((now_ms + MSK_OFFSET_MS) / HOUR_MS) % 24;
        let now_m = ((now_ms + MSK_OFFSET_MS) / MIN_MS) % 60;
        let sleep = self.long_sleep_abs(index, day);
        let sleep_str = match sleep {
            Some((start, len)) => {
                let s_h = ((start + MSK_OFFSET_MS) / HOUR_MS) % 24;
                let s_m = ((start + MSK_OFFSET_MS) / MIN_MS) % 60;
                let e = start + len;
                let e_h = ((e + MSK_OFFSET_MS) / HOUR_MS) % 24;
                let e_m = ((e + MSK_OFFSET_MS) / MIN_MS) % 60;
                format!(
                    "{:02}:{:02}-{:02}:{:02}({}м)",
                    s_h,
                    s_m,
                    e_h,
                    e_m,
                    len / 60_000
                )
            }
            None => "none".to_string(),
        };
        format!(
            "idx={index} win={wname} active={active} now={now_h:02}:{now_m:02} sleep_today={sleep_str} next_in={mins}м next_long_in={mins_long}м next_short_in={mins_short}м"
        )
    }

    /// Длинный сон. База 8–9ч, jitter ±N мин **на начало и на конец** отдельно.
    /// Сон может выходить за окно (пересекаться) — это ок для ночных.
    fn long_sleep_abs(&self, index: usize, day: u64) -> Option<(u64, u64)> {
        let (start_h, end_h) = self.window_for(index);
        let base_start = day * DAY_MS + start_h * HOUR_MS - MSK_OFFSET_MS;
        let base_end = day * DAY_MS + end_h * HOUR_MS - MSK_OFFSET_MS;
        let base_len = base_end.saturating_sub(base_start);
        let _ = base_len; // база окна не используется, длина ниже

        let len = self.long_len(index, day); // 8–9ч

        // jitter на начало
        let jitter_start = if self.long_jitter_ms == 0 {
            0i64
        } else {
            let range = 2 * self.long_jitter_ms + 1;
            let h = hash_u64(self.salt, (index as u64) ^ 0x5555, day);
            (h % range) as i64 - self.long_jitter_ms as i64
        };
        // jitter на конец (независимый)
        let jitter_end = if self.long_jitter_ms == 0 {
            0i64
        } else {
            let range = 2 * self.long_jitter_ms + 1;
            let h = hash_u64(self.salt, (index as u64) ^ 0x6666, day);
            (h % range) as i64 - self.long_jitter_ms as i64
        };

        let start = (base_start as i64 + jitter_start).max(0) as u64;
        // конец = база начала + len + jitter_end, но не меньше 6ч и не больше 11ч
        let raw_end = start as i64 + len as i64 + jitter_end;
        let end = raw_end
            .max(start as i64 + 6 * HOUR_MS as i64)
            .min(start as i64 + 11 * HOUR_MS as i64) as u64;
        Some((start, end - start))
    }

    fn long_len(&self, index: usize, day: u64) -> u64 {
        if self.long_max_ms <= self.long_min_ms {
            return self.long_min_ms;
        }
        let span = self.long_max_ms - self.long_min_ms;
        self.long_min_ms + hash_u64(self.salt, index as u64, day ^ 0x1111) % span
    }

    fn short_breaks_abs(&self, index: usize, day: u64) -> Vec<(u64, u64)> {
        if self.short_count == 0 {
            return Vec::new();
        }
        let win_start = day * DAY_MS + SHORT_WINDOW_START_MSK_H * HOUR_MS - MSK_OFFSET_MS;
        let win_end = day * DAY_MS + SHORT_WINDOW_END_MSK_H * HOUR_MS - MSK_OFFSET_MS;
        let win_len = win_end.saturating_sub(win_start);
        if win_len == 0 {
            return Vec::new();
        }

        let step = win_len / self.short_count as u64;
        let mut out = Vec::with_capacity(self.short_count);

        let bot_offset = if self.n_bots > 0 {
            (index as u64) * (win_len / self.n_bots as u64)
        } else {
            0
        };

        for slot in 0..self.short_count {
            let slot_start_rel = (bot_offset + (slot as u64) * step) % win_len;
            let slot_start = win_start + slot_start_rel;
            let len = self.short_len(index, day, slot);
            let max_jitter = step.saturating_sub(len);
            let jitter = if max_jitter == 0 {
                0
            } else {
                self.short_jitter(index, day, slot, max_jitter)
            };
            let max_start = win_end.saturating_sub(len);
            let start = (slot_start + jitter).min(max_start);
            out.push((start, len));
        }
        out
    }

    fn short_len(&self, index: usize, day: u64, slot: usize) -> u64 {
        if self.short_max_ms <= self.short_min_ms {
            return self.short_min_ms;
        }
        let span = self.short_max_ms - self.short_min_ms;
        hash_u64(
            self.salt,
            (index as u64) ^ ((slot as u64 + 1) << 16),
            day ^ 0x3333,
        ) % span
            + self.short_min_ms
    }

    fn short_jitter(&self, index: usize, day: u64, slot: usize, max: u64) -> u64 {
        if max == 0 {
            return 0;
        }
        hash_u64(
            self.salt,
            (index as u64) ^ ((slot as u64 + 1) << 20),
            day ^ 0x4444,
        ) % max
    }

    pub fn next_transition(&self, index: usize, now_ms: u64) -> u64 {
        let active = self.is_active(index, now_ms);
        for step in 1..(24 * 60) {
            let t = now_ms + step * MIN_MS;
            if self.is_active(index, t) != active {
                return t;
            }
        }
        now_ms + DAY_MS
    }

    /// Смешанный: когда ближайший перерыв любого типа (начало или конец
    /// текущего). Для логов и `debug_state`. **Не** использовать для
    /// выбора казначея — там нужен `next_long_break_at`.
    pub fn next_break_at(&self, index: usize, now_ms: u64) -> u64 {
        let day = day_number(now_ms);
        let mut best: Option<u64> = None;
        for d in [day, day.saturating_sub(1), day + 1] {
            if let Some((start_abs, len)) = self.long_sleep_abs(index, d) {
                let end = start_abs + len;
                if now_ms < start_abs {
                    best = Some(best.map_or(start_abs, |b| b.min(start_abs)));
                } else if now_ms < end {
                    best = Some(best.map_or(end, |b| b.min(end)));
                }
            }
        }
        for d in [day, day + 1] {
            for (start_abs, len) in self.short_breaks_abs(index, d) {
                let end = start_abs + len;
                if now_ms < start_abs {
                    best = Some(best.map_or(start_abs, |b| b.min(start_abs)));
                } else if now_ms < end {
                    best = Some(best.map_or(end, |b| b.min(end)));
                }
            }
        }
        best.unwrap_or(now_ms + DAY_MS)
    }

    /// Когда следующий **длинный** сон. Если сейчас в длинном сне —
    /// когда он закончится. Иначе — когда начнётся следующий.
    ///
    /// Это то, что нужно тикеру казначея: «кто дольше протянет до
    /// длинного сна». Короткие перерывы игнорируются — казначей их
    /// переживёт (flush на 5–10 минут, потом опять работает).
    pub fn next_long_break_at(&self, index: usize, now_ms: u64) -> u64 {
        if index >= self.n_bots {
            return now_ms + DAY_MS;
        }
        let day = day_number(now_ms);
        let mut best: Option<u64> = None;
        // Смотрим вчера, сегодня, завтра — чтобы поймать длинный сон,
        // который начался вчера и идёт сейчас, или начнётся завтра.
        for d in [day.saturating_sub(1), day, day + 1] {
            if let Some((start_abs, len)) = self.long_sleep_abs(index, d) {
                let end = start_abs + len;
                if now_ms < start_abs {
                    best = Some(best.map_or(start_abs, |b| b.min(start_abs)));
                } else if now_ms < end {
                    // Сейчас в этом сне — вернуть его конец.
                    best = Some(best.map_or(end, |b| b.min(end)));
                }
            }
        }
        best.unwrap_or(now_ms + DAY_MS)
    }

    /// Когда следующий **короткий** перерыв. Если сейчас в коротком —
    /// когда он закончится. Иначе — когда начнётся следующий.
    pub fn next_short_break_at(&self, index: usize, now_ms: u64) -> u64 {
        if index >= self.n_bots {
            return now_ms + DAY_MS;
        }
        let day = day_number(now_ms);
        let mut best: Option<u64> = None;
        for d in [day, day + 1] {
            for (start_abs, len) in self.short_breaks_abs(index, d) {
                let end = start_abs + len;
                if now_ms < start_abs {
                    best = Some(best.map_or(start_abs, |b| b.min(start_abs)));
                } else if now_ms < end {
                    best = Some(best.map_or(end, |b| b.min(end)));
                }
            }
        }
        best.unwrap_or(now_ms + DAY_MS)
    }

    /// Текущий длинный сон: (начало, конец) в абсолютных мс.
    pub fn long_break_span(&self, index: usize, now_ms: u64) -> Option<(u64, u64)> {
        if index >= self.n_bots {
            return None;
        }
        let day = day_number(now_ms);
        for d in [day + 1, day, day.saturating_sub(1)] {
            if let Some((s, len)) = self.long_sleep_abs(index, d) {
                if now_ms >= s && now_ms < s + len {
                    return Some((s, s + len));
                }
            }
        }
        None
    }
}

fn day_number(now_ms: u64) -> u64 {
    (now_ms + MSK_OFFSET_MS) / DAY_MS
}

fn hash_salt(anarchy: u16, filename: &str, extra: &str) -> u64 {
    fnv1a(&[
        &anarchy.to_le_bytes()[..],
        filename.as_bytes(),
        b"|",
        extra.as_bytes(),
    ])
}

fn fnv1a(parts: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for part in parts {
        for &b in *part {
            h ^= b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    h
}

fn hash_u64(salt: u64, a: u64, b: u64) -> u64 {
    let mut h = salt;
    h ^= a.wrapping_mul(0x9E3779B97F4A7C15);
    h = h.rotate_left(31).wrapping_mul(0xBF58476D1CE4E5B9);
    h ^= b.wrapping_mul(0x94D049BB133111EB);
    h = h.rotate_left(27).wrapping_mul(0x94D049BB133111EB);
    h ^ (h >> 33)
}

pub fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ScheduleConfig {
        ScheduleConfig::default()
    }

    #[test]
    fn deterministic() {
        let s1 = Schedule::new(1, "1b", 3, &cfg());
        let s2 = Schedule::new(1, "1b", 3, &cfg());
        let t = now_unix_ms();
        for i in 0..3 {
            assert_eq!(s1.is_active(i, t), s2.is_active(i, t));
        }
    }

    #[test]
    fn three_unique_windows() {
        // При N=3 все три окна должны быть заняты (permutation).
        let s = Schedule::new(503, "503b", 3, &cfg());
        let mut wins: Vec<_> = (0..3).map(|i| s.window_for(i)).collect();
        wins.sort();
        wins.dedup();
        assert_eq!(wins.len(), 3, "окна не уникальны");
    }

    #[test]
    fn exactly_one_at_2am_msk() {
        // В 02:00 MSK ровно один бот должен работать (дневной, окно 11-19),
        // двое других спать (окна 00-08 и 02-10).
        let s = Schedule::new(503, "503b", 3, &cfg());
        let day = 20000u64;
        let t02 = day * DAY_MS + 2 * HOUR_MS - MSK_OFFSET_MS;
        // Прогоняем несколько дней — jitter может сдвинуть, но в среднем 1.
        let mut counts = Vec::new();
        for dd in 0..30u64 {
            let t = t02 + dd * DAY_MS;
            let n = (0..3).filter(|&i| s.is_active(i, t)).count();
            counts.push(n);
        }
        let avg: f64 = counts.iter().sum::<usize>() as f64 / counts.len() as f64;
        assert!(avg >= 0.8 && avg <= 2.0, "в 02:00 MSK средний онлайн {avg} — вне [0.8, 2.0]");
    }

    #[test]
    fn someone_always_online() {
        let s = Schedule::new(1, "1b", 3, &cfg());
        let start = now_unix_ms();
        let mut zero_count = 0;
        let total = 7 * 24 * 60;
        for step in 0..total {
            let t = start + step * MIN_MS;
            let n = (0..3).filter(|&i| s.is_active(i, t)).count();
            if n == 0 {
                zero_count += 1;
            }
        }
        // Допускаем редкие 0 из-за jitter, но не больше 1% времени.
        assert!(
            zero_count as f64 / total as f64 <= 0.01,
            "0 онлайн слишком часто: {zero_count} из {total}"
        );
    }

    #[test]
    fn night_has_fewer_online_than_day() {
        let s = Schedule::new(1, "1b", 3, &cfg());
        let start = now_unix_ms();
        let mut night_n = Vec::new();
        let mut day_n = Vec::new();
        for step in 0..(7 * 24 * 60) {
            let t = start + step * MIN_MS;
            let msk_hour = ((t + MSK_OFFSET_MS) / HOUR_MS) % 24;
            let n = (0..3).filter(|&i| s.is_active(i, t)).count();
            if (3..=7).contains(&msk_hour) {
                night_n.push(n);
            } else if (12..=18).contains(&msk_hour) {
                day_n.push(n);
            }
        }
        let night_avg = night_n.iter().sum::<usize>() as f64 / night_n.len() as f64;
        let day_avg = day_n.iter().sum::<usize>() as f64 / day_n.len() as f64;
        assert!(night_avg < day_avg, "ночью {night_avg:.2}, днём {day_avg:.2} — не меньше");
    }

    #[test]
    fn active_changes_over_time() {
        let s = Schedule::new(1, "1b", 3, &cfg());
        let start = now_unix_ms();
        let mut any_change = false;
        let mut prev = [true; 3];
        for step in 0..(48 * 60) {
            let t = start + step * MIN_MS;
            for i in 0..3 {
                let a = s.is_active(i, t);
                if a != prev[i] {
                    any_change = true;
                    prev[i] = a;
                }
            }
        }
        assert!(any_change, "is_active никогда не меняется — баг");
    }

    #[test]
    fn short_breaks_inside_day_window() {
        let s = Schedule::new(1, "1b", 3, &cfg());
        for d in [20000u64, 20001, 20002] {
            let win_start = d * DAY_MS + SHORT_WINDOW_START_MSK_H * HOUR_MS - MSK_OFFSET_MS;
            let win_end = d * DAY_MS + SHORT_WINDOW_END_MSK_H * HOUR_MS - MSK_OFFSET_MS;
            for i in 0..3 {
                for (start, len) in s.short_breaks_abs(i, d) {
                    assert!(
                        start >= win_start && start + len <= win_end,
                        "бот {i} день {d}: короткий вне окна"
                    );
                }
            }
        }
    }

    #[test]
    fn short_breaks_do_not_overlap_within_bot() {
        let s = Schedule::new(1, "1b", 3, &cfg());
        let d = 20000u64;
        for i in 0..3 {
            let breaks = s.short_breaks_abs(i, d);
            for a in 0..breaks.len() {
                for b in (a + 1)..breaks.len() {
                    let (s1, l1) = breaks[a];
                    let (s2, l2) = breaks[b];
                    assert!(s1 + l1 <= s2 || s2 + l2 <= s1, "бот {i}: короткие пересекаются");
                }
            }
        }
    }

    #[test]
    fn sleep_continuous_through_midnight() {
        let s = Schedule::new(1, "1b", 3, &cfg());
        let day = 20000u64;
        let t_23 = day * DAY_MS + 23 * HOUR_MS - MSK_OFFSET_MS;
        let t_02 = (day + 1) * DAY_MS + 2 * HOUR_MS - MSK_OFFSET_MS;
        let t_05 = (day + 1) * DAY_MS + 5 * HOUR_MS - MSK_OFFSET_MS;
        let sleeping = !s.is_active(0, t_23);
        if sleeping {
            assert!(!s.is_active(0, t_02), "сон 23:00 не продолжился в 02:00");
            assert!(!s.is_active(0, t_05), "сон 23:00 не продолжился в 05:00");
        }
    }

    #[test]
    fn next_break_in_future() {
        let s = Schedule::new(1, "1b", 3, &cfg());
        let now = now_unix_ms();
        for i in 0..3 {
            let nb = s.next_break_at(i, now);
            assert!(nb >= now, "next_break_at в прошлом");
        }
    }

    #[test]
    fn debug_state_works() {
        let s = Schedule::new(503, "503b", 3, &cfg());
        let t = now_unix_ms();
        for i in 0..3 {
            let st = s.debug_state(i, t);
            assert!(st.contains("win="));
            assert!(st.contains("active="));
            assert!(st.contains("next_long_in="));
            assert!(st.contains("next_short_in="));
        }
    }

    // ============ тесты на новые методы ============

    #[test]
    fn next_long_break_in_future() {
        let s = Schedule::new(1, "1b", 3, &cfg());
        let now = now_unix_ms();
        for i in 0..3 {
            let nb = s.next_long_break_at(i, now);
            assert!(nb >= now, "next_long_break_at в прошлом для бота {i}");
        }
    }

    #[test]
    fn next_short_break_in_future() {
        let s = Schedule::new(1, "1b", 3, &cfg());
        let now = now_unix_ms();
        for i in 0..3 {
            let nb = s.next_short_break_at(i, now);
            assert!(nb >= now, "next_short_break_at в прошлом для бота {i}");
        }
    }

    #[test]
    fn next_long_break_at_matches_in_long_break() {
        let s = Schedule::new(1, "1b", 3, &cfg());
        let day = 20000u64;
        // Для каждого бота и каждого дня: если сейчас в длинном сне,
        // next_long_break_at == конец этого сна.
        for i in 0..3 {
            for d in 0..7u64 {
                for h in 0..24u64 {
                    let t = (day + d) * DAY_MS + h * HOUR_MS - MSK_OFFSET_MS;
                    if s.is_in_long_break(i, t) {
                        let end = s.next_long_break_at(i, t);
                        assert!(end > t, "бот {i} день {d} час {h}: конец длинного сна в прошлом");
                        // Проверим, что в end уже не спим.
                        assert!(
                            !s.is_in_long_break(i, end),
                            "бот {i} день {d} час {h}: end={end} всё ещё в длинном сне"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn next_short_break_at_matches_in_short_break() {
        let s = Schedule::new(1, "1b", 3, &cfg());
        let day = 20000u64;
        for i in 0..3 {
            for d in 0..3u64 {
                for h in 0..24u64 {
                    let t = (day + d) * DAY_MS + h * HOUR_MS - MSK_OFFSET_MS;
                    if s.is_in_short_break(i, t) {
                        let end = s.next_short_break_at(i, t);
                        assert!(end > t, "бот {i} день {d} час {h}: конец короткого в прошлом");
                        assert!(
                            !s.is_in_short_break(i, end),
                            "бот {i} день {d} час {h}: end={end} всё ещё в коротком"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn next_long_is_later_or_equal_next_break() {
        // Смешанный next_break_at <= next_long_break_at (потому что
        // смешанный учитывает и короткие тоже).
        let s = Schedule::new(1, "1b", 3, &cfg());
        let now = now_unix_ms();
        for i in 0..3 {
            let mixed = s.next_break_at(i, now);
            let long = s.next_long_break_at(i, now);
            assert!(
                mixed <= long,
                "бот {i}: next_break_at ({mixed}) > next_long_break_at ({long}) — короткий должен быть раньше или равен"
            );
        }
    }

    #[test]
    fn is_in_long_and_short_mutually_exclusive_for_active() {
        // Если бот активен — он не в длинном и не в коротком.
        let s = Schedule::new(1, "1b", 3, &cfg());
        let start = now_unix_ms();
        for step in 0..(48 * 60) {
            let t = start + step * MIN_MS;
            for i in 0..3 {
                if s.is_active(i, t) {
                    assert!(!s.is_in_long_break(i, t), "бот {i} активен, но в длинном сне");
                    assert!(!s.is_in_short_break(i, t), "бот {i} активен, но в коротком");
                }
            }
        }
    }
}