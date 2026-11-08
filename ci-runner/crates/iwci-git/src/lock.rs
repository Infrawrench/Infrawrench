//! One advisory lock per cached remote.
//!
//! `std::fs::File::lock` is `flock(2)` on Unix and `LockFileEx` on Windows.
//! The kernel drops the lock when the descriptor closes, including when the
//! process dies, so a crashed run cannot leave a stale lock behind and there
//! is nothing to detect or clean up. Each acquisition opens its own
//! descriptor, which is what makes two threads of one process exclude each
//! other as well as two processes.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use crate::{GitError, Result};

/// Held for the duration of one cache operation; unlocks on drop.
#[derive(Debug)]
pub(crate) struct RemoteLock {
    _file: File,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Mode {
    /// Readers: checkout, diff. Many at once.
    Shared,
    /// Writers: fetch, commit, ref updates. One at a time, and no readers.
    Exclusive,
}

impl RemoteLock {
    pub(crate) fn acquire(path: &Path, mode: Mode) -> Result<Self> {
        let io = |source| GitError::Io {
            path: PathBuf::from(path),
            source,
        };
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(io)?;
        match mode {
            Mode::Shared => file.lock_shared(),
            Mode::Exclusive => file.lock(),
        }
        .map_err(io)?;
        Ok(Self { _file: file })
    }
}
