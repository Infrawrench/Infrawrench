//! Running a job in a gVisor sandbox: the runner's side.
//!
//! A job that uses a native program (Bun) runs whole inside one gVisor
//! sandbox, the runner's own binary first (`inside`), which runs the
//! script and services as a WASIX job runs them. This side builds the
//! sandbox's file systems, starts it in a cgroup of its own with its
//! network through the runner's gateway, reads what the job prints, and
//! stops it at its deadline, on a cancel or when it stalls.
//!
//! What the sandbox sees, each a lisafs connection to a file system the
//! runner holds (`iwci_sandbox::lisafs`):
//!
//! - `/`: the job's own file system, as a WASIX job's root, written to the
//!   same overlay and held to the same write budget;
//! - the native programs and the C library they link (`/usr/local/bin`,
//!   `/lib64`, `/lib/<arch>-linux-gnu`), read only;
//! - `/bin`, `/usr/bin` and `/usr/local/bin`: a stand-in for each of the
//!   environment's commands (the runner's binary under the command's
//!   name, `inside::shim`), read only;
//! - `/.iwci`: the runner's binary, the job's description, the
//!   environment's packages and their compiled modules, read only, and
//!   `/.iwci/out`, where the runner inside writes how the job ended;
//! - `/tmp/workflow`: the run's shared scratch directory, as for WASIX.
//!
//! Its memory is the cgroup's: `memory.max` is the job's `memory:` and a
//! fixed allowance for the runner inside and gVisor's kernel (the
//! [`SandboxHost::overhead`]), swap is off, and the peak is what the report
//! gives. Its CPU time is the cgroup's too, gVisor's kernel's included:
//! that is what the job cost the host.

use std::collections::BTreeMap;
use std::io::{self, Read};
use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use iwci_sandbox::cgroup::{Cgroup, Jobs, Limits};
use iwci_sandbox::lisafs::{self, Export, Serving};
use iwci_sandbox::net::{Gateway, Network};
use iwci_sandbox::runsc::{self, Mount, Release};

/// The service that starts a sandbox for a runner that may not create its
/// namespaces itself (`iwci_sandbox::service`), and its protocol check.
pub mod service {
    pub use iwci_sandbox::service::PROTOCOL;
    pub use iwci_sandbox::service_client::protocol;
}
use iwci_vfs::{DynFs, Modes};
use shared_buffer::OwnedBuffer;
use virtual_fs::{FileSystem, TmpFileSystem};

use crate::capture::Capture;
use crate::inside::{
    JobResult, JobSpec, SpecModule, SpecPackage, SpecProgram, SpecReady, SpecService, SpecTree,
};
use crate::{Error, Invocation, Outcome, Result, Runtime, WebcPackage};

/// Where the runner's own files are in the sandbox.
const IWCI_DIR: &str = "/.iwci";
const RUNNER: &str = crate::inside::shim::SANDBOX_RUNNER;
const OUT_DIR: &str = "/.iwci/out";

/// How often a running sandbox is checked on.
const POLL: Duration = Duration::from_millis(100);

/// What the runner inside gets beyond the job's own timeout, to stop its
/// services and say how the job ended before the runner outside stops it.
const INSIDE_GRACE: Duration = Duration::from_secs(10);

/// What a sandbox may run besides its job: threads of gVisor's kernel and
/// of the runner inside, and the job's processes.
const PIDS: u64 = 4096;

/// A file placed in the sandbox: where, and what.
#[derive(Debug, Clone)]
pub struct Placed {
    pub path: PathBuf,
    pub content: Content,
}

#[derive(Debug, Clone)]
pub enum Content {
    File { bytes: OwnedBuffer, mode: u32 },
    Symlink(PathBuf),
}

/// A native program a job uses: its files, and the commands that run it
/// (`bun` and `bunx`, both the one binary).
#[derive(Debug, Clone)]
pub struct NativeTool {
    pub files: Vec<Placed>,
    /// Command name and the program's path in the sandbox.
    pub commands: Vec<(String, PathBuf)>,
}

