//! A FUSE file system served from a `virtual-fs` one: what a Linux
//! machine's `/tmp/workflow` is, over virtio-fs (`virtiofs.rs` carries the
//! requests; this answers them).
//!
//! [`Server::handle`] takes one request as the guest's kernel wrote it and
//! returns the reply's bytes, so everything here is plain bytes in and out
//! and is tested without a machine. The file system it serves is the job's
//! view of the run's scratch directory (`iwci`'s `ScratchView`), which is
//! what makes a machine job behave as an isolate job does: another
//! runner's files show at once and are waited for only when opened, and a
//! file is sent to the other runners once it is closed.
//!
//! The protocol is the kernel's FUSE ABI, 7.31 (`include/uapi/linux/fuse.h`),
//! little endian as the guest is. The guest is untrusted: every length is
//! checked against what arrived, every name is one path component, and a
//! request that does not read answers `EINVAL`. Nothing here reaches the
//! host's own file system; paths only ever name entries of the served one.
//!
//! What is deliberately not offered: locks (not negotiated, so the
//! kernel keeps them in the machine, which is the only place they are
//! taken), extended attributes, `mknod`, `fallocate` and `lseek`'s
//! data/hole queries (all `ENOSYS`, which the kernel remembers), DAX, and
//! the kernel's write-back cache. Ownership is root's, as every job in a
//! machine runs as root. Modes are the scratch directory's own record
//! (`iwci_vfs::Modes`), as the copy into and out of a machine kept them, so
//! a script one machine job marks executable runs in the next.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use futures::executor::block_on;
use iwci_vfs::virtual_fs::{
    AsyncReadExt, AsyncSeekExt, AsyncWriteExt, FsError, Metadata, OpenOptionsConfig, VirtualFile,
};
use iwci_vfs::{DynFs, Modes};

/// The ABI this server speaks; the kernel answers with what it speaks too,
/// and both use the lower.
pub const KERNEL_VERSION: u32 = 7;
pub const KERNEL_MINOR: u32 = 31;
/// The most one read or write carries: 256 pages.
pub const MAX_IO: u32 = 1 << 20;
const MAX_PAGES: u16 = 256;
/// How long the kernel may trust a name or attributes. Short: other jobs,
/// and other runners, change the directory while the machine runs.
const VALID_SECS: u64 = 1;
/// The same for a file system served read only, which nothing changes
/// while the machine runs: the kernel caches it as it would a disk.
const READ_ONLY_VALID_SECS: u64 = 24 * 60 * 60;
/// `FOPEN_KEEP_CACHE`: the kernel keeps a file's pages across opens.
const FOPEN_KEEP_CACHE: u32 = 1 << 1;
const ROOT: u64 = 1;
const IN_HEADER: usize = 40;
const OUT_HEADER: usize = 16;
const NAME_MAX: usize = 255;

// Opcodes.
const LOOKUP: u32 = 1;
const FORGET: u32 = 2;
const GETATTR: u32 = 3;
const SETATTR: u32 = 4;
const READLINK: u32 = 5;
const SYMLINK: u32 = 6;
const MKDIR: u32 = 9;
const UNLINK: u32 = 10;
const RMDIR: u32 = 11;
const RENAME: u32 = 12;
const LINK: u32 = 13;
const OPEN: u32 = 14;
const READ: u32 = 15;
const WRITE: u32 = 16;
const STATFS: u32 = 17;
const RELEASE: u32 = 18;
const FSYNC: u32 = 20;
const FLUSH: u32 = 25;
const INIT: u32 = 26;
const OPENDIR: u32 = 27;
const READDIR: u32 = 28;
const RELEASEDIR: u32 = 29;
const FSYNCDIR: u32 = 30;
const CREATE: u32 = 35;
const INTERRUPT: u32 = 36;
const DESTROY: u32 = 38;
const BATCH_FORGET: u32 = 42;
const RENAME2: u32 = 45;
const SYNCFS: u32 = 50;

