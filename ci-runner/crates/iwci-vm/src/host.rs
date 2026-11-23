//! Running one job in one machine, start to finish.
//!
//! 1. Make the machine's directory: its sockets (the runner listens, QEMU
//!    connects), its console log, and for Windows its disk overlay and its
//!    copy of UEFI's variables.
//! 2. Linux: make (or reuse) the workspace's erofs image.
//! 3. Start QEMU, accept the agent's port and the network link, start the
//!    link's bridge to the runner's gateway.
//! 4. The conversation: hello, setup, the job's files in (on Linux only
//!    what it starts with beyond the workspace image; on Windows all of
//!    them), the script, and back what it left under the paths asked for.
//!    The run's `/tmp/workflow` is served to a Linux machine over
//!    virtio-fs (`virtiofs.rs`) when the host's QEMU and the image's
//!    agent can, so nothing of it is copied and the job sees it live;
//!    otherwise it is copied in whole and what changed comes back. The
//!    job's own files are streamed in the same way, read only, as the
//!    lower layer of the machine's root, when the image's agent says it
//!    can mount them (`files-virtiofs`): no workspace image is made and no
//!    archive is sent, and a file crosses only when it is read.
//! 5. Stop the machine and remove its directory, whatever happened.
//!
//! The job's timeout, a cancel, and a hang (no output and the machine's
//! CPU time standing still for `stall_after`) stop the machine at once;
//! a job stopped like that sends nothing back.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
#[cfg(target_os = "linux")]
use std::sync::Arc;
use std::time::{Duration, Instant};

use iwci_vfs::{DynFs, JobFs, Snapshot};
use iwci_vm_proto::{
    Collect, Exec, Exited, FILES_FEATURE, Network, PROTOCOL, SCRATCH_TAG, ScratchMount, Setup,
    Shell,
};

use crate::agent::{Agent, Failed, Ran, Tick, Watch};
use crate::archive::{self, Moded};
use crate::images::{LinuxImage, WindowsImage, Workspaces};
use crate::qemu::{self, Arch, Sockets};

/// How big a Linux job's writable disk is. Sparse on the host, so only the
/// sectors the job touches cost anything; the rest is a hole. This replaces
/// the tmpfs writable layer, which used to charge a big install against the
/// job's memory.
const SCRATCH_DISK_BYTES: u64 = 20 << 30;

/// The kind of machine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Os {
    Linux,
    Windows,
}

/// What a runner's machines are made from.
pub struct Config {
    /// `--machines`: `linux/` and `windows/` images (see [`crate::images`]).
    pub dir: PathBuf,
    /// Where workspace images and each machine's own files go.
    pub cache: PathBuf,
    /// The emulator; default `qemu-system-<host arch>` on `PATH`.
    pub qemu: Option<PathBuf>,
    /// For Windows disk overlays; default `qemu-img` on `PATH`.
    pub qemu_img: Option<PathBuf>,
    /// For workspace images; default `mkfs.erofs` on `PATH`.
    pub mkfs_erofs: Option<PathBuf>,
    /// Virtual CPUs a Linux machine gets (a Windows machine gets what its
    /// saved state was made with, or this).
    pub cpus: u32,
    /// The most disk the workspace images keep.
    pub workspace_cache_bytes: u64,
    /// Lets a Linux machine use the host's idle CPUs (see [`Burst`]);
    /// `None` gives it its `cpus:` and no more.
    pub burst: Option<Burst>,
    /// The runner's network policy, the one every job's network goes
    /// through; `None` gives machines no network at all.
    #[cfg(target_os = "linux")]
    pub outside: Option<Arc<dyn iwci_sandbox::net::Outside>>,
}

/// How a Linux machine uses CPUs no job is using. It gets more vCPUs than
/// its job's `cpus:` ([`burst_vcpus`]) and runs in a cgroup of its own
/// among the runner's sandboxes, weighted by those `cpus:`: when the host
/// has idle CPUs a compile or a parallel test run spreads over them, and
/// when every job wants more than there is, each gets its `cpus:` share,
/// as if it had only that many.
#[derive(Debug, Clone, Copy)]
pub struct Burst {
    /// The host's CPUs, the most any machine gets.
    pub host_cpus: u32,
    /// `cpu.weight` per CPU a job holds: the runner's sandboxes weigh 100
    /// per slot, `--jobs-per-cpu` slots to a CPU.
    pub weight_per_cpu: u64,
}

/// At most this many times its `cpus:` in vCPUs.
const BURST_FACTOR: u32 = 4;

/// The vCPUs a machine whose job holds `cpus` and `memory_bytes` gets when
/// it may burst: up to [`BURST_FACTOR`] times its `cpus:` and one per GiB
/// of its memory, since a build or a test run starts a worker per CPU it
/// sees and each needs memory; never fewer than its `cpus:` nor more than
/// the host has.
pub fn burst_vcpus(cpus: u32, memory_bytes: u64, host_cpus: u32) -> u32 {
    let cpus = cpus.max(1);
    let by_memory = u32::try_from(memory_bytes >> 30).unwrap_or(u32::MAX);
    cpus.saturating_mul(BURST_FACTOR)
        .min(by_memory)
        .min(host_cpus)
        .max(cpus)
}

/// Where a job's output goes as it is written: `true` for stderr.
pub type OutputSink = dyn Fn(bool, &[u8]) + Sync;

