//! A lisafs server over a job's file system.
//!
//! lisafs is how gVisor's kernel (the Sentry) reaches files: a socket per
//! mount carries the first requests and sets up "channels", shared memory
//! windows the Sentry then sends most requests over (`flipcall`). gVisor
//! ships a server (its gofer) that serves a host directory; this one
//! serves a `virtual_fs` file system instead, so a sandboxed program sees
//! exactly the files a WASIX job does, and what it writes lands in the
//! job's file system as the job's own writes: held to its write budget,
//! and read back as its changes, caches and artifacts by the code that
//! already does that.
//!
//! The protocol is gVisor's at the pinned release (`tests/fixtures.sh`
//! has the pin); `pkg/lisafs` there is the reference. The server never
//! hands the sandbox a host descriptor other than a channel's memory and
//! descriptor socket, never connects or binds a host socket, and treats
//! every request as hostile: bounds-checked decoding, single path
//! components only, descriptor ids per connection, a cap on descriptors,
//! and a handler that panics answers with an error instead of taking the
//! runner down.
//!
//! The sandbox mounts it with `--file-access=exclusive`: the whole job
//! runs inside the sandbox, so nothing else changes its files while it
//! runs, and the Sentry may cache what it reads.

mod flipcall;
mod server;
mod sock;
mod wire;

#[cfg(test)]
mod tests;

use std::io;
use std::os::fd::OwnedFd;
use std::path::PathBuf;
use std::sync::Arc;
use std::thread::JoinHandle;

use iwci_vfs::{DynFs, Modes};

/// The largest request or reply: gVisor's own bound, a huge page less a
/// page, which is what a channel's window is sized for.
pub(crate) const MAX_MESSAGE: u32 = (2 << 20) - 4096;

/// What one mount serves.
#[derive(Debug, Clone)]
pub struct Export {
    /// The file system.
    pub fs: DynFs,
    /// The modes of its files, by path in `fs`. A file system that is not
    /// the job's own gets a record of its own (`Modes::over`).
    pub modes: Modes,
    /// The directory of `fs` that is the mount's root.
    pub root: PathBuf,
    /// Refuse every change.
    pub read_only: bool,
}

/// A connection being served, on threads of its own: one for the socket,
/// one per channel the sandbox opens.
pub struct Serving {
    conn: Arc<server::Conn>,
    thread: Option<JoinHandle<()>>,
}

/// Serves `export` on `sock`, one end of a `SOCK_STREAM` socket pair whose
/// other end the sandbox mounts. Serving ends when the sandbox closes its
/// end, or on [`Serving::stop`].
pub fn serve(export: Export, sock: OwnedFd) -> io::Result<Serving> {
    let conn = Arc::new(server::Conn::new(export, sock));
    let running = conn.clone();
    let thread = std::thread::Builder::new()
        .name("iwci-lisafs".into())
        .spawn(move || running.run())?;
    Ok(Serving {
        conn,
        thread: Some(thread),
    })
}

impl Serving {
    /// Ends the connection: the sandbox's next request fails.
    pub fn stop(&self) {
        self.conn.stop();
    }

    /// Waits for serving to end (the sandbox closed its end, or
    /// [`Serving::stop`]).
    pub fn wait(mut self) {
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Serving {
    fn drop(&mut self) {
        if let Some(thread) = self.thread.take() {
            self.conn.stop();
            let _ = thread.join();
        }
        self.conn.close();
    }
}

/// A `SOCK_STREAM` socket pair for one mount: serve the first, give the
/// sandbox the second.
pub fn socket_pair() -> io::Result<(OwnedFd, OwnedFd)> {
    sock::socket_pair(libc::SOCK_STREAM)
}
