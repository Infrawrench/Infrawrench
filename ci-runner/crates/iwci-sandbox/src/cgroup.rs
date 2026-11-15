//! A cgroup per sandbox: what holds a native job to its `memory:` and
//! counts what it used.
//!
//! The Sentry keeps all of a job's memory in one shared memory file, which
//! the kernel would rather swap than refuse: with the cgroup's `memory.max`
//! at the job's limit and swap left on, a job that filled 2 GiB under a
//! 512 MiB limit finished with exit 0 and the host's swap 1.5 GiB fuller.
//! So `memory.swap.max` is 0, and an allocation past the limit kills the
//! sandbox (`memory.events`' `oom_kill`), which the runner reports as the
//! job running out of memory. `pids.max` bounds what it can fork, and
//! `cpu.stat`'s `usage_usec` is its CPU time, for billing and the stall
//! check.
//!
//! The runner needs a cgroup subtree of its own to make these in: systemd
//! gives it one with `Delegate=` (`infra/ci-runners`). A cgroup with
//! processes in it may not have children with controllers enabled, so the
//! runner first moves itself (and anything else the service started) into
//! a leaf, `runner/`, beside `jobs/`, under which each sandbox gets one
//! (`Jobs::delegated`).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const ROOT: &str = "/sys/fs/cgroup";
/// The controllers a sandbox's cgroup uses.
const CONTROLLERS: &[&str] = &["memory", "pids", "cpu"];

/// Where the runner makes sandboxes' cgroups.
#[derive(Debug, Clone)]
pub struct Jobs {
    dir: PathBuf,
}

/// What one sandbox may use.
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    /// `memory.max`, bytes. Swap is always 0.
    pub memory: u64,
    /// `pids.max`: threads and processes of the Sentry and the job's own
    /// (which are the Sentry's to count, not the host's).
    pub pids: u64,
}

/// What a sandbox used, read from its cgroup.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    /// `memory.current`, bytes.
    pub memory: u64,
    /// `memory.peak`, bytes.
    pub memory_peak: u64,
    /// The kernel killed something in it for memory (`oom_kill`).
    pub out_of_memory: bool,
    /// CPU time, microseconds (`usage_usec`).
    pub cpu_usec: u64,
}

impl Jobs {
    /// The runner's own delegated subtree, made ready: the runner moved
    /// into `runner/`, the controllers enabled for `jobs/`'s children.
    pub fn delegated() -> io::Result<Self> {
        let own = own_cgroup()?;
        let parent = if own.file_name().is_some_and(|n| n == "runner") {
            own.parent().map(Path::to_path_buf).unwrap_or(own)
        } else {
            // Out of the way, so the subtree can have controllers: the
            // runner and anything else the service started.
            let leaf = own.join("runner");
            mkdir(&leaf)?;
            for pid in fs::read_to_string(own.join("cgroup.procs"))?.split_whitespace() {
                match fs::write(leaf.join("cgroup.procs"), pid) {
                    // Gone in between.
                    Err(e) if e.raw_os_error() == Some(libc::ESRCH) => {}
                    other => other?,
                }
            }
            own
        };
        enable(&parent)?;
        let dir = parent.join("jobs");
        mkdir(&dir)?;
        enable(&dir)?;
        Ok(Self { dir })
    }

    /// A cgroup for one sandbox, `name` unique among those alive.
    pub fn create(&self, name: &str, limits: Limits) -> io::Result<Cgroup> {
        if name.is_empty() || name.contains('/') || name.starts_with('.') {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let path = self.dir.join(name);
        mkdir(&path)?;
        let cgroup = Cgroup { path };
        cgroup.write("memory.max", &limits.memory.to_string())?;
        cgroup.write("memory.swap.max", "0")?;
        // Kill the whole sandbox, not one of its threads, when it is out
        // of memory: the Sentry cannot carry on without a thread.
        cgroup.write("memory.oom.group", "1")?;
        cgroup.write("pids.max", &limits.pids.to_string())?;
        Ok(cgroup)
    }
}

/// One sandbox's cgroup. Dropping it kills what is left in it and removes
/// it.
#[derive(Debug)]
pub struct Cgroup {
    path: PathBuf,
}

impl Cgroup {
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Moves process `pid` (all its threads) in.
    pub fn add(&self, pid: libc::pid_t) -> io::Result<()> {
        self.write("cgroup.procs", &pid.to_string())
    }

