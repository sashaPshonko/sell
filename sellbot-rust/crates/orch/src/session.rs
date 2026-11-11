//! Время и формат даты (MSK) для журнала. Времени смены больше нет: боты заходят по заказу.

const HOUR_MS: u64 = 3600 * 1000;
const MIN_MS: u64 = 60 * 1000;
const DAY_MS: u64 = 24 * HOUR_MS;
const MSK_OFFSET_MS: u64 = 3 * HOUR_MS;

pub fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// `дд.мм ЧЧ:ММ` по Москве.
pub fn fmt_msk(ms: u64) -> String {
    let t = ms + MSK_OFFSET_MS;
    let days = (t / DAY_MS) as i64;
    let rem = t % DAY_MS;
    // civil_from_days (Howard Hinnant)
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    format!(
        "{:02}.{:02} {:02}:{:02}",
        d,
        m,
        rem / HOUR_MS,
        rem % HOUR_MS / MIN_MS
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fmt_msk_known() {
        // 2026-11-01 00:00 MSK = 2026-10-31 21:00 UTC
        assert_eq!(fmt_msk(1_793_480_400_000), "01.11 00:00");
    }
}
