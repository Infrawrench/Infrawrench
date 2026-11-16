//! The runner inside a job's gVisor sandbox.
//!
//! A job that uses a native program (Bun) runs whole in one gVisor sandbox
//! (`sandbox.rs` starts it), so that the native program and everything else
//! of the job share one loopback and one view of the files. The sandbox's
//! first process is the runner's own binary (`iwci sandbox-init`), which
//! runs the job's script and services exactly as a WASIX job runs them
//! (`wasix::run`), with three differences:
//!
//! - the file system is the sandbox's own (`/`, which is the job's file
//!   system served from outside), and modes are the files' real ones,
//!   through `chmod(2)` and `lstat(2)` ([`HostModes`]);
//! - the network is the sandbox's own stack, so a WASIX server and a native
//!   one share the loopback, and the way out is the sandbox's gateway,
//!   which holds it to the runner's policy;
//! - the native programs are on the script's `PATH` (`natives`), and the
//!   environment's commands are on theirs (`shim`).
//!
//! What the job writes to stdout and stderr goes to this process's own, which
//! the runner outside reads; how it ended goes to a result file. Nothing
//! read from inside is trusted by the runner outside: memory, CPU and time
//! are measured and enforced there.

pub(crate) mod natives;
pub(crate) mod shim;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use iwci_vfs::modes::{DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, RealModes};
use serde::{Deserialize, Serialize};
use virtual_fs::FileSystem;

pub use shim::client as shim_client;

/// What a runtime needs to run a job inside its sandbox.
#[derive(Clone)]
pub(crate) struct Sandbox {
    /// The sandbox's own network stack.
    pub(crate) stack: Arc<dyn virtual_net::VirtualNetworking + Send + Sync>,
    /// The native programs: command name and path.
    pub(crate) natives: Vec<(String, PathBuf)>,
}

/// One job, as the runner outside describes it (`job.json`). Paths are the
/// sandbox's.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JobSpec {
    /// The shell command of the environment that runs the script (`bash`).
    pub entry: String,
    pub script: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cwd: String,
    /// The runner outside stops the job at its own deadline; this is a
    /// little later.
    pub timeout_ms: u64,
    pub memory_bytes: u64,
    pub output_cap: usize,
    pub internet: bool,
    pub cpus: usize,
    /// Where the compiled modules are (read only).
    pub cache_dir: PathBuf,
    pub packages: Vec<SpecPackage>,
    pub tools: Vec<SpecModule>,
    pub services: Vec<SpecService>,
    /// The modes the job's files had when it started.
    pub modes: Vec<(PathBuf, u32)>,
    /// Native programs: command name and path.
    pub natives: Vec<(String, PathBuf)>,
    /// Node tools' directories (`tools:` with `abi: node`), each mounted
    /// read only at its `dir` by the runner outside.
    #[serde(default)]
    pub trees: Vec<SpecTree>,
    /// Edge.js's built-ins cache for the environment, when it has one.
    pub builtins: Option<PathBuf>,
    /// Where to write the [`JobResult`].
    pub result: PathBuf,
    /// Written once the environment is loaded, before the script starts:
    /// the runner outside measures the sandbox's own memory then.
    pub ready: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecPackage {
    pub name: String,
    pub version: String,
    pub sha256: String,
    pub file: PathBuf,
}

