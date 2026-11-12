//! The isolates CI jobs run in.
//!
//! A [`Runtime`] owns one wasmer engine (cranelift), the compiled-module
//! cache (on disk and in memory) and a tokio runtime for wasmer-wasix. It is
//! `Send + Sync`; the orchestrator shares one in an `Arc` and calls it from
//! many threads, one job per call. Each call is synchronous and runs one
//! job in its own store, on a fresh instance, over the job's virtual file
//! system:
//!
//! - [`Runtime::run_command`] runs a WASI or WASIX command module (`_start`),
//!   such as a Go `wasip1` build of gofmt.
//! - [`Runtime::run_tsc`] runs ts-rust's TypeScript compiler through its own
//!   host ABI (see [`tsc`]).
//! - [`Runtime::run_script`] runs a shell script in an environment of webc
//!   packages (bash, coreutils, Edge.js), whose commands the script can spawn.
//!
//! Every job has a wall-clock timeout, a cap on each linear memory, captured
//! and capped stdout and stderr, and no network and no host file system:
//! see the `wasix` module for how each is enforced.

mod cache;
mod capture;
mod limits;
mod modes;
mod network;
mod node;
mod services;
mod signals;
mod stall;
pub mod tsc;
mod wasix;
mod watchdog;

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};
use wasmer_wasix::runtime::task_manager::tokio::TokioTaskManager;

pub use cache::CacheStats;
pub use iwci_vfs::DynFs;
pub use stall::DEFAULT_STALL_AFTER;
pub use tsc::TscOutcome;
pub use wasix::{CRASH_EXIT_CODE, TIMEOUT_EXIT_CODE};

/// Sizes V8's background pool (garbage collection, compilation) for jobs that
/// run Node to the runner's vCPUs, so that work stays within `--cpus` instead
/// of V8's default of every core on the machine. The pool is process-wide and
/// fixed when the first isolate is made, so this runs at start-up. Without the
/// `node` feature there is no V8 and nothing to size.
pub fn set_node_worker_threads(cpus: usize) {
    #[cfg(feature = "node")]
    {
        let count = u32::try_from(cpus.max(1)).unwrap_or(u32::MAX);
        // Only fails when an isolate already exists, which start-up rules out.
        let _ = wasmer_napi::set_v8_worker_threads(Some(count));
    }
    #[cfg(not(feature = "node"))]
    let _ = cpus;
}

/// What V8 running out of memory where it cannot recover has cost this
/// process so far (#990). The bridge keeps each such out-of-memory to its
/// job by parking the thread that ran out for good and abandoning the
/// isolate (vendor/README.md), so none of it comes back until the process
/// ends.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct V8Losses {
    /// Isolates abandoned, with their memory, which no job's `memory:`
    /// counts any more.
    pub lost_isolates: u64,
    /// Threads parked for good: a job's own, or one of V8's workers.
    pub parked_threads: u64,
    /// Of those, V8 worker threads. The pool is process-wide and sized to
    /// `--cpus` ([`set_node_worker_threads`]), so each one leaves every
    /// later Node job's garbage collection and compilation fewer threads.
    pub parked_worker_threads: u64,
}

/// See [`V8Losses`]; all zero without the `node` feature.
pub fn v8_losses() -> V8Losses {
    #[cfg(feature = "node")]
    {
        let losses = wasmer_napi::out_of_memory_losses();
        V8Losses {
            lost_isolates: losses.lost_isolates,
            parked_threads: losses.parked_threads,
            parked_worker_threads: losses.parked_worker_threads,
        }
    }
    #[cfg(not(feature = "node"))]
    V8Losses::default()
}

