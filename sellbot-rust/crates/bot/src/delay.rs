//! Паузы из `delay.json` (POLL, WAIT_ANARCHY).

use std::sync::OnceLock;
use std::time::Duration;

use rand::Rng;
use serde_json::Value;

static TIMING: OnceLock<Value> = OnceLock::new();

fn timing() -> &'static Value {
    TIMING.get_or_init(|| {
        serde_json::from_str(include_str!("../delay.json")).expect("delay.json")
    })
}

pub fn init_bot_delay_profile(_username: &str) {}

pub fn get_ms(key: &str) -> u64 {
    let range = timing()
        .get(key)
        .unwrap_or_else(|| panic!("нет задержки: {key}"));
    let mut rng = rand::thread_rng();
    if let Some(n) = range.as_u64() {
        n
    } else if let Some(n) = range.as_i64() {
        n.max(0) as u64
    } else {
        let min = range
            .get("min")
            .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|i| i.max(0) as u64)))
            .unwrap_or(0);
        let max = range
            .get("max")
            .and_then(|v| v.as_u64().or_else(|| v.as_i64().map(|i| i.max(0) as u64)))
            .unwrap_or(min);
        if max <= min {
            min
        } else {
            rng.gen_range(min..=max)
        }
    }
}

pub fn duration(key: &str) -> Duration {
    Duration::from_millis(get_ms(key))
}

pub async fn rnd(key: &str) {
    tokio::time::sleep(duration(key)).await;
}
