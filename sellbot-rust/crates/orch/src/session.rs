//! Рандомные сессии выдачи (детерминированно от ника + дня MSK).
//!
//! У каждого бота **две** смены в сутки, каждая **не длиннее 2 часов**
//! (50–120 мин). Старт размазан по кругу с джиттером ±50 мин.
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

/// Две смены за календарный день MSK: (start_utc_ms, end_utc_ms).
pub fn sessions_utc(nick: &str, index: usize, n: usize, salt: &str, day: u64) -> [(u64, u64); 2] {
    let n = n.max(1) as u64;
    let idx = index as u64;
    let h = mix(&[nick, salt], &[day, idx]);
    let spread = DAY_MS / n;
    let jitter = ((h % 101) as i64 - 50) * MIN_MS as i64; // ±50 мин
    let base = (idx.wrapping_mul(spread)) as i64 + jitter;
    let base = ((base % DAY_MS as i64) + DAY_MS as i64) as u64 % DAY_MS;

    let dur1 = (50 + (h >> 8) % 71) * MIN_MS; // 50–120 мин
    let gap = (10 * HOUR_MS) + ((h >> 16) % 180) * MIN_MS; // ~10–13ч до второй
    let dur2 = (50 + (h >> 24) % 71) * MIN_MS; // 50–120 мин

    let start_day = day_start_utc_ms(day);
    let s1 = start_day + base;
    let e1 = s1 + dur1;
    let s2 = s1 + gap;
    let e2 = s2 + dur2;
    [(s1, e1), (s2, e2)]
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
        assert!(awake >= 1 && awake <= 5, "awake hours {awake}");
    }

    #[test]
    fn max_two_hours() {
        for day in [100u64, 101, 500] {
            for idx in 0..10 {
                for (s, e) in sessions_utc("aaa", idx, 10, "x", day) {
                    let d = e.saturating_sub(s);
                    assert!(d <= 2 * HOUR_MS, "dur {d}");
                    assert!(d >= 50 * MIN_MS, "dur {d}");
                }
            }
        }
    }

    #[test]
    fn stable_for_same_day() {
        let a = sessions_utc("aaa", 1, 10, "x", 100);
        let b = sessions_utc("aaa", 1, 10, "x", 100);
        assert_eq!(a, b);
    }
}
