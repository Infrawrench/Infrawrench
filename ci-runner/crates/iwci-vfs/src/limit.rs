//! Holding a job's file writes to a budget.
//!
//! A job's files live in memory, so without this a job could write past
//! any memory limit. Wasmer's own memory limiter for `mem_fs` is no use
//! here: it grows the buffer first and only then asks, so a refused write
//! still lands and a program that retries keeps growing. Instead every
//! writable file a job opens is wrapped, and a write that would add bytes
//! past the budget is refused before it reaches the file, with the error a
//! full disk gives (`ENOSPC` to the guest).
//!
//! What is counted is the bytes a job adds: a file's growth, given back
//! when it shrinks, is truncated, or is deleted. Copying a snapshot file
//! up to change it in place is not counted, because the snapshot's size
//! bounds it already. So each file the job may change has an [`Account`]
//! of the bytes it holds without having been charged for them, and only
//! the rest is ever given back: removing or shrinking a file gives back
//! what the job added to it, never what it was given.

use std::fmt;
use std::io::{self, SeekFrom};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use virtual_fs::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf, VirtualFile};

/// Somewhere a job's written bytes are counted. Implementations decide the
/// limit; `take` returning false refuses the write.
pub trait WriteBudget: Send + Sync + fmt::Debug {
    fn take(&self, bytes: u64) -> bool;
    fn give(&self, bytes: u64);
}

/// What one file was given without being charged: the bytes it had from
/// the snapshot when the job's copy of it was made. The file's size past
/// that is what it has been charged. Shared by every open handle of the
/// file, and moved with it when it is renamed. Each name of a file with
/// hard links has an account of its own ([`Account::linked`]) for its
/// entry, sharing the file's bytes, so the bytes are charged once
/// whatever the names, and given back with the last one.
#[derive(Debug, Default)]
pub(crate) struct Account {
    free: Arc<Mutex<u64>>,
    /// What the file's entry was charged when the job made it (the runner
    /// keeps a node and an account for it), given back when it goes.
    entry: u64,
}

impl Account {
    pub(crate) fn new(free: u64) -> Arc<Self> {
        Arc::new(Self {
            free: Arc::new(Mutex::new(free)),
            entry: 0,
        })
    }

    /// A new file's account, its entry charged `entry` bytes.
    pub(crate) fn made(entry: u64) -> Arc<Self> {
        Arc::new(Self {
            free: Arc::new(Mutex::new(0)),
            entry,
        })
    }

    /// The account of another name of this file, a hard link whose entry
    /// was charged `entry` bytes: the file's bytes are this account's.
    pub(crate) fn linked(&self, entry: u64) -> Arc<Self> {
        Arc::new(Self {
            free: self.free.clone(),
            entry,
        })
    }

    /// What the file's entry was charged.
    pub(crate) fn entry(&self) -> u64 {
        self.entry
    }

    fn free(&self) -> std::sync::MutexGuard<'_, u64> {
        self.free.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The file lost its tail, going from `old` bytes to `new`: what to
    /// give back. The bytes it was given go last.
    pub(crate) fn shrunk(&self, old: u64, new: u64) -> u64 {
        let mut free = self.free();
        let charged_old = old - (*free).min(old);
        *free = (*free).min(new);
        let charged_new = new - (*free).min(new);
        charged_old.saturating_sub(charged_new)
    }

    /// The file, `size` bytes, is gone (removed, or replaced by a rename):
    /// what to give back. A handle still open on it gives nothing more
    /// back for those bytes.
    pub(crate) fn released(&self, size: u64) -> u64 {
        let mut free = self.free();
        let charged = size - (*free).min(size);
        *free = size;
        charged
    }
}

pub(crate) fn storage_full() -> io::Error {
    io::Error::new(
        io::ErrorKind::StorageFull,
        "the job's memory limit is used up",
    )
}

#[derive(Debug)]
pub(crate) struct LimitedFile {
    inner: Box<dyn VirtualFile + Send + Sync + 'static>,
    budget: Arc<dyn WriteBudget>,
    account: Arc<Account>,
    /// Where the next read or write starts, tracked here because the
    /// growth a write causes depends on it.
    pos: u64,
    append: bool,
}

impl LimitedFile {
    pub(crate) fn new(
        inner: Box<dyn VirtualFile + Send + Sync + 'static>,
        budget: Arc<dyn WriteBudget>,
        account: Arc<Account>,
        append: bool,
    ) -> Self {
        Self {
            inner,
            budget,
            account,
            pos: 0,
            append,
        }
    }
}

impl AsyncWrite for LimitedFile {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        let size = self.inner.size();
        let start = if self.append { size } else { self.pos };
        let growth = (start + buf.len() as u64).saturating_sub(size);
        if growth > 0 && !self.budget.take(growth) {
            return Poll::Ready(Err(storage_full()));
        }
        let result = Pin::new(&mut self.inner).poll_write(cx, buf);
        let grew = self.inner.size().saturating_sub(size);
        // Give back whatever was taken and not used: a short write, a
        // pending one (taken again on the next poll) or a failed one.
        if growth > grew {
            self.budget.give(growth - grew);
        }
        if let Poll::Ready(Ok(n)) = &result {
            self.pos = start + *n as u64;
        }
        result
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

impl AsyncRead for LimitedFile {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buf);
        if let Poll::Ready(Ok(())) = &result {
            self.pos += (buf.filled().len() - before) as u64;
        }
        result
    }
}

impl AsyncSeek for LimitedFile {
    fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> io::Result<()> {
        Pin::new(&mut self.inner).start_seek(position)
    }

    fn poll_complete(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        let result = Pin::new(&mut self.inner).poll_complete(cx);
        if let Poll::Ready(Ok(pos)) = &result {
            self.pos = *pos;
        }
        result
    }
}

impl VirtualFile for LimitedFile {
    fn last_accessed(&self) -> u64 {
        self.inner.last_accessed()
    }
    fn last_modified(&self) -> u64 {
        self.inner.last_modified()
    }
    fn created_time(&self) -> u64 {
        self.inner.created_time()
    }
    fn set_times(&mut self, atime: Option<u64>, mtime: Option<u64>) -> virtual_fs::Result<()> {
        self.inner.set_times(atime, mtime)
    }
    fn size(&self) -> u64 {
        self.inner.size()
    }
    fn set_len(&mut self, new_size: u64) -> virtual_fs::Result<()> {
        let old = self.inner.size();
        if new_size > old && !self.budget.take(new_size - old) {
            return Err(virtual_fs::FsError::StorageFull);
        }
        match self.inner.set_len(new_size) {
            Ok(()) => {
                if new_size < old {
                    self.budget.give(self.account.shrunk(old, new_size));
                }
                Ok(())
            }
            Err(e) => {
                if new_size > old {
                    self.budget.give(new_size - old);
                }
                Err(e)
            }
        }
    }
    fn unlink(&mut self) -> virtual_fs::Result<()> {
        self.inner.unlink()
    }
    fn is_open(&self) -> bool {
        self.inner.is_open()
    }
    fn get_special_fd(&self) -> Option<u32> {
        self.inner.get_special_fd()
    }
    fn as_owned_buffer(&self) -> Option<shared_buffer::OwnedBuffer> {
        self.inner.as_owned_buffer()
    }
    fn poll_read_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Pin::new(&mut *self.inner).poll_read_ready(cx)
    }
    fn poll_write_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Pin::new(&mut *self.inner).poll_write_ready(cx)
    }
    // `copy_reference` and `copy_from_owned_buffer` keep their default
    // implementations, which copy through `poll_write` and so through the
    // budget; the inner file's faster versions would bypass it.
}
