//! One lisafs connection: the descriptor table and the handlers.
//!
//! lisafs is descriptor based: the sandbox walks to a file and is given a
//! "control FD" naming it, opens that for an "open FD", and works on those.
//! The job's file system is path based, so a control FD here is a path,
//! kept in step with renames and marked deleted by unlinks, the way
//! gVisor's own server keeps its node tree (`pkg/lisafs/node.go`). An open
//! FD holds an open file of the job's file system, so it keeps working
//! across a rename, as an open file does.
//!
//! Everything goes through one lock: requests from the socket and the
//! channels are serialised, which keeps a rename and the paths it moves
//! consistent. The handlers are microseconds of in-memory work.
//!
//! Inode numbers are this connection's own, handed out per file and moved
//! with it on rename, never derived from a path. The sandbox's kernel
//! shares one inode between files that report the same number (that is
//! how it supports hard links), so a number may never name two files at
//! once, which a hash of the path would after `mv a b; touch a`.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ffi::OsStr;
use std::io::SeekFrom;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::ffi::OsStrExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;

use futures::executor::block_on;
use iwci_vfs::modes::{DEFAULT_DIR_MODE, DEFAULT_FILE_MODE, MODE_BITS};
use virtual_fs::{
    AsyncReadExt, AsyncSeekExt, AsyncWriteExt, FileSystem, FsError, Metadata, VirtualFile,
};

use super::flipcall::{Endpoint, Side, Window};
use super::sock::{Sock, socket_pair};
use super::wire::{INODE_SIZE, Malformed, Reader, STATX_SIZE, Statx, Timestamp, Writer, mid};
use super::{Export, MAX_MESSAGE};

type Errno = i32;
type Handled = Result<(Vec<u8>, Vec<OwnedFd>), Errno>;
type File = Box<dyn VirtualFile + Send + Sync + 'static>;

/// The messages served. Sockets (`Connect`, `BindAt`, ...) are left out,
/// so the sandbox keeps a socket bound in the file system to itself, and
/// so are extended attributes, which the job's file system has none of.
pub(crate) const SUPPORTED: &[u16] = &[
    mid::MOUNT,
    mid::CHANNEL,
    mid::FSTAT,
    mid::SET_STAT,
    mid::WALK,
    mid::WALK_STAT,
    mid::OPEN_AT,
    mid::OPEN_CREATE_AT,
    mid::CLOSE,
    mid::FSYNC,
    mid::PWRITE,
    mid::PREAD,
    mid::MKDIR_AT,
    mid::MKNOD_AT,
    mid::SYMLINK_AT,
    mid::LINK_AT,
    mid::FSTAT_FS,
    mid::FALLOCATE,
    mid::READ_LINK_AT,
    mid::FLUSH,
    mid::UNLINK_AT,
    mid::RENAME_AT,
    mid::GETDENTS64,
    mid::RENAME_AT2,
];

/// At most this many channels per connection, as gVisor's server allows.
const MAX_CHANNELS: usize = 4;

/// At most this many descriptors per connection. The sandbox's kernel
/// keeps one control FD per cached path and one open FD per open file;
/// the bound is far above that and keeps a misbehaving one from growing
/// the runner's memory without end.
const MAX_FDS: usize = 1 << 18;

/// The longest path the server keeps or makes: Linux's `PATH_MAX`. A
/// path past it is refused (ENAMETOOLONG), as Linux refuses one in a
/// system call, so every path a connection holds is short.
const MAX_PATH: usize = 4096;

/// What one connection's records (its FDs' paths, the inode numbers it
/// gave out) may take of the runner's memory. Past it the numbers no FD
/// names are forgotten, and then a new FD is refused (ENFILE).
const MAX_STATE_BYTES: usize = 64 << 20;

/// What a new file, directory or symlink is charged to the job's budget
/// beside its name: what the job's file system keeps for an entry.
const ENTRY_COST: u64 = 128;

// statx(2) mask bits.
const STATX_MODE: u32 = 0x2;
const STATX_UID: u32 = 0x8;
const STATX_GID: u32 = 0x10;
const STATX_ATIME: u32 = 0x20;
const STATX_MTIME: u32 = 0x40;
const STATX_SIZE_BIT: u32 = 0x200;
const STATX_BASIC_STATS: u32 = 0x7ff;
const SET_STAT_SUPPORTED: u32 =
    STATX_MODE | STATX_UID | STATX_GID | STATX_SIZE_BIT | STATX_ATIME | STATX_MTIME;

// utimensat(2)'s special nanosecond values.
const UTIME_NOW: u32 = (1 << 30) - 1;
const UTIME_OMIT: u32 = (1 << 30) - 2;

// renameat2(2) flags.
const RENAME_NOREPLACE: u32 = 1;

// File type bits.
const S_IFMT: u32 = 0o170_000;
const S_IFREG: u32 = 0o100_000;
const S_IFDIR: u32 = 0o040_000;
const S_IFLNK: u32 = 0o120_000;

// Directory entry types.
const DT_DIR: u8 = 4;
const DT_REG: u8 = 8;
const DT_LNK: u8 = 10;
const DT_UNKNOWN: u8 = 0;

const TMPFS_MAGIC: u64 = 0x0102_1994;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Dir,
    File,
    Symlink,
    Other,
}

impl Kind {
    fn of(meta: &Metadata) -> Self {
        let ft = meta.file_type();
        if ft.is_symlink() {
            Kind::Symlink
        } else if ft.is_dir() {
            Kind::Dir
        } else if ft.is_file() {
            Kind::File
        } else {
            Kind::Other
        }
    }

    fn type_bits(self, meta: &Metadata) -> u32 {
        let ft = meta.file_type();
        match self {
            Kind::Dir => S_IFDIR,
            Kind::File => S_IFREG,
            Kind::Symlink => S_IFLNK,
            Kind::Other if ft.is_char_device() => 0o020_000,
            Kind::Other if ft.is_block_device() => 0o060_000,
            Kind::Other if ft.is_fifo() => 0o010_000,
            Kind::Other if ft.is_socket() => 0o140_000,
            Kind::Other => S_IFREG,
        }
    }

    fn dirent_type(self) -> u8 {
        match self {
            Kind::Dir => DT_DIR,
            Kind::File => DT_REG,
            Kind::Symlink => DT_LNK,
            Kind::Other => DT_UNKNOWN,
        }
    }
}

/// A control FD: a file by path.
#[derive(Debug, Clone)]
struct Control {
    path: PathBuf,
    ino: u64,
    kind: Kind,
    /// Unlinked, or replaced by a rename, since it was walked to.
    deleted: bool,
}

/// An open FD. It keeps its own copy of what it was opened from, kept in
/// step like a control FD's: the Sentry may close the control FD first.
struct Open {
    node: Control,
    /// The open file; `None` for a directory.
    file: Option<File>,
    readable: bool,
    writable: bool,
    /// A directory's listing, taken at the first read (or a rewind), and
    /// how far it has been read.
    listing: Option<(Vec<Dirent>, usize)>,
}

