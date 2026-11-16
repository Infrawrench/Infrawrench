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

mod background;
mod builtins;
mod cache;
mod cancel;
mod capture;
/// The runner inside a job's gVisor sandbox (Linux only).
#[cfg(target_os = "linux")]
pub mod inside;
mod limits;
mod modes;
mod network;
mod node;
/// Running a job in a gVisor sandbox (Linux only).
#[cfg(target_os = "linux")]
pub mod sandbox;
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

pub use cache::{
    CacheStats, DEFAULT_MODULE_MEMORY, DEFAULT_PIN_UNDER, DEFAULT_PINNED_MEMORY, ModuleLimits,
    ResidentModule,
};
pub use cancel::Cancel;
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

/// The engine flags of the V8 that runs every Node job, which the runner
/// sets and nothing else does: V8's flags are the whole process's, so no
/// job's `node` chooses them (vendor/README.md).
///
/// - `--js-source-phase-imports --harmony-import-attributes`: what Edge.js
///   asks for at every start unless told otherwise.
/// - `--no-memory-protection-keys` (#930): on a CPU with PKU, V8 tags the
///   process-wide JS dispatch table with a protection key and grants access
///   in the PKRU register of the thread that first initialises V8 and of the
///   threads that thread creates. PKRU is per thread, so an isolate made on
///   a thread from an older pool (a second job's `node`) faulted reading
///   that table in `Isolate::Init` and took the runner down. Without keys,
///   V8 protects those pages with mprotect, which every thread sees the same.
/// - `--no-global-heap-limit-counts-external-memory` (#1039, our V8 patch
///   `builtins/v8/global-heap-external.patch`): V8 15.9 counts array buffers
///   towards a global heap limit of twice the old generation, so a Worker
///   started at 64 MiB that holds more than about 128 MB of buffers ran
///   back-to-back major GCs (52,000 in one Vitest run). Those bytes are the
///   job's memory, which the budget already holds.
/// - `--max-semi-space-size=16` (#1039): V8 15.9 starts incremental marking
///   again as soon as a major GC ends while the old generation has less
///   room under its limit than the young generation's capacity, and caps
///   that limit halfway between the heap's size and its maximum. With the
///   64 MiB semi-spaces the bridge gave a budgeted isolate by default
///   then, a heap past half of its 256 MiB maximum
///   stayed in that state for good, below the 80% at which V8 asks the
///   near-heap-limit callback for more: one Vitest process ran 12,600
///   mark-compacts in 100 seconds, each freeing nothing, and major GC took
///   60% of the job's CPU. At 16 MiB the state starts past 80%, where the
///   callback grows the heap. The flag sets every isolate's largest
///   semi-space, whatever its constraints ask, so a young generation is
///   at most three of them, 48 MiB, which is what the bridge charges a
///   job's `memory:` for one (`DEFAULT_YOUNG_GENERATION`, #1158; a test
///   below holds the two together).
#[cfg(feature = "node")]
const V8_FLAGS: &str = "--js-source-phase-imports --harmony-import-attributes \
                        --no-memory-protection-keys --no-global-heap-limit-counts-external-memory \
                        --max-semi-space-size=16";

