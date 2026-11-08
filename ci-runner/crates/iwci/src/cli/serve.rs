//! `iwci serve`: see `crate::server` for the API.
//!
//! ```text
//! IWCI_SERVER_KEY=<32+ chars> iwci serve [--listen 127.0.0.1:8547]
//!     [--cpus <n>] [--jobs-per-cpu 4] [--memory <size>]
//!     [--storage-quota 10GiB] [--store <dir>] [--cache <dir>]
//! ```

use std::process::ExitCode;
use std::sync::Arc;

use super::Args;
use super::run::{limits, open_runner, storage_quota};
use crate::server::Server;

/// The storage an owner gets when neither the request nor `--storage-quota`
/// says otherwise.
const DEFAULT_STORAGE_QUOTA: u64 = 10 << 30;

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
    if !args.rest().is_empty() {
        return Err("unexpected arguments; see `iwci help`".into());
    }
    let server = Arc::new(Server::new(runner, key)?);
    server.serve(&listen)?;
    Ok(ExitCode::SUCCESS)
}