struct Dirent {
    name: Vec<u8>,
    ino: u64,
    kind: u8,
}

enum Fd {
    Control(Control),
    Open(Open),
}

impl Fd {
    /// The file it names.
    fn node_mut(&mut self) -> &mut Control {
        match self {
            Fd::Control(c) => c,
            Fd::Open(o) => &mut o.node,
        }
    }
}

/// An inode number given out, and how many FDs name its path. One no FD
/// names may be forgotten (`State::sweep`): the sandbox's kernel then has
/// no dentry for it, and a later walk gives the file a new number.
struct Numbered {
    ino: u64,
    refs: u32,
}

struct State {
    fds: HashMap<u64, Fd>,
    next_fd: u64,
    /// Inode numbers of the files this connection has reported, by path.
    inos: BTreeMap<PathBuf, Numbered>,
    next_ino: u64,
    /// What the paths in `fds` and `inos` take of the runner's memory,
    /// roughly, held under [`MAX_STATE_BYTES`].
    bytes: usize,
    /// Entries this connection created and charged to the job's budget,
    /// by a hash of their path ([`ENTRY_COST`]).
    created: HashSet<u64>,
}

/// One lisafs connection, which is one mount in the sandbox.
pub(crate) struct Conn {
    export: Export,
    sock: Sock,
    state: Mutex<State>,
    channels: Mutex<Vec<(Arc<Endpoint>, JoinHandle<()>)>>,
    closed: AtomicBool,
}

impl Conn {
    pub(crate) fn new(export: Export, sock: OwnedFd) -> Self {
        Self {
            export,
            sock: Sock::new(sock),
            state: Mutex::new(State {
                fds: HashMap::new(),
                // FD id 0 is "invalid" in lisafs.
                next_fd: 1,
                inos: BTreeMap::new(),
                next_ino: 1,
                bytes: 0,
                created: HashSet::new(),
            }),
            channels: Mutex::new(Vec::new()),
            closed: AtomicBool::new(false),
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// FDs, inode numbers and the bytes their paths take, for tests.
    #[cfg(test)]
    pub(crate) fn kept(&self) -> (usize, usize, usize) {
        let state = self.state();
        (state.fds.len(), state.inos.len(), state.bytes)
    }

    /// Serves requests from the socket until the peer closes it, then
    /// tears the connection down.
    pub(crate) fn run(self: &Arc<Self>) {
        while let Ok(Some((m, payload, _))) = self.sock.recv(MAX_MESSAGE, 0) {
            let (m, reply, fds) = self.dispatch(m, &payload);
            let raw: Vec<_> = fds.iter().map(|f| f.as_raw_fd()).collect();
            if self.sock.send(m, &reply, &raw).is_err() {
                break;
            }
        }
        self.close();
    }

    /// Ends the connection: the socket, every channel, every descriptor.
    pub(crate) fn close(&self) {
        if self.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.sock.shutdown();
        let channels =
            std::mem::take(&mut *self.channels.lock().unwrap_or_else(|e| e.into_inner()));
        for (endpoint, _) in &channels {
            endpoint.shutdown();
        }
        for (_, thread) in channels {
            let _ = thread.join();
        }
        // Nothing of it outlives the sandbox.
        let mut state = self.state();
        state.fds = HashMap::new();
        state.inos = BTreeMap::new();
        state.created = HashSet::new();
        state.bytes = 0;
    }

    /// Stops the connection from another thread: the serving thread sees
    /// the socket close and tears the rest down.
    pub(crate) fn stop(&self) {
        self.sock.shutdown();
        for (endpoint, _) in self
            .channels
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
        {
            endpoint.shutdown();
        }
    }

    /// Serves one channel until it is shut down.
    fn service(self: Arc<Self>, endpoint: Arc<Endpoint>, fd_sock: OwnedFd) {
        let Ok(mut len) = endpoint.recv_first() else {
            return;
        };
        while len > 0 {
            let request = endpoint.window.read(len);
            if request.len() < 4 {
                return;
            }
            let m = u16::from_le_bytes([request[0], request[1]]);
            let (m, reply, fds) = self.dispatch(m, &request[4..]);
            let sent = send_fds(&fd_sock, &fds);
            let mut message = Vec::with_capacity(4 + reply.len());
            message.extend_from_slice(&m.to_le_bytes());
            message.push(sent);
            message.push(0);
            message.extend_from_slice(&reply);
            endpoint.window.write(&message);
            len = match endpoint.send_recv(message.len()) {
                Ok(len) => len,
                Err(_) => return,
            };
        }
    }

    /// Answers one request: the reply's message id, its bytes and the
    /// descriptors that go with it.
    fn dispatch(self: &Arc<Self>, m: u16, payload: &[u8]) -> (u16, Vec<u8>, Vec<OwnedFd>) {
        let result = if payload.len() > MAX_MESSAGE as usize {
            Err(libc::EIO)
        } else if !SUPPORTED.contains(&m) {
            Err(libc::EOPNOTSUPP)
        } else {
            // A bug here must not take the runner down with it.
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.handle(m, payload)))
                .unwrap_or(Err(libc::EREMOTEIO))
        };
        match result {
            Ok((reply, _)) if reply.len() > MAX_MESSAGE as usize => error_reply(libc::EIO),
            Ok((reply, fds)) => (m, reply, fds),
            Err(errno) => error_reply(errno),
        }
    }

    fn handle(self: &Arc<Self>, m: u16, payload: &[u8]) -> Handled {
        let mut r = Reader::new(payload);
        let r = &mut r;
        match m {
            mid::MOUNT => self.mount(),
            mid::CHANNEL => self.channel(),
            mid::FSTAT => self.fstat(r.u64().map_err(eio)?),
            mid::SET_STAT => self.set_stat(r).map_err(eio)?,
            mid::WALK => self.walk(r).map_err(eio)?,
            mid::WALK_STAT => self.walk_stat(r).map_err(eio)?,
            mid::OPEN_AT => {
                let fd = r.u64().map_err(eio)?;
                let flags = r.u32().map_err(eio)?;
                self.open_at(fd, flags)
            }
            mid::OPEN_CREATE_AT => self.open_create_at(r).map_err(eio)?,
            mid::CLOSE => {
                let ids = r.fd_ids().map_err(eio)?;
                let mut state = self.state();
                for id in ids {
                    state.remove(id);
                }
                Ok((Vec::new(), Vec::new()))
            }
            mid::FSYNC => {
                let ids = r.fd_ids().map_err(eio)?;
                for id in ids {
                    self.flush(id)?;
                }
                Ok((Vec::new(), Vec::new()))
            }
            mid::FLUSH => {
                self.flush(r.u64().map_err(eio)?)?;
                Ok((Vec::new(), Vec::new()))
            }
            mid::PWRITE => self.pwrite(r).map_err(eio)?,
            mid::PREAD => self.pread(r).map_err(eio)?,
            mid::MKDIR_AT => self.mkdir_at(r).map_err(eio)?,
            mid::MKNOD_AT => self.mknod_at(r).map_err(eio)?,
            mid::SYMLINK_AT => self.symlink_at(r).map_err(eio)?,
            mid::LINK_AT => self.link_at(r).map_err(eio)?,
            mid::FSTAT_FS => {
                r.u64().map_err(eio)?;
                self.statfs()
            }
            mid::FALLOCATE => self.fallocate(r).map_err(eio)?,
            mid::READ_LINK_AT => self.read_link_at(r.u64().map_err(eio)?),
            mid::UNLINK_AT => self.unlink_at(r).map_err(eio)?,
            mid::RENAME_AT => self.rename_at(r, false).map_err(eio)?,
            mid::RENAME_AT2 => self.rename_at(r, true).map_err(eio)?,
            mid::GETDENTS64 => self.getdents(r).map_err(eio)?,
            _ => Err(libc::EOPNOTSUPP),
        }
    }

