//! Очередь выдачи: любое число ботов (1 и больше). Держатель денег — `order[0]`.
//! Времени смены нет: держатель выдаёт `PAYS_BEFORE_ROTATE` (2) заказа покупателям, третьим
//! переводом отдаёт весь остаток следующему и уходит в конец очереди. Боты заходят только по делу
//! (выдать заказ или принять остаток), остальное время офлайн.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const PAYS_BEFORE_ROTATE: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueState {
    /// Ники по кругу. Индекс 0 — держатель денег (выдаёт).
    pub order: Vec<String>,
    /// Сколько успешных выдач покупателям у текущего держателя.
    #[serde(default)]
    pub pays: u32,
    #[serde(default)]
    pub salt: String,
    /// Сколько раз передавали остаток (для журнала).
    #[serde(default)]
    pub shift_no: u64,
    /// Когда последний раз передали остаток.
    #[serde(default)]
    pub shift_start_ms: u64,
}

impl QueueState {
    pub fn from_nicks(nicks: &[String], salt: &str) -> Self {
        Self {
            order: nicks.to_vec(),
            pays: 0,
            salt: salt.to_string(),
            shift_no: 0,
            shift_start_ms: 0,
        }
    }

    pub fn path(farm_root: &Path) -> PathBuf {
        farm_root.join("queue.json")
    }

    /// Состояние переживает рестарт (кто держатель, сколько у него выдач).
    pub fn load_or_init(farm_root: &Path, nicks: &[String], salt: &str) -> Self {
        let mut q = std::fs::read_to_string(Self::path(farm_root))
            .ok()
            .and_then(|raw| serde_json::from_str::<QueueState>(&raw).ok())
            .filter(|q| !q.order.is_empty())
            .unwrap_or_else(|| Self::from_nicks(nicks, salt));
        let old_duty = q.duty().map(|s| s.to_string());
        for n in nicks {
            if !q.order.iter().any(|x| x.eq_ignore_ascii_case(n)) {
                q.order.push(n.clone());
            }
        }
        q.order.retain(|n| nicks.iter().any(|x| x.eq_ignore_ascii_case(n)));
        if q.order.is_empty() {
            q = Self::from_nicks(nicks, salt);
        }
        if q.salt.is_empty() {
            q.salt = salt.to_string();
        }
        if q.duty().map(|s| s.to_string()) != old_duty {
            q.pays = 0;
        }
        q
    }

    pub fn save(&self, farm_root: &Path) {
        let p = Self::path(farm_root);
        if let Ok(s) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(p, s);
        }
    }

    pub fn duty(&self) -> Option<&str> {
        self.order.first().map(|s| s.as_str())
    }

    pub fn next(&self) -> Option<&str> {
        self.order.get(1).map(|s| s.as_str())
    }

    /// Успешная выдача покупателю. `true` = пора передавать остаток следующему.
    pub fn on_delivery_ok(&mut self) -> bool {
        self.pays += 1;
        self.pays >= PAYS_BEFORE_ROTATE
    }

    /// Нужно ли передавать остаток (и есть ли кому).
    pub fn rotation_due(&self) -> bool {
        self.pays >= PAYS_BEFORE_ROTATE && self.order.len() >= 2
    }

    /// Держатель в конец, следующий становится первым. pays = 0.
    pub fn rotate(&mut self, now: u64) {
        if self.order.len() >= 2 {
            let cur = self.order.remove(0);
            self.order.push(cur);
        }
        self.pays = 0;
        self.shift_no += 1;
        self.shift_start_ms = now;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn nicks(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn two_pays_then_rotate() {
        let mut q = QueueState::from_nicks(&nicks(&["a", "b", "c"]), "s");
        assert_eq!(q.duty(), Some("a"));
        assert!(!q.on_delivery_ok());
        assert!(!q.rotation_due());
        assert!(q.on_delivery_ok());
        assert!(q.rotation_due());
        q.rotate(2_000);
        assert_eq!(q.duty(), Some("b"));
        assert_eq!(q.next(), Some("c"));
        assert_eq!(q.order.last().map(|s| s.as_str()), Some("a"));
        assert_eq!(q.pays, 0);
        assert_eq!(q.shift_no, 1);
    }

    #[test]
    fn single_bot_never_rotates() {
        let mut q = QueueState::from_nicks(&nicks(&["solo"]), "s");
        q.on_delivery_ok();
        q.on_delivery_ok();
        assert!(!q.rotation_due());
        q.rotate(9_000);
        assert_eq!(q.duty(), Some("solo"));
        assert_eq!(q.pays, 0);
    }

    #[test]
    fn restart_keeps_holder_and_pays() {
        let dir = std::env::temp_dir().join(format!("q-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let n = nicks(&["a", "b"]);
        let mut q1 = QueueState::from_nicks(&n, "s");
        q1.pays = 1;
        q1.save(&dir);
        let q2 = QueueState::load_or_init(&dir, &n, "other");
        assert_eq!(q2.duty(), Some("a"));
        assert_eq!(q2.pays, 1);
        // держатель убран из списка ботов — счётчик у нового держателя с нуля
        let q3 = QueueState::load_or_init(&dir, &nicks(&["b", "c"]), "s");
        assert_eq!(q3.duty(), Some("b"));
        assert_eq!(q3.pays, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
