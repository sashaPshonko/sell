//! Очередь выдачи: 10 ботов, после 2 успешных `/pay` покупателям —
//! текущий уходит вниз, следующий становится дежурным.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const PAYS_BEFORE_ROTATE: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueueState {
    /// Ники по кругу. Индекс 0 — дежурный (выдаёт).
    pub order: Vec<String>,
    /// Сколько успешных выдач у текущего дежурного.
    #[serde(default)]
    pub pays: u32,
}

impl QueueState {
    pub fn from_nicks(nicks: &[String]) -> Self {
        Self {
            order: nicks.to_vec(),
            pays: 0,
        }
    }

    pub fn path(farm_root: &Path) -> PathBuf {
        farm_root.join("queue.json")
    }

    pub fn load_or_init(farm_root: &Path, nicks: &[String]) -> Self {
        let p = Self::path(farm_root);
        if let Ok(raw) = std::fs::read_to_string(&p) {
            if let Ok(mut q) = serde_json::from_str::<QueueState>(&raw) {
                for n in nicks {
                    if !q.order.iter().any(|x| x.eq_ignore_ascii_case(n)) {
                        q.order.push(n.clone());
                    }
                }
                q.order.retain(|n| nicks.iter().any(|x| x.eq_ignore_ascii_case(n)));
                if q.order.is_empty() {
                    return Self::from_nicks(nicks);
                }
                return q;
            }
        }
        Self::from_nicks(nicks)
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

    /// Успешная выдача. `true` = пора менять дежурного.
    pub fn on_delivery_ok(&mut self) -> bool {
        self.pays += 1;
        self.pays >= PAYS_BEFORE_ROTATE
    }

    /// Дежурный в конец, следующий становится первым. pays = 0.
    pub fn rotate(&mut self) {
        if self.order.len() < 2 {
            self.pays = 0;
            return;
        }
        let cur = self.order.remove(0);
        self.order.push(cur);
        self.pays = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn two_pays_then_rotate() {
        let mut q = QueueState::from_nicks(&["a".into(), "b".into(), "c".into()]);
        assert_eq!(q.duty(), Some("a"));
        assert!(!q.on_delivery_ok());
        assert!(q.on_delivery_ok());
        q.rotate();
        assert_eq!(q.duty(), Some("b"));
        assert_eq!(q.order.last().map(|s| s.as_str()), Some("a"));
        assert_eq!(q.pays, 0);
    }
}