    // ---- connection ---------------------------------------------------

    fn mount(&self) -> Handled {
        let root = self.export.root.clone();
        let meta = self.export.fs.symlink_metadata(&root).map_err(fs_errno)?;
        if Kind::of(&meta) != Kind::Dir {
            return Err(libc::ENOTDIR);
        }
        let mut state = self.state();
        let ino = state.ino(&root)?;
        let stat = self.statx(&root, &meta, ino);
        let fd = state.insert(Fd::Control(Control {
            path: root,
            ino,
            kind: Kind::Dir,
            deleted: false,
        }))?;
        let mut w = Writer::default();
        w.inode(fd, &stat)
            .u32(MAX_MESSAGE)
            .u16(SUPPORTED.len() as u16);
        for m in SUPPORTED {
            w.u16(*m);
        }
        Ok((w.buf, Vec::new()))
    }

    fn channel(self: &Arc<Self>) -> Handled {
        let mut channels = self.channels.lock().unwrap_or_else(|e| e.into_inner());
        if self.closed.load(Ordering::SeqCst) || channels.len() >= MAX_CHANNELS {
            return Err(libc::ENOMEM);
        }
        // Room for the channel header and the largest message.
        let window = Window::create(4 + MAX_MESSAGE as usize).map_err(io_errno)?;
        let (offset, length) = (0u64, window.len() as u64);
        let client_memfd = dup(window.memfd())?;
        let (ours, theirs) = socket_pair(libc::SOCK_SEQPACKET).map_err(io_errno)?;
        let endpoint = Arc::new(Endpoint::new(window, Side::Server));
        let conn = self.clone();
        let serving = endpoint.clone();
        let thread = std::thread::Builder::new()
            .name("iwci-lisafs-chan".into())
            .spawn(move || conn.service(serving, ours))
            .map_err(io_errno)?;
        channels.push((endpoint, thread));
        let mut w = Writer::default();
        w.u64(offset).u64(length);
        Ok((w.buf, vec![client_memfd, theirs]))
    }

    // ---- metadata -----------------------------------------------------

    fn statx(&self, path: &Path, meta: &Metadata, ino: u64) -> Statx {
        let kind = Kind::of(meta);
        let perm = match kind {
            Kind::Symlink => 0o777,
            Kind::Dir => self.export.modes.get(path).unwrap_or(DEFAULT_DIR_MODE),
            _ => self.export.modes.get(path).unwrap_or(DEFAULT_FILE_MODE),
        };
        let size = if kind == Kind::Symlink {
            self.export
                .fs
                .readlink(path)
                .map(|t| t.as_os_str().len() as u64)
                .unwrap_or(meta.len)
        } else {
            meta.len
        };
        stat_from(
            kind.type_bits(meta) | (perm & MODE_BITS),
            ino,
            size,
            meta,
            kind,
        )
    }

    fn fstat(&self, fd: u64) -> Handled {
        let state = self.state();
        let stat = match state.fds.get(&fd) {
            Some(Fd::Control(c)) => {
                let meta = self.lstat(c)?;
                self.statx(&c.path, &meta, c.ino)
            }
            Some(Fd::Open(o)) => {
                let c = &o.node;
                match &o.file {
                    // An open file answers for itself, deleted or not.
                    Some(file) => {
                        let meta = Metadata {
                            ft: virtual_fs::FileType::new_file(),
                            accessed: file.last_accessed(),
                            created: file.created_time(),
                            modified: file.last_modified(),
                            len: file.size(),
                        };
                        let perm = self.export.modes.get(&c.path).unwrap_or(DEFAULT_FILE_MODE);
                        stat_from(
                            S_IFREG | (perm & MODE_BITS),
                            c.ino,
                            file.size(),
                            &meta,
                            Kind::File,
                        )
                    }
                    None => {
                        let meta = self.lstat(c)?;
                        self.statx(&c.path, &meta, c.ino)
                    }
                }
            }
            None => return Err(libc::EBADF),
        };
        let mut w = Writer::default();
        w.statx(&stat);
        Ok((w.buf, Vec::new()))
    }

    fn lstat(&self, c: &Control) -> Result<Metadata, Errno> {
        if c.deleted {
            return Err(libc::ENOENT);
        }
        self.export.fs.symlink_metadata(&c.path).map_err(fs_errno)
    }

    fn set_stat(&self, r: &mut Reader<'_>) -> Result<Handled, Malformed> {
        let fd = r.u64()?;
        let mask = r.u32()?;
        let mode = r.u32()?;
        let _uid = r.u32()?;
        let _gid = r.u32()?;
        let size = r.u64()?;
        let atime = (r.i64()?, r.i64()?);
        let mtime = (r.i64()?, r.i64()?);
        Ok((|| {
            self.writable()?;
            if mask & !SET_STAT_SUPPORTED != 0 {
                return Err(libc::EPERM);
            }
            let state = self.state();
            let c = state.control(fd)?;
            if c.deleted {
                return Err(libc::EINVAL);
            }
            let mut failed = 0u32;
            let mut first_errno = 0;
            let mut fail = |bit: u32, errno: Errno| {
                failed |= bit;
                if first_errno == 0 {
                    first_errno = errno;
                }
            };
            if mask & STATX_MODE != 0 && c.kind != Kind::Symlink {
                self.export.modes.set(&c.path, mode & MODE_BITS);
            }
            if mask & STATX_SIZE_BIT != 0 {
                let result = match c.kind {
                    Kind::Dir => Err(libc::EISDIR),
                    Kind::File => self
                        .open_file(&c.path, true, true, false)
                        .and_then(|mut f| set_len(&mut f, size)),
                    _ => Err(libc::EINVAL),
                };
                if let Err(e) = result {
                    fail(STATX_SIZE_BIT, e);
                }
            }
            if mask & (STATX_ATIME | STATX_MTIME) != 0 && c.kind == Kind::File {
                let pick = |bit: u32, (sec, nsec): (i64, i64)| -> Option<u64> {
                    if mask & bit == 0 || nsec == i64::from(UTIME_OMIT) {
                        return None;
                    }
                    if nsec == i64::from(UTIME_NOW) {
                        return Some(now_nanos());
                    }
                    Some(
                        (sec.max(0) as u64).saturating_mul(1_000_000_000)
                            + nsec.clamp(0, 999_999_999) as u64,
                    )
                };
                let (a, m) = (pick(STATX_ATIME, atime), pick(STATX_MTIME, mtime));
                let result = self
                    .open_file(&c.path, true, false, false)
                    .and_then(|mut f| f.set_times(a, m).map_err(fs_errno));
                if let Err(e) = result {
                    fail(mask & (STATX_ATIME | STATX_MTIME), e);
                }
            }
            // Owners are not kept: a job runs as one user, which owns
            // everything (as under WASIX).
            let mut w = Writer::default();
            w.u32(failed).u32(first_errno as u32);
            Ok((w.buf, Vec::new()))
        })())
    }

