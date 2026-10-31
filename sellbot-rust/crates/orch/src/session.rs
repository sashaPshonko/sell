//! Смены выдачи: детерминированно от ника + дня MSK.
//!
//! Две смены в сутки, привязаны к суточному онлайну FunTime (как в логах
//! Go / capital: ночь 03–09 почти пустая, вечер — пик, corr(online, sales)≈0.5):
//!   • ночь (старт ~00–05) — **3–4 часа** (мало людей, один бот закрывает тишину)
//!   • вечер (старт ~16–22) — **1–2 часа** (пик, чаще меняем лицо)
//!
//! Непривязанные орк не смотрит на это окно.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

const DAY_MS: u64 = 24 * 3600 * 1000;
const HOUR_MS: u64 = 3600 * 1000;
const MIN_MS: u64 = 60 * 1000;
const MSK_OFFSET_MS: u64 = 3 * HOUR_MS;

fn mix(parts: &[&str], nums: &[u64]) -> u64 {
    let mut h = DefaultHasher::new();
    for p in parts {
        p.hash(&mut h);
    }
    for n in nums {
        n.hash(&mut h);
    }
    h.finish()
}

pub fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn msk_day(now_ms: u64) -> u64 {
    (now_ms + MSK_OFFSET_MS) / DAY_MS
}

fn day_start_utc_ms(day: u64) -> u64 {
    day * DAY_MS - MSK_OFFSET_MS
}

/// Ночная смена (длинная) и вечерняя (короткая): (start_utc_ms, end_utc_ms).
pub fn sessions_utc(nick: &str, index: usize, n: usize, salt: &str, day: u64) -> [(u64, u64); 2] {
    let n = n.max(1) as u64;
    let idx = index as u64;
    let h = mix(&[nick, salt], &[day, idx]);
    let start_day = day_start_utc_ms(day);

    // Ночь: старты размазаны 00:00–05:00, джиттер ±25 мин, длина 180–240 мин.
    let night_span = 5 * 60; // минут
    let night_slot = (idx.wrapping_mul(night_span) / n) as i64;
    let night_j = ((h % 51) as i64 - 25) * MIN_MS as i64;
    let night_off = (night_slot * MIN_MS as i64 + night_j)
        .clamp(0, 5 * 60 * MIN_MS as i64) as u64;
    let night_dur = (180 + ((h >> 8) % 61)) * MIN_MS;

    // Вечер/пик: старты 16:00–22:00, джиттер ±20 мин, длина 60–120 мин.
    let peak_span = 6 * 60;
    let peak_slot = (idx.wrapping_mul(peak_span) / n) as i64;
    let peak_j = (((h >> 16) % 41) as i64 - 20) * MIN_MS as i64;
    let peak_off = ((16 * 60 + peak_slot) * MIN_MS as i64 + peak_j)
        .clamp(16 * 60 * MIN_MS as i64, 22 * 60 * MIN_MS as i64) as u64;
    let peak_dur = (60 + ((h >> 24) % 61)) * MIN_MS;

    let ns = start_day + night_off;
    let ps = start_day + peak_off;
    [(ns, ns + night_dur), (ps, ps + peak_dur)]
}

pub fn is_awake(nick: &str, index: usize, n: usize, salt: &str, now_ms: u64) -> bool {
    let day = msk_day(now_ms);
    for d in [day.saturating_sub(1), day, day + 1] {
        for (s, e) in sessions_utc(nick, index, n, salt, d) {
            if now_ms >= s && now_ms < e {
                return true;
            }
        }
    }
    false
}

/// Конец текущей смены, если сейчас в ней.
pub fn session_end_ms(nick: &str, index: usize, n: usize, salt: &str, now_ms: u64) -> Option<u64> {
    let day = msk_day(now_ms);
    for d in [day.saturating_sub(1), day, day + 1] {
        for (s, e) in sessions_utc(nick, index, n, salt, d) {
            if now_ms >= s && now_ms < e {
                return Some(e);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn msk_hour_of(start_day: u64, t: u64) -> u64 {
        ((t - start_day) / HOUR_MS) % 24
    }

    #[test]
    fn night_long_peak_short() {
        let day = 20_000u64;
        let start = day_start_utc_ms(day);
        for idx in 0..10 {
            let [(ns, ne), (ps, pe)] = sessions_utc("bot", idx, 10, "s", day);
            let nd = ne - ns;
            let pd = pe - ps;
            assert!(
                nd >= 180 * MIN_MS && nd <= 240 * MIN_MS,
                "night dur {nd}"
            );
            assert!(pd >= 60 * MIN_MS && pd <= 120 * MIN_MS, "peak dur {pd}");
            let nh = msk_hour_of(start, ns);
            let ph = msk_hour_of(start, ps);
            assert!(nh <= 5, "night start hour {nh}");
            assert!((16..=22).contains(&ph), "peak start hour {ph}");
        }
    }

    #[test]
    fn not_24h() {
        let nick = "testbot";
        let mut awake = 0u32;
        let day0 = 20_000u64;
        let start = day_start_utc_ms(day0);
        for h in 0..24 {
            if is_awake(nick, 0, 10, "s", start + h * HOUR_MS) {
                awake += 1;
            }
        }
        assert!(awake >= 2 && awake <= 8, "awake hours {awake}");
    }

    #[test]
    fn stable_for_same_day() {
        let a = sessions_utc("aaa", 1, 10, "x", 100);
        let b = sessions_utc("aaa", 1, 10, "x", 100);
        assert_eq!(a, b);
    }
}