/// Configures the V8 that Node jobs run on, once per process, with
/// `V8_FLAGS`. It runs at start-up, after [`set_node_worker_threads`]
/// (the platform it makes fixes the pool's size), and every job that can
/// run Node calls it again before its first instance, so it always comes
/// before any job's `node` asks for a runtime. Without the `node` feature
/// there is no V8 and nothing to configure.
pub fn configure_node_runtime() -> Result<(), String> {
    #[cfg(feature = "node")]
    {
        static CONFIGURED: std::sync::OnceLock<Result<(), wasmer_napi::V8RuntimeError>> =
            std::sync::OnceLock::new();
        (*CONFIGURED.get_or_init(|| {
            // V8's worker threads are counted for the job whose task they
            // run (stall.rs), from the platform's first task on.
            stall::node_hooks::install();
            wasmer_napi::configure_v8_runtime(V8_FLAGS)
        }))
        .map_err(|e| format!("configuring V8: {e}"))
    }
    #[cfg(not(feature = "node"))]
    Ok(())
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
    /// The most the abandoned isolates' heaps hold, in bytes: what each
    /// one's job was charged for it, of its `memory:`, when it was lost.
    /// The heaps stay mapped after their jobs end and give their `memory:`
    /// back, so from then on this is the server's own memory, outside the
    /// job budget (#1158).
    pub lost_heap: u64,
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
            lost_heap: wasmer_napi::lost_heap(),
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
    /// Read-only directories a script's tools run from, with the commands
    /// that start them (`tools:` that are Node programs). Only scripts use
    /// them.
    pub trees: Vec<PathTree>,
    /// Whether the job may reach the public internet, when the runtime
    /// offers it (`Runtime::with_internet`). Off leaves only its loopback.
    pub internet: bool,
    /// The modes of the job's files (`JobFs::modes`), which a script reads
    /// and sets with `stat`, `chmod` and `mktemp` (`modes.rs`).
    pub modes: iwci_vfs::Modes,
    /// Programs started in the job's isolate before it, in this order, and
    /// stopped when it ends (`background.rs`). The job starts once every
    /// one is ready.
    pub services: Vec<Service>,
    /// Set when the job's run is cancelled: the job is then stopped the way
    /// its timeout would stop it, services and all.
    pub cancel: Option<Cancel>,
    /// Told what the job holds whenever that is more than it has held
    /// before (see [`MemoryWatch`]).
    pub memory_watch: Option<MemoryWatch>,
}

/// A script's `PATH` when nothing sets one: tools and the runner's own
/// commands in `/usr/local/bin`, then the packages' commands.
pub const DEFAULT_PATH: &str = "/usr/local/bin:/usr/bin:/bin";

/// Where [`Invocation::scratch`] is mounted.
pub const SCRATCH_MOUNT: &str = "/tmp/workflow";

/// A program that runs beside a job (`services:`): in its isolate, on its
/// loopback and over its files, from before the job starts until it ends.
/// Its output goes to the job's stderr, each line after `[service <name>]`.
#[derive(Clone)]
pub struct Service {
    /// Also a name the job's resolver answers with the loopback.
    pub name: String,
    pub program: ServiceProgram,
    /// Its whole environment: nothing of the job's is added.
    pub env: Vec<(String, String)>,
    pub ready: Ready,
    /// How long the job waits for `ready`, within its own timeout.
    pub ready_timeout: Duration,
}

impl std::fmt::Debug for Service {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Service")
            .field("name", &self.name)
            .field("ready", &self.ready)
            .field("ready_timeout", &self.ready_timeout)
            .finish_non_exhaustive()
    }
}

#[derive(Clone)]
pub enum ServiceProgram {
    /// A WASI or WASIX command module, with these arguments.
    Command {
        module: WasmModule,
        args: Vec<String>,
    },
    /// A script `entry` (a shell one of `packages` provides, `bash`) runs,
    /// as a job's `run:` does.
    Script {
        packages: Vec<WebcPackage>,
        entry: String,
        script: String,
    },
}

/// When a service is ready for the job.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Ready {
    /// Once it has started.
    Started,
    /// Something in the job listens on this port of the loopback (IPv4 or
    /// IPv6). Nothing connects to find out.
    Port(u16),
    /// A line of its output, on either stream, matches this regular
    /// expression.
    Log(String),
    /// This script, run by the service's environment's shell with the
    /// service's environment, exits 0. A `Script` service's only.
    Command(String),
}

/// A WASI or WASIX command module a script runs by `name` (`tools:`). The
/// shell finds it on `PATH` as a file and wasmer-wasix runs it like any
/// other program; its compiled form is shared with the module cache, so a
/// tool compiled for a builtin job is already warm here.
#[derive(Clone)]
pub struct PathCommand {
    pub name: String,
    pub module: WasmModule,
}