    fn statfs(&self) -> Handled {
        // A nominal size: what bounds the job's writes is its memory,
        // which the job's budget enforces as writes happen.
        const BLOCK: u64 = 4096;
        const BLOCKS: u64 = (64 << 30) / BLOCK;
        let mut w = Writer::default();
        w.u64(TMPFS_MAGIC)
            .i64(BLOCK as i64)
            .u64(BLOCKS)
            .u64(BLOCKS)
            .u64(BLOCKS)
            .u64(1 << 20)
            .u64(1 << 20)
            .u64(255);
        Ok((w.buf, Vec::new()))
    }

    // ---- walking ------------------------------------------------------

    fn walk(&self, r: &mut Reader<'_>) -> Result<Handled, Malformed> {
        let dir = r.u64()?;
        let names = r.strings()?;
        Ok((|| {
            if 3 + names.len() * INODE_SIZE > MAX_MESSAGE as usize {
                return Err(libc::EIO);
            }
            let mut state = self.state();
            let start = state.control(dir)?;
            if start.kind != Kind::Dir {
                return Err(libc::ENOTDIR);
            }
            let (mut path, mut kind, deleted) = (start.path.clone(), start.kind, start.deleted);
            let mut status = 0u8;
            let mut inodes = Vec::new();
            let mut made = Vec::new();
            let result = (|| {
                if deleted {
                    status = 1;
                    return Ok(());
                }
                for name in &names {
                    check_name(name)?;
                    if kind == Kind::Symlink {
                        status = 2;
                        return Ok(());
                    }
                    let child = joined(&path, name)?;
                    let meta = match self.export.fs.symlink_metadata(&child) {
                        Ok(meta) => meta,
                        Err(FsError::EntryNotFound) => {
                            status = 1;
                            return Ok(());
                        }
                        Err(e) => return Err(fs_errno(e)),
                    };
                    let ino = state.ino(&child)?;
                    let stat = self.statx(&child, &meta, ino);
                    kind = Kind::of(&meta);
                    let fd = state.insert(Fd::Control(Control {
                        path: child.clone(),
                        ino,
                        kind,
                        deleted: false,
                    }))?;
                    made.push(fd);
                    inodes.push((fd, stat));
                    path = child;
                }
                Ok(())
            })();
            if let Err(e) = result {
                for fd in made {
                    state.remove(fd);
                }
                return Err(e);
            }
            let mut w = Writer::default();
            w.u8(status).u16(inodes.len() as u16);
            for (fd, stat) in &inodes {
                w.inode(*fd, stat);
            }
            Ok((w.buf, Vec::new()))
        })())
    }

    fn walk_stat(&self, r: &mut Reader<'_>) -> Result<Handled, Malformed> {
        let dir = r.u64()?;
        let names = r.strings()?;
        Ok((|| {
            if 2 + names.len() * STATX_SIZE > MAX_MESSAGE as usize {
                return Err(libc::EIO);
            }
            let mut state = self.state();
            let start = state.control(dir)?;
            let (start_path, start_kind, start_ino, deleted) =
                (start.path.clone(), start.kind, start.ino, start.deleted);
            let mut names = &names[..];
            if start_kind != Kind::Dir
                && (names.len() > 1 || names.first().is_some_and(|n| !n.is_empty()))
            {
                return Err(libc::ENOTDIR);
            }
            for (i, name) in names.iter().enumerate() {
                if !(i == 0 && name.is_empty()) {
                    check_name(name)?;
                }
            }
            let mut stats = Vec::new();
            if names.first().is_some_and(|n| n.is_empty()) {
                if deleted {
                    return Err(libc::ENOENT);
                }
                let meta = self
                    .export
                    .fs
                    .symlink_metadata(&start_path)
                    .map_err(fs_errno)?;
                stats.push(self.statx(&start_path, &meta, start_ino));
                names = &names[1..];
            }
            let mut path = start_path;
            if !deleted {
                for name in names {
                    let child = joined(&path, name)?;
                    let meta = match self.export.fs.symlink_metadata(&child) {
                        Ok(meta) => meta,
                        Err(FsError::EntryNotFound) => break,
                        Err(e) => return Err(fs_errno(e)),
                    };
                    let ino = state.ino(&child)?;
                    stats.push(self.statx(&child, &meta, ino));
                    if Kind::of(&meta) == Kind::Symlink {
                        break;
                    }
                    if Kind::of(&meta) != Kind::Dir {
                        // Nothing further can be under a file.
                        break;
                    }
                    path = child;
                }
            }
            let mut w = Writer::default();
            w.u16(stats.len() as u16);
            for s in &stats {
                w.statx(s);
            }
            Ok((w.buf, Vec::new()))
        })())
    }

    fn read_link_at(&self, fd: u64) -> Handled {
        let state = self.state();
        let c = state.control(fd)?;
        if c.kind != Kind::Symlink || c.deleted {
            return Err(libc::EINVAL);
        }
        let target = self.export.fs.readlink(&c.path).map_err(fs_errno)?;
        let bytes = target.as_os_str().as_bytes();
        if bytes.len() > u16::MAX as usize {
            return Err(libc::ENAMETOOLONG);
        }
        let mut w = Writer::default();
        w.string(bytes);
        Ok((w.buf, Vec::new()))
    }

    // ---- opening, reading, writing ------------------------------------

    fn open_file(
        &self,
        path: &Path,
        read: bool,
        write: bool,
        truncate: bool,
    ) -> Result<File, Errno> {
        self.export
            .fs
            .new_open_options()
            .read(read)
            .write(write)
            .truncate(truncate)
            .open(path)
            .map_err(fs_errno)
    }

    fn open_at(&self, fd: u64, flags: u32) -> Handled {
        let flags = flags & (libc::O_ACCMODE | libc::O_TRUNC) as u32;
        let access = flags & libc::O_ACCMODE as u32;
        let truncate = flags & libc::O_TRUNC as u32 != 0;
        let read = access != libc::O_WRONLY as u32;
        let write = access != libc::O_RDONLY as u32;
        if self.export.read_only && (write || truncate) {
            return Err(libc::EROFS);
        }
        let mut state = self.state();
        let c = state.control(fd)?;
        if c.deleted || c.kind == Kind::Symlink {
            return Err(libc::EINVAL);
        }
        let open = match c.kind {
            Kind::Dir => {
                if write || truncate {
                    return Err(libc::EISDIR);
                }
                Open {
                    node: c.clone(),
                    file: None,
                    readable: true,
                    writable: false,
                    listing: None,
                }
            }
            Kind::File => Open {
                node: c.clone(),
                file: Some(self.open_file(&c.path, read, write, truncate)?),
                readable: read,
                writable: write,
                listing: None,
            },
            _ => return Err(libc::EPERM),
        };
        let id = state.insert(Fd::Open(open))?;
        let mut w = Writer::default();
        w.u64(id);
        Ok((w.buf, Vec::new()))
    }