/// One job for [`Host::run`].
pub struct Job<'a> {
    pub id: &'a str,
    pub os: Os,
    /// The machine's memory: the job's `memory:`.
    pub memory_bytes: u64,
    /// The machine's vCPUs: what the job holds of its `cpus:`, or the
    /// runner's `cpus` per machine when it has none.
    pub cpus: Option<u32>,
    pub timeout: Duration,
    pub network: bool,
    pub shell: Shell,
    pub script: &'a str,
    pub env: Vec<(String, String)>,
    /// A Unix path.
    pub cwd: &'a str,
    /// The workspace's files and a key naming them (commit and workspace).
    pub workspace: Option<(&'a str, &'a Snapshot)>,
    /// The job's files: the workspace's, and what it starts with.
    pub fs: &'a JobFs,
    /// The run's `/tmp/workflow`, rooted at `/`, and where the job sees it.
    pub scratch: Scratch<'a>,
    pub scratch_at: &'a str,
    /// Unix paths whose contents come back.
    pub collect: &'a [String],
    /// The job's clone, which comes back without what git ignores in it.
    pub repository: Option<&'a str>,
    pub output: Option<&'a OutputSink>,
    pub cancelled: &'a (dyn Fn() -> bool + Sync),
    pub stall_after: Option<Duration>,
    /// What each of stdout and stderr keeps for the report.
    pub output_cap: usize,
}

/// The run's `/tmp/workflow` for one job.
pub struct Scratch<'a> {
    /// What the job sees, served to a Linux machine as it is, over
    /// virtio-fs, when the host and the image can.
    pub live: Option<DynFs>,
    /// Otherwise its files are copied in and what the job changed comes
    /// back into these: `settle` first, so everything another runner wrote
    /// is here to copy.
    pub files: &'a JobFs,
    pub settle: &'a (dyn Fn() -> Result<(), String> + Sync),
}

/// What a machine sent back for one file system.
#[derive(Debug, Default)]
pub struct Collected {
    pub deleted: Vec<PathBuf>,
    pub entries: Vec<Moded>,
}

/// How a job's machine went.
#[derive(Debug, Default)]
pub struct Outcome {
    /// How the script ended, when it ran to its end.
    pub exited: Option<Exited>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub stalled_after: Option<u64>,
    pub cancelled: bool,
    /// As the agent named them.
    pub image: String,
    pub arch: String,
    pub boot_ms: u64,
    pub transfer_ms: u64,
    pub cpu_ms: u64,
    /// For the job's files.
    pub files: Collected,
    /// For the run's `/tmp/workflow`, rooted at `/`.
    pub scratch: Collected,
    pub notes: Vec<String>,
}

/// How long a machine has to answer once started: a Linux micro VM boots
/// in about a second; Windows, from a saved state, in seconds, and
/// booting without one takes a minute or more.
const LINUX_BOOT: Duration = Duration::from_secs(60);
const WINDOWS_RESTORE: Duration = Duration::from_secs(120);
const WINDOWS_BOOT: Duration = Duration::from_secs(600);
/// Each of setup, writing the files and reading them back.
const STEP: Duration = Duration::from_secs(600);
/// What the emulator takes beyond the machine's memory.
const LINUX_OVERHEAD: u64 = 160 << 20;
const WINDOWS_OVERHEAD: u64 = 512 << 20;

/// A runner's machines.
pub struct Host {
    config: Config,
    arch: Option<Arch>,
    qemu: Option<PathBuf>,
    linux: Option<LinuxImage>,
    windows: Option<WindowsImage>,
    qemu_img: Option<PathBuf>,
    workspaces: Option<Workspaces>,
    problems: Vec<String>,
    /// QEMU has `vhost-user-fs-device`: a Linux machine is served the
    /// run's `/tmp/workflow` rather than a copy of it.
    virtiofs: bool,
    /// The host lends 2 MiB huge pages (`vm.nr_overcommit_hugepages`, or a
    /// pool): a machine's shared memory is put in them, which is most of
    /// what its boot costs otherwise (`qemu::linux_args`).
    huge_pages: bool,
    /// Where Linux machines get their weighted cgroups when they may burst
    /// ([`Burst`]): the runner's delegated `jobs/`.
    #[cfg(target_os = "linux")]
    cgroups: Option<iwci_sandbox::cgroup::Jobs>,
}

/// `name` on `PATH`, or `path` when given and present.
fn find(path: Option<&Path>, name: &str) -> Option<PathBuf> {
    if let Some(path) = path {
        return path.is_file().then(|| path.to_path_buf());
    }
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(name))
            .find(|p| p.is_file())
    })
}

/// Whether `child` has exited, or does within a second: a machine whose
/// sockets closed under the runner is on its way out.
fn exits(child: &mut Child) -> bool {
    let until = Instant::now() + Duration::from_secs(1);
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) {
            return true;
        }
        if Instant::now() >= until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

/// Whether the host has, or may make, 2 MiB huge pages: a pool
/// (`nr_hugepages`) or room to make them when asked
/// (`nr_overcommit_hugepages`).
fn lends_huge_pages() -> bool {
    let read = |name: &str| {
        std::fs::read_to_string(format!("/sys/kernel/mm/hugepages/hugepages-2048kB/{name}"))
            .ok()
            .and_then(|t| t.trim().parse::<u64>().ok())
            .unwrap_or(0)
    };
    read("nr_hugepages") + read("nr_overcommit_hugepages") > 0
}

/// Whether `qemu` lists the virtio-fs device a Linux machine's
/// `/tmp/workflow` is served over.
fn has_virtiofs(qemu: &Path) -> bool {
    Command::new(qemu)
        .args(["-device", "help"])
        .stdin(Stdio::null())
        .output()
        .is_ok_and(|out| {
            let text = String::from_utf8_lossy(&out.stdout) + String::from_utf8_lossy(&out.stderr);
            text.contains("\"vhost-user-fs-device\"")
        })
}

