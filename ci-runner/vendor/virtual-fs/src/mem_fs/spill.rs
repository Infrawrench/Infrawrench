//! iwci patch: files that outgrow memory move to disk.
//!
//! A file system given a [`SpillConfig`] keeps its files' contents in memory
//! until, together, they pass `resident_max` bytes. Then the files read or
//! written least recently move, whole, to anonymous files in `dir` (made and
//! unlinked at once, so nothing is left behind if the process dies) until
//! what is in memory is back under three quarters of the limit. A file on
//! disk stays there until it is truncated to nothing, when it comes back to
//! memory; reads and writes of it go to the disk file, through the host's
//! page cache. Without a config, nothing changes: every file is in memory.

use std::fs::File as HostFile;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

/// Where files spill to, and how much of them may stay in memory.
#[derive(Debug, Clone)]
pub struct SpillConfig {
    /// A directory on the host's disk. Its files are unlinked as soon as
    /// they are made.
    pub dir: PathBuf,
    /// The most bytes of file contents kept in memory before the least
    /// recently used files move to disk.
    pub resident_max: u64,
}

/// What a spilling file system knows across its files.
#[derive(Debug)]
pub struct Spill {
    config: SpillConfig,
    /// Bytes of file contents in memory now.
    resident: AtomicU64,
    /// Bytes of file contents on disk now.
    spilled: AtomicU64,
    /// A logical clock: each read or write of a file stamps it.
    clock: AtomicU64,
    /// Names the disk files, which are unlinked at once.
    made: AtomicU64,
}

impl Spill {
    pub fn new(config: SpillConfig) -> Self {
        Self {
            config,
            resident: AtomicU64::new(0),
            spilled: AtomicU64::new(0),
            clock: AtomicU64::new(0),
            made: AtomicU64::new(0),
        }
    }

    /// The next stamp for a file that was just used.
    pub(super) fn tick(&self) -> u64 {
        self.clock.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Whether what is in memory is over the limit.
    pub(super) fn over(&self) -> bool {
        self.resident.load(Ordering::Relaxed) > self.config.resident_max
    }

    /// Whether spilling has brought memory back under three quarters of
    /// the limit, where it stops, so the next few writes do not each spill
    /// another file.
    pub(super) fn settled(&self) -> bool {
        self.resident.load(Ordering::Relaxed) <= self.config.resident_max / 4 * 3
    }

    pub(super) fn resident_changed(&self, before: u64, after: u64) {
        change(&self.resident, before, after);
    }

    pub(super) fn spilled_changed(&self, before: u64, after: u64) {
        change(&self.spilled, before, after);
    }

    /// A new, already unlinked file in the spill directory.
    pub(super) fn create(&self) -> io::Result<HostFile> {
        let n = self.made.fetch_add(1, Ordering::Relaxed);
        let path = self
            .config
            .dir
            .join(format!("spill-{}-{:p}-{n}", std::process::id(), self));
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)?;
        std::fs::remove_file(&path)?;
        Ok(file)
    }

    /// Bytes of file contents in memory and on disk.
    pub fn usage(&self) -> (u64, u64) {
        (
            self.resident.load(Ordering::Relaxed),
            self.spilled.load(Ordering::Relaxed),
        )
    }
}

fn change(counter: &AtomicU64, before: u64, after: u64) {
    if after >= before {
        counter.fetch_add(after - before, Ordering::Relaxed);
    } else {
        let less = before - after;
        let _ = counter.fetch_update(Ordering::Relaxed, Ordering::Relaxed, |now| {
            Some(now.saturating_sub(less))
        });
    }
}
