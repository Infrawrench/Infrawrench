//! The stdio serve loop: the mode Infrawrench actually execs over SSH.
//!
//! One thread reads stdin (an SSH channel gives no way to poll it alongside
//! the Wayland socket), everything else happens on this thread: a turn of the
//! compositor's event loop, then whatever the client asked for, then whatever
//! the compositor produced, then the bytes back out.

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use iw_apps::IconBudget;
use iw_proto::{FrameDecoder, PixelFormat, ServerCaps};

use crate::catalog::FsCatalog;
use crate::compositor::WaylandBackend;
use crate::launch_env;
use crate::session::{Session, SessionConfig};

/// How long a turn of the event loop may block waiting for a client request.
/// Short enough that stdin traffic is answered promptly, long enough that an
/// idle session is not a spin loop on someone else's VM.
const TURN: Duration = Duration::from_millis(8);

pub fn run(session_id: &str, idle_timeout: Duration, icon_size: u32) -> std::io::Result<()> {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let runtime_dir = launch_env::resolve_runtime_dir(
        env.get("XDG_RUNTIME_DIR").map(String::as_str),
        launch_env::current_uid(),
        Path::new("/tmp"),
    )?;

    let backend = WaylandBackend::new(session_id, runtime_dir.clone())
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let app_env = launch_env::launch_env(&env, &runtime_dir, backend.socket_name());

    let catalog = FsCatalog::from_env(
        &env,
        IconBudget {
            target_size: icon_size,
            ..IconBudget::default()
        },
    );

    let config = SessionConfig {
        session_id: session_id.to_owned(),
        version: crate::VERSION.to_owned(),
        caps: ServerCaps {
            vp9: false,
            webp: false,
            jpeg: true,
            xwayland: false,
            audio: false,
            runtime_dir: true,
        },
        pixel_format: PixelFormat::Bgra8888,
        keymap: String::new(),
        launch_env: app_env,
        ..SessionConfig::default()
    };

    let mut session = Session::new(backend, catalog, config);
    let mut decoder = FrameDecoder::new();
    let stdin_rx = spawn_stdin_reader();
    let stdout = std::io::stdout();

    let mut last_activity = Instant::now();
    let mut stdin_open = true;

    loop {
        session
            .backend_mut()
            .dispatch(TURN)
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        for event in session.backend_mut().poll_events() {
            session.on_backend_event(event);
            last_activity = Instant::now();
        }

        loop {
            match stdin_rx.try_recv() {
                Ok(Some(chunk)) => {
                    decoder.push(&chunk);
                    last_activity = Instant::now();
                }
                // Reader hit EOF: the SSH channel closed. Finish this turn so
                // any last frames flush, then stop.
                Ok(None) => {
                    stdin_open = false;
                    break;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    stdin_open = false;
                    break;
                }
            }
        }

        while let Some(frame) = decoder
            .next_frame()
            .map_err(|e| std::io::Error::other(e.to_string()))?
        {
            session.on_client_frame(frame);
        }

        session.pump();

        let outbound = session.drain();
        if !outbound.is_empty() {
            let mut handle = stdout.lock();
            for bytes in outbound {
                handle.write_all(&bytes)?;
            }
            handle.flush()?;
        }

        if session.is_ended() || !stdin_open {
            break;
        }

        // The idle timeout exists so a forgotten session does not sit on a
        // customer's host forever; a session with windows open is not idle
        // however quiet it is.
        if !idle_timeout.is_zero()
            && session.backend_mut().is_idle()
            && last_activity.elapsed() > idle_timeout
        {
            break;
        }
    }

    session.backend_mut().shutdown_processes();
    Ok(())
}

/// Read stdin on its own thread, forwarding chunks and then a single `None`
/// for EOF.
fn spawn_stdin_reader() -> mpsc::Receiver<Option<Vec<u8>>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(None);
                    return;
                }
                Ok(n) => {
                    if tx.send(Some(buf[..n].to_vec())).is_err() {
                        return;
                    }
                }
                Err(_) => {
                    let _ = tx.send(None);
                    return;
                }
            }
        }
    });
    rx
}
