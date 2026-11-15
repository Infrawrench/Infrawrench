//! iwci patch (#1216): advisory file locks between the processes of one
//! control plane, which is every process a job's command starts.
//!
//! WASIX has no file locking, so a C library's `flock` and `fcntl(F_SETLK)`
//! had nothing to call. Two kinds are kept here, independently of each
//! other as on Linux:
//!
//! - **`flock` locks** belong to an open file description: every descriptor
//!   `dup` or a fork made from the one that was opened shares it (they share
//!   its offset, which is what identifies it here). Such a lock is released
//!   by `LOCK_UN`, or once no descriptor of that description is left in any
//!   process.
//! - **Record locks** (`fcntl`'s `F_SETLK`, `F_SETLKW`, `F_GETLK`) belong to
//!   a process and cover a byte range. A process never conflicts with
//!   itself; its locks on a file are released when it closes any descriptor
//!   of that file, or when it exits.
//!
//! A file is known by its path in the job's file system. A lock whose owner
//! has gone (a description with no descriptors left, a process that exited)
//! is dropped the next time the file's locks are looked at, so a waiter
//! polls rather than being woken.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex, Weak};

use wasmer_wasix_types::wasi::Errno;

use crate::os::task::{OwnedTaskStatus, process::WasiProcessId};

/// The locks of every file of one control plane.
#[derive(Debug, Default)]
pub struct FileLocks {
    files: Mutex<HashMap<PathBuf, LocksOfFile>>,
}

#[derive(Debug, Default)]
struct LocksOfFile {
    flocks: Vec<Flock>,
    records: Vec<Record>,
}

/// A `flock` lock, held by an open file description.
#[derive(Debug)]
struct Flock {
    holder: Weak<AtomicU64>,
    exclusive: bool,
}

/// A record lock, held by a process over `[start, end)`.
#[derive(Debug, Clone)]
struct Record {
    pid: WasiProcessId,
    alive: Weak<OwnedTaskStatus>,
    start: u64,
    end: u64,
    write: bool,
}

/// What a `flock` call asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FlockOp {
    Shared,
    Exclusive,
    Unlock,
}

/// The type of a record lock (`F_RDLCK`, `F_WRLCK`, `F_UNLCK`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordType {
    Read,
    Write,
    Unlock,
}

/// A record lock in another process's way, as `F_GETLK` reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Conflict {
    pub write: bool,
    pub start: u64,
    /// Exclusive; `u64::MAX` is "to the end of the file and beyond".
    pub end: u64,
    pub pid: WasiProcessId,
}

/// The process a record lock is asked for by.
#[derive(Debug, Clone)]
pub struct RecordOwner {
    pub pid: WasiProcessId,
    pub alive: Weak<OwnedTaskStatus>,
}

impl Flock {
    fn held(&self) -> bool {
        self.holder.strong_count() > 0
    }
}

impl Record {
    fn held(&self) -> bool {
        self.alive.upgrade().is_some_and(|status| !status.status().is_finished())
    }

    fn overlaps(&self, start: u64, end: u64) -> bool {
        self.start < end && start < self.end
    }
}

impl LocksOfFile {
    fn forget_released(&mut self) {
        self.flocks.retain(Flock::held);
        self.records.retain(Record::held);
    }

    fn is_empty(&self) -> bool {
        self.flocks.is_empty() && self.records.is_empty()
    }
}

impl FileLocks {
    /// Takes, changes or releases `holder`'s `flock` lock on `file`.
    /// `Err(Errno::Again)` when another description holds one in the way;
    /// the caller waits and asks again for a blocking lock.
    pub fn flock(&self, file: &Path, holder: &Arc<AtomicU64>, op: FlockOp) -> Result<(), Errno> {
        let mut files = self.files.lock().unwrap();
        let locks = files.entry(file.to_path_buf()).or_default();
        locks.forget_released();
        let mine = |f: &Flock| std::ptr::eq(f.holder.as_ptr(), Arc::as_ptr(holder));
        if op == FlockOp::Unlock {
            locks.flocks.retain(|f| !mine(f));
        } else {
            let exclusive = op == FlockOp::Exclusive;
            if locks
                .flocks
                .iter()
                .any(|f| !mine(f) && (f.exclusive || exclusive))
            {
                return Err(Errno::Again);
            }
            match locks.flocks.iter_mut().find(|f| mine(f)) {
                Some(held) => held.exclusive = exclusive,
                None => locks.flocks.push(Flock {
                    holder: Arc::downgrade(holder),
                    exclusive,
                }),
            }
        }
        if locks.is_empty() {
            files.remove(file);
        }
        Ok(())
    }

    /// The first record lock of another process that `[start, end)` of type
    /// `write` would conflict with, if any (`F_GETLK`).
    pub fn conflicting_record(
        &self,
        file: &Path,
        pid: WasiProcessId,
        start: u64,
        end: u64,
        write: bool,
    ) -> Option<Conflict> {
        let mut files = self.files.lock().unwrap();
        let locks = files.get_mut(file)?;
        locks.forget_released();
        locks
            .records
            .iter()
            .find(|r| r.pid != pid && r.overlaps(start, end) && (r.write || write))
            .map(|r| Conflict {
                write: r.write,
                start: r.start,
                end: r.end,
                pid: r.pid,
            })
    }

    /// Sets `owner`'s record lock over `[start, end)` (`F_SETLK`), replacing
    /// whatever of its own it held there, or releases that range.
    /// `Err(Errno::Again)` when another process holds a lock in the way.
    pub fn set_record(
        &self,
        file: &Path,
        owner: &RecordOwner,
        start: u64,
        end: u64,
        kind: RecordType,
    ) -> Result<(), Errno> {
        if start >= end {
            return Err(Errno::Inval);
        }
        let mut files = self.files.lock().unwrap();
        let locks = files.entry(file.to_path_buf()).or_default();
        locks.forget_released();
        if kind != RecordType::Unlock {
            let write = kind == RecordType::Write;
            if locks
                .records
                .iter()
                .any(|r| r.pid != owner.pid && r.overlaps(start, end) && (r.write || write))
            {
                return Err(Errno::Again);
            }
        }
        // What the owner held in the range goes; what it held either side
        // of it stays.
        let mut kept = Vec::with_capacity(locks.records.len() + 2);
        for record in locks.records.drain(..) {
            if record.pid != owner.pid || !record.overlaps(start, end) {
                kept.push(record);
                continue;
            }
            if record.start < start {
                kept.push(Record {
                    end: start,
                    ..record.clone()
                });
            }
            if record.end > end {
                kept.push(Record { start: end, ..record });
            }
        }
        if kind != RecordType::Unlock {
            kept.push(Record {
                pid: owner.pid,
                alive: owner.alive.clone(),
                start,
                end,
                write: kind == RecordType::Write,
            });
        }
        locks.records = kept;
        if locks.is_empty() {
            files.remove(file);
        }
        Ok(())
    }

    /// Releases every record lock `pid` holds on `file`: it closed a
    /// descriptor of it.
    pub fn release_records(&self, file: &Path, pid: WasiProcessId) {
        let mut files = self.files.lock().unwrap();
        if let Some(locks) = files.get_mut(file) {
            locks.records.retain(|r| r.pid != pid);
            locks.forget_released();
            if locks.is_empty() {
                files.remove(file);
            }
        }
    }
}