/// What a runner needs to run sandboxed jobs.
pub struct SandboxHost {
    release: Release,
    jobs: Option<Jobs>,
    state_root: PathBuf,
    runner: OwnedBuffer,
    system: Vec<Placed>,
    platform: String,
    overhead: u64,
    /// The CPUs a sandbox has (gVisor's `--cpu-num`, which also sizes its
    /// kernel's threads): the runner's own (`--cpus`), as a WASIX job's
    /// threads share them, unless its job holds vCPUs of its own (`cpus:`).
    /// What the job is told is `Limits::told_cpus` (`JobSpec::told_cpus`).
    cpus: u32,
    /// How many jobs share a vCPU (`--jobs-per-cpu`): a job holding
    /// `cpus:` weighs as many jobs as the slots it holds.
    jobs_per_cpu: u32,
}

impl std::fmt::Debug for SandboxHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SandboxHost")
            .field("release", &self.release)
            .field("state_root", &self.state_root)
            .field("cgroups", &self.jobs.is_some())
            .finish_non_exhaustive()
    }
}

/// The most a sandbox may take for itself beyond its job's `memory:`, which
/// a job with a native tool reserves on top of it: gVisor's kernel and the
/// runner inside, with the environment's packages loaded, which a WASIX job
/// shares with every other job and does not count. Each sandbox's own is
/// measured once the runner inside has loaded the environment and before the
/// job's script starts (about 200 MiB with `env:bash-node`), and its
/// `memory.max` is then the job's `memory:` and that; a test holds the
/// measurement under this (`a_sandboxs_own_memory_is_measured_and_capped`).
pub const DEFAULT_OVERHEAD: u64 = 384 << 20;

impl SandboxHost {
    /// `release` is gVisor's, unpacked; `runner` the runner binary that
    /// runs inside (the runner's own, `/proc/self/exe`); `system` the C
    /// library and anything else every sandbox gets; `state_root` a private
    /// directory with a short path, for each sandbox's control socket.
    /// Without `cgroups`, a sandbox has no memory limit of its own (tests).
    pub fn new(
        release: PathBuf,
        runner: &Path,
        system: Vec<Placed>,
        state_root: PathBuf,
        cgroups: bool,
    ) -> io::Result<Self> {
        let runner = OwnedBuffer::from_file(&std::fs::File::open(runner)?)
            .map_err(|e| io::Error::other(format!("{}: {e}", runner.display())))?;
        let cpus = std::thread::available_parallelism().map_or(1, |n| n.get() as u32);
        let jobs = if cgroups {
            let jobs = Jobs::delegated()?;
            jobs.hold_cpus(Some(cpus))?;
            Some(jobs)
        } else {
            None
        };
        std::fs::create_dir_all(&state_root)?;
        Ok(Self {
            release: Release {
                dir: release,
                service: None,
            },
            jobs,
            state_root,
            runner,
            system,
            platform: "systrap".into(),
            overhead: DEFAULT_OVERHEAD,
            cpus,
            jobs_per_cpu: 1,
        })
    }

    /// The most a sandbox takes beyond its job's `memory:`, which the job
    /// reserves on top of it.
    pub fn overhead(&self) -> u64 {
        self.overhead
    }

    /// Starts each sandbox through the service at `socket`
    /// (`iwci_sandbox::service`), which may create the namespaces the runner
    /// may not.
    pub fn with_service(mut self, socket: PathBuf) -> Self {
        self.release.service = Some(socket);
        self
    }

    /// Holds every sandbox together to `cpus` CPUs' time (`cpu.max` on the
    /// runner's `jobs/` cgroup, shared by equal weight), which is also how
    /// many CPUs each has to run on: the runner's `--cpus`.
    pub fn with_cpus(mut self, cpus: u32) -> io::Result<Self> {
        self.cpus = cpus.max(1);
        if let Some(jobs) = &self.jobs {
            jobs.hold_cpus(Some(self.cpus))?;
        }
        Ok(self)
    }

    /// How many jobs share a vCPU, so that a sandbox whose job holds
    /// `cpus:` gets as much more CPU time than one job's as the slots it
    /// holds (`cpu.weight`).
    pub fn with_jobs_per_cpu(mut self, jobs_per_cpu: u32) -> Self {
        self.jobs_per_cpu = jobs_per_cpu.max(1);
        self
    }

    pub fn with_overhead(mut self, bytes: u64) -> Self {
        self.overhead = bytes;
        self
    }
}

