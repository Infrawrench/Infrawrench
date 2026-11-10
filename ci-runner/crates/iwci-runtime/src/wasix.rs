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
//! - stores come from a clone of the shared engine whose tunables enforce
//!   the job's memory limit and stack size, and every store registers an
//!   interrupter so the watchdog can stop all of the job's processes.

use std::borrow::Cow;
use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sha2::Digest;
use virtual_fs::{FileSystem, MountFileSystem, NullFile, RootFileSystemBuilder, TmpFileSystem};
use wasmer::sys::NativeEngineExt;
use wasmer::{Engine, Interrupter, Module};
use wasmer_config::package::{PackageHash, PackageId};
use wasmer_wasix::bin_factory::{
    BinaryPackage, BinaryPackageCommand, spawn_exec, spawn_exec_module,
};
use wasmer_wasix::http::DynHttpClient;
use wasmer_wasix::os::TtyBridge;
use wasmer_wasix::runtime::module_cache::ModuleCache;
use wasmer_wasix::runtime::package_loader::{PackageLoader, load_package_tree};
use wasmer_wasix::runtime::resolver::{
    DistributionInfo, InMemorySource, PackageInfo, PackageSummary, Resolution, Source, WebcHash,
};
use wasmer_wasix::runtime::task_manager::VirtualTaskManager;
use wasmer_wasix::runtime::{InstantiationState, ModuleInput, PluggableRuntime, TaintReason};
use wasmer_wasix::virtual_net::DynVirtualNetworking;
use wasmer_wasix::wasmer_wasix_types::wasi::{ExitCode, Signal};
use wasmer_wasix::{Runtime as WasixRuntime, WasiEnvBuilder, WasiProcessId};
use webc::Container;

use crate::cache::{ModuleStore, WasixCache};
use crate::capture::Capture;
use crate::limits::LimitingTunables;
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
const MAX_TASKS: usize = 512;

/// How often the kill is repeated while a timed-out job unwinds.
const KILL_POLL: Duration = Duration::from_millis(50);

/// Native stack for WASIX guests. bash and node recurse moderately; this is
/// generous without costing anything until touched (it is reserved, not
/// committed).
const WASIX_STACK: usize = 64 << 20;

/// Shared pieces every job's runtime is assembled from.
pub(crate) struct WasixShared {
    pub(crate) store: Arc<ModuleStore>,
    pub(crate) tasks: Arc<dyn VirtualTaskManager>,
    /// Parsed packages, keyed by the webc digest and the digests of the set
    /// they were resolved against (a package's dependencies come from that
    /// set).
    packages: Mutex<HashMap<(WebcHash, Vec<WebcHash>), BinaryPackage>>,
    /// Parsed containers by webc digest.
    containers: Mutex<HashMap<WebcHash, (PackageSummary, Container)>>,
    /// The host network jobs reach the public internet through, when
    /// offered (`Runtime::with_internet`).
    pub(crate) outside: Option<crate::network::Outside>,
}

impl WasixShared {
    pub(crate) fn new(store: Arc<ModuleStore>, tasks: Arc<dyn VirtualTaskManager>) -> Self {
        Self {
            store,
            tasks,
            packages: Mutex::default(),
            containers: Mutex::default(),
            outside: None,
        }
    }
}

/// The per-job state the watchdog acts on.
#[derive(Default)]
struct JobControl {
    interrupters: Mutex<Vec<Interrupter>>,
    /// The first trap of any of the job's processes. wasmer-wasix reports a
    /// trapped process as exiting with ENOEXEC (45), so this is what tells a
    /// crash from a program that chose that status.
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
}