    /// The directory a creating request names, and the new child's path.
    fn child_of(&self, state: &State, dir: u64, name: &[u8]) -> Result<PathBuf, Errno> {
        self.writable()?;
        check_name(name)?;
        let c = state.control(dir)?;
        if c.kind != Kind::Dir {
            return Err(libc::ENOTDIR);
        }
        if c.deleted {
            return Err(libc::EINVAL);
        }
        joined(&c.path, name)
    }

    /// Charges a new entry at `path` to the job's budget: refused (ENOSPC)
    /// when the budget has no room, as a write past it is.
    fn charge(&self, state: &mut State, path: &Path) -> Result<(), Errno> {
        if let Some(budget) = &self.export.budget {
            if !budget.take(entry_cost(path)) {
                return Err(libc::ENOSPC);
            }
            state.created.insert(path_hash(path));
        }
        Ok(())
    }

    /// Gives back what [`Self::charge`] took for `path`, when it did.
    fn uncharge(&self, state: &mut State, path: &Path) {
        if let Some(budget) = &self.export.budget
            && state.created.remove(&path_hash(path))
        {
            budget.give(entry_cost(path));
        }
    }

    /// Records `perm` for a new file at `path`, unless it is the default
    /// (which is what WASIX gives every new file).
    fn created_with(&self, path: &Path, perm: u32, default: u32) {
        if perm & MODE_BITS != default {
            self.export.modes.set(path, perm & MODE_BITS);
        }
    }

    /// A new control FD for what is now at `path`, and its `Inode`.
    fn new_control(&self, state: &mut State, path: PathBuf) -> Result<(u64, Statx), Errno> {
        let meta = self.export.fs.symlink_metadata(&path).map_err(fs_errno)?;
        let ino = state.ino(&path)?;
        let stat = self.statx(&path, &meta, ino);
        let fd = state.insert(Fd::Control(Control {
            path,
            ino,
            kind: Kind::of(&meta),
            deleted: false,
        }))?;
        Ok((fd, stat))
    }

    fn open_create_at(&self, r: &mut Reader<'_>) -> Result<Handled, Malformed> {
        let (dir, mode) = create_common(r)?;
        let flags = r.u32()?;
        let name = r.string()?;
        Ok((|| {
            let mut state = self.state();
            let path = self.child_of(&state, dir, name)?;
            let access = flags & libc::O_ACCMODE as u32;
            let read = access != libc::O_WRONLY as u32;
            let write = access != libc::O_RDONLY as u32;
            // Opened for writing whatever was asked: creating is a write.
            // The open FD keeps to what was asked.
            self.charge(&mut state, &path)?;
            let file = match self
                .export
                .fs
                .new_open_options()
                .read(true)
                .write(true)
                .create_new(true)
                .open(&path)
            {
                Ok(file) => file,
                Err(e) => {
                    self.uncharge(&mut state, &path);
                    return Err(fs_errno(e));
                }
            };
            self.created_with(&path, mode, DEFAULT_FILE_MODE);
            let (control, stat) = self.new_control(&mut state, path)?;
            let node = state.control(control)?.clone();
            let open = state.insert(Fd::Open(Open {
                node,
                file: Some(file),
                readable: read,
                writable: write,
                listing: None,
            }))?;
            let mut w = Writer::default();
            w.inode(control, &stat).u64(open);
            Ok((w.buf, Vec::new()))
        })())
    }

    fn pread(&self, r: &mut Reader<'_>) -> Result<Handled, Malformed> {
        let offset = r.u64()?;
        let fd = r.u64()?;
        let count = r.u32()?;
        Ok((|| {
            if 8 + u64::from(count) > u64::from(MAX_MESSAGE) {
                return Err(libc::ENOBUFS);
            }
            let mut state = self.state();
            let open = state.open(fd)?;
            if !open.readable {
                return Err(libc::EBADF);
            }
            let file = open.file.as_mut().ok_or(libc::EISDIR)?;
            let mut buf = vec![0u8; count as usize];
            let mut got = 0;
            block_on(async {
                file.seek(SeekFrom::Start(offset)).await?;
                while got < buf.len() {
                    let n = file.read(&mut buf[got..]).await?;
                    if n == 0 {
                        break;
                    }
                    got += n;
                }
                Ok::<(), std::io::Error>(())
            })
            .map_err(io_errno)?;
            buf.truncate(got);
            let mut w = Writer::default();
            w.u64(got as u64).bytes(&buf);
            Ok((w.buf, Vec::new()))
        })())
    }

    fn pwrite(&self, r: &mut Reader<'_>) -> Result<Handled, Malformed> {
        let offset = r.u64()?;
        let fd = r.u64()?;
        let count = r.u32()? as usize;
        let rest = r.rest();
        if rest.len() < count {
            return Err(Malformed);
        }
        let data = &rest[..count];
        Ok((|| {
            self.writable()?;
            let mut state = self.state();
            let open = state.open(fd)?;
            if !open.writable {
                return Err(libc::EBADF);
            }
            let file = open.file.as_mut().ok_or(libc::EISDIR)?;
            block_on(async {
                file.seek(SeekFrom::Start(offset)).await?;
                file.write_all(data).await
            })
            .map_err(io_errno)?;
            let mut w = Writer::default();
            w.u64(data.len() as u64);
            Ok((w.buf, Vec::new()))
        })())
    }

    fn flush(&self, fd: u64) -> Result<(), Errno> {
        let mut state = self.state();
        let open = state.open(fd)?;
        if let Some(file) = open.file.as_mut() {
            block_on(file.flush()).map_err(io_errno)?;
        }
        Ok(())
    }

    fn fallocate(&self, r: &mut Reader<'_>) -> Result<Handled, Malformed> {
        let fd = r.u64()?;
        let mode = r.u64()?;
        let offset = r.u64()?;
        let length = r.u64()?;
        Ok((|| {
            self.writable()?;
            let mut state = self.state();
            let open = state.open(fd)?;
            if !open.writable {
                return Err(libc::EBADF);
            }
            if mode != 0 {
                return Err(libc::EOPNOTSUPP);
            }
            let file = open.file.as_mut().ok_or(libc::EISDIR)?;
            let end = offset.checked_add(length).ok_or(libc::EFBIG)?;
            if end > file.size() {
                set_len(file, end)?;
            }
            Ok((Vec::new(), Vec::new()))
        })())
    }

