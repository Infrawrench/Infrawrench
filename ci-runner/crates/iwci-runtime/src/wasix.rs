//! Running WASI and WASIX programs through wasmer-wasix: plain commands
//! (`_start` modules such as gofmt) and shell scripts in an environment of
//! webc packages.
//!
//! Each job gets a [`JobRuntime`], wasmer-wasix's `Runtime` with everything
//! that could reach outside the job replaced:
//!
//! - networking is the job's own in-memory loopback plus, unless the job
//!   says `network: false`, the public internet (`crate::network`): its
//!   processes listen on and connect to `127.0.0.1` among themselves, and
//!   outbound connections to public addresses use host sockets; the host's
//!   localhost and private addresses are out of reach, and nothing a job
//!   listens on appears on the host;
//! - there is no HTTP client, the package source is an in-memory list of the
//!   packages the caller supplied and the package loader only serves those,
//!   so a command that is not provided fails instead of being fetched from
//!   the Wasmer registry;
//! - the file system is the job's virtual file system with scratch mounts
//!   for `/dev`, `/tmp` and the command directories, and nothing from the
//!   host (no host preopen, no mapped host commands, stdin is empty);
//! - stores come from a clone of the job's own engine whose tunables enforce
//!   the job's memory limit and stack size and hold the modules it loaded
//!   (cache.rs), and every store registers an interrupter so the watchdog
//!   can stop all of the job's processes.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::future::BoxFuture;
use sha2::Digest;
use virtual_fs::{
    ArcFileSystem, FileSystem, MountFileSystem, NullFile, OverlayFileSystem, RootFileSystemBuilder,
    TmpFileSystem, VirtualFile,
};
use wasmer::sys::NativeEngineExt;
use wasmer::{Engine, Interrupter, Module};
use wasmer_config::package::{PackageHash, PackageId};
use wasmer_wasix::bin_factory::{
    BinaryPackage, BinaryPackageCommand, BinaryPackageMount, BinaryPackageMounts, spawn_exec,
    spawn_exec_module,
};
use wasmer_wasix::http::DynHttpClient;
use wasmer_wasix::os::TtyBridge;
use wasmer_wasix::os::task::TaskJoinHandle;
use wasmer_wasix::runtime::module_cache::ModuleCache;
use wasmer_wasix::runtime::module_cache::progress::ModuleLoadProgressReporter;
use wasmer_wasix::runtime::package_loader::{PackageLoader, load_package_tree};
use wasmer_wasix::runtime::resolver::{
    DistributionInfo, InMemorySource, PackageInfo, PackageSummary, Resolution, Source, WebcHash,
};
use wasmer_wasix::runtime::task_manager::VirtualTaskManager;
use wasmer_wasix::runtime::{InstantiationState, ModuleInput, PluggableRuntime, TaintReason};
use wasmer_wasix::virtual_net::DynVirtualNetworking;
use wasmer_wasix::wasmer_wasix_types::wasi::{ExitCode, Signal};
use wasmer_wasix::{Runtime as WasixRuntime, SpawnError, WasiControlPlane, WasiEnvBuilder};
use webc::Container;

use crate::background::Services;
use crate::cache::{JobModules, ModuleStore, WasixCache, WasmHash};
use crate::capture::Capture;
use crate::limits::{LimitingTunables, MemoryMeter};
use crate::stall::{CpuMeter, JobTasks, StallWatch};
use crate::{Error, Invocation, Outcome, Result, WebcPackage};

/// The exit status reported for a job stopped by its timeout, as
/// coreutils' `timeout` reports it.
pub const TIMEOUT_EXIT_CODE: i32 = 124;

/// The exit status reported for a job that trapped (a crash, not an exit).
pub const CRASH_EXIT_CODE: i32 = 134;

/// The status wasmer-wasix gives a process that trapped.
const ENOEXEC: i32 = 45;

/// How long a stopped job gets to unwind after its timeout before its
/// processes are marked finished regardless.
const KILL_GRACE: Duration = Duration::from_secs(5);

/// The most threads plus processes one job may have. A fork bomb hits this
/// instead of the machine.
pub(crate) const MAX_TASKS: usize = 512;

/// How often the kill is repeated while a timed-out job unwinds.
const KILL_POLL: Duration = Duration::from_millis(50);

/// How often a job's services are checked for having exited while it runs.
const SERVICE_POLL: Duration = Duration::from_millis(250);

/// How often a Node job is checked for having been stopped for memory
/// (#972): its JavaScript is over then, and one of its threads may never
/// return, so the job is ended rather than left to its timeout.
const MEMORY_POLL: Duration = Duration::from_millis(200);

/// Native stack for WASIX guests. bash and node recurse moderately; this is
/// generous without costing anything until touched (it is reserved, not
/// committed).
const WASIX_STACK: usize = 64 << 20;

/// Shared pieces every job's runtime is assembled from.
pub(crate) struct WasixShared {
    pub(crate) store: Arc<ModuleStore>,
    pub(crate) tasks: Arc<dyn VirtualTaskManager>,
    /// The async runtime `tasks` runs on, entered where wasmer-wasix reads
    /// the ambient one ([`JobRuntime::new`]).
    tokio: tokio::runtime::Handle,
    /// Parsed packages, keyed by the webc digest and the digests of the set
    /// they were resolved against (a package's dependencies come from that
    /// set). Only while a job uses them and for [`KEEP_PARSED`] after: they
    /// hold the webc's bytes, and an environment can be hundreds of
    /// megabytes (#1035).
    packages: Recent<(WebcHash, Vec<WebcHash>), BinaryPackage>,
    /// Parsed containers by webc digest, kept the same way.
    containers: Recent<WebcHash, Parsed>,
    /// The host network jobs reach the public internet through, when
    /// offered (`Runtime::with_internet`).
    pub(crate) outside: Option<crate::network::Outside>,
    /// Edge.js's built-ins cache for each environment (builtins.rs).
    #[cfg_attr(not(feature = "node"), allow(dead_code))]
    pub(crate) builtins: crate::builtins::Builtins,
    /// Set when this runtime runs a job inside its sandbox (`inside`).
    #[cfg(target_os = "linux")]
    pub(crate) sandbox: Option<crate::inside::Sandbox>,
}

impl WasixShared {
    pub(crate) fn new(
        store: Arc<ModuleStore>,
        tasks: Arc<dyn VirtualTaskManager>,
        tokio: tokio::runtime::Handle,
    ) -> Self {
        // A guest's CPU clocks are its own, not the host's (#1038).
        wasmer_wasix::set_cpu_clocks(crate::stall::guest_cpu);
        Self {
            store,
            tasks,
            tokio,
            packages: Recent::default(),
            containers: Recent::default(),
            outside: None,
            builtins: Default::default(),
            #[cfg(target_os = "linux")]
            sandbox: None,
        }
    }

    /// Drops parsed packages no job has used for [`KEEP_PARSED`].
    pub(crate) fn release_idle(&self) {
        self.packages.expire();
        self.containers.expire();
    }
}

/// A parsed webc: its summary and container.
type Parsed = (PackageSummary, Container);

/// How long a parsed package stays in memory after the last job that used
/// it, so the next job of a busy runner does not parse it again.
pub(crate) const KEEP_PARSED: Duration = Duration::from_secs(120);

/// Values kept while a job holds them (another reference than the map's)
/// and for [`KEEP_PARSED`] after they were last used.
struct Recent<K, V>(Mutex<HashMap<K, (Arc<V>, Instant)>>);

impl<K, V> Default for Recent<K, V> {
    fn default() -> Self {
        Self(Mutex::default())
    }
}

impl<K: Eq + std::hash::Hash, V> Recent<K, V> {
    fn map(&self) -> std::sync::MutexGuard<'_, HashMap<K, (Arc<V>, Instant)>> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn get(&self, key: &K) -> Option<Arc<V>> {
        let mut map = self.map();
        let (value, used) = map.get_mut(key)?;
        *used = Instant::now();
        Some(value.clone())
    }

    fn insert(&self, key: K, value: &Arc<V>) {
        self.expire();
        self.map().insert(key, (value.clone(), Instant::now()));
    }

    fn expire(&self) {
        self.map().retain(|_, (value, used)| {
            Arc::strong_count(value) > 1 || used.elapsed() < KEEP_PARSED
        });
    }
}

/// The per-job state the watchdog acts on.
#[derive(Default)]
struct JobControl {
    interrupters: Mutex<Vec<Interrupter>>,
    /// The first trap of any of the job's processes or guest threads.
    /// wasmer-wasix reports a trapped process as exiting with ENOEXEC (45),
    /// so this is what tells a crash from a program that chose that status.
    /// When the trap was in a child process or in a thread, the job's own
    /// exit status says nothing of it, and it goes in the log instead.
    trap: Mutex<Option<String>>,
    /// The signals its guests sent and got, and the syscalls that were not
    /// implemented, for a job that dies of a signal (signals.rs).
    signals: Arc<crate::signals::SignalLog>,
}

impl std::fmt::Debug for JobControl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JobControl").finish_non_exhaustive()
    }
}

impl JobControl {
    fn interrupt_all(&self) {
        let interrupters = self.interrupters.lock().unwrap_or_else(|e| e.into_inner());
        for interrupter in interrupters.iter() {
            interrupter.interrupt();
        }
    }
}

/// wasmer-wasix's runtime for one job (see the module comment).
#[derive(Debug, Clone)]
pub(crate) struct JobRuntime {
    inner: PluggableRuntime,
    control: Arc<JobControl>,
    /// The module store, to say when a module is being loaded (stall.rs).
    modules: Arc<ModuleStore>,
    /// The job's engine and the modules it holds (cache.rs).
    job_modules: JobModules,
    /// What the job listens on, for `wait-for-port` (services.rs).
    listeners: crate::network::Listeners,
    /// The job runs in its sandbox, beside native programs, so a native
    /// program it executes runs too (`native_executable`).
    in_sandbox: bool,
}