/// What each of stdout and stderr keeps before truncating.
pub const DEFAULT_OUTPUT_CAP: usize = 8 << 20;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("module cache at {path}: {source}")]
    Cache {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("compiling the module: {0}")]
    Compile(#[source] wasmer::CompileError),
    #[error("the module's bytes hash to {actual}, not the declared {expected}")]
    HashMismatch { expected: String, actual: String },
    #[error("package {name}: {reason}")]
    Package { name: String, reason: String },
    #[error("invalid invocation: {0}")]
    InvalidInput(String),
    #[error("setting up the job: {0}")]
    Setup(String),
    #[error("starting the async runtime: {0}")]
    Async(#[source] std::io::Error),
}

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// A wasm module, identified by the sha256 of its bytes.
#[derive(Debug, Clone)]
pub struct WasmModule {
    /// Shown as `argv[0]` to the program.
    pub name: String,
    pub sha256: [u8; 32],
    pub bytes: Arc<[u8]>,
}

impl WasmModule {
    /// Hashes `bytes`. When the caller already knows the digest (a builtin
    /// pinned by hash), [`WasmModule::with_sha256`] skips the hashing; the
    /// digest is still checked before anything is compiled.
    pub fn new(name: impl Into<String>, bytes: impl Into<Arc<[u8]>>) -> Self {
        let bytes = bytes.into();
        Self {
            name: name.into(),
            sha256: Sha256::digest(&bytes).into(),
            bytes,
        }
    }

    pub fn with_sha256(
        name: impl Into<String>,
        sha256: [u8; 32],
        bytes: impl Into<Arc<[u8]>>,
    ) -> Self {
        Self {
            name: name.into(),
            sha256,
            bytes: bytes.into(),
        }
    }
}

/// A downloaded Wasmer package (`.webc`).
#[derive(Debug, Clone)]
pub struct WebcPackage {
    /// The registry name, such as `wasmer/bash`.
    pub name: String,
    /// The semver version, such as `1.0.25`. Name and version matter: webc
    /// files as the registry serves them do not name themselves, and they
    /// are what another package's dependency (bash's on
    /// `wasmer/coreutils@^1.0.19`) is resolved against.
    pub version: String,
    pub sha256: [u8; 32],
    pub bytes: Arc<[u8]>,
}

impl WebcPackage {
    pub fn new(
        name: impl Into<String>,
        version: impl Into<String>,
        bytes: impl Into<Arc<[u8]>>,
    ) -> Self {
        let bytes = bytes.into();
        Self {
            name: name.into(),
            version: version.into(),
            sha256: Sha256::digest(&bytes).into(),
            bytes,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// Wall-clock time from the start of the call.
    pub timeout: Duration,
    /// The most any one linear memory of the job may grow to. Each process
    /// a script spawns has its own memory, each under this cap.
    pub memory_bytes: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(600),
            memory_bytes: 4 << 30,
        }
    }
}

#[derive(Clone)]
pub struct Invocation {
    /// Arguments after `argv[0]`. For a script they become `$1` onwards.
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Absolute guest path; created when missing.
    pub cwd: String,
    /// The job's file system (`JobFs::as_dyn`).
    pub fs: DynFs,
    pub limits: Limits,
    /// Receives output as the program writes it, for live logs. The
    /// [`Outcome`] still carries the captured output either way.
    pub log: Option<LogSink>,
    /// The run's shared scratch directory, mounted at
    /// [`SCRATCH_MOUNT`] for every ABI.
    pub scratch: Option<DynFs>,
    /// Wasm commands a script can run by name, written to `/usr/local/bin`
    /// (first on the default `PATH`). Only scripts use them.
    pub commands: Vec<PathCommand>,
    /// Whether the job may reach the public internet, when the runtime
    /// offers it (`Runtime::with_internet`). Off leaves only its loopback.
    pub internet: bool,
    /// The modes of the job's files (`JobFs::modes`), which a script reads
    /// and sets with `stat`, `chmod` and `mktemp` (`modes.rs`).
    pub modes: iwci_vfs::Modes,
}

/// Where [`Invocation::scratch`] is mounted.
pub const SCRATCH_MOUNT: &str = "/tmp/workflow";

/// A WASI or WASIX command module a script runs by `name` (`tools:`). The
/// shell finds it on `PATH` as a file and wasmer-wasix runs it like any
/// other program; its compiled form is shared with the module cache, so a
/// tool compiled for a builtin job is already warm here.
#[derive(Clone)]
pub struct PathCommand {
    pub name: String,
    pub module: WasmModule,
}

impl std::fmt::Debug for Invocation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Invocation")
            .field("args", &self.args)
            .field("cwd", &self.cwd)
            .field("limits", &self.limits)
            .field("log", &self.log.is_some())
            .field("scratch", &self.scratch.is_some())
            .field("internet", &self.internet)
            .field(
                "commands",
                &self
                    .commands
                    .iter()
                    .map(|c| &c.module.name)
                    .collect::<Vec<_>>(),
            )
            .finish_non_exhaustive()
    }
}

