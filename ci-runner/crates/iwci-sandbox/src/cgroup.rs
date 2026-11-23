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
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Usage {
    /// `memory.current`, bytes.
    pub memory: u64,
    /// `memory.peak`, bytes.
    pub memory_peak: u64,
    /// The kernel killed something in it for memory (`oom_kill`).
    pub out_of_memory: bool,
    /// CPU time, microseconds (`usage_usec`).
    pub cpu_usec: u64,
    /// How often an allocation met `memory.max` and had to reclaim
    /// (`memory.events`' `max`).
    pub limit_hits: u64,
}

/// How long a sandbox may sit at its memory limit, meeting it again and
/// again and burning CPU on it, before it counts as out of memory. The
/// kernel kills a sandbox past its limit when nothing can be reclaimed; one
/// whose memory can always be reclaimed a little (gVisor's own file cache)
/// can instead go on reclaiming for good, doing little else.
pub const RECLAIM_STUCK_AFTER: Duration = Duration::from_secs(10);

/// Over [`RECLAIM_STUCK_AFTER`] at the limit: at least this many more
/// `max` events...
const STUCK_HITS: u64 = 100;
/// ...and at least this share of one CPU's time, so a sandbox that only
/// sits at its limit, idle, is not stopped for it.
const STUCK_CPU_SHARE: f64 = 0.2;

/// Notices a sandbox that is stuck reclaiming at its memory limit (see
/// [`RECLAIM_STUCK_AFTER`]): at the limit for that long without a break,
/// meeting it again and again, and burning CPU all the while.
/// (`memory.pressure` would say so more directly, but stayed at 0 under
/// gVisor in every run at the limit.)
#[derive(Debug, Default)]
pub struct Reclaiming {
    /// When the sandbox reached its limit, with its `max` events and CPU
    /// time then.
    since: Option<(Instant, u64, u64)>,
}

impl Reclaiming {
    /// Takes a sample; true once the sandbox, held to `limit` bytes, has
    /// been stuck for [`RECLAIM_STUCK_AFTER`].
    pub fn stuck(&mut self, now: Instant, usage: &Usage, limit: u64) -> bool {
        let at_limit = usage.memory.saturating_add((limit / 64).min(4 << 20)) >= limit;
        if !at_limit {
            self.since = None;
            return false;
        }
        let (since, hits, cpu) = *self
            .since
            .get_or_insert((now, usage.limit_hits, usage.cpu_usec));
        let held = now.saturating_duration_since(since);
        if held < RECLAIM_STUCK_AFTER {
            return false;
        }
        let burned = usage.cpu_usec.saturating_sub(cpu) as f64 / 1e6;
        let stuck = usage.limit_hits.saturating_sub(hits) >= STUCK_HITS
            && burned >= held.as_secs_f64() * STUCK_CPU_SHARE;
        if !stuck {
            // A window that was not stuck starts the next one.
            self.since = Some((now, usage.limit_hits, usage.cpu_usec));
        }
        stuck
    }
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

    /// Holds every sandbox together to `cpus` CPUs' time (`cpu.max` on
    /// `jobs/`; none for no limit), which they share by equal weight, as a
    /// WASIX job's threads share the runner's.
    pub fn hold_cpus(&self, cpus: Option<u32>) -> io::Result<()> {
        const PERIOD: u64 = 100_000;
        let max = match cpus {
            Some(cpus) => format!("{} {PERIOD}", u64::from(cpus.max(1)) * PERIOD),
            None => format!("max {PERIOD}"),
        };
        let file = self.dir.join("cpu.max");
        fs::write(&file, max)
            .map_err(|e| io::Error::new(e.kind(), format!("{}: {e}", file.display())))
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

impl Jobs {
    /// A cgroup for one virtual machine, `name` unique among those alive,
    /// with CPU weight `weight` and no limits of its own: the machine's
    /// memory is fixed when it starts, and outside the memory controller
    /// in huge pages.
    pub fn create_weighted(&self, name: &str, weight: u64) -> io::Result<Cgroup> {
        if name.is_empty() || name.contains('/') || name.starts_with('.') {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        let path = self.dir.join(name);
        mkdir(&path)?;
        let cgroup = Cgroup { path };
        cgroup.set_cpu_weight(weight)?;
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

    /// Sets `cpu.weight` (1 to 10000, 100 by default): its share of the
    /// CPU time beside the other sandboxes when they want more than there
    /// is.
    pub fn set_cpu_weight(&self, weight: u64) -> io::Result<()> {
        self.write("cpu.weight", &weight.clamp(1, 10_000).to_string())
    }

    /// Changes `memory.max`: what the sandbox may hold from now on.
    pub fn set_memory_max(&self, bytes: u64) -> io::Result<()> {
        self.write("memory.max", &bytes.to_string())
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
        let events = read("memory.events")?;
        Ok(Usage {
            memory: number("memory.current")?,
            memory_peak: number("memory.peak").unwrap_or(0),
            out_of_memory: key(&events, "oom_kill") > 0,
            cpu_usec: key(&read("cpu.stat")?, "usage_usec"),
            limit_hits: key(&events, "max"),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn at(memory: u64, hits: u64, cpu_usec: u64) -> Usage {
        Usage {
            memory,
            limit_hits: hits,
            cpu_usec,
            ..Usage::default()
        }
    }

    /// A sandbox that sits at its limit, meeting it again and again and
    /// burning CPU on it, is out of memory after a while; one that only
    /// passes by the limit, or sits there idle, is not.
    #[test]
    fn a_sandbox_stuck_reclaiming_at_its_limit_counts_as_out_of_memory() {
        const LIMIT: u64 = 256 << 20;
        let start = Instant::now();
        let step = |i: u64| start + Duration::from_millis(500 * i);
        // Reclaiming: 50 `max` events and half a CPU each half second.
        let mut r = Reclaiming::default();
        let stuck_at = (0..60u64)
            .find(|&i| r.stuck(step(i), &at(LIMIT - (1 << 20), i * 50, i * 250_000), LIMIT))
            .map(|i| step(i) - start)
            .expect("stuck");
        assert!(
            stuck_at >= RECLAIM_STUCK_AFTER
                && stuck_at < RECLAIM_STUCK_AFTER + Duration::from_secs(1),
            "{stuck_at:?}"
        );
        // At the limit and idle: not stuck.
        let mut r = Reclaiming::default();
        for i in 0..80u64 {
            assert!(!r.stuck(step(i), &at(LIMIT, i * 50, i * 1000), LIMIT));
        }
        // Busy at the limit without meeting it: not stuck.
        let mut r = Reclaiming::default();
        for i in 0..80u64 {
            assert!(!r.stuck(step(i), &at(LIMIT, 3, i * 500_000), LIMIT));
        }
        // A break under the limit starts the count again.
        let mut r = Reclaiming::default();
        for i in 0..80u64 {
            let memory = if i % 15 == 14 { LIMIT / 2 } else { LIMIT };
            assert!(!r.stuck(step(i), &at(memory, i * 50, i * 250_000), LIMIT));
        }
        // Under the limit, however busy: not this.
        let mut r = Reclaiming::default();
        for i in 0..80u64 {
            assert!(!r.stuck(step(i), &at(LIMIT / 2, i * 50, i * 500_000), LIMIT));
        }
    }
}