impl JobRuntime {
    #[allow(clippy::too_many_arguments)]
    fn new(
        shared: &WasixShared,
        job_modules: &JobModules,
        engine: Engine,
        packages: Option<&PackageSet>,
        #[cfg_attr(not(feature = "node"), allow(unused_variables))] node: Option<
            &crate::node::NodeHooks,
        >,
        internet: bool,
        cpu: Arc<CpuMeter>,
        cpus: Option<u32>,
        services: &[String],
    ) -> Self {
        crate::signals::install();
        // With the `node` feature, wasmer-napi turns on wasmer-wasix's host
        // networking, and `PluggableRuntime::new` then makes a host network
        // (replaced below) that takes the async runtime of the calling
        // thread and panics where there is none. Enter ours, so this does
        // not depend on where it is called from (#1157).
        let _enter = shared.tokio.enter();
        // The shared threads, with the job's tasks counted by its meter
        // (stall.rs), telling a job the CPUs it is told it has
        // (`Limits::told_cpus`).
        let mut inner =
            PluggableRuntime::new(Arc::new(JobTasks::new(shared.tasks.clone(), cpu, cpus)));
        inner.set_engine(engine);
        // One loopback per job, shared by all of its processes, and the
        // public internet when the runtime offers it.
        let network = crate::network::JobNetwork::new(shared.outside.clone().filter(|_| internet));
        // Inside its sandbox, a job's network is the sandbox's own.
        #[cfg(target_os = "linux")]
        let network = match &shared.sandbox {
            Some(sandbox) => {
                crate::network::JobNetwork::in_sandbox(sandbox.stack.clone(), internet)
            }
            None => network,
        };
        let network = network.with_services(services);
        let listeners = network.listeners();
        inner.set_networking_implementation(network);
        inner.http_client = None;
        inner.set_module_cache(WasixCache(shared.store.clone(), job_modules.clone()));
        let packages = packages.cloned().unwrap_or_default();
        inner.set_source(packages.source.clone());
        inner.set_package_loader(packages);
        #[cfg(feature = "node")]
        if let Some(node) = node {
            node.attach(&mut inner);
        }
        #[cfg(target_os = "linux")]
        let in_sandbox = shared.sandbox.is_some();
        #[cfg(not(target_os = "linux"))]
        let in_sandbox = false;
        Self {
            inner,
            control: Arc::default(),
            modules: shared.store.clone(),
            job_modules: job_modules.clone(),
            listeners,
            in_sandbox,
        }
    }
}

/// What a job runs in place of a native program (ELF) one of its WASIX
/// processes executes (wasmer-wasix's `Runtime::native_executable`): in
/// the sandbox, a program for this machine runs natively through a
/// trampoline (`inside::natives::exec_trampoline`), as a native tool's
/// command does; anything else is a small module that says why it cannot
/// run and exits 126, as a shell does for a file it cannot execute.
fn native_executable(path: &str, head: &[u8], in_sandbox: bool) -> Option<Arc<[u8]>> {
    let machine = |m: u16| match m {
        62 => "x86_64",
        183 => "aarch64",
        3 => "x86",
        40 => "arm",
        243 => "riscv64",
        _ => "another architecture",
    };
    let field = |at: usize| {
        head.get(at..at + 2)
            .map(|b| u16::from_le_bytes([b[0], b[1]]))
    };
    let little_64 = head.get(4) == Some(&2) && head.get(5) == Some(&1);
    let (kind, arch) = match (field(16), field(18)) {
        (Some(kind), Some(arch)) if head.get(5) == Some(&1) => (kind, machine(arch)),
        _ => (0, "another architecture"),
    };
    let reason = if !matches!(kind, 2 | 3) {
        format!("{path} is an ELF file that is not a program")
    } else if !little_64 || arch != std::env::consts::ARCH {
        format!(
            "{path} is a native program for {arch}, and this runner is {}",
            std::env::consts::ARCH
        )
    } else if in_sandbox {
        #[cfg(target_os = "linux")]
        if let Some(wasm) = crate::inside::natives::exec_trampoline(path) {
            return Some(wasm);
        }
        format!("{path} cannot be started natively (its path is too long)")
    } else {
        format!(
            "{path} is a native Linux program, which a job starts only in the native sandbox: \
             list a native tool in its `tools:` (builtin:glibc@2.39 for the C library alone, \
             or builtin:rust, builtin:bun) and run it on a runner with the native sandbox \
             (`--native-sandbox`); this job runs only WebAssembly"
        )
    };
    refusal(&format!("iwci: {reason}\n"))
}

/// A module that writes `message` to stderr and exits 126.
fn refusal(message: &str) -> Option<Arc<[u8]>> {
    let mut quoted = String::with_capacity(message.len());
    for &b in message.as_bytes() {
        if b.is_ascii_graphic() && b != b'"' && b != b'\\' || b == b' ' {
            quoted.push(b as char);
        } else {
            quoted.push_str(&format!("\\{b:02x}"));
        }
    }
    let text = format!(
        r#"(module
  (import "wasi_snapshot_preview1" "fd_write" (func $write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 64) "{quoted}")
  (func (export "_start")
    (i32.store (i32.const 0) (i32.const 64))
    (i32.store (i32.const 4) (i32.const {len}))
    (drop (call $write (i32.const 2) (i32.const 0) (i32.const 1) (i32.const 8)))
    (call $exit (i32.const 126))))"#,
        len = message.len()
    );
    Some(wat::parse_str(&text).ok()?.into())
}

#[cfg(test)]
impl JobRuntime {
    pub(crate) fn for_tests(shared: &WasixShared, engine: Engine) -> Self {
        Self::new(
            shared,
            &JobModules::new(),
            engine,
            None,
            None,
            false,
            Arc::default(),
            None,
            &[],
        )
    }
}

impl WasixRuntime for JobRuntime {
    fn networking(&self) -> &DynVirtualNetworking {
        self.inner.networking()
    }

    fn task_manager(&self) -> &Arc<dyn VirtualTaskManager> {
        self.inner.task_manager()
    }

    fn package_loader(&self) -> Arc<dyn PackageLoader + Send + Sync> {
        self.inner.package_loader()
    }

    fn module_cache(&self) -> Arc<dyn ModuleCache + Send + Sync> {
        self.inner.module_cache()
    }

    fn source(&self) -> Arc<dyn Source + Send + Sync> {
        self.inner.source()
    }

    fn engine(&self) -> Engine {
        self.inner.engine()
    }

    fn native_executable(&self, path: &str, head: &[u8]) -> Option<shared_buffer::OwnedBuffer> {
        native_executable(path, head, self.in_sandbox)
            .map(|wasm| shared_buffer::OwnedBuffer::from_bytes(bytes::Bytes::from_owner(wasm)))
    }

    /// Every way wasmer-wasix loads a module for a job comes through here:
    /// from memory, from the disk cache, or compiled on a miss. The store is
    /// told for as long as a load takes, however it ends (stall.rs).
    ///
    /// The module store does the work, rather than wasmer-wasix's own
    /// `load_module`, which compiles with the engine it is given, and the
    /// job holds what it gets until it ends (cache.rs). Only a caller that
    /// names an engine or wants progress reports goes the old way: the
    /// dynamic linker names the job's, and its lookups reach the store
    /// through the job's `WasixCache` all the same.
    fn resolve_module<'a>(
        &'a self,
        input: ModuleInput<'a>,
        engine: Option<&Engine>,
        on_progress: Option<ModuleLoadProgressReporter>,
    ) -> BoxFuture<'a, std::result::Result<Module, SpawnError>> {
        let working = self.modules.working();
        if engine.is_none() && on_progress.is_none() {
            return Box::pin(async move {
                let _working = working;
                let module_hash = input.hash();
                let key: WasmHash = module_hash
                    .as_bytes()
                    .try_into()
                    .map_err(|_| SpawnError::Other("a module hash that is not a sha256".into()))?;
                let name = match &input {
                    ModuleInput::Command(command) => Some(command.name()),
                    _ => None,
                };
                self.modules
                    .get(&self.job_modules, key, input.wasm(), name)
                    .map_err(|e| match e {
                        Error::Compile(error) => SpawnError::CompileError { module_hash, error },
                        other => SpawnError::Other(Box::new(other)),
                    })
            });
        }
        let load = self.inner.resolve_module(input, engine, on_progress);
        Box::pin(async move {
            let _working = working;
            load.await
        })
    }

    fn new_store(&self) -> wasmer::Store {
        let store = wasmer::Store::new(self.inner.engine());
        // wasmer-wasix makes a store on the thread a task is about to run
        // on, so from here on this thread's syscalls are this job's.
        self.control.signals.attend();
        self.control
            .interrupters
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(store.interrupter());
        store
    }

    fn additional_imports(
        &self,
        module: &Module,
        store: &mut wasmer::StoreMut,
    ) -> anyhow::Result<(wasmer::Imports, InstantiationState)> {
        self.inner.additional_imports(module, store)
    }

    fn prepare_imports(
        &self,
        module: &Module,
        store: &mut wasmer::StoreMut,
        imports: &mut wasmer::Imports,
    ) -> anyhow::Result<InstantiationState> {
        self.inner.prepare_imports(module, store, imports)
    }

    fn configure_new_instance(
        &self,
        module: &Module,
        store: &mut wasmer::StoreMut,
        instance: &wasmer::Instance,
        imported_memory: Option<&wasmer::Memory>,
        state: InstantiationState,
    ) -> anyhow::Result<()> {
        self.inner
            .configure_new_instance(module, store, instance, imported_memory, state)
    }

    fn http_client(&self) -> Option<&DynHttpClient> {
        None
    }

    fn tty(&self) -> Option<&(dyn TtyBridge + Send + Sync)> {
        None
    }

    fn on_taint(&self, reason: TaintReason) {
        if let TaintReason::RuntimeError(err) = reason
            && err.clone().to_trap() != Some(wasmer_types::TrapCode::HostInterrupt)
        {
            let mut trap = self.control.trap.lock().unwrap_or_else(|e| e.into_inner());
            trap.get_or_insert_with(|| err.to_string());
        }
    }
}

/// The packages of one environment: an offline source for dependency
/// resolution and a loader that serves only these containers.
#[derive(Debug, Clone, Default)]
pub(crate) struct PackageSet {
    source: InMemorySource,
    containers: Arc<HashMap<WebcHash, Container>>,
    order: Vec<(WebcHash, Container)>,
    /// What this set holds in the shared caches, so another job using the
    /// same packages meanwhile parses nothing again.
    _parsed: Vec<Arc<Parsed>>,
    binaries: Arc<Mutex<Vec<Arc<BinaryPackage>>>>,
    /// Whether what it parses is kept for later jobs; warming parses every
    /// environment and keeps none (#1035).
    remember: bool,
}

impl PackageSet {
    fn new(shared: &WasixShared, packages: &[WebcPackage], remember: bool) -> Result<Self> {
        let mut source = InMemorySource::new();
        let mut containers = HashMap::new();
        let mut order = Vec::new();
        let mut parsed = Vec::new();
        for package in packages {
            let held = parse_package(shared, package, remember)?;
            let (summary, container) = &*held;
            let hash = summary.dist.webc_sha256;
            source.add(summary.clone());
            containers.insert(hash, container.clone());
            order.push((hash, container.clone()));
            parsed.push(held);
        }
        Ok(Self {
            source,
            containers: Arc::new(containers),
            order,
            _parsed: parsed,
            binaries: Arc::default(),
            remember,
        })
    }

    /// Whether a package of the set has a command called `name`.
    #[cfg_attr(not(feature = "node"), allow(dead_code))]
    fn has_command(&self, name: &str) -> bool {
        self.order
            .iter()
            .any(|(_, c)| c.manifest().commands.contains_key(name))
    }

    fn digests(&self) -> Vec<WebcHash> {
        let mut digests: Vec<WebcHash> = self.order.iter().map(|(h, _)| *h).collect();
        digests.sort();
        digests
    }
}