fn kvm() -> Result<(), String> {
    std::fs::File::options()
        .read(true)
        .write(true)
        .open("/dev/kvm")
        .map(drop)
        .map_err(|e| {
            format!("/dev/kvm: {e} (KVM: on x86_64 a host with VT-x or AMD-V, on Graviton a `.metal` instance; the runner's user in the `kvm` group)")
        })
}

impl Host {
    /// Looks at what the host and `config.dir` have. A kind of machine that
    /// cannot run is left off, and [`Host::problems`] says why.
    pub fn open(config: Config) -> Host {
        let mut problems = Vec::new();
        let arch = Arch::host();
        let mut host = Host {
            arch,
            qemu: None,
            linux: None,
            windows: None,
            qemu_img: None,
            workspaces: None,
            problems: Vec::new(),
            virtiofs: false,
            huge_pages: false,
            #[cfg(target_os = "linux")]
            cgroups: None,
            config,
        };
        if !cfg!(target_os = "linux") {
            problems.push("virtual machines need a Linux host with KVM".into());
            host.problems = problems;
            return host;
        }
        let Some(arch) = arch else {
            problems.push(format!(
                "no machines for this host's architecture ({})",
                std::env::consts::ARCH
            ));
            host.problems = problems;
            return host;
        };
        if let Err(e) = kvm() {
            problems.push(e);
            host.problems = problems;
            return host;
        }
        host.qemu = find(host.config.qemu.as_deref(), arch.qemu());
        if host.qemu.is_none() {
            problems.push(format!(
                "{} is not installed (QEMU 8.2 or later)",
                arch.qemu()
            ));
            host.problems = problems;
            return host;
        }
        host.virtiofs = host.qemu.as_deref().is_some_and(has_virtiofs);
        host.huge_pages = lends_huge_pages();
        #[cfg(target_os = "linux")]
        if host.config.burst.is_some() {
            match iwci_sandbox::cgroup::Jobs::delegated() {
                Ok(jobs) => host.cgroups = Some(jobs),
                Err(e) => problems.push(format!(
                    "machines keep to their `cpus:`: no cgroup subtree to weigh them in ({e})"
                )),
            }
        }
        if host.virtiofs && !host.huge_pages {
            problems.push(
                "Linux: machines boot slower: the host lends no 2 MiB huge pages (vm.nr_overcommit_hugepages)"
                    .into(),
            );
        }
        if !host.virtiofs {
            problems.push(
                "Linux: /tmp/workflow is copied into each machine and back: this QEMU has no vhost-user-fs-device"
                    .into(),
            );
        }
        match LinuxImage::open(&host.config.dir.join("linux"), arch.name()) {
            Ok(image) => match find(host.config.mkfs_erofs.as_deref(), "mkfs.erofs") {
                Some(mkfs) => {
                    host.workspaces = Some(Workspaces::new(
                        host.config.cache.join("workspaces"),
                        mkfs,
                        host.config.workspace_cache_bytes,
                    ));
                    host.linux = Some(image);
                }
                None => problems
                    .push("Linux: mkfs.erofs is not installed (erofs-utils 1.7 or later)".into()),
            },
            Err(e) => problems.push(format!("Linux: {e}")),
        }
        // Windows machines are turned off until one has run on a real host
        // (`iwci_spec::VmOs::enabled`): the runner never opens their image,
        // so it never offers `windows`. Turning them on opens it here with
        // `WindowsImage::open` and `qemu-img`, as Linux's above.
        host.problems = problems;
        host
    }

    /// Whether a Linux machine's own files are streamed in over virtio-fs:
    /// QEMU has the device and the image's agent mounts it at boot.
    fn streams_files(&self) -> bool {
        self.virtiofs
            && self
                .linux
                .as_ref()
                .is_some_and(|image| image.info.features.iter().any(|f| f == FILES_FEATURE))
    }

    /// The uid a Linux machine runs scripts as: the image's job user when
    /// its agent has one and the job's files are streamed in, since those
    /// are then served as that user's, so the job can write them. `None`
    /// (root) otherwise, as with every image before the job user.
    fn job_user(&self) -> Option<u32> {
        (self.streams_files()
            && self.linux.as_ref().is_some_and(|image| {
                image
                    .info
                    .features
                    .iter()
                    .any(|f| f == iwci_vm_proto::JOB_USER_FEATURE)
            }))
        .then_some(iwci_vm_proto::JOB_UID)
    }

    /// Whether a Linux machine whose files are streamed in is also given
    /// its own files (what it has beyond the workspace: restored caches,
    /// artifacts, what it is lent) up front: the image keeps its writable
    /// layer in memory, with swap behind it.
    fn puts_own_files(&self) -> bool {
        self.streams_files()
            && self.linux.as_ref().is_some_and(|image| {
                image
                    .info
                    .features
                    .iter()
                    .any(|f| f == iwci_vm_proto::MEMORY_UPPER_FEATURE)
            })
    }

    /// The vCPUs a Linux machine gets: its job's `cpus:`, or more when it
    /// may burst into a weighted cgroup ([`Burst`]).
    fn linux_vcpus(&self, job: &Job<'_>) -> u32 {
        let cpus = job.cpus.unwrap_or(self.config.cpus);
        match (self.config.burst, self.bursts()) {
            (Some(burst), true) => burst_vcpus(cpus, job.memory_bytes, burst.host_cpus),
            _ => cpus,
        }
    }

    /// Whether Linux machines run in weighted cgroups of their own.
    fn bursts(&self) -> bool {
        #[cfg(target_os = "linux")]
        return self.cgroups.is_some();
        #[cfg(not(target_os = "linux"))]
        false
    }

    /// The kinds of machine it can start.
    pub fn platforms(&self) -> Vec<Os> {
        let mut out = Vec::new();
        if self.linux.is_some() {
            out.push(Os::Linux);
        }
        if self.windows.is_some() {
            out.push(Os::Windows);
        }
        out
    }

