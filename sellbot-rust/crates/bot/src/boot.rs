use std::sync::Arc;

use azalea::prelude::*;
use ipc::{BotBoot, OrchCmd};
use parking_lot::Mutex;
use tokio::io::{AsyncBufReadExt, BufReader};
use tracing::warn;

use crate::captcha::CaptchaMaps;
use crate::state::BotState;

pub async fn read_boot() -> anyhow::Result<BotBoot> {
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    let line = lines
        .next_line()
        .await?
        .ok_or_else(|| anyhow::anyhow!("stdin EOF — нет BotBoot"))?;
    let boot: BotBoot = serde_json::from_str(&line)?;

    let _ = GLOBAL.set(Global {
        boot: Arc::new(boot.clone()),
        state: Arc::new(Mutex::new(BotState::from_boot(&boot))),
        captcha_maps: Arc::new(Mutex::new(CaptchaMaps::default())),
        bot_client: Arc::new(Mutex::new(None)),
    });
    Ok(boot)
}

pub struct Global {
    pub boot: Arc<BotBoot>,
    pub state: Arc<Mutex<BotState>>,
    pub captcha_maps: Arc<Mutex<CaptchaMaps>>,
    pub bot_client: Arc<Mutex<Option<Client>>>,
}

static GLOBAL: std::sync::OnceLock<Global> = std::sync::OnceLock::new();

pub fn global() -> &'static Global {
    GLOBAL.get().expect("boot not read")
}

pub async fn stdin_loop(shared: Arc<Mutex<BotState>>) {
    let stdin = tokio::io::stdin();
    let mut lines = BufReader::new(stdin).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<OrchCmd>(&line) {
            Ok(cmd) => shared.lock().apply_cmd(cmd),
            Err(e) => warn!("stdin parse: {e} — {line}"),
        }
    }
}