/// A Node tool's directory ([`crate::PathTree`]): the files are the
/// sandbox's own at `dir`, a read-only mount, so only the rest travels.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecTree {
    pub name: String,
    pub dir: String,
    pub scripts: Vec<(String, Vec<u8>)>,
    pub needs: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecModule {
    pub name: String,
    pub sha256: String,
    pub file: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpecService {
    pub name: String,
    pub env: Vec<(String, String)>,
    pub ready_timeout_ms: u64,
    pub ready: SpecReady,
    pub program: SpecProgram,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpecReady {
    Started,
    Port(u16),
    Log(String),
    Command(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SpecProgram {
    Command {
        module: SpecModule,
        args: Vec<String>,
    },
    Script {
        packages: Vec<SpecPackage>,
        entry: String,
        script: String,
    },
}

/// How the job ended, as the runner inside saw it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct JobResult {
    pub exit_code: i32,
    pub out_of_memory: bool,
    pub timed_out: bool,
    pub error: Option<String>,
    pub service_failure: Option<String>,
}

impl SpecReady {
    pub fn from_ready(ready: &crate::Ready) -> Self {
        match ready {
            crate::Ready::Started => Self::Started,
            crate::Ready::Port(p) => Self::Port(*p),
            crate::Ready::Log(l) => Self::Log(l.clone()),
            crate::Ready::Command(c) => Self::Command(c.clone()),
        }
    }

    fn to_ready(&self) -> crate::Ready {
        match self {
            Self::Started => crate::Ready::Started,
            Self::Port(p) => crate::Ready::Port(*p),
            Self::Log(l) => crate::Ready::Log(l.clone()),
            Self::Command(c) => crate::Ready::Command(c.clone()),
        }
    }
}

/// The modes of the sandbox's own files: real ones.
#[derive(Debug)]
pub(crate) struct HostModes;

impl RealModes for HostModes {
    fn get(&self, path: &Path) -> Result<Option<u32>, ()> {
        let meta = std::fs::symlink_metadata(path).map_err(|_| ())?;
        if meta.file_type().is_symlink() {
            return Ok(None);
        }
        let perm = meta.permissions().mode() & iwci_vfs::modes::MODE_BITS;
        let default = if meta.is_dir() {
            DEFAULT_DIR_MODE
        } else {
            DEFAULT_FILE_MODE
        };
        Ok((perm != default).then_some(perm))
    }

    fn set(&self, path: &Path, mode: u32) -> bool {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).is_ok()
    }
}

/// The sandbox's files as a job sees them, with the mode of every path it
/// looks at taken into the record, so `/proc/iwci/ino/` finds a file a
/// native program gave a mode (modes.rs).
#[derive(Debug)]
pub(crate) struct Observed {
    inner: iwci_vfs::DynFs,
    modes: iwci_vfs::Modes,
}

impl FileSystem for Observed {
    fn readlink(&self, path: &Path) -> virtual_fs::Result<PathBuf> {
        self.inner.readlink(path)
    }
    fn read_dir(&self, path: &Path) -> virtual_fs::Result<virtual_fs::ReadDir> {
        self.inner.read_dir(path)
    }
    fn create_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        self.inner.create_dir(path)
    }
    fn create_symlink(&self, source: &Path, target: &Path) -> virtual_fs::Result<()> {
        // virtual-fs's host file system makes no symlinks; the sandbox's own
        // file system does, and its paths are the job's.
        std::os::unix::fs::symlink(source, target).map_err(virtual_fs::FsError::from)
    }
    fn hard_link(&self, source: &Path, target: &Path) -> virtual_fs::Result<()> {
        self.inner.hard_link(source, target)
    }
    fn remove_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        self.inner.remove_dir(path)
    }
    fn rename<'a>(
        &'a self,
        from: &'a Path,
        to: &'a Path,
    ) -> futures::future::BoxFuture<'a, virtual_fs::Result<()>> {
        self.inner.rename(from, to)
    }
    fn metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        let meta = self.inner.metadata(path)?;
        let _ = self.modes.get(path);
        Ok(meta)
    }
    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<virtual_fs::Metadata> {
        let meta = self.inner.symlink_metadata(path)?;
        if !meta.file_type().is_symlink() {
            let _ = self.modes.get(path);
        }
        Ok(meta)
    }
    fn remove_file(&self, path: &Path) -> virtual_fs::Result<()> {
        self.inner.remove_file(path)
    }
    fn new_open_options(&self) -> virtual_fs::OpenOptions<'_> {
        self.inner.new_open_options()
    }
}

/// Writes what the job prints to this process's stdout and stderr, a
/// chunk at a time.
fn output_sink() -> crate::LogSink {
    let locks = Arc::new([Mutex::new(()), Mutex::new(())]);
    Arc::new(move |stream, data| {
        let (i, fd) = match stream {
            crate::Stream::Stdout => (0, 1),
            crate::Stream::Stderr => (1, 2),
        };
        let _held = locks[i].lock().unwrap_or_else(|e| e.into_inner());
        let mut rest = data;
        while !rest.is_empty() {
            // SAFETY: writing bytes we hold to one of our standard
            // descriptors.
            let n = unsafe { libc::write(fd, rest.as_ptr().cast(), rest.len()) };
            if n < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return;
            }
            rest = &rest[n as usize..];
        }
    })
}

fn read_package(p: &SpecPackage) -> Result<crate::WebcPackage, String> {
    let bytes = std::fs::read(&p.file).map_err(|e| format!("{}: {e}", p.file.display()))?;
    let package = crate::WebcPackage::new(p.name.clone(), p.version.clone(), bytes);
    if hex::encode(package.sha256) != p.sha256 {
        return Err(format!(
            "{}: not the package the runner sent",
            p.file.display()
        ));
    }
    Ok(package)
}

fn read_module(m: &SpecModule) -> Result<crate::WasmModule, String> {
    let bytes = std::fs::read(&m.file).map_err(|e| format!("{}: {e}", m.file.display()))?;
    let module = crate::WasmModule::new(m.name.clone(), bytes);
    if hex::encode(module.sha256) != m.sha256 {
        return Err(format!(
            "{}: not the module the runner sent",
            m.file.display()
        ));
    }
    Ok(module)
}

