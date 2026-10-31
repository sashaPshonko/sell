//! Sell-bot: логин, капча, /an, выдача `/pay`. Без АХ и казначея.

mod afk;
mod anarchy;
mod boot;
mod captcha;
mod cmd;
mod delay;
mod delivery;
mod safe_inv;
mod state;

use std::{
    sync::{
        atomic::{AtomicBool, AtomicU8, Ordering},
        Arc,
    },
    time::Duration,
};

use azalea::{
    prelude::*,
    protocol::{connect::Proxy, packets::game::ClientboundGamePacket},
    JoinOpts,
};
use ipc::{emit, emit_text, WorkerMsg};
use serde_json::json;
use socks5_impl::protocol::UserKey;
use tracing::{info, warn};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let boot = boot::read_boot().await?;
    ipc::pretty_log::init_bot(&boot.username);
    delay::init_bot_delay_profile(&boot.username);
    info!("старт · an{} · выдача", boot.anarchy);

    let g = boot::global();
    tokio::spawn(boot::stdin_loop(g.state.clone()));

    let proxy = parse_proxy(&boot.proxy)?;
    let account = Account::offline(&boot.username);
    let opts = JoinOpts::new().server_proxy(proxy);
    let server = boot.server.clone();

    ClientBuilder::new()
        .set_handler(handle)
        .start_with_opts(account, server.as_str(), opts)
        .await;
    Ok(())
}

#[derive(Clone, Component, Default)]
struct HandleState {
    phase: Arc<AtomicU8>,
    loop_armed: Arc<AtomicBool>,
}

fn parse_proxy(url: &str) -> anyhow::Result<Proxy> {
    let raw = if url.contains("://") {
        url.to_string()
    } else {
        format!("socks5://{url}")
    };
    let u = url::Url::parse(&raw)?;
    let host = u.host_str().unwrap_or("127.0.0.1");
    let port = u.port().unwrap_or(1080);
    let addr = format!("{host}:{port}").parse()?;
    let auth = match (u.username(), u.password()) {
        (user, Some(pass)) if !user.is_empty() => Some(UserKey::new(user, pass.to_string())),
        _ => None,
    };
    Ok(Proxy::new(addr, auth))
}

async fn handle(bot: Client, event: Event, state: HandleState) -> anyhow::Result<()> {
    let g = boot::global();
    match event {
        Event::Spawn => {
            *g.bot_client.lock() = Some(bot.clone());
            let boot = g.boot.clone();
            info!("логин → /reg + /l");
            crate::cmd::say(&bot, format!("/reg {}", boot.password));
            crate::cmd::say(&bot, format!("/l {}", boot.password));
            state.phase.store(1, Ordering::SeqCst);

            let bot2 = bot.clone();
            let phase = state.phase.clone();
            let loop_armed = state.loop_armed.clone();
            let inner = g.state.clone();
            let boot2 = boot.clone();

            if loop_armed.swap(true, Ordering::SeqCst) {
                return Ok(());
            }
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("boot rt");

                let boot_ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    rt.block_on(async {
                        tokio::time::sleep(Duration::from_secs(3)).await;
                        if phase.load(Ordering::SeqCst) < 2 {
                            phase.store(2, Ordering::SeqCst);
                        }
                        inner.lock().funauth_verified = false;
                        if !anarchy::wait_until_on_anarchy(&bot2, &boot2, &inner).await {
                            if inner.lock().banned {
                                warn!("бан — выдачу не стартую");
                            } else {
                                warn!("на анку не зашли — выдачу не стартую");
                            }
                            return false;
                        }
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        {
                            let st = inner.lock();
                            if st.banned || st.shutdown || st.funauth_restarting {
                                return false;
                            }
                        }

                        emit(&WorkerMsg {
                            name: "funauth_verified".into(),
                            username: Some(boot2.username.clone()),
                            ..empty_msg()
                        });
                        inner.lock().funauth_verified = true;
                        phase.store(3, Ordering::SeqCst);

                        {
                            let inner_tick = inner.clone();
                            let boot_tick = boot2.clone();
                            std::thread::spawn(move || {
                                let rt_tick = match tokio::runtime::Builder::new_current_thread()
                                    .enable_all()
                                    .build()
                                {
                                    Ok(rt) => rt,
                                    Err(e) => {
                                        warn!("funauth ticker: {e:#}");
                                        return;
                                    }
                                };
                                rt_tick.block_on(async move {
                                    loop {
                                        tokio::time::sleep(Duration::from_secs(30)).await;
                                        let (banned, shutdown, restarting, on_anarchy, verified) = {
                                            let st = inner_tick.lock();
                                            (
                                                st.banned,
                                                st.shutdown,
                                                st.funauth_restarting,
                                                st.on_anarchy,
                                                st.funauth_verified,
                                            )
                                        };
                                        if banned || shutdown || restarting {
                                            break;
                                        }
                                        if !on_anarchy || !verified {
                                            continue;
                                        }
                                        emit(&WorkerMsg {
                                            name: "funauth_verified".into(),
                                            username: Some(boot_tick.username.clone()),
                                            ..empty_msg()
                                        });
                                    }
                                });
                            });
                        }

                        !(inner.lock().banned || inner.lock().shutdown)
                    })
                }));
                match boot_ok {
                    Ok(false) => {
                        loop_armed.store(false, Ordering::SeqCst);
                        return;
                    }
                    Err(e) => {
                        warn!("boot panic: {e:?}");
                        loop_armed.store(false, Ordering::SeqCst);
                        return;
                    }
                    Ok(true) => {}
                }

                loop {
                    if inner.lock().banned || inner.lock().shutdown {
                        break;
                    }
                    let bot_loop = bot2.clone();
                    let boot_loop = boot2.clone();
                    let inner_loop = inner.clone();
                    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        rt.block_on(delivery::run_loop(bot_loop, boot_loop, inner_loop));
                    }));
                    if inner.lock().banned || inner.lock().shutdown {
                        break;
                    }
                    let wait = match &result {
                        Ok(()) => Duration::from_secs(3),
                        Err(e) => {
                            warn!("выдача panic: {e:?}");
                            Duration::from_secs(5)
                        }
                    };
                    std::thread::sleep(wait);
                }
                loop_armed.store(false, Ordering::SeqCst);
            });
        }
        Event::Chat(m) => {
            let text = m.content();
            if !text.is_empty() {
                ipc::pretty_log::line(
                    &g.boot.username,
                    ipc::pretty_log::LineKind::Chat,
                    &text,
                );
                handle_chat(&bot, &text);
            }
        }
        Event::Packet(packet) => match packet.as_ref() {
            ClientboundGamePacket::Transfer(_) => {
                anarchy::clear_anarchy(&g.state, "transfer");
            }
            other => {
                captcha::on_packet(&g.captcha_maps, other);
            }
        },
        Event::Disconnect(reason) => {
            let r = format!("{reason:?}");
            warn!("disconnect {r}");
            g.state.lock().on_anarchy = false;
            let low = r.to_lowercase();
            if low.contains("забанен") || low.contains("banned") {
                mark_banned(&r);
            } else if is_wrong_password_text(&r) {
                warn!("неверный пароль (kick) → exit 71");
                emit(&WorkerMsg {
                    name: "auth_fault".into(),
                    username: Some(g.boot.username.clone()),
                    reason: Some(r.clone()),
                    data: Some(json!({ "kind": "bad_password" })),
                    ..empty_msg()
                });
                std::thread::spawn(|| {
                    std::thread::sleep(Duration::from_millis(400));
                    std::process::exit(71);
                });
            }
            emit(&WorkerMsg {
                name: "kicked".into(),
                username: Some(g.boot.username.clone()),
                reason: Some(r),
                ..empty_msg()
            });
        }
        _ => {}
    }
    Ok(())
}

