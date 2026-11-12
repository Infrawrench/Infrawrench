//! `iwci serve`: see `crate::server` for the API.
//!
//! ```text
//! IWCI_SERVER_KEY=<32+ chars> iwci serve [--listen 127.0.0.1:8547]
//!     [--cpus <n>] [--jobs-per-cpu 4] [--memory <size>] [--stall-after 5m]
//!     [--memory-reserve 4GiB] [--module-memory 1GiB]
//!     [--storage-quota 10GiB] [--store <dir>] [--cache <dir>]
//!     [--warm-every 10m | --no-warm] [--keep-installs-unpacked 24h]
//!     [--update-channel stable [--update-every 5m]]
//!     [--restart-after-lost-isolates 8 | --restart-after-lost-isolates 0]
//! ```
//!
//! SIGTERM and SIGINT drain (no new runs, running ones finish) and then
//! exit. With `--update-channel`, the server installs the channel's signed
//! release (`IWCI_RELEASE_PUBLIC_KEY`) the same way: drain, then `exec`
//! the new binary in place. See `server_lifecycle.rs`.
//!
//! Every published builtin and environment is downloaded and compiled into
//! the disk cache when the server starts and again every `--warm-every`,
//! so jobs never wait on a cold tool.
//!
//! The job budget is `--memory`, held to the host's memory (or the
//! service's cgroup limit) less `--memory-reserve`, which the runner keeps
//! for itself; without `--memory`, all of that (see `crate::memory`).
//!
//! Cached installs not used for `--keep-installs-unpacked` are packed in
//! the background, once at start and then every ten minutes.
//!
//! V8 running out of memory where it cannot recover costs the process a
//! parked thread and an abandoned isolate each time (#990), so the server
//! drains and `exec`s itself once that has cost one of V8's worker threads
//! or `--restart-after-lost-isolates` isolates (default 8; `0` never).

use std::process::ExitCode;
use std::sync::Arc;

use super::Args;
use super::run::{limits, open_runner, storage_quota};
use crate::server::Server;

/// The storage an owner gets when neither the request nor `--storage-quota`
/// says otherwise.
const DEFAULT_STORAGE_QUOTA: u64 = 10 << 30;

/// How often a server looks for newly published builtins to warm.
const DEFAULT_WARM_EVERY_SECS: u64 = 600;

/// How often a server packs the installs that have gone unused.
const COMPACT_EVERY_SECS: u64 = 600;

/// How often a server checks its release channel.
const DEFAULT_UPDATE_EVERY_SECS: u64 = 300;

/// How many V8 isolates a server lets out-of-memory cost it before it
/// restarts (#990). Each is a parked thread and an isolate's memory, which
/// no job's `memory:` counts any more.
const DEFAULT_RESTART_AFTER_LOST_ISOLATES: u64 = 8;

pub fn serve(mut args: Args) -> Result<ExitCode, String> {
    crate::memory::configure_allocator();
    // Loopback by default: exposing it is a decision, made with --listen.
    let listen = args
        .value("--listen")?
        .unwrap_or_else(|| "127.0.0.1:8547".to_string());
    let key = std::env::var("IWCI_SERVER_KEY")
        .map_err(|_| "set IWCI_SERVER_KEY to the key clients send as a bearer token")?;
    let mut limits = limits(&mut args)?;
    let reserve = match args
        .value("--memory-reserve")?
        .or_else(|| std::env::var("IWCI_MEMORY_RESERVE").ok())
    {
        Some(text) => iwci_spec::parse_size(&text)
            .ok_or_else(|| format!("--memory-reserve takes a size such as `4GiB`, not `{text}`"))?,
        None => crate::memory::DEFAULT_RESERVE,
    };
    let host = crate::memory::host_memory();
    let asked = limits.memory;
    limits.memory = crate::memory::job_budget(asked, host, reserve)?;
    if let (Some(host), Some(budget)) = (host, limits.memory) {
        eprintln!(
            "iwci serve: jobs may reserve {} MiB of the host's {} MiB, keeping {} MiB for the runner{}",
            budget >> 20,
            host >> 20,
            reserve >> 20,
            match asked {
                Some(asked) if asked > budget => format!(" (--memory {} MiB lowered)", asked >> 20),
                _ => String::new(),
            }
        );
    }
    let quota = storage_quota(&mut args)?.unwrap_or(DEFAULT_STORAGE_QUOTA);
    let runner = open_runner(&mut args, &limits, true, Some(quota))?;
    let no_warm = args.flag("--no-warm");
    let warm_every = match args.value("--warm-every")? {
        None => DEFAULT_WARM_EVERY_SECS,
        Some(text) => iwci_spec::parse_duration_secs(&text)
            .filter(|&s| s >= 60)
            .ok_or_else(|| {
                format!("--warm-every takes a duration of at least 1m, such as `10m`, not `{text}`")
            })?,
    };
    let update_channel = args.value("--update-channel")?;
    let update_every = match args.value("--update-every")? {
        None => DEFAULT_UPDATE_EVERY_SECS,
        Some(text) => iwci_spec::parse_duration_secs(&text)
            .filter(|&s| s >= 30)
            .ok_or_else(|| {
                format!("--update-every takes a duration of at least 30s, not `{text}`")
            })?,
    };
    let restart_after = match args.value("--restart-after-lost-isolates")? {
        None => Some(DEFAULT_RESTART_AFTER_LOST_ISOLATES),
        Some(text) => match text.parse::<u64>() {
            Ok(0) => None,
            Ok(n) => Some(n),
            Err(_) => {
                return Err(format!(
                    "--restart-after-lost-isolates takes a count, or 0 for never, not `{text}`"
                ));
            }
        },
    };
    let release_key = match &update_channel {
        Some(_) => Some(crate::server::lifecycle::verifying_key(
            &std::env::var("IWCI_RELEASE_PUBLIC_KEY").map_err(|_| {
                "--update-channel needs IWCI_RELEASE_PUBLIC_KEY, the key releases are signed with"
            })?,
        )?),
        None => None,
    };
    if !args.rest().is_empty() {
        return Err("unexpected arguments; see `iwci help`".into());
    }
    let server = Arc::new(Server::new(runner, key)?.with_memory(host, reserve));
    server.stop_gracefully_on_signals()?;
    if let (Some(channel), Some(key)) = (update_channel, release_key) {
        eprintln!(
            "iwci serve: {} following channel `{channel}`",
            crate::server::lifecycle::VERSION
        );
        server.keep_updated(channel, key, std::time::Duration::from_secs(update_every));
    }
    server.watch_v8_losses(restart_after);
    if !no_warm {
        server.keep_warm(std::time::Duration::from_secs(warm_every));
    }
    server.keep_installs_compact(std::time::Duration::from_secs(COMPACT_EVERY_SECS));
    server.watch_memory();
    server.serve(&listen)?;
    Ok(ExitCode::SUCCESS)
}