    fn getdents(&self, r: &mut Reader<'_>) -> Result<Handled, Malformed> {
        let fd = r.u64()?;
        let count = r.i32()?;
        Ok((|| {
            let rewind = count < 0;
            let budget = (count.unsigned_abs() as usize).min(MAX_MESSAGE as usize - 2);
            let mut state = self.state();
            let (node, needs_listing) = {
                let open = state.open(fd)?;
                (open.node.clone(), rewind || open.listing.is_none())
            };
            if needs_listing {
                let c = &node;
                if c.kind != Kind::Dir {
                    return Err(libc::ENOTDIR);
                }
                if c.deleted {
                    return Err(libc::EINVAL);
                }
                let path = c.path.clone();
                let listing = self.list(&mut state, &path)?;
                state.open(fd)?.listing = Some((listing, 0));
            }
            let open = state.open(fd)?;
            let (entries, next) = open.listing.as_mut().ok_or(libc::EIO)?;
            let mut w = Writer::default();
            w.u16(0);
            let mut used = 0;
            let mut n = 0u16;
            while *next < entries.len() && n < u16::MAX {
                let e = &entries[*next];
                let size = 27 + e.name.len();
                if used + size > budget {
                    break;
                }
                w.u64(e.ino)
                    .u32(0)
                    .u32(0)
                    .u64(*next as u64 + 1)
                    .u8(e.kind)
                    .string(&e.name);
                used += size;
                n += 1;
                *next += 1;
            }
            w.buf[..2].copy_from_slice(&n.to_le_bytes());
            Ok((w.buf, Vec::new()))
        })())
    }

    fn list(&self, state: &mut State, path: &Path) -> Result<Vec<Dirent>, Errno> {
        let entries = self.export.fs.read_dir(path).map_err(fs_errno)?;
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let Some(name) = entry.path.file_name() else {
                continue;
            };
            let child = path.join(name);
            let kind = entry
                .metadata
                .as_ref()
                .ok()
                .map(Kind::of)
                .or_else(|| {
                    self.export
                        .fs
                        .symlink_metadata(&child)
                        .ok()
                        .map(|m| Kind::of(&m))
                })
                .unwrap_or(Kind::Other);
            out.push(Dirent {
                name: name.as_bytes().to_vec(),
                ino: state.listed_ino(&child),
                kind: kind.dirent_type(),
            });
        }
        Ok(out)
    }

    // ---- creating and removing ----------------------------------------

    fn mkdir_at(&self, r: &mut Reader<'_>) -> Result<Handled, Malformed> {
        let (dir, mode) = create_common(r)?;
        let name = r.string()?;
        Ok((|| {
            let mut state = self.state();
            let path = self.child_of(&state, dir, name)?;
            self.charge(&mut state, &path)?;
            if let Err(e) = self.export.fs.create_dir(&path) {
                self.uncharge(&mut state, &path);
                return Err(fs_errno(e));
            }
            self.created_with(&path, mode, DEFAULT_DIR_MODE);
            let (fd, stat) = self.new_control(&mut state, path)?;
            let mut w = Writer::default();
            w.inode(fd, &stat);
            Ok((w.buf, Vec::new()))
        })())
    }

    fn mknod_at(&self, r: &mut Reader<'_>) -> Result<Handled, Malformed> {
        let (dir, mode) = create_common(r)?;
        let _minor = r.u32()?;
        let _major = r.u32()?;
        let name = r.string()?;
        Ok((|| {
            let mut state = self.state();
            let path = self.child_of(&state, dir, name)?;
            // Only regular files: the job's file system has no devices,
            // FIFOs or sockets (the sandbox keeps those to itself).
            if mode & S_IFMT != S_IFREG && mode & S_IFMT != 0 {
                return Err(libc::EPERM);
            }
            self.charge(&mut state, &path)?;
            if let Err(e) = self
                .export
                .fs
                .new_open_options()
                .write(true)
                .create_new(true)
                .open(&path)
            {
                self.uncharge(&mut state, &path);
                return Err(fs_errno(e));
            }
            self.created_with(&path, mode, DEFAULT_FILE_MODE);
            let (fd, stat) = self.new_control(&mut state, path)?;
            let mut w = Writer::default();
            w.inode(fd, &stat);
            Ok((w.buf, Vec::new()))
        })())
    }

    fn symlink_at(&self, r: &mut Reader<'_>) -> Result<Handled, Malformed> {
        let dir = r.u64()?;
        let _uid = r.u32()?;
        let _gid = r.u32()?;
        let name = r.string()?;
        let target = r.string()?;
        Ok((|| {
            let mut state = self.state();
            let path = self.child_of(&state, dir, name)?;
            if target.is_empty() || target.contains(&0) {
                return Err(libc::ENOENT);
            }
            if self.export.fs.symlink_metadata(&path).is_ok() {
                return Err(libc::EEXIST);
            }
            self.charge(&mut state, &path)?;
            if let Err(e) = self
                .export
                .fs
                .create_symlink(Path::new(OsStr::from_bytes(target)), &path)
            {
                self.uncharge(&mut state, &path);
                return Err(fs_errno(e));
            }
            let (fd, stat) = self.new_control(&mut state, path)?;
            let mut w = Writer::default();
            w.inode(fd, &stat);
            Ok((w.buf, Vec::new()))
        })())
    }

    fn link_at(&self, r: &mut Reader<'_>) -> Result<Handled, Malformed> {
        let dir = r.u64()?;
        let target = r.u64()?;
        let name = r.string()?;
        Ok((|| {
            let mut state = self.state();
            let path = self.child_of(&state, dir, name)?;
            let t = state.control(target)?;
            if t.kind == Kind::Dir {
                return Err(libc::EPERM);
            }
            if t.deleted {
                return Err(libc::EINVAL);
            }
            let from = t.path.clone();
            // The job's file system has no hard links (as under WASIX,
            // where `link()` fails with EPERM too).
            self.export
                .fs
                .hard_link(&from, &path)
                .map_err(|e| match e {
                    FsError::Unsupported | FsError::PermissionDenied => libc::EPERM,
                    e => fs_errno(e),
                })?;
            let (fd, stat) = self.new_control(&mut state, path)?;
            let mut w = Writer::default();
            w.inode(fd, &stat);
            Ok((w.buf, Vec::new()))
        })())
    }

    fn unlink_at(&self, r: &mut Reader<'_>) -> Result<Handled, Malformed> {
        let dir = r.u64()?;
        let flags = r.u32()?;
        let name = r.string()?;
        Ok((|| {
            let mut state = self.state();
            let path = self.child_of(&state, dir, name)?;
            let meta = self.export.fs.symlink_metadata(&path).map_err(fs_errno)?;
            let is_dir = Kind::of(&meta) == Kind::Dir;
            if flags & libc::AT_REMOVEDIR as u32 != 0 {
                if !is_dir {
                    return Err(libc::ENOTDIR);
                }
                self.export.fs.remove_dir(&path).map_err(fs_errno)?;
            } else {
                if is_dir {
                    return Err(libc::EISDIR);
                }
                self.export.fs.remove_file(&path).map_err(fs_errno)?;
            }
            self.uncharge(&mut state, &path);
            state.gone(&path);
            Ok((Vec::new(), Vec::new()))
        })())
    }

    fn rename_at(&self, r: &mut Reader<'_>, with_flags: bool) -> Result<Handled, Malformed> {
        let old_dir = r.u64()?;
        let new_dir = r.u64()?;
        let old_name = r.string()?;
        let new_name = r.string()?;
        let flags = if with_flags { r.u32()? } else { 0 };
        Ok((|| {
            let mut state = self.state();
            let from = self.child_of(&state, old_dir, old_name)?;
            let to = self.child_of(&state, new_dir, new_name)?;
            if flags & !RENAME_NOREPLACE != 0 {
                // RENAME_EXCHANGE and RENAME_WHITEOUT: not on this file
                // system, as on many.
                return Err(libc::EINVAL);
            }
            if from == to {
                return Ok((Vec::new(), Vec::new()));
            }
            let fs = &self.export.fs;
            let from_meta = fs.symlink_metadata(&from).map_err(fs_errno)?;
            let from_dir = Kind::of(&from_meta) == Kind::Dir;
            if from_dir && to.starts_with(&from) {
                return Err(libc::EINVAL);
            }
            let replaced = match fs.symlink_metadata(&to) {
                Ok(meta) => {
                    if flags & RENAME_NOREPLACE != 0 {
                        return Err(libc::EEXIST);
                    }
                    let to_dir = Kind::of(&meta) == Kind::Dir;
                    match (from_dir, to_dir) {
                        (true, false) => return Err(libc::ENOTDIR),
                        (false, true) => return Err(libc::EISDIR),
                        (true, true) => {
                            if fs.read_dir(&to).map_err(fs_errno)?.next().is_some() {
                                return Err(libc::ENOTEMPTY);
                            }
                            fs.remove_dir(&to).map_err(fs_errno)?;
                        }
                        (false, false) => {}
                    }
                    true
                }
                Err(FsError::EntryNotFound) => false,
                Err(e) => return Err(fs_errno(e)),
            };
            match block_on(fs.rename(&from, &to)) {
                Ok(()) => {}
                // A file system whose rename does not replace: the target
                // goes first. Nothing in the sandbox sees the gap, since
                // every request waits on this one.
                Err(FsError::AlreadyExists) if replaced && !from_dir => {
                    fs.remove_file(&to).map_err(fs_errno)?;
                    block_on(fs.rename(&from, &to)).map_err(fs_errno)?;
                }
                Err(e) => return Err(fs_errno(e)),
            }
            if replaced {
                self.uncharge(&mut state, &to);
                state.gone(&to);
            }
            if state.created.remove(&path_hash(&from)) {
                state.created.insert(path_hash(&to));
            }
            state.moved(&from, &to);
            Ok((Vec::new(), Vec::new()))
        })())
    }

    fn writable(&self) -> Result<(), Errno> {
        if self.export.read_only {
            Err(libc::EROFS)
        } else {
            Ok(())
        }
    }
}