// Linux errno values: the guest's.
const ENOENT: i32 = 2;
const EINTR: i32 = 4;
const EIO: i32 = 5;
const EBADF: i32 = 9;
const EAGAIN: i32 = 11;
const EACCES: i32 = 13;
const EEXIST: i32 = 17;
const ENOTDIR: i32 = 20;
const EISDIR: i32 = 21;
const EINVAL: i32 = 22;
const ENOSPC: i32 = 28;
const EROFS: i32 = 30;
const ENAMETOOLONG: i32 = 36;
const ENOSYS: i32 = 38;
const ENOTEMPTY: i32 = 39;
const ETIMEDOUT: i32 = 110;

// `INIT` flags this server takes when the kernel offers them.
const ASYNC_READ: u32 = 1 << 0;
const ATOMIC_O_TRUNC: u32 = 1 << 3;
const BIG_WRITES: u32 = 1 << 5;
const PARALLEL_DIROPS: u32 = 1 << 18;
const MAX_PAGES_FLAG: u32 = 1 << 22;
const WANTED: u32 = ASYNC_READ | ATOMIC_O_TRUNC | BIG_WRITES | PARALLEL_DIROPS | MAX_PAGES_FLAG;

// `SETATTR` valid bits.
const FATTR_MODE: u32 = 1 << 0;
const FATTR_SIZE: u32 = 1 << 3;
const FATTR_FH: u32 = 1 << 6;

// `open(2)` flags, as the guest's kernel passes them.
const O_ACCMODE: u32 = 0o3;
const O_WRONLY: u32 = 0o1;
const O_RDWR: u32 = 0o2;
const O_CREAT: u32 = 0o100;
const O_EXCL: u32 = 0o200;
const O_TRUNC: u32 = 0o1000;
const O_APPEND: u32 = 0o2000;

const RENAME_NOREPLACE: u32 = 1;

const S_IFDIR: u32 = 0o040000;
const S_IFREG: u32 = 0o100000;
const S_IFLNK: u32 = 0o120000;
const DT_DIR: u32 = 4;
const DT_REG: u32 = 8;
const DT_LNK: u32 = 10;

/// What a request comes to: an error (`-errno`), a reply body, or nothing
/// (`FORGET`, `INTERRUPT`).
type Answer = Result<Vec<u8>, i32>;

fn errno(e: FsError) -> i32 {
    match e {
        FsError::EntryNotFound => ENOENT,
        FsError::AlreadyExists => EEXIST,
        FsError::PermissionDenied => EACCES,
        FsError::DirectoryNotEmpty => ENOTEMPTY,
        FsError::BaseNotDirectory => ENOTDIR,
        FsError::NotAFile => EISDIR,
        FsError::InvalidInput | FsError::InvalidData => EINVAL,
        FsError::InvalidFd => EBADF,
        FsError::StorageFull => ENOSPC,
        FsError::Interrupted => EINTR,
        FsError::TimedOut => ETIMEDOUT,
        FsError::WouldBlock => EAGAIN,
        _ => EIO,
    }
}

fn io_errno(e: std::io::Error) -> i32 {
    match e.kind() {
        std::io::ErrorKind::StorageFull => ENOSPC,
        std::io::ErrorKind::NotFound => ENOENT,
        std::io::ErrorKind::PermissionDenied => EACCES,
        std::io::ErrorKind::Interrupted => EINTR,
        std::io::ErrorKind::TimedOut => ETIMEDOUT,
        _ => EIO,
    }
}