#[async_trait::async_trait]
impl PackageLoader for PackageSet {
    async fn load(&self, summary: &PackageSummary) -> anyhow::Result<Container> {
        self.containers
            .get(&summary.dist.webc_sha256)
            .cloned()
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "package {} is not part of this environment, and jobs have no network to fetch it",
                    summary.pkg.id
                )
            })
    }

    async fn load_package_tree(
        &self,
        root: &Container,
        resolution: &Resolution,
        root_is_local_dir: bool,
    ) -> anyhow::Result<BinaryPackage> {
        load_package_tree(root, self, resolution, root_is_local_dir).await
    }
}

/// The summary and container of `package`, parsed once while any job uses
/// it. The container borrows the caller's bytes rather than copying them,
/// which matters for an 80 MB Edge.js.
fn parse_package(
    shared: &WasixShared,
    package: &WebcPackage,
    remember: bool,
) -> Result<Arc<Parsed>> {
    let hash = WebcHash::from_bytes(package.sha256);
    if let Some(parsed) = shared.containers.get(&hash) {
        return Ok(parsed);
    }
    let bad = |reason: String| Error::Package {
        name: format!("{}@{}", package.name, package.version),
        reason,
    };
    let actual: [u8; 32] = sha2::Sha256::digest(&package.bytes).into();
    if actual != package.sha256 {
        return Err(bad(format!(
            "the bytes hash to {}, not the declared {}",
            hex::encode(actual),
            hex::encode(package.sha256)
        )));
    }
    let version = webc::detect(&package.bytes[..]).map_err(|e| bad(e.to_string()))?;
    let container =
        Container::from_bytes_and_version(bytes::Bytes::from_owner(package.bytes.clone()), version)
            .map_err(|e| bad(e.to_string()))?;
    let manifest = container.manifest();
    let id = PackageInfo::package_id_from_manifest(manifest)
        .map_err(|e| bad(e.to_string()))?
        .or_else(|| {
            // Packages as the registry's CDN serves them carry no name in
            // their manifest, so the caller's name and version stand in;
            // without them a dependency such as bash's on
            // `wasmer/coreutils@^1.0.19` would find nothing to resolve to.
            let version = package.version.parse().ok()?;
            Some(PackageId::new_named(package.name.clone(), version))
        })
        .unwrap_or_else(|| PackageId::Hash(PackageHash::from_sha256_bytes(package.sha256)));
    let pkg = PackageInfo::from_manifest(id, manifest, container.version())
        .map_err(|e| bad(e.to_string()))?;
    // The URL is never fetched: the loader answers by digest. It only has to
    // be a valid URL for the summary type.
    let url = url::Url::parse(&format!("iwci-webc:///{}", hash.as_hex()))
        .map_err(|e| bad(e.to_string()))?;
    let summary = PackageSummary {
        pkg,
        dist: DistributionInfo {
            webc: url,
            webc_sha256: hash,
        },
    };
    let parsed = Arc::new((summary, container));
    if remember {
        shared.containers.insert(hash, &parsed);
    }
    Ok(parsed)
}

/// A job's native programs inside its sandbox (`inside::natives`); nothing
/// elsewhere.
#[cfg(target_os = "linux")]
pub(crate) type Natives = Arc<crate::inside::natives::Natives>;
#[cfg(not(target_os = "linux"))]
pub(crate) type Natives = ();

/// Where an environment job finds the runner's support files for Node.
pub const NODE_SUPPORT_DIR: &str = "/usr/local/lib/iwci/node";

/// The files under [`NODE_SUPPORT_DIR`]: a working `node:wasi` for
/// Edge.js, whose own has no binding behind it, and the preload that fills
/// its other gaps (see `node/README.md`). Its built-ins cache goes beside
/// them when there is one (builtins.rs).
const NODE_SUPPORT: &[(&str, &[u8])] = &[
    ("preload.cjs", include_bytes!("../node/preload.cjs")),
    (
        "host-platform.cjs",
        include_bytes!("../node/host-platform.cjs"),
    ),
    ("blob-stream.cjs", include_bytes!("../node/blob-stream.cjs")),
    (
        "esbuild-stdio.cjs",
        include_bytes!("../node/esbuild-stdio.cjs"),
    ),
    ("pnpm-global.cjs", include_bytes!("../node/pnpm-global.cjs")),
    ("spawn-path.cjs", include_bytes!("../node/spawn-path.cjs")),
    ("wasi.cjs", include_bytes!("../node/wasi.cjs")),
    ("wasm-util.cjs", include_bytes!("../node/wasm-util.cjs")),
    (
        "wasm-util.LICENSE",
        include_bytes!("../node/wasm-util.LICENSE"),
    ),
];

/// `npx`, for an environment job with `node`: npm's own, which Edge.js
/// ships (its `npm` command is pnpm) without putting it on `PATH`; [`NPM`]
/// is its `npm`. A tool of the same name wins over it.
const NPX: &[u8] = b"#!/bin/bash\n\
# npm's npx, from Edge.js's copy of npm (the runner's node support).\n\
if [[ ! -f /npm/bin/npx-cli.js ]]; then\n\
  echo 'npx: this environment has no npm to run it from; try pnpm dlx' >&2\n\
  exit 127\n\
fi\n\
exec node /npm/bin/npx-cli.js \"$@\"\n";

/// `npm`, for an environment job with `node`: npm's own, from the same copy
/// as `npx`, where Edge.js's `npm` command is pnpm (which refuses a project
/// that says it uses npm, and has no `package-lock.json`). A global
/// install still goes to Edge.js's command, so `npm i -g` keeps putting
/// commands in `PNPM_HOME`, on `PATH`, as before. A tool of the same name
/// wins over it.
const NPM: &[u8] = b"#!/bin/bash\n\
# npm's npm, from Edge.js's copy of npm (the runner's node support).\n\
for arg in \"$@\"; do\n\
  case \"$arg\" in\n\
  --) break ;;\n\
  -g | --global | --location=global)\n\
    [[ -x /usr/bin/npm ]] && exec /usr/bin/npm \"$@\"\n\
    ;;\n\
  esac\n\
done\n\
if [[ ! -f /npm/bin/npm-cli.js ]]; then\n\
  [[ -x /usr/bin/npm ]] && exec /usr/bin/npm \"$@\"\n\
  echo 'npm: this environment has no npm to run it from; try pnpm' >&2\n\
  exit 127\n\
fi\n\
exec node /npm/bin/npm-cli.js \"$@\"\n";

/// `NODE_OPTIONS` for an environment job: the support preload first, then
/// whatever the job set.
pub(crate) fn node_options(env: &[(String, String)]) -> String {
    let preload = format!("--require {NODE_SUPPORT_DIR}/preload.cjs");
    match env.iter().rev().find(|(k, _)| k == "NODE_OPTIONS") {
        Some((_, v)) if v.contains(&preload) => v.clone(),
        Some((_, v)) if !v.trim().is_empty() => format!("{preload} {v}"),
        _ => preload,
    }
}

/// The root file system of a job: the job's own file system at `/`, with
/// scratch mounts that keep WASIX's own files out of `JobFs::changes`.
///
/// A shell job (`shell`) also gets the mode commands in `/usr/local/bin` and
/// the file system they work through (`modes.rs`), and the commands that
/// wait for its background services with theirs (`services.rs`). Every
/// mount but the job's
/// own (which does it itself) is wrapped so that removing or renaming a file
/// moves its mode in `modes`.
///
/// `own_dirs` is for a service: its `/tmp`, and the directories its
/// packages mount, are its own and start empty. A job's are in the job's
/// file system (`/tmp` there, and `package_dirs` over it), so what it
/// writes there is the job's, as anywhere else: counted against its
/// memory, and what `cache:`, `artifacts:` and an environment's caches
/// read and restore (#1083).
#[allow(clippy::too_many_arguments)]
fn job_root(
    fs: crate::DynFs,
    scratch: Option<crate::DynFs>,
    commands: &[crate::PathCommand],
    trees: &[crate::PathTree],
    node_support: bool,
    builtins: Option<&bytes::Bytes>,
    shell: bool,
    modes: &iwci_vfs::Modes,
    listeners: &crate::network::Listeners,
    own_dirs: bool,
    package_dirs: &[BinaryPackageMount],
    natives: Option<&Natives>,
    cpus: usize,
) -> Result<MountFileSystem> {
    type Dyn = Arc<dyn FileSystem + Send + Sync>;
    let tracked =
        |fs: Dyn, at: &str| -> Dyn { Arc::new(iwci_vfs::TrackModes::new(fs, modes.clone(), at)) };
    let mount_err = |e| Error::Setup(format!("mounting the job file system: {e}"));
    // A package's directory over the job's file system: the package's
    // files below, what the job writes above, at the same path of the
    // job's file system, so it holds only what the job added or changed.
    // wasmer-wasix would put a private, empty layer there instead.
    let mut dirs: Vec<(String, String, Dyn)> = Vec::with_capacity(package_dirs.len());
    for dir in package_dirs {
        let (Some(at), Some(source)) = (dir.guest_path.to_str(), dir.source_path.to_str()) else {
            continue;
        };
        iwci_vfs::create_dir_all(fs.as_ref(), &dir.guest_path).map_err(|e| {
            Error::Setup(format!(
                "creating {} in the job file system: {e}",
                dir.guest_path.display()
            ))
        })?;
        let upper = MountFileSystem::new();
        upper
            .mount_with_source(&dir.source_path, &dir.guest_path, fs.clone())
            .map_err(mount_err)?;
        let overlay: Dyn = Arc::new(OverlayFileSystem::new(
            upper,
            [ArcFileSystem::new(dir.fs.clone())],
        ));
        dirs.push((at.to_string(), source.to_string(), overlay));
    }
    // (where, the path in the file system that appears there, what)
    let mut mounts: Vec<(&str, &str, Dyn)> = vec![("/", "/", fs.clone())];
    // /dev/null, /dev/zero, /dev/urandom and /dev/std{in,out,err} (which
    // name the process's own descriptors), and, for a service, an empty
    // /tmp. Both mounts are given their own paths, so their paths are the
    // guest's. A job's /tmp is the job's file system's.
    let system = tracked(Arc::new(RootFileSystemBuilder::default().build_tmp()), "/");
    mounts.push(("/dev", "/dev", system.clone()));
    // /proc/cpuinfo, saying the job has the CPUs WASIX tells it it has.
    mounts.push(("/proc", "/", tracked(proc_fs(cpus)?, "/proc")));
    if own_dirs {
        mounts.push(("/tmp", "/tmp", system));
    } else {
        iwci_vfs::create_dir_all(fs.as_ref(), "/tmp")
            .map_err(|e| Error::Setup(format!("creating /tmp in the job file system: {e}")))?;
    }
    for (at, source, overlay) in &dirs {
        mounts.push((at, source, overlay.clone()));
    }
    // wasmer-wasix writes every package command's wasm into /bin and
    // /usr/bin so a shell can find it on PATH.
    for dir in ["/bin", "/usr/bin"] {
        mounts.push((dir, "/", tracked(Arc::new(TmpFileSystem::new()), dir)));
    }
    if let Some(scratch) = scratch {
        mounts.push((
            crate::SCRATCH_MOUNT,
            "/",
            tracked(scratch, crate::SCRATCH_MOUNT),
        ));
    }
    #[cfg(not(target_os = "linux"))]
    let _ = natives;
    if !commands.is_empty() || shell {
        let bin = TmpFileSystem::new();
        if shell {
            for (name, bytes) in crate::modes::MODE_COMMANDS
                .iter()
                .chain(crate::services::SERVICE_COMMANDS)
            {
                write_command(&bin, name, bytes)?;
            }
        }
        if node_support {
            write_command(&bin, "npx", NPX)?;
            write_command(&bin, "npm", NPM)?;
        }
        for tree in trees {
            for (name, script) in &tree.scripts {
                write_command(&bin, name, script)?;
            }
        }
        // A tool of the same name wins over a mode command.
        for command in commands {
            write_command(&bin, &command.name, &command.module.bytes)?;
        }
        // Inside a sandbox, the native programs' trampolines (`inside`).
        #[cfg(target_os = "linux")]
        if shell && let Some(natives) = natives {
            for name in natives.names() {
                let wasm = crate::inside::natives::trampoline(name).ok_or_else(|| {
                    Error::Setup(format!("the native program `{name}` has no trampoline"))
                })?;
                write_command(&bin, name, &wasm)?;
            }
        }
        mounts.push((
            "/usr/local/bin",
            "/",
            tracked(Arc::new(bin), "/usr/local/bin"),
        ));
    }
    // Each Node tool's files, read only and shared with every job that
    // uses the same build.
    for tree in trees {
        mounts.push((tree.dir.as_str(), "/", tree.fs.clone()));
    }
    if node_support {
        let dir = TmpFileSystem::new();
        for (name, bytes) in NODE_SUPPORT {
            write_command(&dir, name, bytes)?;
        }
        // Read only, and the same bytes for every job.
        if let Some(builtins) = builtins {
            dir.new_open_options_ext()
                .insert_ro_file(
                    &Path::new("/").join(crate::builtins::FILE),
                    shared_buffer::OwnedBuffer::from_bytes(builtins.clone()),
                )
                .map_err(|e| Error::Setup(format!("writing Edge.js's built-ins cache: {e}")))?;
        }
        mounts.push((
            NODE_SUPPORT_DIR,
            "/",
            tracked(Arc::new(dir), NODE_SUPPORT_DIR),
        ));
    }

    let build = |mounts: &[(&str, &str, Dyn)]| -> Result<MountFileSystem> {
        let root = MountFileSystem::new();
        for (at, source, fs) in mounts {
            root.mount_with_source(Path::new(at), Path::new(source), fs.clone())
                .map_err(mount_err)?;
        }
        Ok(root)
    };
    let root = build(&mounts)?;
    if shell {
        // The mode files see the same mounts, without themselves. Package
        // volumes wasmer-wasix mounts later (Edge.js's npm) are not among
        // them, so a mode command does not see those.
        let view: Dyn = Arc::new(build(&mounts)?);
        let control = crate::modes::ModeControl::new(view, modes.clone());
        root.mount(Path::new(crate::modes::MODES_DIR), Arc::new(control))
            .map_err(mount_err)?;
        let ports = crate::services::PortControl::new(listeners.clone());
        root.mount(Path::new(crate::services::PORTS_DIR), Arc::new(ports))
            .map_err(mount_err)?;
        #[cfg(target_os = "linux")]
        if let Some(natives) = natives {
            let control = crate::inside::natives::NativeControl::new(natives.clone());
            root.mount(
                Path::new(crate::inside::natives::NATIVE_DIR),
                Arc::new(control),
            )
            .map_err(mount_err)?;
        }
    }
    Ok(root)
}