    /// The image of `os`'s name (`ubuntu-24.04`) and the caches it
    /// declares, when the runner has that image.
    pub fn caches(&self, os: Os) -> Option<(&str, &[crate::images::ImageCache])> {
        let info = match os {
            Os::Linux => &self.linux.as_ref()?.info,
            Os::Windows => &self.windows.as_ref()?.info,
        };
        Some((info.image.as_str(), info.caches.as_slice()))
    }

    /// Why a kind of machine is not offered, for the runner's log.
    pub fn problems(&self) -> &[String] {
        &self.problems
    }

    /// What a machine of `os` takes beyond its memory.
    pub fn overhead(&self, os: Os) -> u64 {
        match os {
            Os::Linux => LINUX_OVERHEAD,
            Os::Windows => WINDOWS_OVERHEAD,
        }
    }

    /// Runs `job` in a fresh machine. An `Err` is the runner's failure
    /// (the machine did not start, the agent broke off): the job is not
    /// to blame and its report says so.
    pub fn run(&self, job: Job<'_>) -> Result<Outcome, String> {
        let dir =
            self.config
                .cache
                .join("machines")
                .join(format!("{}-{}", sanitise(job.id), unique()));
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let result = self.run_in(&dir, job);
        let _ = std::fs::remove_dir_all(&dir);
        result
    }

