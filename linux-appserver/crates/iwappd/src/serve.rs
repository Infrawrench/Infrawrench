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
use smithay::reexports::calloop::ping::Ping;

use crate::catalog::FsCatalog;
use crate::compositor::WaylandBackend;
use crate::launch_env;
use crate::session::{Session, SessionConfig};

/// How long a turn of the event loop may block waiting for a client request.
/// Short enough that stdin traffic is answered promptly, long enough that an
/// idle session is not a spin loop on someone else's VM.
const TURN: Duration = Duration::from_millis(8);

/// How often the loop reports what it has been doing, when it has been doing
/// anything. One line per interval of *activity* — a quiet session says
/// nothing — written to stderr, which both apps already forward into their
/// logs. Latency questions are otherwise unanswerable from the outside: the
/// user sees "laggy" and everything below is a guess.
const STATS_EVERY: Duration = Duration::from_secs(5);

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
    // The reader wakes the compositor's event loop as soon as it has bytes, so
    // a keystroke is acted on when it arrives rather than whenever the current
    // turn happens to end.
    let stdin_rx = spawn_stdin_reader(session.backend_mut().waker());
    let stdout = std::io::stdout();

    let mut last_activity = Instant::now();
    let mut stdin_open = true;
    let mut stats = Stats::default();

    loop {
        let turn_started = Instant::now();
        session
            .backend_mut()
            .dispatch(TURN)
            .map_err(|e| std::io::Error::other(e.to_string()))?;
        let dispatched = Instant::now();

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

        let pump_started = Instant::now();
        session.pump();

        let outbound = session.drain();
        let outbound_bytes: usize = outbound.iter().map(Vec::len).sum();
        if !outbound.is_empty() {
            let mut handle = stdout.lock();
            for bytes in outbound {
                handle.write_all(&bytes)?;
            }
            handle.flush()?;
        }

        // Compositing happens inside `dispatch`, in the commit handler, so the
        // two numbers separate "the host is slow at drawing" from "the host is
        // slow at encoding" — which want completely different fixes.
        stats.record(
            dispatched.saturating_duration_since(turn_started),
            pump_started.elapsed(),
            outbound_bytes,
        );
        stats.report();

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

/// What the loop has been spending its time on since the last report.
struct Stats {
    since: Instant,
    turns: u32,
    dispatch: Duration,
    encode: Duration,
    slowest_encode: Duration,
    bytes: usize,
}

impl Default for Stats {
    fn default() -> Self {
        Self {
            since: Instant::now(),
            turns: 0,
            dispatch: Duration::ZERO,
            encode: Duration::ZERO,
            slowest_encode: Duration::ZERO,
            bytes: 0,
        }
    }
}

impl Stats {
    fn record(&mut self, dispatch: Duration, encode: Duration, bytes: usize) {
        self.turns += 1;
        self.dispatch += dispatch;
        self.encode += encode;
        self.slowest_encode = self.slowest_encode.max(encode);
        self.bytes += bytes;
    }

    fn report(&mut self) {
        let elapsed = self.since.elapsed();
        if elapsed < STATS_EVERY {
            return;
        }
        // Nothing went out: the session was idle, and saying so every five
        // seconds for an hour helps nobody.
        if self.bytes > 0 {
            let seconds = elapsed.as_secs_f64().max(0.001);
            eprintln!(
                "[stats] {:.0} turns/s, compositing {:.1}ms/s, encoding {:.1}ms/s (slowest frame {:.1}ms), {:.0} KiB/s",
                f64::from(self.turns) / seconds,
                self.dispatch.as_secs_f64() * 1000.0 / seconds,
                self.encode.as_secs_f64() * 1000.0 / seconds,
                self.slowest_encode.as_secs_f64() * 1000.0,
                self.bytes as f64 / 1024.0 / seconds,
            );
        }
        *self = Self::default();
    }
}

/// Read stdin on its own thread, forwarding chunks and then a single `None`
/// for EOF.
fn spawn_stdin_reader(waker: Ping) -> mpsc::Receiver<Option<Vec<u8>>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(None);
                    waker.ping();
                    return;
                }
                Ok(n) => {
                    if tx.send(Some(buf[..n].to_vec())).is_err() {
                        return;
                    }
                    waker.ping();
                }
                Err(_) => {
                    let _ = tx.send(None);
                    waker.ping();
                    return;
                }
            }
        }
    });
    rx
}