/// What every job finds at `/proc`: `cpuinfo`, read only, listing `cpus`
/// processors on one package of `cpus` cores, the count WASIX reports
/// (`thread_parallelism`, which is what `os.cpu_count()` and `nproc` read;
/// `Limits::told_cpus`: the job's `cpus:`, or 1). WASIX has no `/proc`, and
/// psutil's `cpu_count(logical=False)`, which pytest-xdist's `-n auto`
/// asks when psutil is installed, reads the physical cores from this file
/// and raised `FileNotFoundError` without it. Nothing else is here; Node's
/// `os.cpus()` reads no file (Edge.js's libuv for WASI has no CPU list, and
/// it answers with one CPU). The mode, port and native program controls
/// mount under it at `/proc/iwci`.
fn proc_fs(cpus: usize) -> Result<Arc<dyn FileSystem + Send + Sync>> {
    let fs = TmpFileSystem::new();
    fs.new_open_options_ext()
        .insert_ro_file(
            Path::new("/cpuinfo"),
            shared_buffer::OwnedBuffer::from_bytes(bytes::Bytes::from(cpuinfo(cpus))),
        )
        .map_err(|e| Error::Setup(format!("writing /proc/cpuinfo: {e}")))?;
    Ok(Arc::new(fs))
}

/// `/proc/cpuinfo` as Linux lays it out on x86, with the fields programs
/// parse: a `processor` section per CPU, all of them cores of physical
/// package 0 (`physical id`, `siblings`, `core id`, `cpu cores`).
fn cpuinfo(cpus: usize) -> String {
    let cpus = cpus.max(1);
    let mut text = String::new();
    for cpu in 0..cpus {
        text.push_str(&format!(
            "processor\t: {cpu}\n\
             vendor_id\t: WebAssembly\n\
             model name\t: WebAssembly\n\
             physical id\t: 0\n\
             siblings\t: {cpus}\n\
             core id\t\t: {cpu}\n\
             cpu cores\t: {cpus}\n\
             \n"
        ));
    }
    text
}

/// Makes the directory `HOME` names in a shell job's file system. The
/// runner sets `HOME=/root` for every job, and nothing in an environment
/// made it: `pnpm dlx` failed with "lstat '/root'", and `pnpm add -g` and
/// npm's caches had nowhere to start from. Best effort: a `HOME` the job set
/// somewhere it cannot be made is the job's to sort out.
fn make_home(fs: &(dyn FileSystem + Send + Sync), env: &[(String, String)]) {
    let Some((_, home)) = env.iter().rev().find(|(k, _)| k == "HOME") else {
        return;
    };
    if home.starts_with('/') && home.len() > 1 {
        let _ = iwci_vfs::create_dir_all(fs, home);
    }
}

/// The user database of an environment job: `root`, who a job runs as
/// (uid 0, `HOME=/root`), and `nobody`.
const PASSWD: &str = "root:x:0:0:root:/root:/bin/bash\n\
                      nobody:x:65534:65534:nobody:/nonexistent:/bin/false\n";
const GROUP: &str = "root:x:0:\nnogroup:x:65534:\n";

/// A file system holding the user database in the directory `etc`.
fn user_database(etc: &Path) -> Result<Arc<dyn FileSystem + Send + Sync>> {
    let err = |e: &dyn std::fmt::Display| Error::Setup(format!("writing the user database: {e}"));
    let fs = TmpFileSystem::new();
    iwci_vfs::create_dir_all(&fs, etc).map_err(|e| err(&e))?;
    for (name, text) in [("passwd", PASSWD), ("group", GROUP)] {
        fs.new_open_options_ext()
            .insert_ro_file(
                &etc.join(name),
                shared_buffer::OwnedBuffer::from_bytes(bytes::Bytes::from_static(text.as_bytes())),
            )
            .map_err(|e| err(&e))?;
    }
    Ok(Arc::new(fs))
}

/// The packages of an environment job with a user database in `/etc`
/// (#1077). The isolate had none, so nothing answered for the root a job is
/// told it is: Node's `os.userInfo()` threw (ENOENT from
/// `uv_os_get_passwd`), and with it anything that asks for the user's shell
/// that way, such as oclif's command lines.
///
/// It is a package of its own, with no commands, used after the
/// environment's, so its files sit under theirs in the root file system and
/// a package that brings its own `/etc/passwd` wins. A package that mounts a
/// volume at `/etc` (Edge.js's `hosts` and `resolv.conf`) hides what the
/// root file system has there, so the database goes under that volume too.
fn with_user_database(packages: &[BinaryPackage]) -> Result<Vec<BinaryPackage>> {
    let etc = Path::new("/etc");
    let mut out = Vec::with_capacity(packages.len() + 1);
    for package in packages {
        let mut package = package.clone();
        if let Some(mounts) = &package.package_mounts
            && mounts.mounts.iter().any(|m| m.guest_path == etc)
        {
            let mut mounts = BinaryPackageMounts::clone(mounts);
            for mount in mounts.mounts.iter_mut().filter(|m| m.guest_path == etc) {
                let users = user_database(&mount.source_path)?;
                mount.fs = Arc::new(OverlayFileSystem::new(
                    ArcFileSystem::new(mount.fs.clone()),
                    [ArcFileSystem::new(users)],
                ));
            }
            package.package_mounts = Some(Arc::new(mounts));
        }
        out.push(package);
    }
    let id = PackageId::new_named(
        "iwci/user-database",
        "1.0.0"
            .parse()
            .map_err(|e| Error::Setup(format!("the user database's version: {e}")))?,
    );
    out.push(BinaryPackage {
        id: id.clone(),
        package_ids: vec![id],
        webc_version: webc::Version::V3,
        when_cached: None,
        entrypoint_cmd: None,
        hash: Default::default(),
        package_mounts: Some(Arc::new(BinaryPackageMounts {
            root_layer: Some(user_database(etc)?),
            mounts: Vec::new(),
        })),
        commands: Vec::new(),
        uses: Vec::new(),
        file_system_memory_footprint: 0,
        additional_host_mapped_directories: Vec::new(),
    });
    Ok(out)
}

/// Takes the directories `uses` mount (every `[fs]` entry but `/`) out of
/// the packages, for `job_root` to mount over the job's file system; the
/// packages keep their root layer, which wasmer-wasix stacks under `/` as
/// before. Where two packages mount the same path, the first keeps it.
fn take_package_dirs(uses: Vec<BinaryPackage>) -> (Vec<BinaryPackage>, Vec<BinaryPackageMount>) {
    let mut dirs: Vec<BinaryPackageMount> = Vec::new();
    let uses = uses
        .into_iter()
        .map(|mut package| {
            if let Some(mounts) = package.package_mounts.take() {
                for mount in &mounts.mounts {
                    if !dirs.iter().any(|d| d.guest_path == mount.guest_path) {
                        dirs.push(mount.clone());
                    }
                }
                package.package_mounts = Some(Arc::new(BinaryPackageMounts {
                    root_layer: mounts.root_layer.clone(),
                    mounts: Vec::new(),
                }));
            }
            package
        })
        .collect();
    (uses, dirs)
}

/// Writes `bytes` as the executable file `/<name>` of `fs`.
fn write_command(fs: &TmpFileSystem, name: &str, bytes: &[u8]) -> Result<()> {
    use virtual_fs::AsyncWriteExt;
    let err = |e: &dyn std::fmt::Display| Error::Setup(format!("writing command `{name}`: {e}"));
    let mut file = fs
        .new_open_options()
        .create(true)
        .write(true)
        .truncate(true)
        .open(Path::new("/").join(name))
        .map_err(|e| err(&e))?;
    futures::executor::block_on(async {
        file.write_all(bytes).await?;
        file.flush().await
    })
    .map_err(|e| err(&e))
}