    pub fn usage(&self) -> io::Result<Usage> {
        let read = |file: &str| -> io::Result<String> { fs::read_to_string(self.path.join(file)) };
        let number = |file: &str| -> io::Result<u64> {
            read(file)?
                .trim()
                .parse()
                .map_err(|_| io::Error::other(format!("{file} is not a number")))
        };
        let key = |text: &str, key: &str| -> u64 {
            text.lines()
                .find_map(|l| l.strip_prefix(key)?.strip_prefix(' ')?.trim().parse().ok())
                .unwrap_or(0)
        };
        Ok(Usage {
            memory: number("memory.current")?,
            memory_peak: number("memory.peak").unwrap_or(0),
            out_of_memory: key(&read("memory.events")?, "oom_kill") > 0,
            cpu_usec: key(&read("cpu.stat")?, "usage_usec"),
        })
    }

    /// Kills everything in it at once.
    pub fn kill(&self) -> io::Result<()> {
        self.write("cgroup.kill", "1")
    }

    /// Whether anything is still in it.
    pub fn populated(&self) -> bool {
        fs::read_to_string(self.path.join("cgroup.events"))
            .map(|e| e.lines().any(|l| l == "populated 1"))
            .unwrap_or(false)
    }

    fn write(&self, file: &str, value: &str) -> io::Result<()> {
        fs::write(self.path.join(file), value).map_err(|e| {
            io::Error::new(e.kind(), format!("{}: {e}", self.path.join(file).display()))
        })
    }
}

impl Drop for Cgroup {
    fn drop(&mut self) {
        let _ = self.kill();
        // The kernel empties it asynchronously.
        let until = Instant::now() + Duration::from_secs(10);
        while self.populated() && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(5));
        }
        let _ = fs::remove_dir(&self.path);
    }
}

/// The runner's cgroup (v2), as a path under `/sys/fs/cgroup`.
fn own_cgroup() -> io::Result<PathBuf> {
    let text = fs::read_to_string("/proc/self/cgroup")?;
    let rel = text
        .lines()
        .find_map(|l| l.strip_prefix("0::"))
        .ok_or_else(|| io::Error::other("no cgroup v2 hierarchy"))?;
    Ok(Path::new(ROOT).join(rel.trim_start_matches('/')))
}

fn mkdir(path: &Path) -> io::Result<()> {
    match fs::create_dir(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(()),
        Err(e) => Err(io::Error::new(e.kind(), format!("{}: {e}", path.display()))),
    }
}

/// Enables the controllers for `dir`'s children.
fn enable(dir: &Path) -> io::Result<()> {
    let have = fs::read_to_string(dir.join("cgroup.controllers"))?;
    let mut missing = Vec::new();
    for c in CONTROLLERS {
        if !have.split_whitespace().any(|h| h == *c) {
            missing.push(*c);
        }
    }
    if !missing.is_empty() {
        return Err(io::Error::other(format!(
            "{} is not delegated the {} controller(s)",
            dir.display(),
            missing.join(", ")
        )));
    }
    let wanted: Vec<String> = CONTROLLERS.iter().map(|c| format!("+{c}")).collect();
    fs::write(dir.join("cgroup.subtree_control"), wanted.join(" ")).map_err(|e| {
        io::Error::new(
            e.kind(),
            format!("enabling controllers in {}: {e}", dir.display()),
        )
    })
}
