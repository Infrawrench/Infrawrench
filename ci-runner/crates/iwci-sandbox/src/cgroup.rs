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
    /// `cpu.max`: at most this many CPUs' time, when set.
    pub cpus: Option<u32>,
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
    /// The share of the last ten seconds in which every task of the cgroup
    /// was stalled on memory (`memory.pressure`'s `full avg10`), percent.
    pub pressure_full: f64,
}

/// How long a sandbox may sit at its memory limit, every task stalled on
/// reclaim, before it counts as out of memory. The kernel kills a sandbox
/// past its limit when nothing can be reclaimed; one whose memory can
/// always be reclaimed a little (gVisor's own file cache) can instead go on
/// reclaiming for good, doing nothing else.
pub const RECLAIM_STUCK_AFTER: Duration = Duration::from_secs(10);

/// What `full avg10` above counts as stalled.
const STALLED_PRESSURE: f64 = 50.0;

/// Notices a sandbox that is stuck reclaiming at its memory limit (see
/// [`RECLAIM_STUCK_AFTER`]): at the limit, meeting it again and again, and
/// stalled on it, for that long without a break.
#[derive(Debug, Default)]
pub struct Reclaiming {
    since: Option<Instant>,
    hits: u64,
}

impl Reclaiming {
    /// Takes a sample; true once the sandbox, held to `limit` bytes, has
    /// been stuck for [`RECLAIM_STUCK_AFTER`].
    pub fn stuck(&mut self, now: Instant, usage: &Usage, limit: u64) -> bool {
        let at_limit = usage.memory.saturating_add((limit / 64).min(4 << 20)) >= limit;
        let meeting = usage.limit_hits > self.hits;
        self.hits = usage.limit_hits;
        if at_limit && meeting && usage.pressure_full >= STALLED_PRESSURE {
            let since = *self.since.get_or_insert(now);
            now.saturating_duration_since(since) >= RECLAIM_STUCK_AFTER
        } else {
            self.since = None;
            false
        }
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
        if let Some(cpus) = limits.cpus {
            const PERIOD: u64 = 100_000;
            cgroup.write(
                "cpu.max",
                &format!("{} {PERIOD}", u64::from(cpus.max(1)) * PERIOD),
            )?;
        }
        Ok(cgroup)
    }
}

/// `full avg10` of a `*.pressure` file.
fn full_avg10(text: &str) -> Option<f64> {
    text.lines()
        .find(|l| l.starts_with("full "))?
        .split_whitespace()
        .find_map(|f| f.strip_prefix("avg10="))?
        .parse()
        .ok()
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
            pressure_full: read("memory.pressure")
                .ok()
                .and_then(|p| full_avg10(&p))
                .unwrap_or(0.0),
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

    fn at(memory: u64, hits: u64, pressure: f64) -> Usage {
        Usage {
            memory,
            limit_hits: hits,
            pressure_full: pressure,
            ..Usage::default()
        }
    }

    /// A sandbox that sits at its limit, meeting it again and again with
    /// every task stalled, is out of memory after a while; one that only
    /// passes by the limit, or keeps working there (low pressure), is not.
    #[test]
    fn a_sandbox_stuck_reclaiming_at_its_limit_counts_as_out_of_memory() {
        const LIMIT: u64 = 256 << 20;
        let start = Instant::now();
        let mut r = Reclaiming::default();
        let mut hits = 0;
        let mut stuck_at = None;
        for i in 0..40u64 {
            hits += 50;
            let now = start + Duration::from_millis(500 * i);
            if r.stuck(now, &at(LIMIT - (1 << 20), hits, 95.0), LIMIT) {
                stuck_at = Some(now - start);
                break;
            }
        }
        let stuck_at = stuck_at.expect("stuck");
        assert!(
            stuck_at >= RECLAIM_STUCK_AFTER
                && stuck_at < RECLAIM_STUCK_AFTER + Duration::from_secs(1)
        );

        // Working at the limit, its cache reclaimed as it goes: not stuck.
        let mut r = Reclaiming::default();
        for i in 0..60u64 {
            let now = start + Duration::from_millis(500 * i);
            assert!(!r.stuck(now, &at(LIMIT, i * 50, 5.0), LIMIT));
        }
        // Stalled, but a break in between starts the count again.
        let mut r = Reclaiming::default();
        for i in 0..60u64 {
            let now = start + Duration::from_millis(500 * i);
            let memory = if i % 15 == 14 { LIMIT / 2 } else { LIMIT };
            assert!(!r.stuck(now, &at(memory, i * 50, 95.0), LIMIT));
        }
        // Under the limit, however stalled: not this.
        let mut r = Reclaiming::default();
        for i in 0..60u64 {
            let now = start + Duration::from_millis(500 * i);
            assert!(!r.stuck(now, &at(LIMIT / 2, i * 50, 95.0), LIMIT));
        }
    }

    #[test]
    fn pressure_is_read_from_its_full_line() {
        let text = "some avg10=12.50 avg60=3.00 avg300=1.00 total=123\nfull avg10=97.25 avg60=40.00 avg300=9.00 total=99\n";
        assert_eq!(full_avg10(text), Some(97.25));
        assert_eq!(
            full_avg10("some avg10=1.00 avg60=0 avg300=0 total=1\n"),
            None
        );
    }
}