/// The engine of one job's stores: a clone of the job's engine with
/// tunables that enforce its limits and hold its modules, so no module is
/// freed while a store of the job can run it (cache.rs). With it, whether
/// a memory was refused growth and the meter of the memories it makes.
pub(crate) fn job_engine(
    job_modules: &JobModules,
    memory_bytes: u64,
    stack_bytes: usize,
    watch: Option<crate::MemoryWatch>,
) -> (Engine, Arc<AtomicBool>, Arc<MemoryMeter>) {
    let hit = Arc::new(AtomicBool::new(false));
    let meter = Arc::new(MemoryMeter::watched(watch));
    let mut engine = job_modules.engine().clone();
    engine.set_tunables(
        LimitingTunables::new(memory_bytes, stack_bytes, hit.clone(), meter.clone())
            .holding(job_modules.clone()),
    );
    (engine, hit, meter)
}

fn check_nul(inv: &Invocation) -> Result<()> {
    let has_nul = |s: &str| s.contains('\0');
    let bad_env = |env: &[(String, String)]| {
        env.iter()
            .any(|(k, v)| has_nul(k) || has_nul(v) || k.contains('='))
    };
    let bad_service = |service: &crate::Service| {
        bad_env(&service.env)
            || match &service.program {
                crate::ServiceProgram::Command { args, .. } => args.iter().any(|a| has_nul(a)),
                crate::ServiceProgram::Script { script, .. } => has_nul(script),
            }
            || matches!(&service.ready, crate::Ready::Command(s) if has_nul(s))
    };
    if has_nul(&inv.cwd)
        || inv.args.iter().any(|a| has_nul(a))
        || bad_env(&inv.env)
        || inv.services.iter().any(bad_service)
    {
        return Err(Error::InvalidInput(
            "cwd, args and env must not contain NUL bytes, and env names no '='".into(),
        ));
    }
    Ok(())
}

/// What to start in the job's runtime.
pub(crate) enum Entry<'a> {
    /// A WASI or WASIX module with `_start`, already compiled.
    Module(Module),
    /// A command of an environment package (`bash`).
    Command {
        packages: &'a [WebcPackage],
        name: &'a str,
    },
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct Caps {
    pub(crate) output_bytes: usize,
    /// Stop the job once it has gone this long without output or CPU use
    /// (stall.rs); `None` waits for the timeout.
    pub(crate) stall_after: Option<Duration>,
}

/// Edge.js's built-ins cache for a job of `packages` with Node hooks
/// (builtins.rs): made before the first job of the environment this process
/// runs, by a job of its own. `None` for an environment without `node`.
#[cfg_attr(not(feature = "node"), allow(unused_variables))]
pub(crate) fn builtins(
    shared: &WasixShared,
    tokio: &tokio::runtime::Runtime,
    job_modules: &JobModules,
    packages: &[WebcPackage],
    output_bytes: usize,
) -> Option<bytes::Bytes> {
    #[cfg(feature = "node")]
    {
        let set = PackageSet::new(shared, packages, true).ok()?;
        if !set.has_command("node") {
            return None;
        }
        shared.builtins.get_or_make(set.digests(), || {
            crate::builtins::make(|script, mut inv| {
                inv.args = crate::script_args("bash", script);
                inv.env.push(("PATH".into(), crate::DEFAULT_PATH.into()));
                let node = crate::node::NodeHooks::new(inv.limits.memory_bytes);
                run(
                    shared,
                    tokio,
                    job_modules,
                    Entry::Command {
                        packages,
                        name: "bash",
                    },
                    "bash",
                    inv,
                    Caps {
                        output_bytes,
                        stall_after: Some(Duration::from_secs(30)),
                    },
                    Some(&node),
                    None,
                )
            })
        })
    }
    #[cfg(not(feature = "node"))]
    None
}

/// Starts the process trees of one job on its runtime: its first process,
/// each of its services and a service's readiness probe (background.rs).
/// Each tree gets its own control plane and root file system, over the
/// job's files.
pub(crate) struct Starter<'a> {
    pub(crate) shared: &'a WasixShared,
    /// The job's engine and modules, which its services share.
    pub(crate) job_modules: &'a JobModules,
    pub(crate) tokio: &'a tokio::runtime::Runtime,
    pub(crate) runtime: &'a Arc<dyn WasixRuntime + Send + Sync>,
    pub(crate) fs: &'a crate::DynFs,
    pub(crate) scratch: Option<&'a crate::DynFs>,
    pub(crate) modes: &'a iwci_vfs::Modes,
    pub(crate) listeners: &'a crate::network::Listeners,
    /// The job has Node hooks (`NodeHooks`).
    pub(crate) node: bool,
    /// Edge.js's built-ins cache, for its `node`s (builtins.rs).
    pub(crate) builtins: Option<&'a bytes::Bytes>,
    /// Inside a sandbox, the job's native programs (`inside`).
    pub(crate) natives: Option<&'a Natives>,
}

/// What a [`Process`] runs.
pub(crate) enum Program {
    /// A WASI or WASIX module with `_start`, already compiled.
    Module(Module),
    /// The command `name` of one of `uses`, every one of whose commands is
    /// on the process's `PATH`.
    Command {
        uses: Vec<BinaryPackage>,
        name: String,
    },
}

/// The first process of one tree.
pub(crate) struct Process<'a> {
    /// `argv[0]`.
    pub(crate) name: &'a str,
    pub(crate) program: Program,
    /// After `argv[0]`.
    pub(crate) args: Vec<String>,
    pub(crate) env: Vec<(String, String)>,
    pub(crate) cwd: &'a str,
    /// `tools:` on `PATH`; a `Command` gets the mode and service commands
    /// there as well.
    pub(crate) commands: &'a [crate::PathCommand],
    /// Node tools' directories and commands, for a `Command` only.
    pub(crate) trees: &'a [crate::PathTree],
    pub(crate) stdout: Box<dyn VirtualFile + Send + Sync + 'static>,
    pub(crate) stderr: Box<dyn VirtualFile + Send + Sync + 'static>,
    /// Empty when `None`.
    pub(crate) stdin: Option<Box<dyn VirtualFile + Send + Sync + 'static>>,
    /// A service's tree: its `/tmp` and its packages' directories are its
    /// own rather than the job's file system's (see `job_root`).
    pub(crate) own_dirs: bool,
}