    fn run_in(&self, dir: &Path, job: Job<'_>) -> Result<Outcome, String> {
        let arch = self.arch.ok_or("no machines on this host")?;
        let qemu_bin = self.qemu.as_ref().ok_or("QEMU is not installed")?;
        let started = Instant::now();
        // `IWCI_BOOT_TIMES=1`: when each step of a machine's start ended,
        // from the start of `run_in`, on stderr.
        let times = std::env::var_os("IWCI_BOOT_TIMES").is_some();
        let mark = |step: &str| {
            if times {
                eprintln!(
                    "iwci: machine {}: {step} at {} ms",
                    job.id,
                    started.elapsed().as_millis()
                );
            }
        };
        let memory_mib = job.memory_bytes.div_ceil(1 << 20);
        let user = if job.os == Os::Linux {
            self.job_user()
        } else {
            None
        };
        // What the machine is shown its files as owned by: the job user's,
        // or root's.
        #[cfg(target_os = "linux")]
        let owner = user.map_or((0, 0), |uid| (uid, uid));
        let sockets = Sockets {
            agent: dir.join("agent.sock"),
            // A Windows machine's saved state has a network device, so it
            // always gets a link; one without a network gets a dead end.
            net: (job.network || job.os == Os::Windows).then(|| dir.join("net.sock")),
            console: dir.join("console.log"),
            scratch: (cfg!(target_os = "linux")
                && job.os == Os::Linux
                && self.virtiofs
                && job.scratch.live.is_some())
            .then(|| dir.join("scratch.sock")),
            files: (cfg!(target_os = "linux") && job.os == Os::Linux && self.streams_files())
                .then(|| dir.join("files.sock")),
        };
        // A sparse file per job becomes the guest's ext4 writable layer.
        // `run` removes the machine's directory, and the disk with it.
        let scratch_disk = if cfg!(target_os = "linux") && job.os == Os::Linux {
            let path = dir.join("scratch.img");
            let file =
                std::fs::File::create(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            file.set_len(SCRATCH_DISK_BYTES)
                .map_err(|e| format!("resizing {}: {e}", path.display()))?;
            Some(path)
        } else {
            None
        };
        let agent_listener = listen(&sockets.agent)?;
        let net_listener = sockets.net.as_deref().map(listen).transpose()?;
        // Shared memory in huge pages when the host lends them, else in
        // 4 KiB pages: tried in that order (`qemu::linux_args`).
        let shared = sockets.scratch.is_some() || sockets.files.is_some();
        let tries: Vec<bool> = if shared && self.huge_pages {
            vec![true, false]
        } else {
            vec![false]
        };

        // The arguments for each try, and how long the machine has to say
        // hello.
        let (attempts, boot): (Vec<(Vec<OsString>, bool)>, Duration) = match job.os {
            Os::Linux => {
                let image = self
                    .linux
                    .as_ref()
                    .ok_or("this runner has no Linux image")?;
                let workspace = match job.workspace {
                    // Streamed in instead (`sockets.files`).
                    Some(_) if sockets.files.is_some() => None,
                    Some((key, snapshot)) => self
                        .workspaces
                        .as_ref()
                        .ok_or("no workspace images")?
                        .image(key, snapshot)?,
                    None => None,
                };
                let attempts = tries
                    .iter()
                    .map(|&huge_pages| {
                        let args = qemu::linux_args(&qemu::Linux {
                            arch,
                            kernel: &image.kernel,
                            rootfs: &image.rootfs,
                            workspace: workspace.as_deref(),
                            scratch_disk: scratch_disk.as_deref(),
                            // Huge pages come whole.
                            memory_mib: if huge_pages {
                                memory_mib.div_ceil(2) * 2
                            } else {
                                memory_mib
                            },
                            cpus: self.linux_vcpus(&job),
                            sockets: &sockets,
                            huge_pages,
                            user,
                        });
                        (args, huge_pages)
                    })
                    .collect();
                (attempts, LINUX_BOOT)
            }
            Os::Windows => {
                let image = self
                    .windows
                    .as_ref()
                    .ok_or("this runner has no Windows image")?;
                let cpus = job.cpus.unwrap_or(self.config.cpus).max(2);
                let restore = image.state(memory_mib, cpus);
                // A restored machine's disk goes on its state's own disk,
                // which holds what that boot wrote; a cold boot's on the
                // installed system.
                let base = restore.as_ref().map_or(&image.disk, |r| &r.disk);
                let disk = dir.join("disk.qcow2");
                let made = Command::new(self.qemu_img.as_ref().ok_or("qemu-img is missing")?)
                    .args(["create", "-q", "-f", "qcow2", "-F", "qcow2", "-b"])
                    .arg(base)
                    .arg(&disk)
                    .stdin(Stdio::null())
                    .output()
                    .map_err(|e| format!("qemu-img: {e}"))?;
                if !made.status.success() {
                    return Err(format!(
                        "qemu-img: {}",
                        String::from_utf8_lossy(&made.stderr).trim()
                    ));
                }
                let vars = dir.join("efi-vars.fd");
                std::fs::copy(&image.vars, &vars).map_err(|e| format!("UEFI variables: {e}"))?;
                let args = qemu::windows_args(&qemu::Windows {
                    machine: image.machine(),
                    firmware: &image.firmware,
                    vars: &vars,
                    disk: &disk,
                    memory_mib,
                    cpus,
                    sockets: &sockets,
                    incoming: restore.as_ref().map(|r| r.state.as_path()),
                });
                (
                    vec![(args, false)],
                    if restore.is_some() {
                        WINDOWS_RESTORE
                    } else {
                        WINDOWS_BOOT
                    },
                )
            }
        };

        // Listening before QEMU starts, and stopped after it has (they are
        // dropped after `machine`); started again for a second try, since
        // each takes one connection.
        #[cfg(target_os = "linux")]
        let mut _serving: Option<crate::virtiofs::Serving> = None;
        // The job's own files, read only: the machine writes to its
        // overlay above them, and what it left is collected as before.
        #[cfg(target_os = "linux")]
        let mut _serving_files: Option<crate::virtiofs::Serving> = None;
        // A Linux machine whose files are streamed in is given its own
        // files (restored caches, artifacts, what it is lent) up front when
        // the image keeps its writable layer in memory: a restored cache is
        // read whole (a package store is tens of thousands of files), and
        // over virtio-fs each one is round trips to the runner, so a pnpm
        // install from a restored store took longer than downloading it.
        // Up to half the job's memory; more is left to be streamed. Those
        // put are then not served too, so the agent's read-ahead spends
        // itself on the workspace.
        let mut put_own = if job.os == Os::Linux && sockets.files.is_some() && self.puts_own_files()
        {
            let own = archive::own(job.fs);
            (archive::file_bytes(&own) <= job.memory_bytes / 2).then_some(own)
        } else {
            None
        };
        let deadline = started + boot.min(job.timeout + boot);
        let mut fell_back = None;
        let mut launched = None;
        for (n, (args, huge_pages)) in attempts.iter().enumerate() {
            #[cfg(target_os = "linux")]
            {
                _serving = None;
                _serving_files = None;
                _serving = match (&sockets.scratch, &job.scratch.live) {
                    (Some(path), Some(fs)) => Some(crate::virtiofs::Serving::start(
                        fs.clone(),
                        job.scratch.files.modes(),
                        owner,
                        path,
                    )?),
                    _ => None,
                };
                _serving_files = match (&sockets.files, &put_own, job.workspace) {
                    (Some(path), Some(_), Some((_, workspace))) => {
                        Some(crate::virtiofs::Serving::start_read_only(
                            workspace.read_only(),
                            job.fs.modes(),
                            owner,
                            path,
                        )?)
                    }
                    (Some(path), _, _) => Some(crate::virtiofs::Serving::start_read_only(
                        job.fs.as_dyn(),
                        job.fs.modes(),
                        owner,
                        path,
                    )?),
                    (None, _, _) => None,
                };
            }
            let log = std::fs::File::create(dir.join("qemu.log"))
                .map_err(|e| format!("the emulator's log: {e}"))?;
            mark("set up");
            let mut args = args.clone();
            if times && let Some(at) = args.iter().position(|a| a == "-append") {
                // The agent's own steps on the console (`init::mark`).
                args[at + 1].push(" iwci.times");
            }
            let child = Command::new(qemu_bin)
                .args(&args)
                .stdin(Stdio::null())
                .stdout(log.try_clone().map_err(|e| e.to_string())?)
                .stderr(log)
                .spawn()
                .map_err(|e| format!("{}: {e}", qemu_bin.display()))?;
            // In a cgroup of its own, weighted by the CPUs its job holds,
            // when it may use more than those ([`Burst`]).
            #[cfg(target_os = "linux")]
            let cgroup = match (&self.cgroups, self.config.burst, job.os) {
                (Some(jobs), Some(burst), Os::Linux) => {
                    let cpus = job.cpus.unwrap_or(self.config.cpus).max(1);
                    let made = jobs
                        .create_weighted(
                            &format!("vm-{}", unique()),
                            burst.weight_per_cpu.saturating_mul(u64::from(cpus)),
                        )
                        .and_then(|cgroup| {
                            cgroup.add(child.id() as libc::pid_t)?;
                            Ok(cgroup)
                        });
                    match made {
                        Ok(cgroup) => Some(cgroup),
                        Err(e) => {
                            eprintln!("iwci: machine {}: no cgroup of its own: {e}", job.id);
                            None
                        }
                    }
                }
                _ => None,
            };
            let mut machine = Machine {
                child,
                dir: dir.to_path_buf(),
                bridge: Vec::new(),
                #[cfg(target_os = "linux")]
                gateway: None,
                #[cfg(target_os = "linux")]
                _cgroup: cgroup,
            };
            mark("started QEMU");
            // Everything up to the agent's hello: QEMU connects its sockets
            // before it maps the guest's memory, so a machine that could
            // not have its huge pages still connects, then goes.
            let mut start = || -> Result<_, String> {
                let agent_stream = machine.accept(&agent_listener, deadline, job.cancelled)?;
                mark("agent port connected");
                if let Some(listener) = &net_listener {
                    let stream = machine.accept(listener, deadline, job.cancelled)?;
                    self.connect_link(&mut machine, stream, job.network)?;
                    mark("network linked");
                }
                let reader = agent_stream.try_clone().map_err(|e| e.to_string())?;
                let mut agent = Agent::start(reader, agent_stream).map_err(|e| e.to_string())?;
                let left = deadline.saturating_duration_since(Instant::now());
                let hello = agent
                    .hello(left.max(Duration::from_secs(5)))
                    .map_err(|e| machine.failed(e))?;
                Ok((agent, hello))
            };
            match start() {
                Ok((agent, hello)) => {
                    launched = Some((machine, agent, hello));
                    break;
                }
                // Huge pages the host could not give: the same machine in
                // ordinary pages.
                Err(e) if *huge_pages && n + 1 < attempts.len() && exits(&mut machine.child) => {
                    fell_back = Some(e);
                }
                Err(e) => return Err(e),
            }
        }
        let (mut machine, mut agent, hello) = launched.ok_or("the machine did not start")?;
        if times {
            let console = std::fs::read_to_string(dir.join("console.log")).unwrap_or_default();
            for line in console.lines().filter(|l| l.contains("of uptime")) {
                eprintln!("iwci: machine {}: {line}", job.id);
            }
        }
        if hello.protocol != PROTOCOL {
            return Err(format!(
                "the machine's agent speaks protocol {}, this runner {PROTOCOL}: the image needs rebuilding with this runner's agent",
                hello.protocol
            ));
        }
        let mut outcome = Outcome {
            image: hello.image.clone(),
            arch: hello.arch.clone(),
            boot_ms: {
                mark("hello");
                started.elapsed().as_millis() as u64
            },
            ..Default::default()
        };
        if let Some(why) = fell_back {
            outcome.notes.push(format!(
                "the machine started without huge pages, which the host could not give ({}); it boots slower so",
                why.lines().next().unwrap_or_default()
            ));
        }
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        // Served, when the device is there and the agent can mount it; an
        // older image's agent gets the copy.
        let live = sockets.scratch.is_some() && hello.virtiofs;
        agent
            .setup(
                Setup {
                    protocol: PROTOCOL,
                    time_ms: now_ms,
                    hostname: "iwci".into(),
                    network: job.network.then(Network::standard),
                    scratch: live.then(|| ScratchMount {
                        tag: SCRATCH_TAG.into(),
                        at: job.scratch_at.into(),
                    }),
                },
                STEP,
            )
            .map_err(|e| machine.failed(e))?;

        // The job's files: on Linux what it has beyond the workspace image
        // (artifacts it was handed, what it is lent, caches it restored),
        // on Windows everything. The run's scratch either way.
        let transfer = Instant::now();
        let files = match job.os {
            // Streamed in: nothing to send but what is put up front.
            Os::Linux if sockets.files.is_some() => {
                // Served whole when there is no workspace to serve alone.
                if job.workspace.is_some() {
                    put_own.take().unwrap_or_default()
                } else {
                    Vec::new()
                }
            }
            Os::Linux => archive::own(job.fs),
            Os::Windows => archive::whole(job.fs),
        };
        if live {
            if !files.is_empty() {
                agent
                    .put(&[("/", &files)], STEP)
                    .map_err(|e| machine.failed(e))?;
            }
        } else {
            (job.scratch.settle)()?;
            let scratch = archive::whole(job.scratch.files);
            agent
                .put(&[("/", &files), (job.scratch_at, &scratch)], STEP)
                .map_err(|e| machine.failed(e))?;
        }
        let mut transfer_ms = transfer.elapsed().as_millis() as u64;

        // The script, until it ends or is stopped.
        let env = match job.os {
            Os::Linux => job.env.clone(),
            Os::Windows => windows_env(job.env.clone()),
        };
        let run_started = Instant::now();
        let run_deadline = run_started + job.timeout;
        let pid = machine.child.id();
        let mut last_progress = Instant::now();
        let mut last_cpu = qemu::cpu_ms(pid).unwrap_or(0);
        let mut last_cpu_at = Instant::now();
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut stop: Option<&'static str> = None;
        let ran = agent.exec(
            Exec {
                shell: job.shell,
                script: job.script.into(),
                env,
                cwd: job.cwd.into(),
            },
            Duration::from_millis(500),
            &mut |tick| {
                if let Tick::Output(err, data) = tick {
                    let buf = if err { &mut stderr } else { &mut stdout };
                    let room = job.output_cap.saturating_sub(buf.len());
                    buf.extend_from_slice(&data[..data.len().min(room)]);
                    if let Some(out) = job.output {
                        out(err, data);
                    }
                    last_progress = Instant::now();
                }
                if (job.cancelled)() {
                    stop = Some("cancelled");
                    return Watch::Stop;
                }
                if Instant::now() >= run_deadline {
                    stop = Some("timeout");
                    return Watch::Stop;
                }
                if let Some(stall) = job.stall_after {
                    // The machine's CPU time moving counts as progress: a
                    // compile prints nothing for minutes. An idle machine
                    // still spends a little on its timers, so it has to
                    // move by more than 2% of the time that passed.
                    if last_cpu_at.elapsed() >= Duration::from_secs(5) {
                        let cpu = qemu::cpu_ms(pid).unwrap_or(last_cpu);
                        let wall = last_cpu_at.elapsed().as_millis() as u64;
                        if cpu.saturating_sub(last_cpu) * 50 > wall {
                            last_progress = Instant::now();
                        }
                        last_cpu = cpu;
                        last_cpu_at = Instant::now();
                    }
                    if last_progress.elapsed() >= stall {
                        stop = Some("stalled");
                        return Watch::Stop;
                    }
                }
                Watch::Continue
            },
        );
        outcome.cpu_ms = qemu::cpu_ms(pid).unwrap_or(0);
        let text = |b: &[u8]| String::from_utf8_lossy(b).into_owned();
        outcome.stdout = text(&stdout);
        outcome.stderr = text(&stderr);
        match ran.map_err(|e| machine.failed(e))? {
            Ran::Stopped => {
                match stop {
                    Some("cancelled") => outcome.cancelled = true,
                    Some("stalled") => {
                        outcome.stalled_after = job.stall_after.map(|d| d.as_secs());
                    }
                    _ => outcome.timed_out = true,
                }
                outcome.notes.push(
                    "the machine was stopped, so nothing it wrote was kept (artifacts, downloads, caches and `/tmp/workflow`)"
                        .into(),
                );
                outcome.transfer_ms = transfer_ms;
                return Ok(outcome);
            }
            Ran::Exited(exited) => outcome.exited = Some(exited),
        }

        // What it left, for the scheduler to read as any job's files.
        let back = Instant::now();
        let mut paths: Vec<String> = job.collect.to_vec();
        if !live {
            paths.push(job.scratch_at.to_string());
        }
        let (collected, entries, done) = agent
            .collect(
                Collect {
                    paths,
                    repository: job.repository.map(str::to_owned),
                    // Its files are held to its memory, as any job's are,
                    // and the scratch to the run's room on top.
                    max_bytes: job.memory_bytes.saturating_mul(2),
                },
                STEP,
            )
            .map_err(|e| machine.failed(e))?;
        if done.truncated {
            outcome
                .notes
                .push("what the job left was cut short at twice its memory".into());
        }
        let scratch_at = Path::new(job.scratch_at);
        for path in collected.deleted {
            let path = PathBuf::from(path);
            match path.strip_prefix(scratch_at) {
                Ok(rest) => outcome.scratch.deleted.push(Path::new("/").join(rest)),
                Err(_) => outcome.files.deleted.push(path),
            }
        }
        for (entry, mode) in entries {
            match rebase(&entry, scratch_at) {
                Some(inside) => outcome.scratch.entries.push((inside, mode)),
                None if is_parent(&entry, scratch_at) => {}
                None => outcome.files.entries.push((entry, mode)),
            }
        }
        if !hello.modes {
            // Windows has no Unix modes to give: each file keeps its own.
            for (_, mode) in outcome
                .files
                .entries
                .iter_mut()
                .chain(outcome.scratch.entries.iter_mut())
            {
                *mode = None;
            }
        }
        transfer_ms += back.elapsed().as_millis() as u64;
        outcome.transfer_ms = transfer_ms;
        agent.shutdown();
        Ok(outcome)
    }

    #[cfg(target_os = "linux")]
    fn connect_link(
        &self,
        machine: &mut Machine,
        stream: std::os::unix::net::UnixStream,
        network: bool,
    ) -> Result<(), String> {
        match (&self.config.outside, network) {
            (Some(outside), true) => {
                let (gateway, link) =
                    iwci_sandbox::net::Gateway::start(iwci_sandbox::net::Network {
                        outside: outside.clone(),
                        services: Vec::new(),
                    })
                    .map_err(|e| format!("the machine's network: {e}"))?;
                machine.gateway = Some(gateway);
                machine.bridge = crate::link::bridge::start(stream, link)
                    .map_err(|e| format!("the machine's network: {e}"))?;
            }
            _ => {
                machine.bridge = vec![
                    crate::link::bridge::sink(stream)
                        .map_err(|e| format!("the machine's network: {e}"))?,
                ];
            }
        }
        Ok(())
    }

    #[cfg(not(target_os = "linux"))]
    fn connect_link(
        &self,
        _machine: &mut Machine,
        _stream: std::os::unix::net::UnixStream,
        _network: bool,
    ) -> Result<(), String> {
        Err("virtual machines need a Linux host".into())
    }
}

/// A running emulator, stopped and cleaned up when dropped.
struct Machine {
    child: Child,
    dir: PathBuf,
    bridge: Vec<std::thread::JoinHandle<()>>,
    #[cfg(target_os = "linux")]
    gateway: Option<iwci_sandbox::net::Gateway>,
    /// Its weighted cgroup, removed once the emulator is gone (killed
    /// first, in `drop`, before the fields are).
    #[cfg(target_os = "linux")]
    _cgroup: Option<iwci_sandbox::cgroup::Cgroup>,
}

impl Machine {
    /// Accepts QEMU's connection to `listener` by `deadline`, giving up as
    /// soon as QEMU exits or the job is cancelled.
    fn accept(
        &mut self,
        listener: &std::os::unix::net::UnixListener,
        deadline: Instant,
        cancelled: &(dyn Fn() -> bool + Sync),
    ) -> Result<std::os::unix::net::UnixStream, String> {
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    stream.set_nonblocking(false).map_err(|e| e.to_string())?;
                    return Ok(stream);
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(e.to_string()),
            }
            if let Ok(Some(status)) = self.child.try_wait() {
                return Err(format!(
                    "the emulator exited ({status}) before the machine started{}",
                    self.tail()
                ));
            }
            if cancelled() {
                return Err("the run was cancelled while the machine started".into());
            }
            if Instant::now() >= deadline {
                return Err(format!("the machine did not start in time{}", self.tail()));
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    /// The end of the emulator's and the console's logs, for an error.
    fn tail(&self) -> String {
        let mut out = String::new();
        for name in ["qemu.log", "console.log"] {
            let Ok(text) = std::fs::read_to_string(self.dir.join(name)) else {
                continue;
            };
            let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
            let start = lines.len().saturating_sub(12);
            if start < lines.len() {
                out.push_str(&format!("\n{name}:\n{}", lines[start..].join("\n")));
            }
        }
        out
    }

    /// An agent failure as the runner's error, with the logs.
    fn failed(&mut self, e: Failed) -> String {
        let _ = self.child.kill();
        let _ = self.child.wait();
        format!("{e}{}", self.tail())
    }
}

impl Drop for Machine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        #[cfg(target_os = "linux")]
        if let Some(mut gateway) = self.gateway.take() {
            gateway.stop();
        }
        for pump in self.bridge.drain(..) {
            let _ = pump.join();
        }
    }
}