/// Reads a request's arguments, never past what arrived.
struct Args<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Args<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], i32> {
        let end = self.pos.checked_add(n).ok_or(EINVAL)?;
        let out = self.buf.get(self.pos..end).ok_or(EINVAL)?;
        self.pos = end;
        Ok(out)
    }
    fn u32(&mut self) -> Result<u32, i32> {
        Ok(u32::from_le_bytes(self.take(4)?.try_into().unwrap()))
    }
    fn u64(&mut self) -> Result<u64, i32> {
        Ok(u64::from_le_bytes(self.take(8)?.try_into().unwrap()))
    }
    fn skip(&mut self, n: usize) -> Result<(), i32> {
        self.take(n).map(drop)
    }
    /// A NUL-terminated name: one path component.
    fn name(&mut self) -> Result<&'a str, i32> {
        let rest = self.buf.get(self.pos..).ok_or(EINVAL)?;
        let len = rest.iter().position(|&b| b == 0).ok_or(EINVAL)?;
        let name = &rest[..len];
        self.pos += len + 1;
        if name.len() > NAME_MAX {
            return Err(ENAMETOOLONG);
        }
        let name = std::str::from_utf8(name).map_err(|_| EINVAL)?;
        if name.is_empty() || name == "." || name == ".." || name.contains('/') {
            return Err(EINVAL);
        }
        Ok(name)
    }
    /// A NUL-terminated symlink target, which may be any path.
    fn target(&mut self) -> Result<&'a str, i32> {
        let rest = self.buf.get(self.pos..).ok_or(EINVAL)?;
        let len = rest.iter().position(|&b| b == 0).ok_or(EINVAL)?;
        self.pos += len + 1;
        if len == 0 || len > 4096 {
            return Err(EINVAL);
        }
        std::str::from_utf8(&rest[..len]).map_err(|_| EINVAL)
    }
}

/// Builds a reply body.
#[derive(Default)]
struct Out(Vec<u8>);

impl Out {
    fn u16(&mut self, v: u16) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn u32(&mut self, v: u32) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn u64(&mut self, v: u64) -> &mut Self {
        self.0.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn zeros(&mut self, n: usize) -> &mut Self {
        self.0.resize(self.0.len() + n, 0);
        self
    }
    fn done(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.0)
    }
}

/// One name the kernel holds: its path in the served file system and how
/// many lookups it has not forgotten.
#[derive(Debug, Clone)]
struct Node {
    path: PathBuf,
    lookups: u64,
}

enum Handle {
    File(Box<Mutex<Box<dyn VirtualFile + Send + Sync + 'static>>>),
    /// A directory's entries as they were when it was opened: name,
    /// number, type.
    Dir(Vec<(String, u64, u32)>),
}

#[derive(Default)]
struct Tables {
    nodes: HashMap<u64, Node>,
    by_path: HashMap<PathBuf, u64>,
    next_node: u64,
    handles: HashMap<u64, std::sync::Arc<Handle>>,
    next_handle: u64,
}

/// Answers FUSE requests from one file system. Shared by the threads that
/// carry requests: every table is behind one lock, held only to look up
/// or change an entry, never across a call into the file system, which
/// can wait (a file still coming from another runner).
pub struct Server {
    fs: DynFs,
    /// The modes of the served files, by path.
    modes: Modes,
    /// Nothing may be written ([`Server::read_only`]).
    read_only: bool,
    tables: Mutex<Tables>,
}

impl std::fmt::Debug for Server {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Server").finish_non_exhaustive()
    }
}

impl Server {
    /// Serves `fs`, its files' modes kept in `modes`.
    pub fn new(fs: DynFs, modes: Modes) -> Self {
        let mut tables = Tables {
            next_node: ROOT + 1,
            next_handle: 1,
            ..Tables::default()
        };
        tables.nodes.insert(
            ROOT,
            Node {
                path: PathBuf::from("/"),
                lookups: 1,
            },
        );
        tables.by_path.insert(PathBuf::from("/"), ROOT);
        Self {
            fs,
            modes,
            read_only: false,
            tables: Mutex::new(tables),
        }
    }

    /// Serves `fs` read only: a machine's own files, which the runner
    /// does not change while the machine runs. Every write is `EROFS`
    /// (the machine writes to its overlay above them), and the kernel may
    /// cache names, attributes and pages for as long as it likes.
    pub fn read_only(fs: DynFs, modes: Modes) -> Self {
        Self {
            read_only: true,
            ..Self::new(fs, modes)
        }
    }