impl Starter<'_> {
    /// Starts `process` and returns its handle and its control plane.
    pub(crate) fn start(&self, process: Process<'_>) -> Result<(TaskJoinHandle, WasiControlPlane)> {
        let shell = matches!(process.program, Program::Command { .. });
        let mut builder = WasiEnvBuilder::new(process.name);
        builder.add_args(process.args.iter());
        builder.add_envs(process.env.iter().map(|(k, v)| (k.clone(), v.clone())));
        // Go's wasip1 port takes its working directory from `$PWD`, not from
        // WASI, and treats a missing one as `/`: gofmt given `.` then walks
        // the whole file system. A shell would have set it, so set it to the
        // cwd.
        if !process.env.iter().any(|(k, _)| k == "PWD") {
            builder.add_env("PWD", process.cwd);
        }
        builder.set_runtime(self.runtime.clone());
        if shell {
            make_home(self.fs.as_ref(), &process.env);
        }
        let (program, package_dirs) = match process.program {
            Program::Command { uses, name } => {
                let uses = with_user_database(&uses)?;
                if process.own_dirs {
                    (Program::Command { uses, name }, Vec::new())
                } else {
                    let (uses, dirs) = take_package_dirs(uses);
                    (Program::Command { uses, name }, dirs)
                }
            }
            program => (program, Vec::new()),
        };
        // An environment's `node` gets the runner's support files.
        builder.set_mount_fs(job_root(
            self.fs.clone(),
            self.scratch.cloned(),
            process.commands,
            if shell { process.trees } else { &[] },
            self.node && shell,
            self.builtins,
            shell,
            self.modes,
            self.listeners,
            process.own_dirs,
            &package_dirs,
            self.natives,
            self.runtime
                .task_manager()
                .thread_parallelism()
                .unwrap_or(1),
        )?);
        // WASIX programs ask the runtime for their working directory. Plain
        // WASI ones built on wasi-libc cannot be given one: their cwd is
        // always `/`, and a preopen of the cwd named `.` either changes
        // nothing or sends every absolute path into the cwd (#906, and the
        // test `a_command_sees_only_the_root_preopen_and_its_cwd_as_pwd`).
        // `$PWD` is how they learn it.
        builder.set_current_dir(process.cwd);
        builder
            .add_preopen_dir("/")
            .map_err(|e| Error::Setup(e.to_string()))?;
        builder.set_stdin(
            process
                .stdin
                .unwrap_or_else(|| Box::new(NullFile::default())),
        );
        builder.set_stdout(process.stdout);
        builder.set_stderr(process.stderr);
        builder.capabilities_mut().threading.max_threads = Some(MAX_TASKS);
        // V8 must run on a real thread stack. With asynchronous threading,
        // wasm (and the N-API calls it makes into V8) runs on coroutine
        // stacks, and V8, whose isolate takes its stack bounds from where it
        // was created, segfaults the first time it unwinds an exception.
        // wasmer-napi's own runner turns it off for N-API modules the same
        // way. It is set in the tree's control plane, so it covers bash and
        // every `node` it spawns.
        if self.node {
            builder
                .capabilities_mut()
                .threading
                .enable_asynchronous_threading = false;
        }
        if let Program::Command { uses, .. } = &program {
            for package in uses {
                builder.add_webc(package.clone());
            }
        }
        let env = builder.build().map_err(|e| Error::Setup(e.to_string()))?;
        let control_plane = env.control_plane.clone();
        let handle = match program {
            Program::Module(module) => spawn_exec_module(module, env, self.runtime),
            Program::Command { uses, name } => {
                let package = uses
                    .iter()
                    .find(|p| p.get_command(&name).is_some())
                    .cloned()
                    .ok_or_else(|| {
                        Error::Setup(format!("no package in the environment provides `{name}`"))
                    })?;
                self.tokio
                    .block_on(spawn_exec(package, &name, env, self.runtime))
            }
        }
        .map_err(|e| Error::Setup(e.to_string()))?;
        Ok((handle, control_plane))
    }

    /// `packages` loaded for a tree of their own (a service's), with their
    /// commands' default environment under `env` (see
    /// `command_env_as_defaults`). They are resolved against each other,
    /// as for a job that uses them, and share its cache.
    pub(crate) fn load(
        &self,
        packages: &[WebcPackage],
        env: &[(String, String)],
    ) -> Result<Vec<BinaryPackage>> {
        let set = PackageSet::new(self.shared, packages, true)?;
        let loader = JobRuntime::new(
            self.shared,
            self.job_modules,
            self.job_modules.engine().clone(),
            Some(&set),
            None,
            false,
            Arc::default(),
            None,
            &[],
        );
        let loader: Arc<dyn WasixRuntime + Send + Sync> = Arc::new(loader);
        let uses = binary_packages(self.shared, &set, &loader, self.tokio)?;
        let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).chain(["PWD"]).collect();
        Ok(command_env_as_defaults(uses, &keys))
    }
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn run(
    shared: &WasixShared,
    tokio: &tokio::runtime::Runtime,
    job_modules: &JobModules,
    entry: Entry<'_>,
    program_name: &str,
    inv: Invocation,
    caps: Caps,
    node: Option<&crate::node::NodeHooks>,
    builtins: Option<bytes::Bytes>,
) -> Result<Outcome> {
    check_nul(&inv)?;
    let started = Instant::now();
    let _enter = tokio.enter();

    let (engine, hit_memory, meter) = job_engine(
        job_modules,
        inv.limits.memory_bytes,
        WASIX_STACK,
        inv.memory_watch.clone(),
    );

    let package_set = match &entry {
        Entry::Module(_) => None,
        Entry::Command { packages, .. } => Some(PackageSet::new(shared, packages, true)?),
    };
    let cpu = Arc::new(CpuMeter::default());
    // This thread works for the job too: it loads the job's packages and
    // modules and starts its first process, then waits for it.
    let _driving = cpu.enter();
    let service_names: Vec<String> = inv.services.iter().map(|s| s.name.clone()).collect();
    let runtime = JobRuntime::new(
        shared,
        job_modules,
        engine,
        package_set.as_ref(),
        node,
        inv.internet,
        cpu.clone(),
        Some(inv.limits.told_cpus()),
        &service_names,
    );
    let control = runtime.control.clone();
    let listeners = runtime.listeners.clone();
    let runtime: Arc<dyn WasixRuntime + Send + Sync> = Arc::new(runtime);

    let uses = match &package_set {
        Some(set) => binary_packages(shared, set, &runtime, tokio)?,
        None => Vec::new(),
    };
    // A tool that runs on a command the environment lacks (a Node tool in
    // `env:bash`) says so before anything starts.
    for tree in &inv.trees {
        if let Some(needed) = &tree.needs
            && !uses
                .iter()
                .any(|package| package.commands.iter().any(|c| c.name() == needed))
        {
            return Err(Error::Setup(format!(
                "`{}` (tools:) runs on `{needed}`, which this environment does not have: use one that has, such as env:bash-node@24",
                tree.name
            )));
        }
    }
    // What a native program's shim starts comes from the same packages,
    // with its own environment's defaults (`inside::shim`).
    #[cfg(target_os = "linux")]
    let shim_uses = uses.clone();
    // An environment job's `node` gets the runner's support files.
    let node_support = node.is_some() && matches!(entry, Entry::Command { .. });
    let mut env = inv.env.clone();
    if node_support {
        let options = node_options(&env);
        env.retain(|(k, _)| k != "NODE_OPTIONS");
        env.push(("NODE_OPTIONS".into(), options));
    }
    let job_keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).chain(["PWD"]).collect();
    let uses = command_env_as_defaults(uses, &job_keys);

    // Bytes written to either stream, which the stall check watches.
    let written = Arc::new(AtomicU64::new(0));
    let stdout = Capture::new(caps.output_bytes)
        .with_sink(inv.log.clone(), crate::Stream::Stdout)
        .counting(written.clone());
    let stderr = Capture::new(caps.output_bytes)
        .with_sink(inv.log.clone(), crate::Stream::Stderr)
        .counting(written.clone());

    // Inside a sandbox, the job's native programs and their sessions.
    #[cfg(target_os = "linux")]
    let natives: Option<Natives> = shared.sandbox.as_ref().map(|sandbox| {
        Arc::new(
            crate::inside::natives::Natives::new(sandbox.natives.clone())
                .telling_cpus(inv.limits.told_cpus()),
        )
    });
    #[cfg(not(target_os = "linux"))]
    let natives: Option<Natives> = None;
    let starter = Starter {
        shared,
        job_modules,
        tokio,
        runtime: &runtime,
        fs: &inv.fs,
        scratch: inv.scratch.as_ref(),
        modes: &inv.modes,
        listeners: &listeners,
        node: node.is_some(),
        builtins: builtins.as_ref(),
        natives: natives.as_ref(),
    };
    let interrupt = || {
        #[cfg(feature = "node")]
        if let Some(node) = node {
            node.terminate();
        }
        control.interrupt_all();
    };

    // Inside a sandbox, native programs start the environment's commands
    // through shims (`inside::shim`).
    #[cfg(target_os = "linux")]
    let shim_spawn = |request: crate::inside::natives::Request,
                      stdio: crate::inside::shim::Stdio| {
        shim_process(
            &starter,
            &shim_uses,
            &inv.commands,
            &inv.trees,
            node.is_some(),
            request,
            stdio,
        )
    };
    std::thread::scope(|scope| {
        #[cfg(target_os = "linux")]
        let shims = match &natives {
            Some(_) => Some(
                crate::inside::shim::Server::start(scope, &shim_spawn, tokio.handle().clone())
                    .map_err(|e| Error::Setup(format!("listening for native programs: {e}")))?,
            ),
            None => None,
        };
        #[cfg(not(target_os = "linux"))]
        let _ = scope;
        let result = (|| -> Result<Outcome> {
            // The job's services first, each ready before the job starts
            // (background.rs).
            let deadline = started + inv.limits.timeout;
            let mut services = Services::start(&starter, &inv.services, &stderr, &inv.cwd)?;
            let cancel = inv.cancel.clone();
            let cancelled = || cancel.as_ref().is_some_and(|c| c.is_cancelled());
            if let Err(failure) = services.wait_ready(&starter, deadline, cancel.as_ref()) {
                services.stop(&interrupt);
                stderr.push(format!("iwci: {failure}\n").as_bytes());
                let out = stdout.take();
                let err = stderr.take();
                let cancelled = cancelled();
                return Ok(Outcome {
                    exit_code: if cancelled { TIMEOUT_EXIT_CODE } else { 1 },
                    stdout: out.bytes,
                    stderr: err.bytes,
                    truncated: out.truncated || err.truncated,
                    duration: started.elapsed(),
                    timed_out: false,
                    cancelled,
                    stalled_after: None,
                    out_of_memory: hit_memory.load(Ordering::Acquire),
                    peak_memory_bytes: meter.peak(),
                    held_memory_bytes: meter.held_peak(),
                    error: None,
                    service_failure: (!cancelled).then_some(failure),
                    sandbox: None,
                });
            }

            let program = match entry {
                Entry::Module(module) => Program::Module(module),
                Entry::Command { name, .. } => Program::Command {
                    uses,
                    name: name.to_string(),
                },
            };
            let started_job = starter.start(Process {
                name: program_name,
                program,
                args: inv.args.clone(),
                env,
                cwd: &inv.cwd,
                commands: &inv.commands,
                trees: &inv.trees,
                stdout: stdout.file(),
                stderr: stderr.file(),
                stdin: None,
                own_dirs: false,
            });
            let (mut handle, control_plane) = match started_job {
                Ok(started) => started,
                Err(e) => {
                    services.stop(&interrupt);
                    return Err(e);
                }
            };

            let kill = || {
                interrupt();
                for_each_process(&control_plane, |process| {
                    process.signal_process(Signal::Sigkill)
                });
                services.kill();
            };
            let (result, stopped) = tokio.block_on(async {
                let mut finished = Box::pin(handle.wait_finished());
                let output = || written.load(Ordering::Relaxed);
                let mut watch = caps.stall_after.and_then(|after| {
                    StallWatch::new(after, Instant::now(), output(), cpu.total())
                });
                let stopped = loop {
                    let mut wake = match &watch {
                        Some(watch) => deadline.min(Instant::now() + watch.every()),
                        None => deadline,
                    };
                    if node.is_some() {
                        wake = wake.min(Instant::now() + MEMORY_POLL);
                    }
                    if !services.is_empty() {
                        wake = wake.min(Instant::now() + SERVICE_POLL);
                    }
                    if cancel.is_some() {
                        wake = wake.min(Instant::now() + crate::cancel::CANCEL_POLL);
                    }
                    let wake = tokio::time::Instant::from_std(wake);
                    if let Ok(result) = tokio::time::timeout_at(wake, &mut finished).await {
                        return (Some(result), None);
                    }
                    services.report_exits(&stderr);
                    if let Some(node) = node {
                        meter.set_heaps(node.heap_bytes(), node.held_heap_bytes());
                    }
                    if node.is_some_and(|node| node.exhaustion().stops_the_job()) {
                        break Stop::OutOfMemory;
                    }
                    if cancelled() {
                        break Stop::Cancelled;
                    }
                    let now = Instant::now();
                    if now >= deadline {
                        break Stop::Timeout;
                    }
                    if let Some(watch) = &mut watch
                        && watch.stalled(
                            now,
                            output(),
                            cpu.total(),
                            cpu.is_busy() || shared.store.is_working(),
                        )
                    {
                        break Stop::Stalled;
                    }
                };
                // An interrupt is best effort (it can land just before a guest
                // enters wasm, and a process blocked in a syscall only sees the
                // signal when it wakes), so both are repeated until the job ends.
                let grace = Instant::now() + KILL_GRACE;
                while Instant::now() < grace {
                    kill();
                    if let Ok(result) = tokio::time::timeout(KILL_POLL, &mut finished).await {
                        return (Some(result), Some(stopped));
                    }
                }
                // Still running: mark every process finished so the job returns.
                // A guest stuck inside a host call keeps its pool thread until that
                // call returns, but the job is over.
                for_each_process(&control_plane, |process| {
                    process.terminate(ExitCode::from(TIMEOUT_EXIT_CODE as u16))
                });
                let result = tokio::time::timeout(KILL_POLL, &mut finished).await.ok();
                (result, Some(stopped))
            });
            // The job is over, so are its services; what they printed last is
            // still theirs to say. The signals that stop them, and what the job
            // left running, are not the job's.
            services.report_exits(&stderr);
            control.signals.close();
            if !services.is_empty() {
                services.stop(&interrupt);
            }
            let timed_out = stopped == Some(Stop::Timeout);
            let stalled = stopped == Some(Stop::Stalled);
            let was_cancelled = stopped == Some(Stop::Cancelled);

            let result = match result {
                Some(result) => result,
                None => Ok(ExitCode::from(TIMEOUT_EXIT_CODE as u16)),
            };
            let trap = control
                .trap
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .take();
            let trapped = trap.clone();
            // After the trap is read: stopping a process that spins in Wasm traps
            // it, and that is not the job's crash.
            stop_left_behind(&control_plane, &interrupt);
            let (exit_code, error) = match result {
                Ok(code) if code.raw() == ENOEXEC && trap.is_some() => (CRASH_EXIT_CODE, trap),
                Ok(code) => (code.raw(), None),
                Err(err) => match err.as_exit_code() {
                    Some(code) => (code.raw(), None),
                    None => (
                        CRASH_EXIT_CODE,
                        Some(trap.unwrap_or_else(|| err.to_string())),
                    ),
                },
            };
            let out = stdout.take();
            let mut err = stderr.take();
            let exhaustion = node.map(|node| node.exhaustion()).unwrap_or_default();
            if let Some(node) = node {
                meter.set_heaps(node.heap_bytes(), node.held_heap_bytes());
            }
            let failed = stopped.is_some() || exit_code != 0;
            // Memory ran short for the job's Node (#964): a stopped heap ends the
            // job; a refused isolate or buffer is the program's to handle, and is
            // the reason only if the job then failed (as with a refused write).
            let out_of_memory = hit_memory.load(Ordering::Acquire)
                || exhaustion.stops_the_job()
                || (failed && exhaustion.any());
            // What the runner knows of a failure that the job's own output does not
            // say, added to its log, which is all a one-off like #955 leaves behind.
            let mut notes = Vec::new();
            if out_of_memory && let Some(note) = exhaustion.note(inv.limits.memory_bytes) {
                notes.push(note);
            }
            if stopped.is_none() && exit_code != 0 {
                // A trap in a child process or a guest thread: wasmer-wasix prints
                // it on the runner's stderr and the script carries on, or fails
                // somewhere else, with nothing to show for it.
                if error.is_none()
                    && let Some(trap) = trapped
                {
                    notes.push(format!(
                    "iwci: a process or thread of the job crashed, which its exit status ({exit_code}) does not say:\n  {}\n",
                    trap.replace('\n', "\n  ")
                ));
                }
                // A job that died of a signal: who sent it.
                notes.extend(control.signals.report(exit_code, &err.bytes));
            }
            for note in notes {
                let newline: &[u8] = if err.bytes.is_empty() || err.bytes.ends_with(b"\n") {
                    b""
                } else {
                    b"\n"
                };
                for part in [newline, note.as_bytes()] {
                    stderr.note(part);
                    err.bytes.extend_from_slice(part);
                }
            }
            Ok(Outcome {
                exit_code: if stopped.is_some() {
                    TIMEOUT_EXIT_CODE
                } else {
                    exit_code
                },
                stdout: out.bytes,
                stderr: err.bytes,
                truncated: out.truncated || err.truncated,
                duration: started.elapsed(),
                timed_out,
                cancelled: was_cancelled,
                stalled_after: caps.stall_after.filter(|_| stalled),
                out_of_memory,
                peak_memory_bytes: meter.peak(),
                held_memory_bytes: meter.held_peak(),
                error: if stopped.is_some() { None } else { error },
                service_failure: None,
                sandbox: None,
            })
        })();
        // What native programs and their shims left running is the job's.
        #[cfg(target_os = "linux")]
        {
            if let Some(shims) = &shims {
                shims.stop();
            }
            if let Some(natives) = &natives {
                natives.stop_all();
            }
        }
        result
    })
}