fn mark_banned(reason: &str) {
    let g = boot::global();
    {
        let mut st = g.state.lock();
        if st.banned {
            return;
        }
        st.banned = true;
        st.shutdown = true;
        st.on_anarchy = false;
    }
    warn!("бан: {reason}");
    emit(&WorkerMsg {
        name: "banned".into(),
        username: Some(g.boot.username.clone()),
        reason: Some(reason.to_string()),
        ..empty_msg()
    });
    std::thread::spawn(|| {
        std::thread::sleep(Duration::from_millis(500));
        std::process::exit(0);
    });
}

fn handle_chat(bot: &Client, text: &str) {
    let g = boot::global();
    let low = text.to_lowercase();
    let pass = &g.boot.password;
    let user = &g.boot.username;
    crate::delivery::on_chat(&g.state, text);

    if is_staff_check_text(text) {
        warn!("проверка читов → Go");
        emit(&WorkerMsg {
            name: "staff_check".into(),
            username: Some(user.clone()),
            reason: Some(text.chars().take(1500).collect()),
            data: Some(json!({ "anarchy": g.boot.anarchy })),
            ..empty_msg()
        });
        return;
    }

    if anarchy::on_lobby_broadcast(&g.state, text) {
        return;
    }

    if text.contains("Здесь нет команд") {
        anarchy::clear_anarchy(&g.state, "нет команд");
        return;
    }

    if text.contains("Вы уже подключены к этому серверу") {
        anarchy::mark_anarchy_joined(&g.boot, &g.state);
        return;
    }

    if low.contains("введите номер с картинки")
        || (text.contains("BotFilter >>") && low.contains("картинк"))
    {
        let start = {
            let mut st = g.state.lock();
            if st.captcha_busy {
                false
            } else {
                st.captcha_busy = true;
                st.captcha_ok = false;
                st.captcha_wrong = false;
                true
            }
        };
        if start {
            emit_text(&format!("{user} - решаю капчу"));
            emit(&WorkerMsg {
                name: "captcha".into(),
                username: Some(user.clone()),
                reason: Some("solving".into()),
                ..empty_msg()
            });
            let bot2 = bot.clone();
            let maps = g.captcha_maps.clone();
            let pass = pass.clone();
            let user2 = user.clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("captcha rt");
                let res = rt.block_on(captcha::handle_captcha_login(
                    &bot2, &maps, &pass, &user2,
                ));
                let g = boot::global();
                g.state.lock().captcha_busy = false;
                match res {
                    Ok(()) => {
                        emit_text(&format!("{user2} - капча решена"));
                    }
                    Err(e) => {
                        warn!("капча fail: {e:#}");
                        emit_text(&format!("{user2} - капча fail: {e}"));
                        emit(&WorkerMsg {
                            name: "captcha".into(),
                            username: Some(user2),
                            reason: Some(format!("fail:{e}")),
                            ..empty_msg()
                        });
                    }
                }
            });
        }
    } else if low.contains("проверка пройдена") {
        let mut st = g.state.lock();
        st.captcha_busy = false;
        st.captcha_ok = true;
        st.captcha_wrong = false;
        drop(st);
        emit_text(&format!("{user} - капча ок"));
    } else if low.contains("капчу неправильно") {
        g.state.lock().captcha_wrong = true;
        emit_text(&format!("{user} - капча неправильно"));
    } else if low.contains("зарегистрируйтесь") || text.contains("/reg <") {
        if g.state.lock().captcha_busy {
            return;
        }
        crate::cmd::say(bot, format!("/reg {pass}"));
        crate::cmd::say(bot, format!("/l {pass}"));
    } else if low.contains("авторизируйтесь") || text.contains("/l <") || text.contains("/login") {
        if g.state.lock().captcha_busy {
            return;
        }
        crate::cmd::say(bot, format!("/l {pass}"));
    } else if low.contains("вы забанены") {
        mark_banned(text);
    } else if is_wrong_password_text(text) {
        warn!("неверный пароль → exit 71");
        emit_text("неверный пароль");
        emit(&WorkerMsg {
            name: "auth_fault".into(),
            username: Some(user.clone()),
            reason: Some(text.chars().take(500).collect()),
            data: Some(json!({ "kind": "bad_password" })),
            ..empty_msg()
        });
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(400));
            std::process::exit(71);
        });
    } else if low.contains("подтвердите вход")
        || (low.contains("личные сообщения") && low.contains("подтвердите"))
    {
        {
            let mut st = g.state.lock();
            if st.funauth_restarting {
                return;
            }
            st.funauth_verified = false;
            st.funauth_restarting = true;
            st.shutdown = true;
        }
        emit_text("funauth 2fa → рестарт воркера");
        emit(&WorkerMsg {
            name: "funauth_2fa".into(),
            username: Some(user.clone()),
            ..empty_msg()
        });
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(400));
            std::process::exit(0);
        });
    } else if low.contains("/vk") {
        {
            let mut st = g.state.lock();
            if st.funauth_restarting {
                return;
            }
            st.funauth_verified = false;
            st.funauth_restarting = true;
            st.shutdown = true;
        }
        emit_text("funauth bind → рестарт воркера");
        emit(&WorkerMsg {
            name: "funauth_bind".into(),
            username: Some(user.clone()),
            ..empty_msg()
        });
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(400));
            std::process::exit(0);
        });
    } else if text.contains("Данная команда недоступна в режиме AFK") {
        g.state.lock().afk = true;
        ipc::pretty_log::line(user, ipc::pretty_log::LineKind::Afk, "сервер сказал AFK");
    } else if let Some(bal) = parse_balance(text) {
        g.state.lock().balance = Some(bal);
        emit(&WorkerMsg {
            name: "balance".into(),
            username: Some(user.clone()),
            balance: Some(bal),
            ..empty_msg()
        });
    }
}

