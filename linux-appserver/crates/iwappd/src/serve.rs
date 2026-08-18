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
use iw_codec::Tier;
use iw_proto::{FrameDecoder, PixelFormat, ServerCaps};
use smithay::reexports::calloop::ping::Ping;

use crate::backend::Backend;
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
    let mut app_env = launch_env::launch_env(&env, &runtime_dir, backend.socket_name());
    // A GTK4 application with no session bus waits for one forever rather than
    // failing, so this is resolved once, here, where looking at the host is
    // allowed — and reported, because "which bus" is the first question when an
    // application starts and never appears.
    let bus = launch_env::resolve_session_bus(
        &env,
        runtime_dir.join("bus").exists(),
        &runtime_dir,
        launch_env::on_path(env.get("PATH").map(String::as_str), "dbus-run-session"),
    );
    let launch_prefix = launch_env::apply_session_bus(&mut app_env, &bus);
    eprintln!("iwappd: session bus: {}", describe_bus(&bus));

    // Accessibility: only when the bus has an address both the apps and our
    // registry thread can dial. Started before anything launches, because
    // toolkits register themselves at startup and need somebody listening.
    let a11y_enabled = launch_env::apply_a11y(&mut app_env, &bus);
    let a11y = if let launch_env::SessionBus::Address(address) = &bus {
        let waker = backend.waker();
        eprintln!("iwappd: a11y: registry on the session bus");
        Some(crate::atspi::A11yHandle::start(
            address.clone(),
            move || waker.ping(),
        ))
    } else {
        None
    };

    // The audio server. A failure to bind (exotic mount options, path length)
    // costs audio, not the session — apps simply find no PulseAudio, exactly
    // as they would on the bare host.
    let audio = {
        let waker = backend.waker();
        match crate::pulse::start(
            &launch_env::audio_socket_dir(&runtime_dir, session_id),
            move || waker.ping(),
        ) {
            Ok(runtime) => {
                eprintln!("iwappd: audio: serving at {}", runtime.server_env);
                Some(runtime)
            }
            Err(err) => {
                eprintln!("iwappd: audio: disabled ({err})");
                None
            }
        }
    };
    launch_env::apply_audio(&mut app_env, audio.as_ref().map(|a| a.server_env.as_str()));

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
            audio: audio.is_some(),
            runtime_dir: true,
            a11y: a11y_enabled && a11y.is_some(),
        },
        pixel_format: PixelFormat::Bgra8888,
        keymap: String::new(),
        launch_env: app_env,
        launch_prefix,
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

        // Accessibility requests go to their own thread; a tree walk is
        // thousands of D-Bus round trips and the loop has frames to encode.
        for (window_id, request_id) in session.take_a11y_requests() {
            let pid = session.backend_mut().window_pid(window_id);
            let handed = a11y.as_ref().is_some_and(|handle| {
                handle.request(crate::atspi::A11yQuery {
                    window_id,
                    request_id,
                    pid,
                })
            });
            if !handed {
                session.on_a11y_result(
                    window_id,
                    request_id,
                    None,
                    Some("the accessibility service is not running".into()),
                );
            }
        }
        if let Some(handle) = &a11y {
            for result in handle.try_results() {
                session.on_a11y_result(
                    result.window_id,
                    result.request_id,
                    result.tree,
                    result.message,
                );
                last_activity = Instant::now();
            }
        }

        let pump_started = Instant::now();
        session.pump();

        if let Some(audio) = &audio {
            for chunk in audio.try_iter() {
                session.on_audio_chunk(&chunk);
                last_activity = Instant::now();
            }
        }

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
        stats.report(&session.window_load());

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
    if let Some(audio) = &audio {
        audio.shutdown();
    }
    Ok(())
}

/// A line for the log, so a session that cannot start an application says why.
fn describe_bus(bus: &launch_env::SessionBus) -> String {
    match bus {
        launch_env::SessionBus::Address(address) => address.clone(),
        launch_env::SessionBus::RunSession => "per-application, via dbus-run-session".into(),
        launch_env::SessionBus::None => {
            "none — install dbus, or enable lingering for this user; GTK4 applications need one"
                .into()
        }
    }
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

    fn report(&mut self, load: &[(u32, Tier, u8)]) {
        let elapsed = self.since.elapsed();
        if elapsed < STATS_EVERY {
            return;
        }
        // Nothing went out: the session was idle, and saying so every five
        // seconds for an hour helps nobody.
        if self.bytes > 0 {
            let seconds = elapsed.as_secs_f64().max(0.001);
            // The tier and quality are what explain the byte rate: a window on
            // the lossy tier at a quality the budget pushed down is a window
            // whose link cannot carry what it wants to send.
            let windows: Vec<String> = load
                .iter()
                .map(|(id, tier, quality)| match tier {
                    Tier::Image => format!("w{id}=lossy/q{quality}"),
                    Tier::Video => format!("w{id}=video"),
                    Tier::Lossless => format!("w{id}=lossless"),
                })
                .collect();
            eprintln!(
                "[stats] {:.0} turns/s, compositing {:.1}ms/s, encoding {:.1}ms/s (slowest frame {:.1}ms), {:.0} KiB/s{}{}",
                f64::from(self.turns) / seconds,
                self.dispatch.as_secs_f64() * 1000.0 / seconds,
                self.encode.as_secs_f64() * 1000.0 / seconds,
                self.slowest_encode.as_secs_f64() * 1000.0,
                self.bytes as f64 / 1024.0 / seconds,
                if windows.is_empty() { "" } else { ", " },
                windows.join(" "),
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