/// Files under one mount point, as a read-only file system of their own.
fn placed_fs(root: &Path, files: &[&Placed]) -> Result<(DynFs, Modes)> {
    let fs = TmpFileSystem::new();
    let mut modes = BTreeMap::new();
    for placed in files {
        let rel = Path::new("/").join(placed.path.strip_prefix(root).unwrap_or(&placed.path));
        if let Some(parent) = rel.parent() {
            iwci_vfs::create_dir_all(&fs, parent).map_err(setup)?;
        }
        match &placed.content {
            Content::File { bytes, mode } => {
                fs.new_open_options_ext()
                    .insert_ro_file(&rel, bytes.clone())
                    .map_err(setup)?;
                modes.insert(rel, *mode);
            }
            Content::Symlink(target) => {
                fs.create_symlink(target, &rel).map_err(setup)?;
            }
        }
    }
    Ok((
        Arc::new(fs),
        Modes::over(Arc::new(modes.into_iter().collect())),
    ))
}

fn setup(e: impl std::fmt::Display) -> Error {
    Error::Setup(format!("preparing the sandbox: {e}"))
}

/// The mount points `placed` need: each file's directory, with any under
/// another one folded into it.
fn mount_points(placed: &[Placed]) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = placed
        .iter()
        .filter_map(|p| p.path.parent().map(Path::to_path_buf))
        .collect();
    dirs.sort();
    dirs.dedup();
    let mut out: Vec<PathBuf> = Vec::new();
    for dir in dirs {
        if !out.iter().any(|o| dir.starts_with(o)) {
            out.push(dir);
        }
    }
    out
}

fn mmap(path: &Path) -> Result<OwnedBuffer> {
    let file = std::fs::File::open(path).map_err(setup)?;
    OwnedBuffer::from_file(&file).map_err(|e| setup(format!("{}: {e}", path.display())))
}

/// A write budget for `/.iwci/out`: a result is a few hundred bytes.
#[derive(Debug, Default)]
struct Small(AtomicU64);

impl iwci_vfs::WriteBudget for Small {
    fn take(&self, bytes: u64) -> bool {
        self.0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                (used + bytes <= 1 << 20).then_some(used + bytes)
            })
            .is_ok()
    }
    fn give(&self, bytes: u64) {
        let _ = self
            .0
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |used| {
                Some(used.saturating_sub(bytes))
            });
    }
}

/// The user database and resolver a native program reads, written into
/// the job's `/etc` where it has none.
const ETC: &[(&str, &str)] = &[
    (
        "/etc/passwd",
        "root:x:0:0:root:/root:/bin/bash\nnobody:x:65534:65534:nobody:/nonexistent:/bin/false\n",
    ),
    ("/etc/group", "root:x:0:\nnogroup:x:65534:\n"),
    ("/etc/hosts", "127.0.0.1 localhost\n::1 localhost\n"),
    ("/etc/resolv.conf", "nameserver 10.0.2.2\n"),
];

/// One running export and the mount it is.
struct Served {
    _serving: Serving,
}

fn serve(export: Export) -> Result<(Served, OwnedFd)> {
    let (ours, theirs) = lisafs::socket_pair().map_err(setup)?;
    let serving = lisafs::serve(export, ours).map_err(setup)?;
    Ok((Served { _serving: serving }, theirs))
}

/// The `cpu.weight` of a sandbox whose job holds `cpus` vCPUs, where a
/// job of one slot, `1 / jobs_per_cpu` of a vCPU, weighs the default 100.
fn cpu_weight(cpus: u32, jobs_per_cpu: u32) -> u64 {
    100 * u64::from(cpus.max(1)) * u64::from(jobs_per_cpu.max(1))
}

/// A unique name for a sandbox.
fn sandbox_id() -> String {
    static N: AtomicU64 = AtomicU64::new(0);
    format!(
        "iwci-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    )
}

/// Reads `pipe` into `capture` until it closes.
fn pump(pipe: OwnedFd, capture: Capture) -> std::thread::JoinHandle<()> {
    std::thread::Builder::new()
        .name("iwci-sandbox-out".into())
        .spawn(move || {
            let mut file = std::fs::File::from(pipe);
            let mut buf = vec![0u8; 64 << 10];
            loop {
                match file.read(&mut buf) {
                    Ok(0) => return,
                    Ok(n) => capture.push(&buf[..n]),
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => return,
                }
            }
        })
        .expect("spawning a thread")
}

fn pipe() -> Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0; 2];
    // SAFETY: `fds` has room for both ends.
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } < 0 {
        return Err(setup(io::Error::last_os_error()));
    }
    use std::os::fd::FromRawFd;
    // SAFETY: both were just created and are ours.
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stop {
    Timeout,
    Stalled,
    Cancelled,
    /// At its memory limit, stuck reclaiming (`cgroup::Reclaiming`).
    OutOfMemory,
}

