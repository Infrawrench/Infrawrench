//! `iwappd` — uploaded to a host over SSH and exec'd there.
//!
//! It speaks the protocol in `iw-proto` over stdin and stdout; no port is ever
//! listened on, and the only thing it needs from the host is a directory it can
//! put a Wayland socket in.
//!
//! Two modes need no compositor at all — `--list-apps` and `--caps` — so
//! `infrawrench apps list` can answer over a plain SSH exec before any session
//! is started.

use std::collections::BTreeMap;

use iw_apps::IconBudget;
use iw_proto::ServerCaps;
use iwappd::args::{self, Command};
use iwappd::catalog::{Catalog, FsCatalog};
use iwappd::launch_env;

fn main() {
    let parsed = match args::parse(std::env::args().skip(1)) {
        Ok(parsed) => parsed,
        Err(err) => {
            eprintln!("iwappd: {err}\n\n{}", args::HELP);
            std::process::exit(2);
        }
    };

    let env: BTreeMap<String, String> = std::env::vars().collect();

    match parsed.command {
        Command::Help => println!("{}", args::HELP),
        Command::Version => println!("{}", iwappd::VERSION),
        Command::Caps { json } => print_caps(json),
        Command::ListApps { json } => {
            let mut catalog = FsCatalog::from_env(
                &env,
                IconBudget {
                    target_size: parsed.icon_size,
                    ..IconBudget::default()
                },
            );
            print_apps(&mut catalog, json);
        }
        Command::Serve => serve(&parsed),
        Command::Capture(capture) => run_capture(&capture),
    }
}

#[cfg(target_os = "linux")]
fn serve(args: &args::Args) {
    let idle = std::time::Duration::from_secs(args.idle_timeout_secs);
    if let Err(err) = iwappd::serve::run(&args.session_id, idle, args.icon_size) {
        eprintln!("iwappd: {err}");
        std::process::exit(1);
    }
}

#[cfg(target_os = "linux")]
fn run_capture(capture: &args::Capture) {
    if let Err(err) = iwappd::capture::run(capture) {
        eprintln!("iwappd: {err}");
        std::process::exit(1);
    }
}

/// The compositor is the Linux-only half. Elsewhere, say so plainly and with a
/// distinct exit code rather than hanging on a stdin nobody will answer.
#[cfg(not(target_os = "linux"))]
fn serve(_args: &args::Args) {
    no_compositor();
}

#[cfg(not(target_os = "linux"))]
fn run_capture(_capture: &args::Capture) {
    no_compositor();
}

#[cfg(not(target_os = "linux"))]
fn no_compositor() -> ! {
    eprintln!(
        "iwappd: this build has no compositor backend (target {}). Use --list-apps or --caps.",
        std::env::consts::OS
    );
    std::process::exit(3);
}

fn host_caps() -> ServerCaps {
    ServerCaps {
        // Declared false until the encoders exist, so a client never waits for
        // a tier this build cannot produce.
        vp9: false,
        webp: false,
        // The JPEG encoder is compiled in, so the lossy tier is always
        // available — unlike VP9, which has no encoder yet.
        jpeg: true,
        xwayland: false,
        audio: false,
        runtime_dir: launch_env::resolve_runtime_dir(
            std::env::var("XDG_RUNTIME_DIR").ok().as_deref(),
            current_uid(),
            std::path::Path::new("/tmp"),
        )
        .is_ok(),
    }
}

fn print_caps(json: bool) {
    let caps = host_caps();
    if json {
        println!(
            "{}",
            serde_json::to_string(&caps).expect("caps are serialisable")
        );
        return;
    }
    println!("version      {}", iwappd::VERSION);
    println!("protocol     {}", iw_proto::PROTOCOL_VERSION);
    println!("runtime dir  {}", yes_no(caps.runtime_dir));
    println!("vp9          {}", yes_no(caps.vp9));
    println!("webp         {}", yes_no(caps.webp));
    println!("xwayland     {}", yes_no(caps.xwayland));
    println!("audio        {}", yes_no(caps.audio));
}

fn print_apps(catalog: &mut impl Catalog, json: bool) {
    let apps = catalog.list(true);
    if json {
        println!(
            "{}",
            serde_json::to_string(&apps).expect("app entries are serialisable")
        );
        return;
    }
    if apps.is_empty() {
        println!("no graphical applications found on this host");
        return;
    }
    let width = apps.iter().map(|a| a.name.len()).max().unwrap_or(0).min(32);
    for app in &apps {
        let flag = if app.needs_terminal {
            " (terminal)"
        } else {
            ""
        };
        println!("{:width$}  {}{}", app.name, app.id, flag, width = width);
    }
}

fn yes_no(value: bool) -> &'static str {
    if value { "yes" } else { "no" }
}

/// The process uid, used only to name a fallback runtime directory.
#[cfg(unix)]
fn current_uid() -> u32 {
    // SAFETY: getuid takes no arguments, touches no memory we own, and cannot
    // fail — it is one of the few libc calls with no failure mode at all.
    unsafe { getuid() }
}

#[cfg(unix)]
unsafe extern "C" {
    fn getuid() -> u32;
}

#[cfg(not(unix))]
fn current_uid() -> u32 {
    0
}
