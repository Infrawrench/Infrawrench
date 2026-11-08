//! `iwci serve`: see `crate::server` for the API.
//!
//! ```text
//! IWCI_SERVER_KEY=<32+ chars> iwci serve [--listen 127.0.0.1:8547]
//!     [--cpus <n>] [--jobs-per-cpu 4] [--memory <size>]
//!     [--storage-quota 10GiB] [--store <dir>] [--cache <dir>]
//!     [--warm-every 10m | --no-warm]
//! ```
//!
//! Every published builtin and environment is downloaded and compiled when
//! the server starts and again every `--warm-every`, so jobs never wait on
//! a cold tool.

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

pub fn serve(mut args: Args) -> Result<ExitCode, String> {
    // Loopback by default: exposing it is a decision, made with --listen.
    let listen = args
        .value("--listen")?
        .unwrap_or_else(|| "127.0.0.1:8547".to_string());
    let key = std::env::var("IWCI_SERVER_KEY")
        .map_err(|_| "set IWCI_SERVER_KEY to the key clients send as a bearer token")?;
    let limits = limits(&mut args)?;
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
    if !args.rest().is_empty() {
        return Err("unexpected arguments; see `iwci help`".into());
    }
    let server = Arc::new(Server::new(runner, key)?);
    if !no_warm {
        server.keep_warm(std::time::Duration::from_secs(warm_every));
    }
    server.serve(&listen)?;
    Ok(ExitCode::SUCCESS)
}
