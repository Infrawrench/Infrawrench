//! The capture harness: launch one application, screenshot its window a few
//! times, exit.
//!
//! This is how the compositor is smoke-tested without a client at the other
//! end of the protocol — and how a human sees, in one command, whether a real
//! application actually renders through it. It talks to the backend directly:
//! no session, no encoder, no flow control, so a failure here is unambiguously
//! the compositor's.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use iw_apps::IconBudget;

use crate::args::Capture;
use crate::backend::{Backend, BackendEvent, LaunchSpec};
use crate::catalog::{Catalog, FsCatalog};
use crate::compositor::WaylandBackend;
use crate::{launch_env, png};
use iw_proto::{ButtonState, InputEvent, PointerButton, fixed_from_px};

pub fn run(options: &Capture) -> std::io::Result<()> {
    let env: BTreeMap<String, String> = std::env::vars().collect();
    let runtime_dir = launch_env::resolve_runtime_dir(
        env.get("XDG_RUNTIME_DIR").map(String::as_str),
        launch_env::current_uid(),
        Path::new("/tmp"),
    )?;
    let out_dir = PathBuf::from(&options.out_dir);
    std::fs::create_dir_all(&out_dir)?;

    let mut backend = WaylandBackend::new("capture", runtime_dir.clone())
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    println!("compositor listening on {}", backend.socket_name());

    let mut app_env = launch_env::launch_env(&env, &runtime_dir, backend.socket_name());
    let bus = launch_env::resolve_session_bus(
        &env,
        runtime_dir.join("bus").exists(),
        &runtime_dir,
        launch_env::on_path(env.get("PATH").map(String::as_str), "dbus-run-session"),
    );
    let launch_prefix = launch_env::apply_session_bus(&mut app_env, &bus);
    println!("session bus: {bus:?}");
    let mut spec = resolve(options, &env, app_env)?;
    // The same prefix the serve loop applies, so what this harness exercises is
    // what a real session does.
    if !launch_prefix.is_empty() {
        let mut argv = launch_prefix;
        argv.extend(spec.argv);
        spec.argv = argv;
    }
    println!("launching {:?}", spec.argv);
    backend
        .launch(spec)
        .map_err(|e| std::io::Error::other(e.to_string()))?;

    let started = Instant::now();
    // Generous: a cold browser on a small VM takes its time, and a capture
    // that gives up early looks exactly like a compositor that never mapped
    // the window.
    let deadline =
        started + Duration::from_millis(options.interval_ms * options.frames as u64 + 60_000);

    let mut window: Option<u32> = None;
    let mut shots = 0u32;
    let mut next_shot = started + Duration::from_millis(options.interval_ms);
    let mut written = Vec::new();
    let mut scroll_after = false;

    while shots < options.frames && Instant::now() < deadline {
        backend
            .dispatch(Duration::from_millis(8))
            .map_err(|e| std::io::Error::other(e.to_string()))?;

        for event in backend.poll_events() {
            match event {
                BackendEvent::WindowOpened {
                    window_id,
                    title,
                    app_id,
                    width,
                    height,
                    parent_window_id,
                } => {
                    println!(
                        "window {window_id} opened: {title:?} app_id={app_id:?} {width}x{height} parent={parent_window_id:?}"
                    );
                    if window.is_none() && parent_window_id.is_none() {
                        window = Some(window_id);
                        backend
                            .configure(window_id, options.width, options.height, 1.0)
                            .map_err(|e| std::io::Error::other(e.to_string()))?;
                    }
                }
                BackendEvent::WindowMeta {
                    window_id,
                    title: Some(title),
                    ..
                } => println!("window {window_id} retitled: {title:?}"),
                BackendEvent::WindowClosed { window_id, .. } => {
                    println!("window {window_id} closed");
                    if window == Some(window_id) {
                        window = None;
                    }
                }
                BackendEvent::LaunchFailed { message, .. } => {
                    // The interesting failure: on a bare host this is almost
                    // always a missing library, and the child's own stderr is
                    // the whole diagnosis.
                    return Err(std::io::Error::other(format!("launch failed: {message}")));
                }
                _ => {}
            }
        }

        if scroll_after && let Some(window_id) = window {
            scroll_after = false;
            let now = started.elapsed().as_millis() as u32;
            let centre = (
                fixed_from_px(options.width as i32 / 2),
                fixed_from_px(options.height as i32 / 2),
            );
            let mut events = vec![
                InputEvent::PointerMotion {
                    time_ms: now,
                    x: centre.0,
                    y: centre.1,
                },
                // A click first: a browser only scrolls a page it considers
                // focused, and the pointer arriving is not the same as the
                // window being interacted with.
                InputEvent::PointerButton {
                    time_ms: now,
                    button: PointerButton::LEFT,
                    state: ButtonState::Pressed,
                },
                InputEvent::PointerButton {
                    time_ms: now + 10,
                    button: PointerButton::LEFT,
                    state: ButtonState::Released,
                },
            ];
            for notch in 0..options.scroll.unsigned_abs() {
                events.push(InputEvent::PointerAxis {
                    time_ms: now + 20 + notch * 10,
                    dx: 0,
                    // Wayland's convention is ten units per notch, in 24.8
                    // fixed point; the sign is the scroll direction.
                    dy: fixed_from_px(10) * options.scroll.signum(),
                });
            }
            println!("injecting {} scroll notch(es)", options.scroll);
            backend
                .send_input(window_id, &events)
                .map_err(|e| std::io::Error::other(e.to_string()))?;
        }

        // Consume a frame every turn whether or not we are saving it: frame
        // callbacks are what let the client draw the next one, so a harness
        // that only takes frames on its own schedule stalls the application it
        // is trying to photograph.
        let Some(window_id) = window else { continue };
        let due = Instant::now() >= next_shot;
        if let Some(frame) = backend.take_frame(window_id) {
            if due {
                let png = png::encode_bgra(frame.width, frame.height, frame.stride, frame.pixels);
                let path = out_dir.join(format!("frame-{:02}.png", shots + 1));
                std::fs::write(&path, &png)?;
                println!(
                    "shot {} → {} ({}x{}, {} KB)",
                    shots + 1,
                    path.display(),
                    frame.width,
                    frame.height,
                    png.len() / 1024
                );
                written.push(path);
                shots += 1;
                next_shot = Instant::now() + Duration::from_millis(options.interval_ms);
                scroll_after = options.scroll != 0 && shots < options.frames;
            }
        }
    }

    backend.shutdown();
    if written.is_empty() {
        return Err(std::io::Error::other(
            "no frames captured: the application never mapped a window",
        ));
    }
    println!("captured {} frame(s)", written.len());
    Ok(())
}

fn resolve(
    options: &Capture,
    env: &BTreeMap<String, String>,
    app_env: BTreeMap<String, String>,
) -> std::io::Result<LaunchSpec> {
    if let Some(app_id) = &options.app_id {
        let mut catalog = FsCatalog::from_env(env, IconBudget::default());
        let resolved = catalog
            .resolve(app_id)
            .ok_or_else(|| std::io::Error::other(format!("no desktop entry {app_id}")))?;
        return Ok(LaunchSpec {
            app_id: Some(resolved.app_id),
            argv: resolved.argv,
            env: app_env,
            cwd: resolved.cwd,
        });
    }

    let exec = options
        .exec
        .as_deref()
        .ok_or_else(|| std::io::Error::other("capture needs --app-id or --exec"))?;
    let argv = iw_apps::exec_argv(exec, "", None);
    if argv.is_empty() {
        return Err(std::io::Error::other("empty --exec"));
    }
    Ok(LaunchSpec {
        app_id: None,
        argv,
        env: app_env,
        cwd: None,
    })
}