impl State {
    fn insert(&mut self, fd: Fd) -> Result<u64, Errno> {
        if self.fds.len() >= MAX_FDS {
            return Err(libc::ENFILE);
        }
        let path = match &fd {
            Fd::Control(c) => &c.path,
            Fd::Open(o) => &o.node.path,
        };
        let cost = path_cost(path);
        self.room(cost)?;
        if let Some(n) = self.inos.get_mut(path) {
            n.refs += 1;
        }
        self.bytes += cost;
        let id = self.next_fd;
        self.next_fd += 1;
        self.fds.insert(id, fd);
        Ok(id)
    }

    /// Closes FD `id`.
    fn remove(&mut self, id: u64) {
        let Some(mut fd) = self.fds.remove(&id) else {
            return;
        };
        let c = fd.node_mut();
        self.bytes = self.bytes.saturating_sub(path_cost(&c.path));
        // A file no FD names any more has no dentry in the sandbox's
        // kernel either: its number goes, and a later walk gives a new one.
        if !c.deleted
            && let Some(n) = self.inos.get_mut(&c.path)
        {
            n.refs = n.refs.saturating_sub(1);
            if n.refs == 0 {
                self.inos.remove(&c.path);
                self.bytes = self.bytes.saturating_sub(path_cost(&c.path));
            }
        }
    }

    /// Makes room for `cost` more bytes, forgetting the inode numbers no FD
    /// names if it has to; ENFILE when there is none.
    fn room(&mut self, cost: usize) -> Result<(), Errno> {
        if self.bytes + cost > MAX_STATE_BYTES {
            self.sweep();
        }
        if self.bytes + cost > MAX_STATE_BYTES {
            return Err(libc::ENFILE);
        }
        Ok(())
    }

    /// Forgets every inode number no FD names.
    fn sweep(&mut self) {
        let mut freed = 0;
        self.inos.retain(|path, n| {
            if n.refs == 0 {
                freed += path_cost(path);
                false
            } else {
                true
            }
        });
        self.bytes = self.bytes.saturating_sub(freed);
    }

    fn control(&self, id: u64) -> Result<&Control, Errno> {
        match self.fds.get(&id) {
            Some(Fd::Control(c)) => Ok(c),
            Some(Fd::Open(_)) => Err(libc::EINVAL),
            None => Err(libc::EBADF),
        }
    }

    fn open(&mut self, id: u64) -> Result<&mut Open, Errno> {
        match self.fds.get_mut(&id) {
            Some(Fd::Open(o)) => Ok(o),
            Some(Fd::Control(_)) => Err(libc::EINVAL),
            None => Err(libc::EBADF),
        }
    }

    /// The inode number of the file at `path`, given one if it has none.
    fn ino(&mut self, path: &Path) -> Result<u64, Errno> {
        if let Some(n) = self.inos.get(path) {
            return Ok(n.ino);
        }
        let cost = path_cost(path);
        self.room(cost)?;
        let ino = self.next_ino;
        self.next_ino += 1;
        self.inos
            .insert(path.to_path_buf(), Numbered { ino, refs: 0 });
        self.bytes += cost;
        Ok(ino)
    }

    /// The inode number a directory listing gives `path`: its own when it
    /// has one, else a fresh one, not kept (a listing names every entry of
    /// a directory, and keeping them all would grow without end).
    fn listed_ino(&mut self, path: &Path) -> u64 {
        match self.inos.get(path) {
            Some(n) => n.ino,
            None => {
                self.next_ino += 1;
                self.next_ino - 1
            }
        }
    }

    /// What was at `path` (and under it) is gone: its control FDs name a
    /// deleted file and its inode numbers are retired.
    fn gone(&mut self, path: &Path) {
        for fd in self.fds.values_mut() {
            let c = fd.node_mut();
            if c.path.starts_with(path) {
                c.deleted = true;
            }
        }
        let under: Vec<PathBuf> = self
            .inos
            .range(path.to_path_buf()..)
            .take_while(|(p, _)| p.starts_with(path))
            .map(|(p, _)| p.clone())
            .collect();
        for p in under {
            self.inos.remove(&p);
            self.bytes = self.bytes.saturating_sub(path_cost(&p));
        }
    }