/// Which stream a chunk of output was written to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stream {
    Stdout,
    Stderr,
}

/// Called with each chunk a program writes, from whichever thread wrote it.
pub type LogSink = Arc<dyn Fn(Stream, &[u8]) + Send + Sync>;

#[derive(Debug, Clone)]
pub struct Outcome {
    /// The exit status, or [`TIMEOUT_EXIT_CODE`] when the runner stopped it
    /// (a timeout, a stall, or its JavaScript stopped for memory), or
    /// [`CRASH_EXIT_CODE`] when the program trapped.
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    /// Either stream hit the output cap and lost the rest.
    pub truncated: bool,
    pub duration: Duration,
    pub timed_out: bool,
    /// The job was stopped before its timeout because it had gone this
    /// long without writing output or using CPU time: hung, not working
    /// (see [`Runtime::with_stall_after`]). Its exit code is
    /// [`TIMEOUT_EXIT_CODE`], as for a timeout.
    pub stalled_after: Option<Duration>,
    /// A memory of the job was refused growth by the memory limit (the job
    /// may still have exited cleanly if it handled the failure), or its
    /// Node ran short of it: a JavaScript heap could not grow, which stops
    /// the job, or a `node`, worker thread or buffer was refused and the job
    /// then failed. Its stderr ends with a note saying which.
    pub out_of_memory: bool,
    /// The trap, when the program crashed rather than exiting.
    pub error: Option<String>,
}

impl Outcome {
    pub fn success(&self) -> bool {
        self.exit_code == 0
            && !self.timed_out
            && self.stalled_after.is_none()
            && self.error.is_none()
    }
}

pub struct Runtime {
    store: Arc<cache::ModuleStore>,
    wasix: wasix::WasixShared,
    // Declared after `wasix`, so the task manager that holds its handle is
    // dropped before the runtime it points into.
    tokio: tokio::runtime::Runtime,
    output_cap: usize,
    stall_after: Option<Duration>,
}

impl std::fmt::Debug for Runtime {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Runtime")
            .field("store", &self.store)
            .finish_non_exhaustive()
    }
}

impl Runtime {
    /// A runtime whose compiled modules live under `cache_dir` (created if
    /// missing).
    pub fn new(cache_dir: PathBuf) -> Result<Self> {
        Self::with_threads(cache_dir, None)
    }

    /// [`Runtime::new`] with the async runtime capped at `threads` worker
    /// threads (default: one per core), for a runner given a CPU limit.
    /// Guest threads and WASIX subprocesses run on blocking threads, which
    /// are not capped: a script waiting on its child would deadlock if they
    /// were.
    pub fn with_threads(cache_dir: PathBuf, threads: Option<usize>) -> Result<Self> {
        let (engine, fingerprint) = cache::new_engine();
        let store = Arc::new(cache::ModuleStore::new(engine, fingerprint, &cache_dir)?);
        let mut builder = tokio::runtime::Builder::new_multi_thread();
        if let Some(threads) = threads {
            builder.worker_threads(threads.max(1));
        }
        let tokio = builder
            .enable_time()
            .thread_name("iwci-runtime")
            .build()
            .map_err(Error::Async)?;
        let tasks = Arc::new(TokioTaskManager::new(tokio.handle().clone()));
        Ok(Self {
            wasix: wasix::WasixShared::new(store.clone(), tasks),
            store,
            tokio,
            output_cap: DEFAULT_OUTPUT_CAP,
            stall_after: Some(DEFAULT_STALL_AFTER),
        })
    }

    /// Lets jobs connect to the public internet (see `network.rs`: never the
    /// host's loopback or any private, link-local or reserved address). Off
    /// by default, so tests never reach the network; the `iwci` command
    /// turns it on.
    pub fn with_internet(mut self) -> Self {
        // LocalNetworking takes the runtime's handle when it is made.
        let _enter = self.tokio.enter();
        let host = virtual_net::host::LocalNetworking::new();
        self.wasix.outside = Some(Arc::new(network::OutsideNet::new(
            Arc::new(host),
            network::host_addresses(),
        )));
        self
    }