/// A tool that is a directory of files rather than one module: a pinned
/// npm CLI (`builtin:vercel`), which the environment's `node` runs. Its
/// files are mounted read-only at `dir` and shared by every job that uses
/// the same build; its command is a script written to `/usr/local/bin`.
#[derive(Clone)]
pub struct PathTree {
    /// The tool's name, for errors.
    pub name: String,
    /// Absolute guest path the files are mounted at.
    pub dir: String,
    pub fs: DynFs,
    /// Scripts written to `/usr/local/bin` by name, after the mode commands
    /// and before `commands` (a module tool of the same name wins).
    pub scripts: Vec<(String, Vec<u8>)>,
    /// A command one of the environment's packages must provide, such as
    /// `node`: a job whose environment has none fails to start, saying so.
    pub needs: Option<String>,
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

/// Called with the bytes a job holds of the host's memory each time that
/// passes the most it has held ([`Outcome::held_memory_bytes`], as it
/// grows), from whichever thread grew it: a program growing its memory,
/// or the one that reads the job's V8 heaps five times a second. It must
/// not block.
pub type MemoryWatch = Arc<dyn Fn(u64) + Send + Sync>;

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
    /// The job was stopped because its run was cancelled. Its exit code is
    /// [`TIMEOUT_EXIT_CODE`], as for a timeout.
    pub cancelled: bool,
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
    /// The most memory the job held at once, in bytes: its linear memories
    /// (every process of the job and of its services) and the room its V8
    /// heaps had reserved, read five times a second. What `memory:` has
    /// to cover, beside the files the job writes.
    pub peak_memory_bytes: u64,
    /// The most of the host's memory the job held at once, in bytes: its
    /// linear memories as above, and what its V8 heaps had committed, not
    /// the room they had reserved. A Node job reserves two to five times
    /// what its heaps come to hold, so this is what a runner can plan the
    /// host's memory by; `peak_memory_bytes` is what the job's own limit
    /// has to cover. The same number for a job that runs no JavaScript.
    pub held_memory_bytes: u64,
    /// The trap, when the program crashed rather than exiting.
    pub error: Option<String>,
    /// Why the job never started: a service exited, or was not ready in
    /// time. Its exit code is 1 then.
    pub service_failure: Option<String>,
    /// For a job run in a gVisor sandbox (`sandbox.rs`): what the sandbox
    /// itself took. The memory figures above are then the job's share.
    pub sandbox: Option<SandboxUsage>,
}

/// What a job's gVisor sandbox took besides the job.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SandboxUsage {
    /// The sandbox's own memory, measured once the runner inside had
    /// loaded the environment and before the job's script started.
    pub overhead_bytes: u64,
    /// What the runner reserved for it on top of the job's `memory:`.
    pub reserved_bytes: u64,
    /// The CPU time of the whole sandbox, gVisor's kernel's included.
    pub cpu_usec: u64,
}