impl JobRuntime {
    fn new(
        shared: &WasixShared,
        engine: Engine,
        packages: Option<&PackageSet>,
        #[cfg_attr(not(feature = "node"), allow(unused_variables))] node: Option<
            &crate::node::NodeHooks,
        >,
        internet: bool,
    ) -> Self {
        crate::signals::install();
        let mut inner = PluggableRuntime::new(shared.tasks.clone());
        inner.set_engine(engine);
        // One loopback per job, shared by all of its processes, and the
        // public internet when the runtime offers it.
        inner.set_networking_implementation(crate::network::JobNetwork::new(
            shared.outside.clone().filter(|_| internet),
        ));
        inner.http_client = None;
        inner.set_module_cache(WasixCache(shared.store.clone()));
        let packages = packages.cloned().unwrap_or_default();
        inner.set_source(packages.source.clone());
        inner.set_package_loader(packages);
        #[cfg(feature = "node")]
        if let Some(node) = node {
            node.attach(&mut inner);
        }
        Self {
            inner,
            control: Arc::default(),
        }
    }
}

#[cfg(test)]
impl JobRuntime {
    pub(crate) fn for_tests(shared: &WasixShared, engine: Engine) -> Self {
        Self::new(shared, engine, None, None, false)
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
}

impl PackageSet {
    fn new(shared: &WasixShared, packages: &[WebcPackage]) -> Result<Self> {
        let mut source = InMemorySource::new();
        let mut containers = HashMap::new();
        let mut order = Vec::new();
        for package in packages {
            let (summary, container) = parse_package(shared, package)?;
            let hash = summary.dist.webc_sha256;
            source.add(summary);
            containers.insert(hash, container.clone());
            order.push((hash, container));
        }
        Ok(Self {
            source,
            containers: Arc::new(containers),
            order,
        })
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

/// The summary and container of `package`, parsed once per runtime. The
/// container borrows the caller's bytes rather than copying them, which
/// matters for an 80 MB Edge.js.
fn parse_package(
    shared: &WasixShared,
    package: &WebcPackage,
) -> Result<(PackageSummary, Container)> {
    let hash = WebcHash::from_bytes(package.sha256);
    if let Some(parsed) = shared
        .containers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&hash)
    {
        return Ok(parsed.clone());
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
    shared
        .containers
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(hash, (summary.clone(), container.clone()));
    Ok((summary, container))
}

/// Where an environment job finds the runner's support files for Node.
pub const NODE_SUPPORT_DIR: &str = "/usr/local/lib/iwci/node";

/// The files under [`NODE_SUPPORT_DIR`]: a working `node:wasi` for
/// Edge.js, whose own has no binding behind it, and the preload that fills
/// its other gaps (see `node/README.md`).
const NODE_SUPPORT: &[(&str, &[u8])] = &[
    ("preload.cjs", include_bytes!("../node/preload.cjs")),
    ("blob-stream.cjs", include_bytes!("../node/blob-stream.cjs")),
    ("wasi.cjs", include_bytes!("../node/wasi.cjs")),
    ("wasm-util.cjs", include_bytes!("../node/wasm-util.cjs")),
    (
        "wasm-util.LICENSE",
        include_bytes!("../node/wasm-util.LICENSE"),
    ),
];

/// `NODE_OPTIONS` for an environment job: the support preload first, then
/// whatever the job set.
pub(crate) fn node_options(env: &[(String, String)]) -> String {
    let preload = format!("--require {NODE_SUPPORT_DIR}/preload.cjs");
    match env.iter().rev().find(|(k, _)| k == "NODE_OPTIONS") {
        Some((_, v)) if !v.trim().is_empty() => format!("{preload} {v}"),
        _ => preload,
    }
}

/// The root file system of a job: the job's own file system at `/`, with
/// scratch mounts that keep WASIX's own files out of `JobFs::changes`.
fn job_root(
    fs: crate::DynFs,
    scratch: Option<crate::DynFs>,
    commands: &[crate::PathCommand],
    node_support: bool,
) -> Result<MountFileSystem> {
    let root = MountFileSystem::new();
    let mount_err = |e| Error::Setup(format!("mounting the job file system: {e}"));
    root.mount(Path::new("/"), fs).map_err(mount_err)?;
    // /dev/null, /dev/zero, /dev/urandom and /dev/std{in,out,err} (which
    // name the process's own descriptors), and an empty /tmp.
    let system: Arc<dyn FileSystem + Send + Sync> =
        Arc::new(RootFileSystemBuilder::default().build_tmp());
    root.mount_with_source(Path::new("/dev"), Path::new("/dev"), system.clone())
        .map_err(mount_err)?;
    root.mount_with_source(Path::new("/tmp"), Path::new("/tmp"), system)
        .map_err(mount_err)?;
    // wasmer-wasix writes every package command's wasm into /bin and
    // /usr/bin so a shell can find it on PATH.
    root.mount(Path::new("/bin"), Arc::new(TmpFileSystem::new()))
        .map_err(mount_err)?;
    root.mount(Path::new("/usr/bin"), Arc::new(TmpFileSystem::new()))
        .map_err(mount_err)?;
    if let Some(scratch) = scratch {
        root.mount(Path::new(crate::SCRATCH_MOUNT), scratch)
            .map_err(mount_err)?;
    }
    if !commands.is_empty() {
        let bin = TmpFileSystem::new();
        for command in commands {
            write_command(&bin, &command.name, &command.module.bytes)?;
        }
        root.mount(Path::new("/usr/local/bin"), Arc::new(bin))
            .map_err(mount_err)?;
    }
    if node_support {
        let dir = TmpFileSystem::new();
        for (name, bytes) in NODE_SUPPORT {
            write_command(&dir, name, bytes)?;
        }
        root.mount(Path::new(NODE_SUPPORT_DIR), Arc::new(dir))
            .map_err(mount_err)?;
    }
    Ok(root)
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

/// The engine clone and tunables of one job.
pub(crate) fn job_engine(
    base: &Engine,
    memory_bytes: u64,
    stack_bytes: usize,
) -> (Engine, Arc<AtomicBool>) {
    let hit = Arc::new(AtomicBool::new(false));
    let mut engine = base.clone();
    engine.set_tunables(LimitingTunables::new(
        memory_bytes,
        stack_bytes,
        hit.clone(),
    ));
    (engine, hit)
}

fn check_nul(inv: &Invocation) -> Result<()> {
    let has_nul = |s: &str| s.contains('\0');
    if has_nul(&inv.cwd)
        || inv.args.iter().any(|a| has_nul(a))
        || inv
            .env
            .iter()
            .any(|(k, v)| has_nul(k) || has_nul(v) || k.contains('='))
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
}

pub(crate) fn run(
    shared: &WasixShared,
    tokio: &tokio::runtime::Runtime,
    entry: Entry<'_>,
    program: &str,
    inv: Invocation,
    caps: Caps,
    node: Option<&crate::node::NodeHooks>,
) -> Result<Outcome> {
    check_nul(&inv)?;
    let started = Instant::now();
    let _enter = tokio.enter();

    let (engine, hit_memory) =
        job_engine(shared.store.engine(), inv.limits.memory_bytes, WASIX_STACK);

    let package_set = match &entry {
        Entry::Module(_) => None,
        Entry::Command { packages, .. } => Some(PackageSet::new(shared, packages)?),
    };
    let runtime = JobRuntime::new(shared, engine, package_set.as_ref(), node, inv.internet);
    let control = runtime.control.clone();
    let runtime: Arc<dyn WasixRuntime + Send + Sync> = Arc::new(runtime);

    let uses = match &package_set {
        Some(set) => binary_packages(shared, set, &runtime, tokio)?,
        None => Vec::new(),
    };
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

    let stdout = Capture::new(caps.output_bytes).with_sink(inv.log.clone(), crate::Stream::Stdout);
    let stderr = Capture::new(caps.output_bytes).with_sink(inv.log.clone(), crate::Stream::Stderr);

    let mut builder = WasiEnvBuilder::new(program);
    builder.add_args(inv.args.iter());
    builder.add_envs(env.iter().map(|(k, v)| (k.clone(), v.clone())));
    // Go's wasip1 port takes its working directory from `$PWD`, not from
    // WASI, and treats a missing one as `/`: gofmt given `.` then walks the
    // whole file system. A shell would have set it, so set it to the cwd.
    if !env.iter().any(|(k, _)| k == "PWD") {
        builder.add_env("PWD", inv.cwd.clone());
    }
    builder.set_runtime(runtime.clone());
    builder.set_mount_fs(job_root(
        inv.fs.clone(),
        inv.scratch.clone(),
        &inv.commands,
        node_support,
    )?);
    // WASIX programs ask the runtime for their working directory. Plain WASI
    // ones built on wasi-libc cannot be given one: their cwd is always `/`,
    // and a preopen of the cwd named `.` either changes nothing or sends
    // every absolute path into the cwd (#906, and the test
    // `a_command_sees_only_the_root_preopen_and_its_cwd_as_pwd`). `$PWD` is
    // how they learn it.
    builder.set_current_dir(&inv.cwd);
    builder
        .add_preopen_dir("/")
        .map_err(|e| Error::Setup(e.to_string()))?;
    builder.set_stdin(Box::new(NullFile::default()));
    builder.set_stdout(stdout.file());
    builder.set_stderr(stderr.file());
    builder.capabilities_mut().threading.max_threads = Some(MAX_TASKS);
    // V8 must run on a real thread stack. With asynchronous threading, wasm
    // (and the N-API calls it makes into V8) runs on coroutine stacks, and
    // V8, whose isolate takes its stack bounds from where it was created,
    // segfaults the first time it unwinds an exception. wasmer-napi's
    // own runner turns it off for N-API modules the same way. It is set in
    // the job's control plane, so it covers bash and every `node` it spawns.
    if node.is_some() {
        builder
            .capabilities_mut()
            .threading
            .enable_asynchronous_threading = false;
    }
    for package in &uses {
        builder.add_webc(package.clone());
    }
    let env = builder.build().map_err(|e| Error::Setup(e.to_string()))?;
    let control_plane = env.control_plane.clone();

    let mut handle = match entry {
        Entry::Module(module) => spawn_exec_module(module, env, &runtime),
        Entry::Command { name, .. } => {
            let package = uses
                .iter()
                .find(|p| p.get_command(name).is_some())
                .cloned()
                .ok_or_else(|| {
                    Error::Setup(format!("no package in the environment provides `{name}`"))
                })?;
            tokio.block_on(spawn_exec(package, name, env, &runtime))
        }
    }
    .map_err(|e| Error::Setup(e.to_string()))?;

    let deadline = started + inv.limits.timeout;
    let kill = || {
        #[cfg(feature = "node")]
        if let Some(node) = node {
            node.terminate();
        }
        control.interrupt_all();
        for_each_process(&control_plane, |process| {
            process.signal_process(Signal::Sigkill)
        });
    };
    let (result, timed_out) = tokio.block_on(async {
        let mut finished = Box::pin(handle.wait_finished());
        let deadline = tokio::time::Instant::from_std(deadline);
        if let Ok(result) = tokio::time::timeout_at(deadline, &mut finished).await {
            return (Some(result), false);
        }
        // An interrupt is best effort (it can land just before a guest
        // enters wasm, and a process blocked in a syscall only sees the
        // signal when it wakes), so both are repeated until the job ends.
        let grace = Instant::now() + KILL_GRACE;
        while Instant::now() < grace {
            kill();
            if let Ok(result) = tokio::time::timeout(KILL_POLL, &mut finished).await {
                return (Some(result), true);
            }
        }
        // Still running: mark every process finished so the job returns.
        // A guest stuck inside a host call keeps its pool thread until that
        // call returns, but the job is over.
        for_each_process(&control_plane, |process| {
            process.terminate(ExitCode::from(TIMEOUT_EXIT_CODE as u16))
        });
        let result = tokio::time::timeout(KILL_POLL, &mut finished).await.ok();
        (result, true)
    });

    let result = match result {
        Some(result) => result,
        None => Ok(ExitCode::from(TIMEOUT_EXIT_CODE as u16)),
    };
    let trap = control
        .trap
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take();
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
    // A job that died of a signal: say who sent it, in its own log, which
    // is all a one-off like #955 leaves behind.
    if !timed_out && let Some(report) = control.signals.report(exit_code, &err.bytes) {
        let newline: &[u8] = if err.bytes.is_empty() || err.bytes.ends_with(b"\n") {
            b""
        } else {
            b"\n"
        };
        for part in [newline, report.as_bytes()] {
            stderr.note(part);
            err.bytes.extend_from_slice(part);
        }
    }
    Ok(Outcome {
        exit_code: if timed_out {
            TIMEOUT_EXIT_CODE
        } else {
            exit_code
        },
        stdout: out.bytes,
        stderr: err.bytes,
        truncated: out.truncated || err.truncated,
        duration: started.elapsed(),
        timed_out,
        out_of_memory: hit_memory.load(Ordering::Acquire),
        error: if timed_out { None } else { error },
    })
}

/// Compiles every command of `packages` into the module cache, so the
/// first script that spawns one does not spend its timeout compiling.
pub(crate) fn prepare(
    shared: &WasixShared,
    tokio: &tokio::runtime::Runtime,
    packages: &[WebcPackage],
) -> Result<()> {
    let _enter = tokio.enter();
    let set = PackageSet::new(shared, packages)?;
    let runtime = JobRuntime::new(
        shared,
        shared.store.engine().clone(),
        Some(&set),
        None,
        false,
    );
    let runtime: Arc<dyn WasixRuntime + Send + Sync> = Arc::new(runtime);
    for package in binary_packages(shared, &set, &runtime, tokio)? {
        for command in &package.commands {
            let input = ModuleInput::Command(Cow::Borrowed(command));
            tokio
                .block_on(runtime.resolve_module(input, None, None))
                .map_err(|e| Error::Package {
                    name: format!("{} ({})", package.id, command.name()),
                    reason: e.to_string(),
                })?;
        }
    }
    Ok(())
}

/// Calls `f` on every process of the job. Process ids are handed out from 1
/// upwards and never reused within a control plane, which is per job.
fn for_each_process(
    control_plane: &wasmer_wasix::WasiControlPlane,
    mut f: impl FnMut(wasmer_wasix::WasiProcess),
) {
    let mut missing = 0;
    for pid in 1..=(MAX_TASKS as u32 * 4) {
        match control_plane.get_process(WasiProcessId::from(pid)) {
            Some(process) => {
                missing = 0;
                f(process);
            }
            None => {
                missing += 1;
                if missing > 16 {
                    break;
                }
            }
        }
    }
}

/// Treats a command's `wasi.env` annotation as defaults: an entry whose key
/// the job's environment already has is dropped.
///
/// wasmer-wasix 0.705's `WasiEnv::prepare_spawn` appends those entries to
/// the environment a spawned command inherits instead of merging them, so
/// Edge.js's `pnpm` (which declares `PATH` and `HOME`) saw `PATH` twice and
/// failed on `Object.keys(process.env)`: "'ownKeys' on proxy: trap returned
/// duplicate entries". Wasmer's main branch now applies them as defaults
/// (`add_command_env_defaults`); this gives the released crate the same
/// result for every key the job starts with. A key a script exports later
/// can still be duplicated until the upstream fix ships.
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
        let cached = shared
            .packages
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&key)
            .cloned();
        let package = match cached {
            Some(package) => package,
            None => {
                let package = tokio
                    .block_on(BinaryPackage::from_webc(container, runtime.as_ref()))
                    .map_err(|e| Error::Package {
                        name: hash.as_hex(),
                        reason: format!("{e:#}"),
                    })?;
                shared
                    .packages
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(key, package.clone());
                package
            }
        };
        out.push(package);
    }
    Ok(out)
}
