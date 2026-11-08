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
//! bounds it already.

use std::fmt;
use std::io::{self, SeekFrom};
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use virtual_fs::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf, VirtualFile};

/// Somewhere a job's written bytes are counted. Implementations decide the
/// limit; `take` returning false refuses the write.
pub trait WriteBudget: Send + Sync + fmt::Debug {
    fn take(&self, bytes: u64) -> bool;
    fn give(&self, bytes: u64);
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
    /// Where the next read or write starts, tracked here because the
    /// growth a write causes depends on it.
    pos: u64,
    append: bool,
}

impl LimitedFile {
    pub(crate) fn new(
        inner: Box<dyn VirtualFile + Send + Sync + 'static>,
        budget: Arc<dyn WriteBudget>,
        append: bool,
    ) -> Self {
        Self {
            inner,
            budget,
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
                    self.budget.give(old - new_size);
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