/// Starts the command a native program's shim asked for (`inside::shim`):
/// a package's command by its name, or anything else on the script's
/// `PATH` (a tool, a mode command) through the shell.
#[cfg(target_os = "linux")]
fn shim_process(
    starter: &Starter<'_>,
    uses: &[BinaryPackage],
    commands: &[crate::PathCommand],
    trees: &[crate::PathTree],
    node: bool,
    request: crate::inside::natives::Request,
    stdio: crate::inside::shim::Stdio,
) -> Result<(TaskJoinHandle, WasiControlPlane)> {
    let argv0 = request.args[0].clone();
    let name = argv0.rsplit('/').next().unwrap_or(&argv0).to_string();
    let mut env = request.env;
    // The isolate's `node` gets the runner's preload, which a native
    // program was not given (`inside::natives`).
    if node {
        let options = node_options(&env);
        env.retain(|(k, _)| k != "NODE_OPTIONS");
        env.push(("NODE_OPTIONS".into(), options));
    }
    let keys: Vec<&str> = env.iter().map(|(k, _)| k.as_str()).chain(["PWD"]).collect();
    let uses = command_env_as_defaults(uses.to_vec(), &keys);
    let provided = |n: &str| uses.iter().any(|p| p.get_command(n).is_some());
    let (program, args) = if provided(&name) {
        // The command's own leading arguments and default environment, as a
        // spawn from a WASIX process gives them (`prepare_spawn`): Edge.js's
        // `pnpm` is `node` with pnpm's script first, so turbo's `pnpm run
        // lint` ran `node run lint`.
        let (mut args, defaults) = command_defaults(&uses, &name);
        args.extend(request.args[1..].iter().cloned());
        for (key, value) in defaults {
            if !env.iter().any(|(k, _)| *k == key) {
                env.push((key, value));
            }
        }
        (name.clone(), args)
    } else if name == "sh" && provided("bash") {
        // bash started as `sh` is a POSIX shell, as `/bin/sh` is.
        ("bash".to_string(), request.args[1..].to_vec())
    } else {
        let mut args = vec![
            "-c".to_string(),
            "exec \"$0\" \"$@\"".to_string(),
            name.clone(),
        ];
        args.extend(request.args[1..].iter().cloned());
        ("bash".to_string(), args)
    };
    starter.start(Process {
        name: &name,
        program: Program::Command {
            uses,
            name: program,
        },
        args,
        env,
        cwd: &request.cwd,
        commands,
        trees,
        stdout: stdio.stdout,
        stderr: stdio.stderr,
        stdin: Some(stdio.stdin),
        own_dirs: false,
    })
}

/// The `wasi` annotation of the command `name` in `uses`: its leading
/// arguments (`main-args`) and its default environment.
#[cfg(target_os = "linux")]
fn command_defaults(uses: &[BinaryPackage], name: &str) -> (Vec<String>, Vec<(String, String)>) {
    let Some(Ok(Some(wasi))) = uses
        .iter()
        .find_map(|p| p.get_command(name))
        .map(|command| command.metadata().wasi())
    else {
        return (Vec::new(), Vec::new());
    };
    let env = wasi
        .env
        .unwrap_or_default()
        .into_iter()
        .filter_map(|entry| {
            entry
                .split_once('=')
                .map(|(k, v)| (k.to_string(), v.to_string()))
        })
        .collect();
    (wasi.main_args.unwrap_or_default(), env)
}

/// Why the runner stopped a job that had not exited.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    Timeout,
    /// No output and no CPU use for `Caps::stall_after` (stall.rs).
    Stalled,
    /// Its JavaScript was stopped for memory (`NodeHooks::exhaustion`).
    OutOfMemory,
    /// Its run was cancelled (`Invocation::cancel`).
    Cancelled,
}

/// Compiles every command of `packages` into the disk cache, so the first
/// script that spawns one does not spend its timeout compiling. Nothing
/// stays in memory: not the modules, nor the parsed packages.
pub(crate) fn prepare(
    shared: &WasixShared,
    tokio: &tokio::runtime::Runtime,
    packages: &[WebcPackage],
) -> Result<()> {
    let _enter = tokio.enter();
    let set = PackageSet::new(shared, packages, false)?;
    let job_modules = JobModules::new();
    let runtime = JobRuntime::new(
        shared,
        &job_modules,
        job_modules.engine().clone(),
        Some(&set),
        None,
        false,
        Arc::default(),
        None,
        &[],
    );
    let runtime: Arc<dyn WasixRuntime + Send + Sync> = Arc::new(runtime);
    for package in binary_packages(shared, &set, &runtime, tokio)? {
        for command in &package.commands {
            let input = ModuleInput::Command(Cow::Borrowed(command));
            let key: WasmHash = input
                .hash()
                .as_bytes()
                .try_into()
                .map_err(|_| Error::Package {
                    name: format!("{} ({})", package.id, command.name()),
                    reason: "a module hash that is not a sha256".into(),
                })?;
            shared
                .store
                .ensure_compiled(key, input.wasm())
                .map_err(|e| Error::Package {
                    name: format!("{} ({})", package.id, command.name()),
                    reason: e.to_string(),
                })?;
        }
    }
    Ok(())
}

/// `packages` parsed and loaded as a job of them loads them, held for as
/// long as the result is (`inside`).
#[cfg(target_os = "linux")]
pub(crate) fn preload(
    shared: &WasixShared,
    tokio: &tokio::runtime::Runtime,
    packages: &[WebcPackage],
    entry: &str,
) -> Result<PackageSet> {
    let _enter = tokio.enter();
    let set = PackageSet::new(shared, packages, true)?;
    let job_modules = JobModules::new();
    let runtime = JobRuntime::new(
        shared,
        &job_modules,
        job_modules.engine().clone(),
        Some(&set),
        None,
        false,
        Arc::default(),
        None,
        &[],
    );
    let runtime: Arc<dyn WasixRuntime + Send + Sync> = Arc::new(runtime);
    // And the entry's module, which the job starts first.
    for package in binary_packages(shared, &set, &runtime, tokio)? {
        if let Some(command) = package.get_command(entry) {
            let input = ModuleInput::Command(Cow::Borrowed(command));
            if let Ok(key) = input.hash().as_bytes().try_into() {
                let _ = shared
                    .store
                    .get(&job_modules, key, input.wasm(), Some(entry));
            }
        }
    }
    Ok(set)
}

/// [`prepare`], and the module keys of every command of `packages`, and
/// their command names: what a sandboxed job's runner inside loads
/// (`sandbox.rs`).
#[cfg(target_os = "linux")]
pub(crate) fn prepare_listing(
    shared: &WasixShared,
    tokio: &tokio::runtime::Runtime,
    packages: &[WebcPackage],
) -> Result<(Vec<WasmHash>, Vec<String>)> {
    prepare(shared, tokio, packages)?;
    let _enter = tokio.enter();
    let set = PackageSet::new(shared, packages, true)?;
    let job_modules = JobModules::new();
    let runtime = JobRuntime::new(
        shared,
        &job_modules,
        job_modules.engine().clone(),
        Some(&set),
        None,
        false,
        Arc::default(),
        None,
        &[],
    );
    let runtime: Arc<dyn WasixRuntime + Send + Sync> = Arc::new(runtime);
    let mut keys = Vec::new();
    let mut names = Vec::new();
    for package in binary_packages(shared, &set, &runtime, tokio)? {
        for command in &package.commands {
            let input = ModuleInput::Command(Cow::Borrowed(command));
            if let Ok(key) = input.hash().as_bytes().try_into() {
                keys.push(key);
            }
            names.push(command.name().to_string());
        }
    }
    keys.sort();
    keys.dedup();
    names.sort();
    names.dedup();
    Ok((keys, names))
}

/// Calls `f` on every process of the job: every one its control plane
/// (which is per job) has created, whatever its id (#1094). Ids come from
/// one counter that thread ids share and never go back, so a job that has
/// started thousands of processes, or a process after a run of threads, has
/// ids that probing a fixed range from 1 would not reach. `f` runs on a
/// snapshot, outside the control plane's lock.
pub(crate) fn for_each_process(
    control_plane: &wasmer_wasix::WasiControlPlane,
    f: impl FnMut(wasmer_wasix::WasiProcess),
) {
    control_plane.processes().into_iter().for_each(f);
}