fn listen(path: &Path) -> Result<std::os::unix::net::UnixListener, String> {
    let _ = std::fs::remove_file(path);
    std::os::unix::net::UnixListener::bind(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// The job's variables as a Windows job sees them: its two runner paths
/// on the system drive, and no `HOME` (the runner's `/root`); Windows has
/// its own.
pub fn windows_env(env: Vec<(String, String)>) -> Vec<(String, String)> {
    env.into_iter()
        .filter(|(k, _)| k != "HOME")
        .map(|(k, v)| {
            if (k == "IWCI_OUTPUT" || k == "IWCI_SCRATCH") && v.starts_with('/') {
                let mapped = iwci_vm_proto::windows_path(&v);
                (k, mapped)
            } else {
                (k, v)
            }
        })
        .collect()
}

/// `entry` moved from under `at` to under `/`, or `None` when it is not
/// under `at`.
fn rebase(entry: &iwci_vfs::Entry, at: &Path) -> Option<iwci_vfs::Entry> {
    use iwci_vfs::Entry;
    let moved = |path: &Path| path.strip_prefix(at).ok().map(|r| Path::new("/").join(r));
    Some(match entry {
        Entry::Dir { path } => Entry::Dir { path: moved(path)? },
        Entry::File { path, data } => Entry::File {
            path: moved(path)?,
            data: data.clone(),
        },
        Entry::Symlink { path, target } => Entry::Symlink {
            path: moved(path)?,
            target: target.clone(),
        },
    })
}

/// A directory on the way to `at` (`/tmp` for `/tmp/workflow`).
fn is_parent(entry: &iwci_vfs::Entry, at: &Path) -> bool {
    matches!(entry, iwci_vfs::Entry::Dir { path } if at.starts_with(path))
}

fn sanitise(id: &str) -> String {
    id.chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .take(48)
        .collect()
}

fn unique() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!(
        "{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_windows_job_sees_its_runner_paths_on_the_system_drive() {
        let env = windows_env(vec![
            ("HOME".into(), "/root".into()),
            ("IWCI_OUTPUT".into(), "/iwci/output".into()),
            ("IWCI_SCRATCH".into(), "/tmp/workflow".into()),
            ("OTHER".into(), "/app".into()),
        ]);
        assert_eq!(
            env,
            [
                ("IWCI_OUTPUT".to_string(), "C:\\iwci\\output".to_string()),
                ("IWCI_SCRATCH".to_string(), "C:\\tmp\\workflow".to_string()),
                ("OTHER".to_string(), "/app".to_string()),
            ]
        );
    }

    #[test]
    fn scratch_entries_are_rebased_and_their_parents_dropped() {
        use iwci_vfs::Entry;
        let at = Path::new("/tmp/workflow");
        let file = Entry::File {
            path: "/tmp/workflow/a/b".into(),
            data: b"x".to_vec().into(),
        };
        assert_eq!(
            rebase(&file, at),
            Some(Entry::File {
                path: "/a/b".into(),
                data: b"x".to_vec().into()
            })
        );
        assert_eq!(
            rebase(
                &Entry::Dir {
                    path: "/app".into()
                },
                at
            ),
            None
        );
        assert!(is_parent(
            &Entry::Dir {
                path: "/tmp".into()
            },
            at
        ));
        assert!(!is_parent(
            &Entry::Dir {
                path: "/app".into()
            },
            at
        ));
    }

    /// A machine gets up to four times its `cpus:` in vCPUs, one per GiB
    /// of its memory, never fewer than its `cpus:` and never more than the
    /// host has.
    #[test]
    fn a_machine_bursts_to_what_its_memory_can_feed() {
        let gib = 1u64 << 30;
        assert_eq!(burst_vcpus(2, 6 * gib, 64), 6);
        assert_eq!(burst_vcpus(2, 16 * gib, 64), 8, "four times its cpus");
        assert_eq!(burst_vcpus(2, 2 * gib, 64), 2);
        assert_eq!(burst_vcpus(4, 2 * gib, 64), 4, "never below its cpus");
        assert_eq!(burst_vcpus(1, gib / 2, 64), 1);
        assert_eq!(burst_vcpus(8, 64 * gib, 12), 12, "the host's CPUs");
        assert_eq!(burst_vcpus(0, 0, 64), 1);
    }

    #[test]
    fn a_host_without_kvm_offers_nothing_and_says_why() {
        let host = Host::open(Config {
            dir: "/nonexistent".into(),
            cache: std::env::temp_dir(),
            qemu: None,
            qemu_img: None,
            mkfs_erofs: None,
            cpus: 2,
            workspace_cache_bytes: 1 << 30,
            burst: None,
            #[cfg(target_os = "linux")]
            outside: None,
        });
        if std::path::Path::new("/dev/kvm").exists() {
            // A host with KVM still has no images under /nonexistent.
            assert!(host.platforms().is_empty());
        } else {
            assert!(host.platforms().is_empty());
            assert!(!host.problems().is_empty());
        }
    }
}