impl Runtime {
    /// [`Runtime::run_script`] in a gVisor sandbox with `natives` on the
    /// script's `PATH` (see the module comment).
    #[allow(clippy::too_many_arguments)]
    pub fn run_script_sandboxed(
        &self,
        host: &SandboxHost,
        natives: &[NativeTool],
        packages: &[WebcPackage],
        entry: &str,
        script: &str,
        inv: Invocation,
        budget: Option<Arc<dyn iwci_vfs::WriteBudget>>,
    ) -> Result<Outcome> {
        let started = Instant::now();

        // What the runner inside loads: every package's commands compiled
        // (here, where the cache can be written), the tools' and services'.
        let (mut keys, names) = crate::wasix::prepare_listing(&self.wasix, &self.tokio, packages)?;
        for tool in &inv.commands {
            self.prepare(&tool.module)?;
            keys.push(tool.module.sha256);
        }
        let mut all_packages: Vec<&WebcPackage> = packages.iter().collect();
        for service in &inv.services {
            match &service.program {
                crate::ServiceProgram::Command { module, .. } => {
                    self.prepare(module)?;
                    keys.push(module.sha256);
                }
                crate::ServiceProgram::Script { packages, .. } => {
                    let (more, _) =
                        crate::wasix::prepare_listing(&self.wasix, &self.tokio, packages)?;
                    keys.extend(more);
                    all_packages.extend(packages.iter());
                }
            }
        }
        keys.sort();
        keys.dedup();
        let builtins = self.node_builtins(packages);

        // /.iwci: the runner, the job, its packages and modules.
        let iwci = TmpFileSystem::new();
        let mut iwci_modes = BTreeMap::new();
        let ro = |fs: &TmpFileSystem, path: &str, bytes: OwnedBuffer| -> Result<()> {
            let path = Path::new(path);
            if let Some(parent) = path.parent() {
                iwci_vfs::create_dir_all(fs, parent).map_err(setup)?;
            }
            fs.new_open_options_ext()
                .insert_ro_file(path, bytes)
                .map_err(setup)
        };
        ro(&iwci, "/bin/iwci", host.runner.clone())?;
        iwci_modes.insert(PathBuf::from("/bin/iwci"), 0o755);
        iwci_vfs::create_dir_all(&iwci, "/out").map_err(setup)?;
        let fingerprint = self
            .store
            .dir()
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .ok_or_else(|| setup("the module cache has no directory"))?;
        for key in &keys {
            if let Some((artifact, digest)) = self.store.artifact_files(key) {
                for file in [artifact, digest] {
                    let name = file.file_name().map(|n| n.to_string_lossy().into_owned());
                    if let Some(name) = name {
                        ro(&iwci, &format!("/cache/{fingerprint}/{name}"), mmap(&file)?)?;
                    }
                }
            }
        }
        let mut spec_packages = BTreeMap::new();
        for package in &all_packages {
            let sha = hex::encode(package.sha256);
            let file = format!("/job/packages/{sha}.webc");
            if !spec_packages.contains_key(&sha) {
                ro(
                    &iwci,
                    &file,
                    OwnedBuffer::from_bytes(bytes::Bytes::from_owner(package.bytes.clone())),
                )?;
            }
            spec_packages.insert(
                sha.clone(),
                SpecPackage {
                    name: package.name.clone(),
                    version: package.version.clone(),
                    sha256: sha,
                    file: PathBuf::from(IWCI_DIR).join(&file[1..]),
                },
            );
        }
        let spec_package = |p: &WebcPackage| spec_packages[&hex::encode(p.sha256)].clone();
        let module_file = |m: &crate::WasmModule| -> Result<SpecModule> {
            let sha = hex::encode(m.sha256);
            let file = format!("/job/modules/{sha}.wasm");
            if iwci.metadata(Path::new(&file)).is_err() {
                ro(
                    &iwci,
                    &file,
                    OwnedBuffer::from_bytes(bytes::Bytes::from_owner(m.bytes.clone())),
                )?;
            }
            Ok(SpecModule {
                name: m.name.clone(),
                sha256: sha,
                file: PathBuf::from(IWCI_DIR).join(&file[1..]),
            })
        };
        let tools = inv
            .commands
            .iter()
            .map(|c| {
                let mut m = module_file(&c.module)?;
                m.name = c.name.clone();
                Ok(m)
            })
            .collect::<Result<Vec<_>>>()?;
        let services = inv
            .services
            .iter()
            .map(|s| {
                Ok(SpecService {
                    name: s.name.clone(),
                    env: s.env.clone(),
                    ready_timeout_ms: s.ready_timeout.as_millis() as u64,
                    ready: SpecReady::from_ready(&s.ready),
                    program: match &s.program {
                        crate::ServiceProgram::Command { module, args } => SpecProgram::Command {
                            module: module_file(module)?,
                            args: args.clone(),
                        },
                        crate::ServiceProgram::Script {
                            packages,
                            entry,
                            script,
                        } => SpecProgram::Script {
                            packages: packages.iter().map(spec_package).collect(),
                            entry: entry.clone(),
                            script: script.clone(),
                        },
                    },
                })
            })
            .collect::<Result<Vec<_>>>()?;
        if let Some(builtins) = &builtins {
            ro(
                &iwci,
                "/job/builtins",
                OwnedBuffer::from_bytes(builtins.clone()),
            )?;
        }
        let native_commands: Vec<(String, PathBuf)> = natives
            .iter()
            .flat_map(|n| n.commands.iter().cloned())
            .collect();
        let spec = JobSpec {
            entry: entry.to_string(),
            script: script.to_string(),
            args: inv.args.clone(),
            env: inv.env.clone(),
            cwd: inv.cwd.clone(),
            timeout_ms: (inv.limits.timeout + INSIDE_GRACE).as_millis() as u64,
            memory_bytes: inv.limits.memory_bytes,
            output_cap: 64 << 10,
            internet: inv.internet,
            cpus: inv.limits.cpus.unwrap_or(host.cpus) as usize,
            told_cpus: inv.limits.told_cpus(),
            cache_dir: PathBuf::from(IWCI_DIR).join("cache"),
            packages: packages.iter().map(spec_package).collect(),
            tools,
            services,
            modes: inv.modes.recorded(),
            natives: native_commands.clone(),
            trees: inv
                .trees
                .iter()
                .map(|t| SpecTree {
                    name: t.name.clone(),
                    dir: t.dir.clone(),
                    scripts: t.scripts.clone(),
                    needs: t.needs.clone(),
                })
                .collect(),
            builtins: builtins
                .as_ref()
                .map(|_| PathBuf::from(IWCI_DIR).join("job/builtins")),
            result: PathBuf::from(OUT_DIR).join("result.json"),
            ready: PathBuf::from(OUT_DIR).join("ready"),
        };
        ro(
            &iwci,
            "/job/job.json",
            OwnedBuffer::from_bytes(serde_json::to_vec(&spec).map_err(setup)?),
        )?;

        // The commands' stand-ins, the native programs, the C library.
        let native_names: Vec<&str> = native_commands.iter().map(|(n, _)| n.as_str()).collect();
        let mut placed: Vec<Placed> = host.system.clone();
        for native in natives {
            placed.extend(native.files.iter().cloned());
        }
        let shim = |dir: &str, name: &str| Placed {
            path: Path::new(dir).join(name),
            content: Content::Symlink(PathBuf::from(RUNNER)),
        };
        let mut on_path: Vec<String> = names.clone();
        on_path.extend(["sh".to_string(), "env".to_string()]);
        on_path.sort();
        on_path.dedup();
        for name in &on_path {
            if native_names.contains(&name.as_str()) || name.contains('/') {
                continue;
            }
            placed.push(shim("/usr/bin", name));
            placed.push(shim("/bin", name));
        }
        // A Node tool's command too, so a native program can run it.
        let mut local: Vec<String> = inv
            .trees
            .iter()
            .flat_map(|t| t.scripts.iter().map(|(name, _)| name.clone()))
            .chain(inv.commands.iter().map(|c| c.name.clone()))
            .collect();
        local.extend(
            crate::modes::MODE_COMMANDS
                .iter()
                .chain(crate::services::SERVICE_COMMANDS)
                .map(|(n, _)| n.to_string()),
        );
        for name in local {
            if !native_names.contains(&name.as_str())
                && !placed
                    .iter()
                    .any(|p| p.path == Path::new("/usr/local/bin").join(&name))
            {
                placed.push(shim("/usr/local/bin", &name));
            }
        }
        let points = mount_points(&placed);
        // Each Node tool's directory is a mount of its own, read only, so it
        // cannot be under another one.
        for tree in &inv.trees {
            let dir = Path::new(&tree.dir);
            if !dir.is_absolute() || points.iter().any(|p| dir.starts_with(p)) {
                return Err(Error::Setup(format!(
                    "`{}` (tools:): its directory {} cannot be mounted in the sandbox",
                    tree.name, tree.dir
                )));
            }
        }

        // The job's root, with somewhere to mount each of those and what
        // a native program reads in /etc.
        let job_fs = inv.fs.clone();
        for point in points
            .iter()
            .map(PathBuf::as_path)
            .chain([Path::new(IWCI_DIR)])
            .chain(inv.trees.iter().map(|t| Path::new(t.dir.as_str())))
            .chain(
                inv.scratch
                    .is_some()
                    .then_some(Path::new(crate::SCRATCH_MOUNT)),
            )
        {
            iwci_vfs::create_dir_all(job_fs.as_ref(), point).map_err(setup)?;
        }
        for (path, text) in ETC {
            if job_fs.metadata(Path::new(path)).is_err() {
                let mut text = text.to_string();
                // A service's name is the loopback, for native programs
                // too, with or without a way out.
                if *path == "/etc/hosts" {
                    for service in &inv.services {
                        text.push_str(&format!("127.0.0.1 {}\n", service.name));
                    }
                }
                iwci_vfs::write_file(job_fs.as_ref(), path, text.as_bytes()).map_err(setup)?;
            }
        }

        let mut served = Vec::new();
        let (root_serving, root_gofer) = serve(Export {
            fs: job_fs,
            modes: inv.modes.clone(),
            root: "/".into(),
            read_only: false,
            budget: budget.clone(),
        })?;
        served.push(root_serving);
        let mut mounts = Vec::new();
        for point in &points {
            let files: Vec<&Placed> = placed
                .iter()
                .filter(|p| p.path.starts_with(point))
                .collect();
            let (fs, modes) = placed_fs(point, &files)?;
            let (s, gofer) = serve(Export {
                fs,
                modes,
                root: "/".into(),
                read_only: true,
                budget: None,
            })?;
            served.push(s);
            mounts.push(Mount {
                destination: point.to_string_lossy().into_owned(),
                read_only: true,
                gofer,
            });
        }
        // Node tools' directories, read only and shared as outside.
        for tree in &inv.trees {
            let (s, gofer) = serve(Export {
                fs: tree.fs.clone(),
                modes: Modes::default(),
                root: "/".into(),
                read_only: true,
                budget: None,
            })?;
            served.push(s);
            mounts.push(Mount {
                destination: tree.dir.clone(),
                read_only: true,
                gofer,
            });
        }
        let (s, gofer) = serve(Export {
            fs: Arc::new(iwci),
            modes: Modes::over(Arc::new(iwci_modes.into_iter().collect())),
            root: "/".into(),
            read_only: true,
            budget: None,
        })?;
        served.push(s);
        mounts.push(Mount {
            destination: IWCI_DIR.into(),
            read_only: true,
            gofer,
        });
        let small: Arc<dyn iwci_vfs::WriteBudget> = Arc::new(Small::default());
        let out = iwci_vfs::SnapshotBuilder::new()
            .freeze()
            .fork_limited(small.clone());
        let (s, gofer) = serve(Export {
            fs: out.as_dyn(),
            modes: out.modes(),
            root: "/".into(),
            read_only: false,
            budget: Some(small),
        })?;
        served.push(s);
        mounts.push(Mount {
            destination: OUT_DIR.into(),
            read_only: false,
            gofer,
        });
        if let Some(scratch) = &inv.scratch {
            let (s, gofer) = serve(Export {
                fs: scratch.clone(),
                modes: Modes::default(),
                root: "/".into(),
                read_only: false,
                budget: budget.clone(),
            })?;
            served.push(s);
            mounts.push(Mount {
                destination: crate::SCRATCH_MOUNT.into(),
                read_only: false,
                gofer,
            });
        }

        // Its way out, its cgroup, its output.
        let gateway = match (&self.wasix.outside, inv.internet) {
            (Some(outside), true) => {
                let (gateway, link) = Gateway::start(Network {
                    outside: outside.clone(),
                    services: inv.services.iter().map(|s| s.name.clone()).collect(),
                })
                .map_err(setup)?;
                Some((gateway, link))
            }
            _ => None,
        };
        let (gateway, link) = match gateway {
            Some((g, l)) => (Some(g), Some(l)),
            None => (None, None),
        };
        let id = sandbox_id();
        let cgroup: Option<Cgroup> = match &host.jobs {
            Some(jobs) => Some(
                jobs.create(
                    &id,
                    Limits {
                        memory: inv.limits.memory_bytes.saturating_add(host.overhead),
                        pids: PIDS,
                    },
                )
                .map_err(setup)?,
            ),
            None => None,
        };
        // Sandboxes share the runner's CPUs by equal weight, one job's
        // each; one whose job holds `cpus:` weighs the jobs its slots are.
        if let (Some(cgroup), Some(cpus)) = (&cgroup, inv.limits.cpus) {
            cgroup
                .set_cpu_weight(cpu_weight(cpus, host.jobs_per_cpu))
                .map_err(setup)?;
        }
        let written = Arc::new(AtomicU64::new(0));
        let stdout = Capture::new(self.output_cap)
            .with_sink(inv.log.clone(), crate::Stream::Stdout)
            .counting(written.clone());
        let stderr = Capture::new(self.output_cap)
            .with_sink(inv.log.clone(), crate::Stream::Stderr)
            .counting(written.clone());
        let (out_r, out_w) = pipe()?;
        let (err_r, err_w) = pipe()?;
        let stdin: OwnedFd = std::fs::File::open("/dev/null").map_err(setup)?.into();
        let state_dir = host.state_root.join(&id);
        let log_path = host.state_root.join(format!("{id}.log"));
        let log: OwnedFd = std::fs::File::create(&log_path).map_err(setup)?.into();
        let config = runsc::Config {
            id: id.clone(),
            state_dir: state_dir.clone(),
            args: vec![
                RUNNER.into(),
                "sandbox-init".into(),
                format!("{IWCI_DIR}/job/job.json"),
            ],
            env: vec![
                "PATH=/usr/local/bin:/usr/bin:/bin".into(),
                "HOME=/root".into(),
            ],
            cwd: "/".into(),
            platform: host.platform.clone(),
            cpus: spec.cpus as u32,
            memory_bytes: inv.limits.memory_bytes,
            extra_flags: Vec::new(),
            cgroup: cgroup.as_ref().map(|c| c.path().to_path_buf()),
        };
        let booted = runsc::boot_with(
            &host.release,
            &config,
            root_gofer,
            mounts,
            [stdin, out_w, err_w],
            log,
            link,
        );
        let mut sandbox = match booted {
            Ok(sandbox) => sandbox,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&state_dir);
                return Err(setup(format!("starting the sandbox: {e}")));
            }
        };
        let readers = [pump(out_r, stdout.clone()), pump(err_r, stderr.clone())];
        if let Err(e) = sandbox.start() {
            sandbox.kill();
            let log = std::fs::read_to_string(&log_path).unwrap_or_default();
            let _ = std::fs::remove_dir_all(&state_dir);
            let _ = std::fs::remove_file(&log_path);
            let tail: Vec<&str> = log.lines().rev().take(20).collect();
            return Err(setup(format!(
                "starting the sandbox: {e}\n{}",
                tail.into_iter().rev().collect::<Vec<_>>().join("\n")
            )));
        }

        // Until it ends, or the runner ends it.
        let deadline = started + inv.limits.timeout;
        let cancel = inv.cancel.clone();
        let usage = |c: &Option<Cgroup>| c.as_ref().and_then(|c| c.usage().ok());
        let cpu = || usage(&cgroup).map(|u| Duration::from_micros(u.cpu_usec));
        let mut watch = self.stall_after.and_then(|after| {
            crate::stall::StallWatch::new(
                after,
                Instant::now(),
                written.load(Ordering::Relaxed),
                cpu(),
            )
        });
        let mut held = 0u64;
        // The sandbox's own memory, once the runner inside says it has
        // loaded the environment: from then on the job may have its whole
        // `memory:` on top, and no more.
        let mut baseline: Option<u64> = None;
        let mut reclaiming = iwci_sandbox::cgroup::Reclaiming::default();
        let mut limit = inv.limits.memory_bytes.saturating_add(host.overhead);
        let (status, stopped) = loop {
            match sandbox.wait_for(Some(POLL)) {
                Ok(Some(status)) => break (Some(status), None),
                Ok(None) => {}
                Err(_) => break (None, None),
            }
            let u = usage(&cgroup);
            if baseline.is_none()
                && let Some(u) = &u
                && out.read("/ready").is_ok()
            {
                let own = u.memory.min(host.overhead);
                baseline = Some(own);
                limit = inv.limits.memory_bytes.saturating_add(own);
                if let Some(cgroup) = &cgroup {
                    let _ = cgroup.set_memory_max(limit);
                }
            }
            let now = Instant::now();
            if let Some(u) = &u
                && reclaiming.stuck(now, u, limit)
            {
                break (None, Some(Stop::OutOfMemory));
            }
            // The whole sandbox, against what the job reserved with it.
            if let Some(u) = u
                && u.memory > held
            {
                held = u.memory;
                if let Some(watch) = &inv.memory_watch {
                    watch(held);
                }
            }
            if cancel.as_ref().is_some_and(|c| c.is_cancelled()) {
                break (None, Some(Stop::Cancelled));
            }
            if now >= deadline {
                break (None, Some(Stop::Timeout));
            }
            if let Some(watch) = &mut watch
                && watch.stalled(now, written.load(Ordering::Relaxed), cpu(), false)
            {
                break (None, Some(Stop::Stalled));
            }
        };
        if stopped.is_some() {
            sandbox.kill();
        }
        let used = usage(&cgroup).unwrap_or_default();
        drop(sandbox);
        drop(gateway);
        drop(cgroup);
        for reader in readers {
            let _ = reader.join();
        }
        drop(served);
        let result: Option<JobResult> = out
            .read("/result.json")
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        let _ = std::fs::remove_dir_all(&state_dir);
        let _ = std::fs::remove_file(&log_path);

        // What the runner saw for itself decides how the job ended: the
        // sandbox's own exit status, its cgroup and its clock. The runner
        // inside only adds what only it can know (a refused allocation, a
        // trap, a service that failed). Those come from a file the sandbox
        // writes, so the job could write them itself; that is fine, as each
        // can only mark this job failed or out of memory (its exit code,
        // timeout and billing never come from the file), which is the job's
        // to say anyway.
        let killed_for_memory = used.out_of_memory || stopped == Some(Stop::OutOfMemory);
        let exit_code = match status {
            _ if stopped == Some(Stop::OutOfMemory) => 137,
            _ if stopped.is_some() => crate::TIMEOUT_EXIT_CODE,
            Some(s) if libc::WIFEXITED(s) => libc::WEXITSTATUS(s),
            Some(s) if libc::WIFSIGNALED(s) => 128 + libc::WTERMSIG(s),
            _ => crate::CRASH_EXIT_CODE,
        };
        let out = stdout.take();
        let mut err = stderr.take();
        if killed_for_memory {
            let note = format!(
                "iwci: the job ran out of its {} MiB of memory, and its sandbox was stopped\n",
                inv.limits.memory_bytes >> 20
            );
            if !err.bytes.is_empty() && !err.bytes.ends_with(b"\n") {
                stderr.note(b"\n");
                err.bytes.push(b'\n');
            }
            stderr.note(note.as_bytes());
            err.bytes.extend_from_slice(note.as_bytes());
        }
        // The job's share, as a WASIX job's figures are its own: what the
        // sandbox held beyond what it took before the script started. A
        // sandbox that never got that far held nothing of the job's.
        let own = baseline.unwrap_or_else(|| used.memory_peak.max(held));
        let peak = used.memory_peak.max(held).saturating_sub(own);
        let held = held.saturating_sub(own);
        Ok(Outcome {
            exit_code,
            stdout: out.bytes,
            stderr: err.bytes,
            truncated: out.truncated || err.truncated,
            duration: started.elapsed(),
            timed_out: stopped == Some(Stop::Timeout),
            cancelled: stopped == Some(Stop::Cancelled),
            stalled_after: self.stall_after.filter(|_| stopped == Some(Stop::Stalled)),
            out_of_memory: killed_for_memory || result.as_ref().is_some_and(|r| r.out_of_memory),
            peak_memory_bytes: peak,
            held_memory_bytes: held,
            error: if stopped.is_some() {
                None
            } else {
                result.as_ref().and_then(|r| r.error.clone())
            },
            service_failure: result.and_then(|r| r.service_failure),
            sandbox: Some(crate::SandboxUsage {
                overhead_bytes: own,
                reserved_bytes: host.overhead,
                cpu_usec: used.cpu_usec,
            }),
        })
    }
}
