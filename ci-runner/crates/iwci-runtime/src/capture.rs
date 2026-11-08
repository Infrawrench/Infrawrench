//! Captured standard output and error.

use std::io::{self, SeekFrom};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use virtual_fs::{AsyncRead, AsyncSeek, AsyncWrite, ReadBuf, VirtualFile};

/// What a job printed on one stream, up to a cap. A job that prints more is
/// not stopped (a chatty test suite is still a passing one); the rest is
/// dropped and the stream is marked truncated.
#[derive(Debug, Default)]
pub(crate) struct Captured {
    pub(crate) bytes: Vec<u8>,
    pub(crate) truncated: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct Capture {
    inner: Arc<Mutex<Captured>>,
    cap: usize,
}

impl Capture {
    pub(crate) fn new(cap: usize) -> Self {
        Self {
            inner: Arc::default(),
            cap,
        }
    }

    pub(crate) fn push(&self, data: &[u8]) {
        let mut captured = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let room = self.cap.saturating_sub(captured.bytes.len());
        if data.len() > room {
            captured.truncated = true;
        }
        captured
            .bytes
            .extend_from_slice(&data[..data.len().min(room)]);
    }

    pub(crate) fn take(&self) -> Captured {
        std::mem::take(&mut *self.inner.lock().unwrap_or_else(|e| e.into_inner()))
    }

    /// A file handle that appends to this capture, for a WASI fd.
    pub(crate) fn file(&self) -> Box<dyn VirtualFile + Send + Sync + 'static> {
        Box::new(CaptureFile(self.clone()))
    }
}

/// Stdout or stderr as WASIX sees it: a write-only character stream. Every
/// spawned subprocess inherits a handle to the same capture.
#[derive(Debug)]
struct CaptureFile(Capture);

impl AsyncWrite for CaptureFile {
    fn poll_write(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        self.0.push(buf);
        Poll::Ready(Ok(buf.len()))
    }

    fn poll_flush(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }

    fn poll_shutdown(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncRead for CaptureFile {
    fn poll_read(
        self: Pin<&mut Self>,
        _: &mut Context<'_>,
        _: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        // Reading stdout back is end of file, as for a pipe nobody writes to.
        Poll::Ready(Ok(()))
    }
}

impl AsyncSeek for CaptureFile {
    fn start_seek(self: Pin<&mut Self>, _: SeekFrom) -> io::Result<()> {
        Err(io::Error::from(io::ErrorKind::Unsupported))
    }

    fn poll_complete(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Poll::Ready(Ok(0))
    }
}

impl VirtualFile for CaptureFile {
    fn last_accessed(&self) -> u64 {
        0
    }

    fn last_modified(&self) -> u64 {
        0
    }

    fn created_time(&self) -> u64 {
        0
    }

    fn size(&self) -> u64 {
        0
    }

    fn set_len(&mut self, _: u64) -> virtual_fs::Result<()> {
        Err(virtual_fs::FsError::PermissionDenied)
    }

    fn unlink(&mut self) -> virtual_fs::Result<()> {
        Ok(())
    }

    fn poll_read_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(0))
    }

    fn poll_write_ready(self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Poll::Ready(Ok(8192))
    }
}