    fn valid_secs(&self) -> u64 {
        if self.read_only {
            READ_ONLY_VALID_SECS
        } else {
            VALID_SECS
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Tables> {
        self.tables.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Answers one request: the reply's bytes, header included, or `None`
    /// when the request has none.
    pub fn handle(&self, request: &[u8]) -> Option<Vec<u8>> {
        let mut args = Args {
            buf: request,
            pos: 0,
        };
        let header = (|| -> Result<(u32, u32, u64, u64), i32> {
            let len = args.u32()?;
            let opcode = args.u32()?;
            let unique = args.u64()?;
            let node = args.u64()?;
            args.skip(IN_HEADER - 24)?;
            Ok((len, opcode, unique, node))
        })();
        let Ok((len, opcode, unique, node)) = header else {
            return None;
        };
        // The request is what its header says, and no more.
        if (len as usize) < IN_HEADER || len as usize > request.len() {
            return Some(reply(unique, Err(EINVAL)));
        }
        args.buf = &request[..len as usize];
        if self.read_only
            && matches!(
                opcode,
                SETATTR
                    | SYMLINK
                    | MKDIR
                    | UNLINK
                    | RMDIR
                    | RENAME
                    | RENAME2
                    | LINK
                    | CREATE
                    | WRITE
            )
        {
            return Some(reply(unique, Err(EROFS)));
        }
        let answer = match opcode {
            FORGET => {
                if let Ok(n) = args.u64() {
                    self.forget(node, n);
                }
                return None;
            }
            BATCH_FORGET => {
                self.batch_forget(&mut args);
                return None;
            }
            INTERRUPT => return None,
            INIT => self.init(&mut args),
            DESTROY => Ok(Vec::new()),
            LOOKUP => self.lookup(node, &mut args),
            GETATTR => self.getattr(node),
            SETATTR => self.setattr(node, &mut args),
            READLINK => self.readlink(node),
            SYMLINK => self.symlink(node, &mut args),
            MKDIR => self.mkdir(node, &mut args),
            UNLINK => self.unlink(node, &mut args, false),
            RMDIR => self.unlink(node, &mut args, true),
            RENAME => self.rename(node, &mut args, false),
            RENAME2 => self.rename(node, &mut args, true),
            LINK => self.link(node, &mut args),
            OPEN => self.open(node, &mut args),
            CREATE => self.create(node, &mut args),
            READ => self.read(&mut args),
            WRITE => self.write(&mut args),
            RELEASE | RELEASEDIR => self.release(&mut args),
            OPENDIR => self.opendir(node),
            READDIR => self.readdir(&mut args),
            STATFS => Ok(statfs()),
            FLUSH | FSYNC | FSYNCDIR | SYNCFS => Ok(Vec::new()),
            _ => Err(ENOSYS),
        };
        Some(reply(unique, answer))
    }

    fn path_of(&self, node: u64) -> Result<PathBuf, i32> {
        self.lock()
            .nodes
            .get(&node)
            .map(|n| n.path.clone())
            .ok_or(ENOENT)
    }

    fn child(&self, parent: u64, name: &str) -> Result<PathBuf, i32> {
        Ok(self.path_of(parent)?.join(name))
    }

    /// The node for `path`, made if it has none; a lookup counts one more.
    fn node_for(&self, path: &Path, lookup: bool) -> u64 {
        let mut t = self.lock();
        let id = match t.by_path.get(path) {
            Some(&id) => id,
            None => {
                let id = t.next_node;
                t.next_node += 1;
                t.nodes.insert(
                    id,
                    Node {
                        path: path.to_path_buf(),
                        lookups: 0,
                    },
                );
                t.by_path.insert(path.to_path_buf(), id);
                id
            }
        };
        if lookup && let Some(n) = t.nodes.get_mut(&id) {
            n.lookups += 1;
        }
        id
    }

    fn forget(&self, node: u64, n: u64) {
        if node == ROOT {
            return;
        }
        let mut t = self.lock();
        let gone = match t.nodes.get_mut(&node) {
            Some(entry) => {
                entry.lookups = entry.lookups.saturating_sub(n);
                entry.lookups == 0
            }
            None => false,
        };
        if gone
            && let Some(entry) = t.nodes.remove(&node)
            && t.by_path.get(&entry.path) == Some(&node)
        {
            t.by_path.remove(&entry.path);
        }
    }

    fn batch_forget(&self, args: &mut Args<'_>) {
        let Ok(count) = args.u32() else { return };
        if args.skip(4).is_err() {
            return;
        }
        for _ in 0..count {
            let (Ok(node), Ok(n)) = (args.u64(), args.u64()) else {
                return;
            };
            self.forget(node, n);
        }
    }

    fn init(&self, args: &mut Args<'_>) -> Answer {
        let major = args.u32()?;
        let _minor = args.u32()?;
        let max_readahead = args.u32()?;
        let flags = args.u32()?;
        if major < KERNEL_VERSION {
            return Err(EIO);
        }
        Ok(Out::default()
            .u32(KERNEL_VERSION)
            .u32(KERNEL_MINOR)
            .u32(max_readahead)
            .u32(flags & WANTED)
            .u16(16) // max_background
            .u16(12) // congestion_threshold
            .u32(MAX_IO) // max_write
            .u32(1) // time_gran: nanoseconds
            .u16(MAX_PAGES)
            .u16(0) // map_alignment
            .u32(0) // flags2
            .zeros(7 * 4)
            .done())
    }

    fn attr(&self, node: u64, path: &Path, meta: &Metadata) -> Vec<u8> {
        let mode = self.modes.get(path);
        let ft = meta.file_type();
        let (kind, default, nlink) = if ft.is_dir() {
            (S_IFDIR, 0o755, 2)
        } else if ft.is_symlink() {
            (S_IFLNK, 0o777, 1)
        } else {
            (S_IFREG, 0o644, 1)
        };
        let secs = |ns: u64| ns / 1_000_000_000;
        let nsec = |ns: u64| (ns % 1_000_000_000) as u32;
        let mut out = Out::default();
        out.u64(node)
            .u64(meta.len)
            .u64(meta.len.div_ceil(512))
            .u64(secs(meta.accessed))
            .u64(secs(meta.modified))
            .u64(secs(meta.modified.max(meta.created)))
            .u32(nsec(meta.accessed))
            .u32(nsec(meta.modified))
            .u32(nsec(meta.modified.max(meta.created)))
            .u32(kind | mode.unwrap_or(default) & 0o7777)
            .u32(nlink)
            .u32(0) // uid
            .u32(0) // gid
            .u32(0) // rdev
            .u32(4096) // blksize
            .u32(0); // flags
        out.done()
    }

    fn entry(&self, node: u64, path: &Path, meta: &Metadata) -> Vec<u8> {
        let mut out = Out::default();
        out.u64(node)
            .u64(0) // generation
            .u64(self.valid_secs())
            .u64(self.valid_secs())
            .u32(0)
            .u32(0);
        let mut body = out.done();
        body.extend(self.attr(node, path, meta));
        body
    }

    fn stat(&self, path: &Path) -> Result<Metadata, i32> {
        self.fs.symlink_metadata(path).map_err(errno)
    }

    /// The reply for a name that now exists at `path`.
    fn found(&self, path: &Path) -> Answer {
        let meta = self.stat(path)?;
        let node = self.node_for(path, true);
        Ok(self.entry(node, path, &meta))
    }

    fn lookup(&self, parent: u64, args: &mut Args<'_>) -> Answer {
        let path = self.child(parent, args.name()?)?;
        self.found(&path)
    }

    fn getattr(&self, node: u64) -> Answer {
        let path = self.path_of(node)?;
        let meta = self.stat(&path)?;
        let mut out = Out::default();
        out.u64(self.valid_secs()).u32(0).u32(0);
        let mut body = out.done();
        body.extend(self.attr(node, &path, &meta));
        Ok(body)
    }

    fn setattr(&self, node: u64, args: &mut Args<'_>) -> Answer {
        let valid = args.u32()?;
        args.skip(4)?;
        let fh = args.u64()?;
        let size = args.u64()?;
        args.skip(8 + 8 + 8 + 8 + 4 + 4 + 4)?; // lock owner, times, nanoseconds
        let mode = args.u32()?;
        let path = self.path_of(node)?;
        if valid & FATTR_SIZE != 0 {
            let handle = if valid & FATTR_FH != 0 {
                self.lock().handles.get(&fh).cloned()
            } else {
                None
            };
            match handle.as_deref() {
                Some(Handle::File(file)) => file
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .set_len(size)
                    .map_err(errno)?,
                _ => {
                    let mut file = self
                        .fs
                        .new_open_options()
                        .write(true)
                        .open(&path)
                        .map_err(errno)?;
                    file.set_len(size).map_err(errno)?;
                }
            }
        }
        if valid & FATTR_MODE != 0 {
            self.modes.set(&path, mode & 0o7777);
        }
        // Ownership and times are not kept: everything is root's, and a
        // file's times are when it was last written.
        self.getattr(node)
    }

    fn readlink(&self, node: u64) -> Answer {
        let path = self.path_of(node)?;
        let target = self.fs.readlink(&path).map_err(errno)?;
        Ok(target.to_string_lossy().into_owned().into_bytes())
    }

    fn symlink(&self, parent: u64, args: &mut Args<'_>) -> Answer {
        let name = args.name()?;
        let target = args.target()?;
        let path = self.child(parent, name)?;
        self.fs
            .create_symlink(Path::new(target), &path)
            .map_err(errno)?;
        self.found(&path)
    }

    fn mkdir(&self, parent: u64, args: &mut Args<'_>) -> Answer {
        let mode = args.u32()?;
        let umask = args.u32()?;
        let path = self.child(parent, args.name()?)?;
        self.fs.create_dir(&path).map_err(errno)?;
        self.modes.set(&path, mode & !umask & 0o7777);
        self.found(&path)
    }

    fn unlink(&self, parent: u64, args: &mut Args<'_>, dir: bool) -> Answer {
        let path = self.child(parent, args.name()?)?;
        if dir {
            self.fs.remove_dir(&path).map_err(errno)?;
        } else {
            if self.stat(&path)?.is_dir() {
                return Err(EISDIR);
            }
            self.fs.remove_file(&path).map_err(errno)?;
        }
        // The node lives until the kernel forgets it; the name is free.
        let mut t = self.lock();
        t.by_path.remove(&path);
        Ok(Vec::new())
    }

    fn rename(&self, parent: u64, args: &mut Args<'_>, flags: bool) -> Answer {
        let new_parent = args.u64()?;
        let flags = if flags {
            let f = args.u32()?;
            args.skip(4)?;
            f
        } else {
            0
        };
        let from = self.child(parent, args.name()?)?;
        let to = self.child(new_parent, args.name()?)?;
        if flags & !RENAME_NOREPLACE != 0 {
            // `RENAME_EXCHANGE` and `RENAME_WHITEOUT`.
            return Err(EINVAL);
        }
        if flags & RENAME_NOREPLACE != 0 && self.fs.symlink_metadata(&to).is_ok() {
            return Err(EEXIST);
        }
        // The served file system moves the modes along (`Modes::renamed`).
        block_on(self.fs.rename(&from, &to)).map_err(errno)?;
        // Every node at or under the old name moves with it.
        let mut t = self.lock();
        t.by_path.remove(&to);
        let moved: Vec<(u64, PathBuf)> = t
            .nodes
            .iter()
            .filter_map(|(&id, n)| {
                let rest = n.path.strip_prefix(&from).ok()?;
                Some((id, to.join(rest)))
            })
            .collect();
        for (id, path) in moved {
            let old = t.nodes.get(&id).map(|n| n.path.clone());
            if let Some(old) = old
                && t.by_path.get(&old) == Some(&id)
            {
                t.by_path.remove(&old);
            }
            if let Some(n) = t.nodes.get_mut(&id) {
                n.path = path.clone();
            }
            t.by_path.insert(path, id);
        }
        Ok(Vec::new())
    }

    fn link(&self, parent: u64, args: &mut Args<'_>) -> Answer {
        let old = args.u64()?;
        let from = self.path_of(old)?;
        let to = self.child(parent, args.name()?)?;
        self.fs.hard_link(&from, &to).map_err(errno)?;
        self.found(&to)
    }

    fn add_handle(&self, handle: Handle) -> u64 {
        let mut t = self.lock();
        let fh = t.next_handle;
        t.next_handle += 1;
        t.handles.insert(fh, std::sync::Arc::new(handle));
        fh
    }

    fn open_file(&self, path: &Path, flags: u32, create: bool) -> Result<u64, i32> {
        let access = flags & O_ACCMODE;
        let conf = OpenOptionsConfig {
            read: access != O_WRONLY,
            write: access == O_WRONLY || access == O_RDWR,
            create_new: create && flags & O_EXCL != 0,
            create,
            append: flags & O_APPEND != 0,
            truncate: flags & O_TRUNC != 0,
        };
        let file = self
            .fs
            .new_open_options()
            .options(conf)
            .open(path)
            .map_err(errno)?;
        Ok(self.add_handle(Handle::File(Box::new(Mutex::new(file)))))
    }

    fn open(&self, node: u64, args: &mut Args<'_>) -> Answer {
        let flags = args.u32()?;
        let path = self.path_of(node)?;
        if self.stat(&path)?.is_dir() {
            return Err(EISDIR);
        }
        if self.read_only && (flags & O_ACCMODE != 0 || flags & O_TRUNC != 0) {
            return Err(EROFS);
        }
        let fh = self.open_file(&path, flags & !(O_CREAT | O_EXCL), false)?;
        let keep = if self.read_only { FOPEN_KEEP_CACHE } else { 0 };
        Ok(Out::default().u64(fh).u32(keep).u32(0).done())
    }

    fn create(&self, parent: u64, args: &mut Args<'_>) -> Answer {
        let flags = args.u32()?;
        let mode = args.u32()?;
        let umask = args.u32()?;
        args.skip(4)?;
        let path = self.child(parent, args.name()?)?;
        let fh = self.open_file(&path, flags | O_CREAT, true)?;
        if flags & O_EXCL != 0 || self.modes.get(&path).is_none() {
            self.modes.set(&path, mode & !umask & 0o7777);
        }
        let entry = match self.found(&path) {
            Ok(entry) => entry,
            Err(e) => {
                self.lock().handles.remove(&fh);
                return Err(e);
            }
        };
        let mut body = entry;
        body.extend(Out::default().u64(fh).u32(0).u32(0).done());
        Ok(body)
    }

    fn file(&self, fh: u64) -> Result<std::sync::Arc<Handle>, i32> {
        self.lock().handles.get(&fh).cloned().ok_or(EBADF)
    }

    fn read(&self, args: &mut Args<'_>) -> Answer {
        let fh = args.u64()?;
        let offset = args.u64()?;
        let size = args.u32()?.min(MAX_IO) as usize;
        let handle = self.file(fh)?;
        let Handle::File(file) = handle.as_ref() else {
            return Err(EISDIR);
        };
        let mut file = file.lock().unwrap_or_else(|e| e.into_inner());
        block_on(file.seek(std::io::SeekFrom::Start(offset))).map_err(io_errno)?;
        let mut buf = vec![0u8; size];
        let mut got = 0;
        while got < size {
            let n = block_on(file.read(&mut buf[got..])).map_err(io_errno)?;
            if n == 0 {
                break;
            }
            got += n;
        }
        buf.truncate(got);
        Ok(buf)
    }

    fn write(&self, args: &mut Args<'_>) -> Answer {
        let fh = args.u64()?;
        let offset = args.u64()?;
        let size = args.u32()?;
        args.skip(4 + 8 + 4 + 4)?; // write flags, lock owner, flags, padding
        if size > MAX_IO {
            return Err(EINVAL);
        }
        let data = args.take(size as usize)?;
        let handle = self.file(fh)?;
        let Handle::File(file) = handle.as_ref() else {
            return Err(EISDIR);
        };
        let mut file = file.lock().unwrap_or_else(|e| e.into_inner());
        block_on(file.seek(std::io::SeekFrom::Start(offset))).map_err(io_errno)?;
        block_on(file.write_all(data)).map_err(io_errno)?;
        Ok(Out::default().u32(size).u32(0).done())
    }

    fn release(&self, args: &mut Args<'_>) -> Answer {
        let fh = args.u64()?;
        // Dropping the last reference closes the file, which is what sends
        // it to the other runners.
        self.lock().handles.remove(&fh);
        Ok(Vec::new())
    }

    fn opendir(&self, node: u64) -> Answer {
        let path = self.path_of(node)?;
        let meta = self.stat(&path)?;
        if !meta.is_dir() {
            return Err(ENOTDIR);
        }
        let listed = self.fs.read_dir(&path).map_err(errno)?;
        let parent = path.parent().map_or(ROOT, |p| self.node_for(p, false));
        let mut entries = vec![
            (".".to_string(), node, DT_DIR),
            ("..".to_string(), parent, DT_DIR),
        ];
        for entry in listed.filter_map(Result::ok) {
            let Some(name) = entry.path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let full = path.join(name);
            let kind = match &entry.metadata {
                Ok(m) if m.is_dir() => DT_DIR,
                Ok(m) if m.file_type().is_symlink() => DT_LNK,
                _ => DT_REG,
            };
            // A number to show; the kernel looks the name up before using
            // it, which counts.
            let id = self.node_for(&full, false);
            entries.push((name.to_string(), id, kind));
        }
        let fh = self.add_handle(Handle::Dir(entries));
        Ok(Out::default().u64(fh).u32(0).u32(0).done())
    }

    fn readdir(&self, args: &mut Args<'_>) -> Answer {
        let fh = args.u64()?;
        let offset = args.u64()? as usize;
        let size = args.u32()?.min(MAX_IO) as usize;
        let handle = self.file(fh)?;
        let Handle::Dir(entries) = handle.as_ref() else {
            return Err(ENOTDIR);
        };
        let mut out = Vec::new();
        for (i, (name, id, kind)) in entries.iter().enumerate().skip(offset) {
            let len = 24 + name.len();
            let padded = len.div_ceil(8) * 8;
            if out.len() + padded > size {
                break;
            }
            out.extend_from_slice(&id.to_le_bytes());
            out.extend_from_slice(&((i + 1) as u64).to_le_bytes());
            out.extend_from_slice(&(name.len() as u32).to_le_bytes());
            out.extend_from_slice(&kind.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.resize(out.len() + padded - len, 0);
        }
        Ok(out)
    }
}

fn statfs() -> Vec<u8> {
    // The directory is held in memory and capped by the run's `scratch:`;
    // what `df` shows is a large round number rather than that cap.
    let blocks: u64 = 1 << 22;
    Out::default()
        .u64(blocks)
        .u64(blocks)
        .u64(blocks)
        .u64(1 << 20)
        .u64(1 << 20)
        .u32(4096)
        .u32(NAME_MAX as u32)
        .u32(4096)
        .u32(0)
        .zeros(6 * 4)
        .done()
}

fn reply(unique: u64, answer: Answer) -> Vec<u8> {
    let (error, body) = match answer {
        Ok(body) => (0, body),
        Err(e) => (-e, Vec::new()),
    };
    let mut out = Vec::with_capacity(OUT_HEADER + body.len());
    out.extend_from_slice(&((OUT_HEADER + body.len()) as u32).to_le_bytes());
    out.extend_from_slice(&error.to_le_bytes());
    out.extend_from_slice(&unique.to_le_bytes());
    out.extend(body);
    out
}

#[cfg(test)]
#[path = "fuse_tests.rs"]
mod tests;
