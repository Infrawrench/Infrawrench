//! iwci patch: AF_UNIX stream sockets on a path, between the processes of
//! one job.
//!
//! WASIX has the address (`__wasi_addr_port_t`'s `unix` arm, which
//! wasix-libc fills from a `sockaddr_un`) but no socket behind it: binding
//! one failed with EINVAL, so a Node server listening on a path (tsx's IPC,
//! test runners' workers) could not start. Here such a socket is a TCP
//! socket on the job's loopback, and its path a file in the job's file
//! system naming the loopback port, which every process of the job shares:
//! `bind` creates the file (EADDRINUSE if the path exists, as on Linux),
//! `connect` reads it (ENOENT without it, ECONNREFUSED for a file that is
//! not one of these or a listener that has gone, as Linux refuses a path
//! with no socket listening on it), and `getsockname`, `getpeername` and
//! `accept` answer with the path. The loopback is the job's own, so nothing
//! here reaches the host. Abstract names (a path starting with NUL) and
//! datagram sockets are not supported.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};

use virtual_fs::{AsyncReadExt, AsyncWriteExt, FileSystem, FsError};
use wasmer::{MemoryView, WasmPtr};
use wasmer_types::MemorySize;
use wasmer_wasix_types::wasi::{Addressfamily, Errno};

use wasmer_wasix_types::types::__wasi_addr_port_t;

use crate::{fs::fs_error_into_wasi_err, state::WasiState};

/// What a socket file says, before the port.
const MARK: &str = "iwci-unix-socket 127.0.0.1:";

/// Room for a path in `__wasi_addr_port_t` (the address starts after the
/// tag and a padding byte; the C struct is 110 bytes).
const PATH_MAX: usize = 108;

/// The names of an AF_UNIX socket: the path it was bound to, and the path
/// it connected to. Either is unnamed (`None`) otherwise, as an accepted
/// connection's peer is.
#[derive(Debug, Clone, Default)]
pub(crate) struct UnixName {
    pub local: Option<String>,
    pub peer: Option<String>,
}

/// An address a guest passed: an IP address and port, or a path.
pub(crate) enum SockAddr {
    Ip(SocketAddr),
    Unix(String),
}

pub(crate) fn read_sock_addr<M: MemorySize>(
    memory: &MemoryView,
    ptr: WasmPtr<__wasi_addr_port_t, M>,
) -> Result<SockAddr, Errno> {
    let tag = ptr.deref(memory).read().map_err(crate::mem_error_to_wasi)?.tag;
    if tag != Addressfamily::Unix {
        let (ip, port) = crate::net::read_ip_port(memory, ptr)?;
        return Ok(SockAddr::Ip(SocketAddr::new(ip, port)));
    }
    let start: u64 = ptr.offset().into();
    let mut raw = [0u8; PATH_MAX];
    memory
        .read(start + 2, &mut raw)
        .map_err(crate::mem_error_to_wasi)?;
    let len = raw.iter().position(|b| *b == 0).unwrap_or(PATH_MAX);
    if len == 0 {
        // Unnamed, or an abstract name.
        return Err(Errno::Inval);
    }
    let path = std::str::from_utf8(&raw[..len]).map_err(|_| Errno::Inval)?;
    Ok(SockAddr::Unix(path.to_string()))
}

/// Writes `path` (empty for unnamed) as an AF_UNIX address.
pub(crate) fn write_unix_addr<M: MemorySize>(
    memory: &MemoryView,
    ptr: WasmPtr<__wasi_addr_port_t, M>,
    path: &str,
) -> Result<(), Errno> {
    let mut raw = [0u8; 2 + PATH_MAX];
    raw[0] = Addressfamily::Unix as u8;
    let bytes = path.as_bytes();
    let len = bytes.len().min(PATH_MAX - 1);
    raw[2..2 + len].copy_from_slice(&bytes[..len]);
    let start: u64 = ptr.offset().into();
    memory.write(start, &raw).map_err(crate::mem_error_to_wasi)
}

/// Where a socket on `path` listens on the loopback.
pub(crate) fn loopback(port: u16) -> SocketAddr {
    SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port)
}

/// Creates the file for a socket about to be bound on `path`: it must not
/// exist yet. Returns a handle to write the port to once the socket has one.
pub(crate) fn create(
    state: &WasiState,
    path: &str,
) -> Result<Box<dyn virtual_fs::VirtualFile + Send + Sync>, Errno> {
    let absolute = state.fs.relative_path_to_absolute(path.to_string());
    let absolute = std::path::Path::new(&absolute);
    if state.fs.root_fs.symlink_metadata(absolute).is_ok() {
        return Err(Errno::Addrinuse);
    }
    state
        .fs
        .root_fs
        .new_open_options()
        .write(true)
        .create_new(true)
        .open(absolute)
        .map_err(|err| match err {
            FsError::AlreadyExists => Errno::Addrinuse,
            err => fs_error_into_wasi_err(err),
        })
}

/// Records `port` in a socket file `create` made.
pub(crate) fn publish(
    mut file: Box<dyn virtual_fs::VirtualFile + Send + Sync>,
    port: u16,
) -> Result<(), Errno> {
    let content = format!("{MARK}{port}\n");
    virtual_mio::block_on(async move {
        file.write_all(content.as_bytes()).await?;
        file.flush().await
    })
    .map_err(|_| Errno::Io)
}

/// Removes a socket file whose bind failed after `create`.
pub(crate) fn remove(state: &WasiState, path: &str) {
    let absolute = state.fs.relative_path_to_absolute(path.to_string());
    let _ = state.fs.root_fs.remove_file(std::path::Path::new(&absolute));
}

/// The loopback port the socket on `path` listens on.
pub(crate) fn find(state: &WasiState, path: &str) -> Result<u16, Errno> {
    let absolute = state.fs.relative_path_to_absolute(path.to_string());
    let mut file = state
        .fs
        .root_fs
        .new_open_options()
        .read(true)
        .open(std::path::Path::new(&absolute))
        .map_err(|err| match err {
            FsError::EntryNotFound => Errno::Noent,
            FsError::BaseNotDirectory => Errno::Notdir,
            _ => Errno::Connrefused,
        })?;
    let mut content = String::new();
    virtual_mio::block_on(file.read_to_string(&mut content)).map_err(|_| Errno::Connrefused)?;
    content
        .strip_prefix(MARK)
        .and_then(|rest| rest.trim_end().parse::<u16>().ok())
        .ok_or(Errno::Connrefused)
}