    /// What was at `from` (and under it) is now at `to`.
    fn moved(&mut self, from: &Path, to: &Path) {
        let mut bytes = self.bytes;
        for fd in self.fds.values_mut() {
            let c = fd.node_mut();
            if !c.deleted
                && let Ok(rest) = c.path.strip_prefix(from)
            {
                let new = join_rest(to, rest);
                bytes = (bytes + path_cost(&new)).saturating_sub(path_cost(&c.path));
                c.path = new;
            }
        }
        let under: Vec<PathBuf> = self
            .inos
            .range(from.to_path_buf()..)
            .take_while(|(p, _)| p.starts_with(from))
            .map(|(p, _)| p.clone())
            .collect();
        for p in under {
            let Some(n) = self.inos.remove(&p) else {
                continue;
            };
            bytes = bytes.saturating_sub(path_cost(&p));
            if let Ok(rest) = p.strip_prefix(from) {
                let new = join_rest(to, rest);
                bytes += path_cost(&new);
                self.inos.insert(new, n);
            }
        }
        self.bytes = bytes;
    }
}

/// `dir/name`, refused (ENAMETOOLONG) past [`MAX_PATH`].
fn joined(dir: &Path, name: &[u8]) -> Result<PathBuf, Errno> {
    if dir.as_os_str().len() + 1 + name.len() > MAX_PATH {
        return Err(libc::ENAMETOOLONG);
    }
    Ok(dir.join(OsStr::from_bytes(name)))
}

/// What keeping `path` takes, roughly: its bytes and a map entry.
fn path_cost(path: &Path) -> usize {
    path.as_os_str().len() + 64
}

/// What a new entry at `path` is charged to the job's budget: what the
/// job's file system keeps for it.
fn entry_cost(path: &Path) -> u64 {
    ENTRY_COST + path.file_name().map_or(0, |n| n.len() as u64)
}

fn path_hash(path: &Path) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    h.finish()
}

fn join_rest(to: &Path, rest: &Path) -> PathBuf {
    if rest.as_os_str().is_empty() {
        to.to_path_buf()
    } else {
        to.join(rest)
    }
}

fn stat_from(mode: u32, ino: u64, size: u64, meta: &Metadata, kind: Kind) -> Statx {
    Statx {
        mask: STATX_BASIC_STATS,
        blksize: 4096,
        nlink: if kind == Kind::Dir { 2 } else { 1 },
        mode: mode as u16,
        ino,
        size,
        blocks: size.div_ceil(512),
        atime: Timestamp::from_nanos(meta.accessed),
        btime: Timestamp::from_nanos(meta.created),
        ctime: Timestamp::from_nanos(meta.modified),
        mtime: Timestamp::from_nanos(meta.modified),
        ..Statx::default()
    }
}

/// `DirFD, UID, GID, Mode, padding` at the front of the creating requests;
/// the directory and the mode.
fn create_common(r: &mut Reader<'_>) -> Result<(u64, u32), Malformed> {
    let dir = r.u64()?;
    let _uid = r.u32()?;
    let _gid = r.u32()?;
    let mode = u32::from(r.u16()?);
    r.skip(2 + 4)?;
    Ok((dir, mode))
}

/// One path component, as gVisor's `checkSafeName` has it: nothing that
/// could step out of the directory it is looked up in.
fn check_name(name: &[u8]) -> Result<(), Errno> {
    if name.is_empty() || name == b"." || name == b".." || name.contains(&b'/') || name.contains(&0)
    {
        return Err(libc::EINVAL);
    }
    if name.len() > 255 {
        return Err(libc::ENAMETOOLONG);
    }
    Ok(())
}

fn error_reply(errno: Errno) -> (u16, Vec<u8>, Vec<OwnedFd>) {
    (
        mid::ERROR,
        (errno as u32).to_le_bytes().to_vec(),
        Vec::new(),
    )
}

fn eio(_: Malformed) -> Errno {
    libc::EIO
}

fn dup(fd: i32) -> Result<OwnedFd, Errno> {
    use std::os::fd::FromRawFd;
    // SAFETY: duplicating a descriptor we hold; the result is checked.
    let raw = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
    if raw < 0 {
        return Err(std::io::Error::last_os_error()
            .raw_os_error()
            .unwrap_or(libc::EIO));
    }
    // SAFETY: just created and ours.
    Ok(unsafe { OwnedFd::from_raw_fd(raw) })
}

/// Sends each of `fds` as its own message on a channel's descriptor socket
/// (`pkg/fdchannel`), and says how many went.
fn send_fds(sock: &OwnedFd, fds: &[OwnedFd]) -> u8 {
    let mut sent = 0u8;
    for fd in fds.iter().take(u8::MAX as usize) {
        let mut control = vec![0u8; super::sock::cmsg_space(1)];
        // SAFETY: zeroed is a valid msghdr; it points at `control` only.
        let mut msg: libc::msghdr = unsafe { std::mem::zeroed() };
        super::sock::fill_rights(&mut msg, &mut control, &[fd.as_raw_fd()]);
        // SAFETY: as above.
        if unsafe { libc::sendmsg(sock.as_raw_fd(), &msg, libc::MSG_NOSIGNAL) } < 0 {
            break;
        }
        sent += 1;
    }
    sent
}

/// Resizes `file`.
fn set_len(file: &mut File, size: u64) -> Result<(), Errno> {
    file.set_len(size).map_err(fs_errno)?;
    block_on(file.flush()).map_err(io_errno)
}

fn now_nanos() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0)
}

fn fs_errno(e: FsError) -> Errno {
    match e {
        FsError::EntryNotFound => libc::ENOENT,
        FsError::AlreadyExists => libc::EEXIST,
        FsError::BaseNotDirectory => libc::ENOTDIR,
        FsError::NotAFile => libc::EISDIR,
        FsError::DirectoryNotEmpty => libc::ENOTEMPTY,
        FsError::PermissionDenied => libc::EPERM,
        FsError::InvalidInput => libc::EINVAL,
        FsError::InvalidFd => libc::EBADF,
        FsError::StorageFull | FsError::WriteZero => libc::ENOSPC,
        FsError::Unsupported => libc::EOPNOTSUPP,
        FsError::NoDevice => libc::ENODEV,
        FsError::WouldBlock => libc::EAGAIN,
        FsError::Interrupted => libc::EINTR,
        FsError::TimedOut => libc::ETIMEDOUT,
        _ => libc::EIO,
    }
}

fn io_errno(e: std::io::Error) -> Errno {
    if let Some(errno) = e.raw_os_error() {
        return errno;
    }
    use std::io::ErrorKind as K;
    match e.kind() {
        K::NotFound => libc::ENOENT,
        K::AlreadyExists => libc::EEXIST,
        K::PermissionDenied => libc::EPERM,
        K::StorageFull | K::WriteZero => libc::ENOSPC,
        K::InvalidInput => libc::EINVAL,
        K::Unsupported => libc::EOPNOTSUPP,
        K::IsADirectory => libc::EISDIR,
        K::NotADirectory => libc::ENOTDIR,
        K::DirectoryNotEmpty => libc::ENOTEMPTY,
        _ => libc::EIO,
    }
}