    /// Changes what each of stdout and stderr keeps (default 8 MiB).
    pub fn with_output_cap(mut self, bytes: usize) -> Self {
        self.output_cap = bytes;
        self
    }

    /// Stops a WASI, WASIX or script job that has gone `after` without
    /// writing output or using CPU time (default [`DEFAULT_STALL_AFTER`];
    /// `None` leaves every job to its timeout). A job that computes in
    /// silence keeps using CPU and is never stopped by this; one that waits
    /// on nothing, such as a process whose exit hangs (#938), is. Only
    /// measured on Linux; elsewhere jobs wait for their timeout. tsc jobs are
    /// single-threaded compiles and are not watched.
    pub fn with_stall_after(mut self, after: Option<Duration>) -> Self {
        self.stall_after = after.filter(|d| !d.is_zero());
        self
    }

    /// Compiles `module` (or loads it from the cache) without running it, so
    /// the first job that needs it starts at once.
    pub fn prepare(&self, module: &WasmModule) -> Result<()> {
        self.store.get(module.sha256, &module.bytes).map(drop)
    }

    /// Compiles every command of an environment's packages (or loads them
    /// from the cache), so a script's first `node` or `ls` starts at once
    /// instead of spending the job's timeout in the compiler.
    pub fn prepare_environment(&self, packages: &[WebcPackage]) -> Result<()> {
        wasix::prepare(&self.wasix, &self.tokio, packages)
    }

    pub fn cache_stats(&self) -> CacheStats {
        self.store.stats()
    }

    /// Runs a WASI (`wasi_snapshot_preview1`) or WASIX command module's
    /// `_start` with `inv`.
    pub fn run_command(&self, module: &WasmModule, inv: Invocation) -> Result<Outcome> {
        let compiled = self.store.get(module.sha256, &module.bytes)?;
        wasix::run(
            &self.wasix,
            &self.tokio,
            wasix::Entry::Module(compiled),
            &module.name,
            inv,
            wasix::Caps {
                output_bytes: self.output_cap,
                stall_after: self.stall_after,
            },
            None,
        )
    }

    /// Runs ts-rust's compiler once. `inv.args` are the tsc arguments. With
    /// `diagnostics_json`, the diagnostics come back as JSON instead of
    /// being printed.
    pub fn run_tsc(
        &self,
        module: &WasmModule,
        inv: Invocation,
        diagnostics_json: bool,
    ) -> Result<TscOutcome> {
        let compiled = self.store.get(module.sha256, &module.bytes)?;
        tsc::run(
            self.store.engine(),
            &compiled,
            inv,
            diagnostics_json,
            self.output_cap,
        )
    }

    /// Runs `script` with `entry` (a shell command one of `packages`
    /// provides, normally `bash`) as `entry -c '<strict prelude>; script'
    /// entry args...`. Every command of every package is on `PATH` for the
    /// script to spawn. bash gets `set -euo pipefail` first, any other shell
    /// `set -eu`.
    pub fn run_script(
        &self,
        packages: &[WebcPackage],
        entry: &str,
        script: &str,
        mut inv: Invocation,
    ) -> Result<Outcome> {
        let prelude = if entry == "bash" {
            "set -euo pipefail"
        } else {
            "set -eu"
        };
        let mut args = vec![
            "-c".to_string(),
            format!("{prelude}\n{script}"),
            entry.to_string(),
        ];
        args.append(&mut inv.args);
        inv.args = args;
        if !inv.env.iter().any(|(k, _)| k == "PATH") {
            inv.env
                .push(("PATH".into(), "/usr/local/bin:/usr/bin:/bin".into()));
        }
        #[cfg(feature = "node")]
        let node = Some(node::NodeHooks::new(inv.limits.memory_bytes));
        #[cfg(not(feature = "node"))]
        let node: Option<node::NodeHooks> = None;
        wasix::run(
            &self.wasix,
            &self.tokio,
            wasix::Entry::Command {
                packages,
                name: entry,
            },
            entry,
            inv,
            wasix::Caps {
                output_bytes: self.output_cap,
                stall_after: self.stall_after,
            },
            node.as_ref(),
        )
    }
}

#[allow(dead_code)]
fn assert_shareable() {
    fn check<T: Send + Sync>() {}
    check::<Runtime>();
}

#[cfg(test)]
mod tests;