/// Stops whatever a job left running once its first process has ended: a
/// background command (`cmd &`), one a subshell started (`( cmd & )`) and
/// outlived (#1105), a detached `node` child. Each outlives its parent, as
/// on Linux, but not the job, as a container's processes do not outlive the
/// container: left alone, one kept running on the runner after its job and
/// wrote into the next job's files (#1106). SIGKILL and `interrupt` (for
/// one that spins in Wasm and makes no syscall to see the signal) are
/// repeated for [`KILL_GRACE`], and whatever is still running is then
/// marked finished.
fn stop_left_behind(control_plane: &wasmer_wasix::WasiControlPlane, interrupt: &dyn Fn()) {
    let alive = || {
        let mut any = false;
        for_each_process(control_plane, |process| any |= process.try_join().is_none());
        any
    };
    if !alive() {
        return;
    }
    let grace = Instant::now() + KILL_GRACE;
    loop {
        for_each_process(control_plane, |process| {
            if process.try_join().is_none() {
                process.signal_process(Signal::Sigkill);
            }
        });
        interrupt();
        std::thread::sleep(KILL_POLL);
        if !alive() {
            return;
        }
        if Instant::now() >= grace {
            break;
        }
    }
    for_each_process(control_plane, |process| {
        process.terminate(ExitCode::from(TIMEOUT_EXIT_CODE as u16))
    });
}

/// Treats a command's `wasi.env` annotation as defaults: an entry whose key
/// the job's environment already has is dropped.
///
/// wasmer-wasix 0.705's `WasiEnv::prepare_spawn` appends those entries to
/// the environment a spawned command inherits instead of merging them, so
/// Edge.js's `pnpm` (which declares `PATH` and `HOME`) saw `PATH` twice and
/// failed on `Object.keys(process.env)`: "'ownKeys' on proxy: trap returned
/// duplicate entries". Wasmer's main branch now applies them as defaults
/// (`add_command_env_defaults`), and so does the vendored crate, which has
/// it backported: that covers a key a parent exports or inherits from a
/// command's own defaults (a `pnpm` that starts another `pnpm` passes the
/// first one's `npm_config_*` on). This one stays for every key the job
/// starts with, which it drops from the package itself.
fn command_env_as_defaults(packages: Vec<BinaryPackage>, job_keys: &[&str]) -> Vec<BinaryPackage> {
    packages
        .into_iter()
        .map(|mut package| {
            let mut changed = false;
            let commands: Vec<BinaryPackageCommand> = package
                .commands
                .iter()
                .map(|command| {
                    let Ok(Some(mut wasi)) = command.metadata().wasi() else {
                        return command.clone();
                    };
                    let Some(env) = wasi.env.as_mut() else {
                        return command.clone();
                    };
                    let before = env.len();
                    env.retain(|entry| {
                        let key = entry.split_once('=').map_or(entry.as_str(), |(k, _)| k);
                        !job_keys.contains(&key)
                    });
                    if env.len() == before {
                        return command.clone();
                    }
                    let Ok(annotation) = ciborium::Value::serialized(&wasi) else {
                        return command.clone();
                    };
                    let mut metadata = command.metadata().clone();
                    metadata.annotations.insert(
                        webc::metadata::annotations::Wasi::KEY.to_string(),
                        annotation,
                    );
                    changed = true;
                    BinaryPackageCommand::new(
                        command.name().to_string(),
                        metadata,
                        command.atom(),
                        *command.hash(),
                        command.wasm_features(),
                        command.package().clone(),
                        command.origin_package().clone(),
                    )
                })
                .collect();
            if changed {
                package.commands = commands;
            }
            package
        })
        .collect()
}

fn binary_packages(
    shared: &WasixShared,
    set: &PackageSet,
    runtime: &Arc<dyn WasixRuntime + Send + Sync>,
    tokio: &tokio::runtime::Runtime,
) -> Result<Vec<BinaryPackage>> {
    let digests = set.digests();
    let mut out = Vec::new();
    for (hash, container) in &set.order {
        let key = (*hash, digests.clone());
        let package = match shared.packages.get(&key) {
            Some(package) => package,
            None => {
                let package = Arc::new(
                    tokio
                        .block_on(BinaryPackage::from_webc(container, runtime.as_ref()))
                        .map_err(|e| Error::Package {
                            name: hash.as_hex(),
                            reason: format!("{e:#}"),
                        })?,
                );
                if set.remember {
                    shared.packages.insert(key, &package);
                }
                package
            }
        };
        out.push(BinaryPackage::clone(&package));
        set.binaries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .push(package);
    }
    Ok(out)
}

#[cfg(test)]
mod user_database_tests {
    use super::*;
    use wasmer_wasix::bin_factory::BinaryPackageMount;

    fn package(name: &str, mounts: Option<BinaryPackageMounts>) -> BinaryPackage {
        let id = PackageId::new_named(name, "1.0.0".parse().unwrap());
        BinaryPackage {
            id: id.clone(),
            package_ids: vec![id],
            webc_version: webc::Version::V3,
            when_cached: None,
            entrypoint_cmd: None,
            hash: Default::default(),
            package_mounts: mounts.map(Arc::new),
            commands: Vec::new(),
            uses: Vec::new(),
            file_system_memory_footprint: 0,
            additional_host_mapped_directories: Vec::new(),
        }
    }

    fn text(fs: &(dyn FileSystem + Send + Sync), path: &str) -> String {
        String::from_utf8(iwci_vfs::read_file(fs, path).unwrap()).unwrap()
    }

    /// The database is a root layer under the packages', and goes under a
    /// package's own `/etc` volume, which would hide it, keeping that
    /// volume's files and any user database it has.
    #[test]
    fn the_user_database_is_under_the_packages_and_their_etc() {
        let etc = TmpFileSystem::new();
        iwci_vfs::write_file(&etc, "/etc/hosts", b"127.0.0.1 localhost\n").unwrap();
        let own = TmpFileSystem::new();
        iwci_vfs::write_file(&own, "/passwd", b"theirs\n").unwrap();
        let mount = |fs: TmpFileSystem, source: &str| BinaryPackageMount {
            guest_path: "/etc".into(),
            fs: Arc::new(fs),
            source_path: source.into(),
        };
        let packages = vec![
            package("a/plain", None),
            package(
                "a/etc",
                Some(BinaryPackageMounts {
                    root_layer: None,
                    mounts: vec![mount(etc, "/etc")],
                }),
            ),
            package(
                "a/own",
                Some(BinaryPackageMounts {
                    root_layer: None,
                    mounts: vec![mount(own, "/")],
                }),
            ),
        ];
        let out = with_user_database(&packages).unwrap();
        assert_eq!(out.len(), 4);
        assert!(out[0].package_mounts.is_none());
        let etc = &out[1].package_mounts.as_ref().unwrap().mounts[0];
        assert_eq!(text(etc.fs.as_ref(), "/etc/hosts"), "127.0.0.1 localhost\n");
        assert_eq!(text(etc.fs.as_ref(), "/etc/passwd"), PASSWD);
        assert_eq!(text(etc.fs.as_ref(), "/etc/group"), GROUP);
        let own = &out[2].package_mounts.as_ref().unwrap().mounts[0];
        assert_eq!(text(own.fs.as_ref(), "/passwd"), "theirs\n");
        assert_eq!(text(own.fs.as_ref(), "/group"), GROUP);
        let database = out[3].package_mounts.as_ref().unwrap();
        assert!(database.mounts.is_empty());
        let root = database.root_layer.as_ref().unwrap();
        assert_eq!(text(root.as_ref(), "/etc/passwd"), PASSWD);
        assert!(out[3].commands.is_empty());
    }
}

#[cfg(test)]
mod job_root_tests {
    use super::*;
    use futures::executor::block_on;
    use virtual_fs::{AsyncReadExt, AsyncWriteExt};

    fn read(fs: &dyn FileSystem, path: &str) -> String {
        let mut file = fs
            .new_open_options()
            .read(true)
            .open(Path::new(path))
            .unwrap();
        let mut out = String::new();
        block_on(file.read_to_string(&mut out)).unwrap();
        out
    }

    fn write(fs: &dyn FileSystem, path: &str, text: &str) {
        let mut file = fs
            .new_open_options()
            .write(true)
            .create(true)
            .truncate(true)
            .open(Path::new(path))
            .unwrap();
        block_on(async {
            file.write_all(text.as_bytes()).await?;
            file.flush().await
        })
        .unwrap();
    }

    fn files(job: &iwci_vfs::JobFs, paths: &[&str]) -> Vec<String> {
        let mut files: Vec<String> = job
            .entries_under(paths)
            .into_iter()
            .filter_map(|e| match e {
                iwci_vfs::Entry::File { path, .. } => Some(path.display().to_string()),
                _ => None,
            })
            .collect();
        files.sort();
        files
    }

    fn root(job: &iwci_vfs::JobFs, own_dirs: bool, dirs: &[BinaryPackageMount]) -> MountFileSystem {
        job_root(
            job.as_dyn(),
            None,
            &[],
            &[],
            false,
            None,
            false,
            &job.modes(),
            &crate::network::Listeners::default(),
            own_dirs,
            dirs,
            None,
            1,
        )
        .unwrap()
    }

    /// What a job writes in a directory its environment's packages mount,
    /// and in `/tmp`, is in the job's file system, where `cache:` and the
    /// environment's caches save it from and restore it to (#1083). The
    /// package's own files are read through but never copied in. A
    /// service's `/tmp` stays its own.
    #[test]
    fn a_jobs_package_dirs_and_tmp_are_in_its_file_system() {
        let shipped = TmpFileSystem::new();
        write(&shipped, "/std", "shipped");
        let dirs = [BinaryPackageMount {
            guest_path: "/root/.cache/go-build".into(),
            fs: Arc::new(shipped),
            source_path: "/".into(),
        }];
        let job = iwci_vfs::SnapshotBuilder::new().freeze().fork();
        // A restored cache entry, written before the job starts.
        job.write("/root/.cache/go-build/restored", b"restored")
            .unwrap();
        let fs = root(&job, false, &dirs);
        assert_eq!(read(&fs, "/root/.cache/go-build/std"), "shipped");
        assert_eq!(read(&fs, "/root/.cache/go-build/restored"), "restored");
        write(&fs, "/root/.cache/go-build/added", "added");
        write(&fs, "/tmp/scratch", "tmp");
        assert_eq!(
            files(&job, &["/root/.cache/go-build", "/tmp"]),
            vec![
                "/root/.cache/go-build/added",
                "/root/.cache/go-build/restored",
                "/tmp/scratch",
            ]
        );
        // A directory the job makes under its home, beside the package's.
        fs.create_dir(Path::new("/root/other")).unwrap();

        let service = iwci_vfs::SnapshotBuilder::new().freeze().fork();
        let fs = root(&service, true, &[]);
        write(&fs, "/tmp/own", "own");
        assert_eq!(read(&fs, "/tmp/own"), "own");
        assert!(files(&service, &["/tmp"]).is_empty());
    }
}