impl Outcome {
    pub fn success(&self) -> bool {
        self.exit_code == 0
            && !self.timed_out
            && !self.cancelled
            && self.stalled_after.is_none()
            && self.error.is_none()
            && self.service_failure.is_none()
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
        let store = Arc::new(cache::ModuleStore::new(cache::fingerprint(), &cache_dir)?);
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
            wasix: wasix::WasixShared::new(store.clone(), tasks, tokio.handle().clone()),
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

    /// Runs jobs inside their gVisor sandbox (`inside`): over the sandbox's
    /// own network stack, with `natives` (command name and path) on a
    /// script's `PATH`.
    #[cfg(target_os = "linux")]
    pub(crate) fn in_sandbox(mut self, natives: Vec<(String, PathBuf)>) -> Self {
        let _enter = self.tokio.enter();
        self.wasix.sandbox = Some(inside::Sandbox {
            stack: Arc::new(virtual_net::host::LocalNetworking::new()),
            natives,
        });
        self
    }

    /// Parses and loads `packages` as a job of them will, keeping them for
    /// as long as the result is held.
    #[cfg(target_os = "linux")]
    pub(crate) fn preload(&self, packages: &[WebcPackage], entry: &str) -> Result<impl Sized> {
        wasix::preload(&self.wasix, &self.tokio, packages, entry)
    }

    /// The sandbox's own files, from `dir` (`/` for all of them).
    #[cfg(target_os = "linux")]
    pub(crate) fn sandbox_dir(&self, dir: &str) -> std::result::Result<DynFs, String> {
        let fs = virtual_fs::host_fs::FileSystem::new(self.tokio.handle().clone(), dir)
            .map_err(|e| format!("the sandbox's files at {dir}: {e}"))?;
        Ok(Arc::new(fs))
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

    /// Sets how compiled modules stay in memory between jobs (see
    /// `cache.rs`): small ones pinned for the life of the process, the rest
    /// in an LRU that frees the least recently used of those no job is
    /// using once it passes its budget. Counted as the size of the modules'
    /// artifacts.
    pub fn with_module_limits(self, limits: ModuleLimits) -> Self {
        self.store.set_limits(limits);
        self
    }

    /// Compiles `module` into the disk cache, unless it is there already,
    /// without loading it, so the first job that needs it loads it in tens
    /// of milliseconds instead of compiling.
    pub fn prepare(&self, module: &WasmModule) -> Result<()> {
        self.store.ensure_compiled(module.sha256, &module.bytes)
    }

    /// Compiles every command of an environment's packages into the disk
    /// cache, unless they are there already, so a script's first `node` or
    /// `ls` loads at once instead of spending the job's timeout in the
    /// compiler.
    pub fn prepare_environment(&self, packages: &[WebcPackage]) -> Result<()> {
        wasix::prepare(&self.wasix, &self.tokio, packages)
    }

    /// Lets go of what no job uses any more: parsed packages unused for a
    /// couple of minutes, compiled modules the LRU holds past its budget
    /// that no job is using, and the Wasm stacks of threads that have
    /// ended. A server calls this now and then, so an idle runner holds
    /// only its pinned modules and what the LRU's budget allows.
    pub fn release_idle(&self) {
        self.wasix.release_idle();
        self.store.release_idle();
        // A thread that ends gives its cached Wasm stack (`WASIX_STACK`, 64
        // MiB of address space, resident as deep as it was ever used) to
        // wasmer's pool, which never shrinks; threads that are still alive
        // keep their own. A stack is a fresh mapping away (#1063).
        wasmer_vm::drain_stack_pool();
    }

    pub fn cache_stats(&self) -> CacheStats {
        self.store.stats()
    }

    /// How compiled modules stay in memory ([`Runtime::with_module_limits`]).
    pub fn module_limits(&self) -> ModuleLimits {
        self.store.limits()
    }

    /// The compiled modules in memory: pinned ones first, then the LRU's
    /// from the most recently used.
    pub fn resident_modules(&self) -> Vec<ResidentModule> {
        self.store.modules()
    }

    /// Runs a WASI (`wasi_snapshot_preview1`) or WASIX command module's
    /// `_start` with `inv`.
    pub fn run_command(&self, module: &WasmModule, inv: Invocation) -> Result<Outcome> {
        let job_modules = cache::JobModules::new();
        let compiled = self.store.get(
            &job_modules,
            module.sha256,
            &module.bytes,
            Some(&module.name),
        )?;
        // A tool job has no Node of its own, but a service in an
        // environment may run one.
        #[cfg(feature = "node")]
        let node = inv
            .services
            .iter()
            .any(|s| matches!(s.program, ServiceProgram::Script { .. }))
            .then(|| node::NodeHooks::new(inv.limits.memory_bytes));
        #[cfg(not(feature = "node"))]
        let node: Option<node::NodeHooks> = None;
        wasix::run(
            &self.wasix,
            &self.tokio,
            &job_modules,
            wasix::Entry::Module(compiled),
            &module.name,
            inv,
            wasix::Caps {
                output_bytes: self.output_cap,
                stall_after: self.stall_after,
            },
            node.as_ref(),
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
        let job_modules = cache::JobModules::new();
        let compiled = self.store.get(
            &job_modules,
            module.sha256,
            &module.bytes,
            Some(&module.name),
        )?;
        tsc::run(
            &job_modules,
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
        inv: Invocation,
    ) -> Result<Outcome> {
        self.run_script_with(packages, entry, script, inv, None)
    }

    /// [`Runtime::run_script`] with Edge.js's built-ins cache made by
    /// another runtime (the runner outside a sandbox, which keeps it).
    #[cfg(target_os = "linux")]
    pub(crate) fn run_script_with_builtins(
        &self,
        packages: &[WebcPackage],
        entry: &str,
        script: &str,
        inv: Invocation,
        builtins: Option<bytes::Bytes>,
    ) -> Result<Outcome> {
        self.run_script_with(packages, entry, script, inv, Some(builtins))
    }

    /// Edge.js's built-ins cache for `packages`, made once per process
    /// (`builtins.rs`): for a sandboxed job's runner inside, which has none
    /// of its own.
    pub fn node_builtins(&self, packages: &[WebcPackage]) -> Option<bytes::Bytes> {
        let job_modules = cache::JobModules::new();
        wasix::builtins(
            &self.wasix,
            &self.tokio,
            &job_modules,
            packages,
            self.output_cap,
        )
    }

    fn run_script_with(
        &self,
        packages: &[WebcPackage],
        entry: &str,
        script: &str,
        mut inv: Invocation,
        given_builtins: Option<Option<bytes::Bytes>>,
    ) -> Result<Outcome> {
        let mut args = script_args(entry, script);
        args.append(&mut inv.args);
        inv.args = args;
        if !inv.env.iter().any(|(k, _)| k == "PATH") {
            inv.env.push(("PATH".into(), DEFAULT_PATH.into()));
        }
        script_shell(&mut inv.env, entry);
        #[cfg(feature = "node")]
        let node = Some(node::NodeHooks::new(inv.limits.memory_bytes));
        #[cfg(not(feature = "node"))]
        let node: Option<node::NodeHooks> = None;
        // Made before the first job of the environment in this process,
        // which waits for it, as do any that start meanwhile.
        let job_modules = cache::JobModules::new();
        let builtins = match given_builtins {
            Some(given) => given,
            None => node.as_ref().and_then(|_| {
                wasix::builtins(
                    &self.wasix,
                    &self.tokio,
                    &job_modules,
                    packages,
                    self.output_cap,
                )
            }),
        };
        wasix::run(
            &self.wasix,
            &self.tokio,
            &job_modules,
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
            builtins,
        )
    }
}

/// `SHELL` for a script `entry` runs (`/bin/bash`), unless the job or its
/// environment set one (#1077). bash sets it for itself without exporting
/// it, so nothing the script started had one, and a program that asks for
/// the user's shell (oclif's command lines) went on to the user database.
pub(crate) fn script_shell(env: &mut Vec<(String, String)>, entry: &str) {
    if !env.iter().any(|(k, _)| k == "SHELL") {
        env.push(("SHELL".into(), format!("/bin/{entry}")));
    }
}

/// The arguments that make `entry` (a shell) run `script` strictly: bash
/// with `set -euo pipefail` first, any other shell `set -eu`.
pub(crate) fn script_args(entry: &str, script: &str) -> Vec<String> {
    let prelude = if entry == "bash" {
        "set -euo pipefail"
    } else {
        "set -eu"
    };
    vec![
        "-c".to_string(),
        format!("{prelude}\n{script}"),
        entry.to_string(),
    ]
}

#[allow(dead_code)]
fn assert_shareable() {
    fn check<T: Send + Sync>() {}
    check::<Runtime>();
}

#[cfg(test)]
mod tests;