/// Runs the job `spec` describes and writes its result: the runner's
/// `sandbox-init`. Its exit code is the job's.
pub fn main(spec: &Path) -> i32 {
    match run(spec) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("iwci: in the sandbox: {e}");
            125
        }
    }
}

fn run(spec_path: &Path) -> Result<i32, String> {
    let spec: JobSpec = serde_json::from_slice(
        &std::fs::read(spec_path).map_err(|e| format!("{}: {e}", spec_path.display()))?,
    )
    .map_err(|e| format!("{}: {e}", spec_path.display()))?;
    crate::set_node_worker_threads(spec.cpus);
    crate::configure_node_runtime()?;
    let runtime = crate::Runtime::with_threads(spec.cache_dir.clone(), Some(spec.cpus))
        .map_err(|e| e.to_string())?
        .with_output_cap(spec.output_cap)
        .with_stall_after(None)
        .in_sandbox(spec.natives.clone());

    let packages = spec
        .packages
        .iter()
        .map(read_package)
        .collect::<Result<Vec<_>, _>>()?;
    let commands = spec
        .tools
        .iter()
        .map(|m| {
            Ok(crate::PathCommand {
                name: m.name.clone(),
                module: read_module(m)?,
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let services = spec
        .services
        .iter()
        .map(|s| {
            let program = match &s.program {
                SpecProgram::Command { module, args } => crate::ServiceProgram::Command {
                    module: read_module(module)?,
                    args: args.clone(),
                },
                SpecProgram::Script {
                    packages,
                    entry,
                    script,
                } => crate::ServiceProgram::Script {
                    packages: packages
                        .iter()
                        .map(read_package)
                        .collect::<Result<Vec<_>, _>>()?,
                    entry: entry.clone(),
                    script: script.clone(),
                },
            };
            Ok(crate::Service {
                name: s.name.clone(),
                program,
                env: s.env.clone(),
                ready: s.ready.to_ready(),
                ready_timeout: Duration::from_millis(s.ready_timeout_ms),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let trees = spec
        .trees
        .iter()
        .map(|t| {
            Ok(crate::PathTree {
                name: t.name.clone(),
                dir: t.dir.clone(),
                fs: runtime.sandbox_dir(&t.dir)?,
                scripts: t.scripts.clone(),
                needs: t.needs.clone(),
            })
        })
        .collect::<Result<Vec<_>, String>>()?;
    let builtins = match &spec.builtins {
        Some(path) => Some(bytes::Bytes::from(
            std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?,
        )),
        None => None,
    };

    // The environment, parsed and loaded as the job will use it, so that
    // what the sandbox holds now is its own (`sandbox.rs`).
    let _loaded = runtime
        .preload(&packages, &spec.entry)
        .map_err(|e| e.to_string())?;
    std::fs::write(&spec.ready, b"").map_err(|e| format!("{}: {e}", spec.ready.display()))?;

    let base: std::collections::BTreeMap<PathBuf, u32> = spec.modes.iter().cloned().collect();
    let modes = iwci_vfs::Modes::real(Arc::new(base), Arc::new(HostModes));
    let root = runtime.sandbox_dir("/")?;
    let tracked: iwci_vfs::DynFs = Arc::new(iwci_vfs::TrackModes::new(root, modes.clone(), "/"));
    let fs: iwci_vfs::DynFs = Arc::new(Observed {
        inner: tracked,
        modes: modes.clone(),
    });
    let inv = crate::Invocation {
        args: spec.args.clone(),
        env: spec.env.clone(),
        cwd: spec.cwd.clone(),
        fs,
        limits: crate::Limits {
            timeout: Duration::from_millis(spec.timeout_ms),
            memory_bytes: spec.memory_bytes,
        },
        log: Some(output_sink()),
        scratch: None,
        commands,
        trees,
        internet: spec.internet,
        modes,
        services,
        cancel: None,
        memory_watch: None,
    };
    let outcome = runtime
        .run_script_with_builtins(&packages, &spec.entry, &spec.script, inv, builtins)
        .map_err(|e| e.to_string())?;
    let result = JobResult {
        exit_code: outcome.exit_code,
        out_of_memory: outcome.out_of_memory,
        timed_out: outcome.timed_out,
        error: outcome.error,
        service_failure: outcome.service_failure,
    };
    std::fs::write(
        &spec.result,
        serde_json::to_vec(&result).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("{}: {e}", spec.result.display()))?;
    Ok(outcome.exit_code)
}