fn is_wrong_password_text(text: &str) -> bool {
    let s = text.to_lowercase();
    s.contains("неправильный пароль")
        || s.contains("неверный пароль")
        || s.contains("wrong password")
        || s.contains("incorrect password")
}

fn parse_balance(text: &str) -> Option<f64> {
    let low = text.to_lowercase();
    if !low.contains("баланс") && !low.contains("монет") {
        return None;
    }
    let cleaned: String = text
        .chars()
        .map(|c| {
            if c.is_ascii_digit() || c == ',' || c == '.' || c == ' ' {
                c
            } else {
                ' '
            }
        })
        .collect();
    let mut best: Option<f64> = None;
    for part in cleaned.split_whitespace() {
        let p = part.replace(',', "");
        if let Ok(n) = p.parse::<f64>() {
            if n >= 1.0 {
                best = Some(best.map(|b: f64| b.max(n)).unwrap_or(n));
            }
        }
    }
    best
}

pub fn empty_msg() -> WorkerMsg {
    WorkerMsg {
        name: String::new(),
        username: None,
        reason: None,
        items: None,
        data: None,
        id: None,
        price: None,
        balance: None,
        lots: None,
        extra: json!({}),
    }
}

fn is_staff_check_text(raw: &str) -> bool {
    let lower = raw.to_lowercase();
    if lower.contains("вызваны на проверку читов") {
        return true;
    }
    if lower.contains("проверку читов") && lower.contains("признание") {
        return true;
    }
    if lower.contains("проверка выполняется через") && lower.contains("anydesk") {
        return true;
    }
    if lower.contains("anydesk") && lower.contains("rustdesk") {
        return true;
    }
    false
}
