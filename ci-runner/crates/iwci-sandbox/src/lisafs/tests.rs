//! The server against a client speaking the protocol as gVisor's does
//! (`pkg/lisafs/client.go`), over a real socket pair and a real channel.

use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use iwci_vfs::{Change, JobFs, SnapshotBuilder, WriteBudget};

use super::flipcall::{Endpoint, Side, Window};
use super::sock::Sock;
use super::wire::{Reader, Statx, Writer, mid};
use super::{Export, MAX_MESSAGE, Serving, serve, socket_pair};

struct Client {
    sock: Sock,
    channel: Option<Endpoint>,
    _serving: Serving,
}

type Reply = Result<(Vec<u8>, Vec<OwnedFd>), i32>;

#[derive(Debug, Clone, Copy)]
struct Inode {
    fd: u64,
    stat: Statx,
}

fn read_inode(r: &mut Reader<'_>) -> Inode {
    Inode {
        fd: r.u64().unwrap(),
        stat: Statx::read(r).unwrap(),
    }
}

impl Client {
    fn new(export: Export) -> Self {
        let (ours, theirs) = socket_pair().unwrap();
        let serving = serve(export, ours).unwrap();
        Self {
            sock: Sock::new(theirs),
            channel: None,
            _serving: serving,
        }
    }

    fn call(&self, m: u16, payload: &[u8]) -> Reply {
        if let Some(channel) = &self.channel {
            let mut message = Vec::new();
            message.extend_from_slice(&m.to_le_bytes());
            message.extend_from_slice(&[0, 0]);
            message.extend_from_slice(payload);
            channel.window.write(&message);
            let n = channel.send_recv(message.len()).unwrap();
            let reply = channel.window.read(n);
            let got = u16::from_le_bytes([reply[0], reply[1]]);
            return decode(m, got, reply[4..].to_vec(), Vec::new());
        }
        self.sock.send(m, payload, &[]).unwrap();
        let (got, reply, fds) = self.sock.recv(MAX_MESSAGE, 4).unwrap().unwrap();
        decode(m, got, reply, fds)
    }

    fn ok(&self, m: u16, w: &Writer) -> Vec<u8> {
        match self.call(m, &w.buf) {
            Ok((reply, _)) => reply,
            Err(errno) => panic!("message {m} failed with errno {errno}"),
        }
    }

    fn errno(&self, m: u16, w: &Writer) -> i32 {
        match self.call(m, &w.buf) {
            Ok(_) => panic!("message {m} succeeded"),
            Err(errno) => errno,
        }
    }

    fn mount(&self) -> Inode {
        let reply = self.ok(mid::MOUNT, &Writer::default());
        let mut r = Reader::new(&reply);
        let root = read_inode(&mut r);
        assert_eq!(r.u32().unwrap(), MAX_MESSAGE);
        let count = r.u16().unwrap();
        let supported: Vec<u16> = (0..count).map(|_| r.u16().unwrap()).collect();
        assert!(supported.contains(&mid::CHANNEL) && supported.contains(&mid::RENAME_AT));
        root
    }

    /// Switches to a flipcall channel, as the Sentry does after mounting.
    fn open_channel(&mut self) {
        let (reply, mut fds) = self.call(mid::CHANNEL, &[]).unwrap();
        assert_eq!(
            fds.len(),
            2,
            "a channel comes with its memory and its socket"
        );
        let mut r = Reader::new(&reply);
        let offset = r.u64().unwrap() as i64;
        let length = r.u64().unwrap() as usize;
        let _fd_sock = fds.pop().unwrap();
        let memfd = fds.pop().unwrap();
        let window = Window::map(memfd, offset, length).unwrap();
        let endpoint = Endpoint::new(window, Side::Client);
        endpoint.connect().unwrap();
        self.channel = Some(endpoint);
    }

    fn walk(&self, dir: u64, names: &[&str]) -> (u8, Vec<Inode>) {
        let mut w = Writer::default();
        w.u64(dir).u16(names.len() as u16);
        for n in names {
            w.string(n.as_bytes());
        }
        let reply = self.ok(mid::WALK, &w);
        let mut r = Reader::new(&reply);
        let status = r.u8().unwrap();
        let count = r.u16().unwrap();
        (status, (0..count).map(|_| read_inode(&mut r)).collect())
    }

    fn walk_to(&self, root: u64, path: &str) -> Inode {
        let names: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
        let (status, inodes) = self.walk(root, &names);
        assert_eq!(status, 0, "walking to {path}");
        *inodes.last().unwrap()
    }

    fn open(&self, fd: u64, flags: i32) -> u64 {
        let mut w = Writer::default();
        w.u64(fd).u32(flags as u32).u32(0);
        Reader::new(&self.ok(mid::OPEN_AT, &w)).u64().unwrap()
    }

    fn create(&self, dir: u64, name: &str, mode: u16, flags: i32) -> (Inode, u64) {
        let mut w = Writer::default();
        create_common(&mut w, dir, mode);
        w.u32(flags as u32).string(name.as_bytes());
        let reply = self.ok(mid::OPEN_CREATE_AT, &w);
        let mut r = Reader::new(&reply);
        let inode = read_inode(&mut r);
        (inode, r.u64().unwrap())
    }

    fn pread(&self, fd: u64, offset: u64, count: u32) -> Vec<u8> {
        let mut w = Writer::default();
        w.u64(offset).u64(fd).u32(count).u32(0);
        let reply = self.ok(mid::PREAD, &w);
        let mut r = Reader::new(&reply);
        let n = r.u64().unwrap() as usize;
        r.rest()[..n].to_vec()
    }

    fn pwrite_req(fd: u64, offset: u64, data: &[u8]) -> Writer {
        let mut w = Writer::default();
        w.u64(offset).u64(fd).u32(data.len() as u32).bytes(data);
        w
    }

    fn pwrite(&self, fd: u64, offset: u64, data: &[u8]) {
        let reply = self.ok(mid::PWRITE, &Self::pwrite_req(fd, offset, data));
        assert_eq!(Reader::new(&reply).u64().unwrap(), data.len() as u64);
    }

    fn close(&self, fds: &[u64]) {
        let mut w = Writer::default();
        w.u16(fds.len() as u16);
        for fd in fds {
            w.u64(*fd);
        }
        self.ok(mid::CLOSE, &w);
    }

    fn fstat(&self, fd: u64) -> Statx {
        let mut w = Writer::default();
        w.u64(fd);
        Statx::read(&mut Reader::new(&self.ok(mid::FSTAT, &w))).unwrap()
    }

    fn getdents(&self, fd: u64, count: i32) -> Vec<(String, u64, u8)> {
        let mut w = Writer::default();
        w.u64(fd).i32(count).u32(0);
        let reply = self.ok(mid::GETDENTS64, &w);
        let mut r = Reader::new(&reply);
        let n = r.u16().unwrap();
        (0..n)
            .map(|_| {
                let ino = r.u64().unwrap();
                r.u32().unwrap();
                r.u32().unwrap();
                r.u64().unwrap();
                let kind = r.u8().unwrap();
                let name = String::from_utf8(r.string().unwrap().to_vec()).unwrap();
                (name, ino, kind)
            })
            .collect()
    }

    fn list(&self, dir: u64) -> Vec<(String, u64, u8)> {
        let fd = self.open(dir, libc::O_RDONLY);
        let mut all = self.getdents(fd, -65536);
        loop {
            let more = self.getdents(fd, 65536);
            if more.is_empty() {
                break;
            }
            all.extend(more);
        }
        self.close(&[fd]);
        all.sort();
        all
    }

    fn rename(&self, old_dir: u64, old: &str, new_dir: u64, new: &str) -> Reply {
        let mut w = Writer::default();
        w.u64(old_dir)
            .u64(new_dir)
            .string(old.as_bytes())
            .string(new.as_bytes());
        self.call(mid::RENAME_AT, &w.buf)
    }

    fn unlink(&self, dir: u64, name: &str, flags: i32) -> Reply {
        let mut w = Writer::default();
        w.u64(dir).u32(flags as u32).string(name.as_bytes());
        self.call(mid::UNLINK_AT, &w.buf)
    }

    fn set_stat(&self, fd: u64, mask: u32, mode: u32, size: u64) -> (u32, u32) {
        let mut w = Writer::default();
        w.u64(fd).u32(mask).u32(mode).u32(0).u32(0).u64(size);
        w.i64(0).i64(0).i64(0).i64(0);
        let reply = self.ok(mid::SET_STAT, &w);
        let mut r = Reader::new(&reply);
        (r.u32().unwrap(), r.u32().unwrap())
    }
}

fn create_common(w: &mut Writer, dir: u64, mode: u16) {
    w.u64(dir).u32(0).u32(0).u16(mode).u16(0).u32(0);
}

fn decode(sent: u16, got: u16, reply: Vec<u8>, fds: Vec<OwnedFd>) -> Reply {
    if got == mid::ERROR {
        return Err(Reader::new(&reply).u32().unwrap() as i32);
    }
    assert_eq!(got, sent, "a reply answers its request");
    Ok((reply, fds))
}

#[derive(Debug, Default)]
struct Budget {
    left: AtomicU64,
}

impl WriteBudget for Budget {
    fn take(&self, bytes: u64) -> bool {
        self.left
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |left| {
                left.checked_sub(bytes)
            })
            .is_ok()
    }
    fn give(&self, bytes: u64) {
        self.left.fetch_add(bytes, Ordering::SeqCst);
    }
}

/// A snapshot like a checkout: files, a directory, a symlink, an
/// executable.
fn job(budget: Option<u64>) -> JobFs {
    let b = SnapshotBuilder::new();
    b.write("/work/a.txt", b"hello").unwrap();
    b.write("/work/sub/b.txt", b"bee").unwrap();
    b.write("/work/run.sh", b"#!/bin/sh\necho hi\n").unwrap();
    b.set_mode("/work/run.sh", 0o755).unwrap();
    b.symlink("/work/link", "a.txt").unwrap();
    b.mkdir_all("/tmp").unwrap();
    let snapshot = b.freeze();
    match budget {
        Some(bytes) => snapshot.fork_limited(Arc::new(Budget {
            left: AtomicU64::new(bytes),
        })),
        None => snapshot.fork(),
    }
}

fn export(job: &JobFs) -> Export {
    Export {
        fs: job.as_dyn(),
        modes: job.modes(),
        root: PathBuf::from("/"),
        read_only: false,
    }
}

const S_IFMT: u16 = 0o170_000;

#[test]
fn the_checkout_reads_as_the_job_sees_it() {
    let job = job(None);
    let mut client = Client::new(export(&job));
    let root = client.mount();
    assert_eq!(root.stat.mode & S_IFMT, 0o040_000);
    client.open_channel();

    let work = client.walk_to(root.fd, "work");
    let names: Vec<(String, u8)> = client
        .list(work.fd)
        .into_iter()
        .map(|(n, _, k)| (n, k))
        .collect();
    assert_eq!(
        names,
        [
            ("a.txt".into(), 8),
            ("link".into(), 10),
            ("run.sh".into(), 8),
            ("sub".into(), 4)
        ]
    );

    let a = client.walk_to(root.fd, "work/a.txt");
    assert_eq!((a.stat.mode, a.stat.size), (0o100_644, 5));
    let fd = client.open(a.fd, libc::O_RDONLY);
    assert_eq!(client.pread(fd, 0, 100), b"hello");
    assert_eq!(client.pread(fd, 2, 2), b"ll");
    assert_eq!(client.pread(fd, 10, 2), b"");

    let run = client.walk_to(root.fd, "work/run.sh");
    assert_eq!(run.stat.mode, 0o100_755, "the commit's executable bit");

    // A walk stops at a symlink and says so; the Sentry resolves it.
    let (status, inodes) = client.walk(root.fd, &["work", "link", "x"]);
    assert_eq!((status, inodes.len()), (2, 2));
    assert_eq!(inodes[1].stat.mode & S_IFMT, 0o120_000);
    let mut w = Writer::default();
    w.u64(inodes[1].fd);
    let target = client.ok(mid::READ_LINK_AT, &w);
    assert_eq!(Reader::new(&target).string().unwrap(), b"a.txt");

    // A missing component ends the walk without an error.
    let (status, inodes) = client.walk(root.fd, &["work", "nope", "x"]);
    assert_eq!((status, inodes.len()), (1, 1));
}

#[test]
fn writes_land_in_the_job_as_its_changes() {
    let job = job(None);
    let mut client = Client::new(export(&job));
    let root = client.mount();
    client.open_channel();
    let work = client.walk_to(root.fd, "work");

    let (new, fd) = client.create(work.fd, "new.txt", 0o644, libc::O_WRONLY);
    client.pwrite(fd, 0, b"data");
    client.pwrite(fd, 4, b"!");
    client.close(&[fd]);
    assert_eq!(client.fstat(new.fd).size, 5);

    let a = client.walk_to(root.fd, "work/a.txt");
    let fd = client.open(a.fd, libc::O_RDWR | libc::O_TRUNC);
    client.pwrite(fd, 0, b"HELLO");
    client.close(&[fd]);

    let sub = client.walk_to(root.fd, "work/sub");
    client.unlink(sub.fd, "b.txt", 0).unwrap();
    client.unlink(work.fd, "sub", libc::AT_REMOVEDIR).unwrap();

    // Files the job writes to /tmp are the job's too (#1083).
    let tmp = client.walk_to(root.fd, "tmp");
    let (_, fd) = client.create(tmp.fd, "scratch", 0o600, libc::O_RDWR);
    client.pwrite(fd, 0, b"tmp");
    client.close(&[fd]);

    let changes = job.changes("/");
    assert_eq!(
        changes,
        [
            Change::Added {
                path: "/tmp/scratch".into(),
                bytes: b"tmp".to_vec()
            },
            Change::Modified {
                path: "/work/a.txt".into(),
                bytes: b"HELLO".to_vec()
            },
            Change::Added {
                path: "/work/new.txt".into(),
                bytes: b"data!".to_vec()
            },
            Change::Deleted {
                path: "/work/sub/b.txt".into()
            },
        ]
    );
    assert_eq!(job.modes().get(Path::new("/tmp/scratch")), Some(0o600));
    assert_eq!(
        job.modes().get(Path::new("/work/new.txt")),
        None,
        "the default is not recorded"
    );
}

#[test]
fn renames_move_paths_modes_and_inode_numbers() {
    let job = job(None);
    let client = Client::new(export(&job));
    let root = client.mount();
    let work = client.walk_to(root.fd, "work");
    let run = client.walk_to(root.fd, "work/run.sh");
    let open = client.open(run.fd, libc::O_RDONLY);

    client.rename(work.fd, "run.sh", work.fd, "go.sh").unwrap();
    // The control FD follows the file, and so does its mode.
    let moved = client.fstat(run.fd);
    assert_eq!((moved.mode, moved.ino), (0o100_755, run.stat.ino));
    assert_eq!(client.pread(open, 0, 9), b"#!/bin/sh");
    assert_eq!(job.read("/work/go.sh").unwrap(), b"#!/bin/sh\necho hi\n");
    assert!(job.read("/work/run.sh").is_err());

    // A new file where the old one was is a different inode: the Sentry
    // would otherwise take it for the renamed one.
    let (fresh, fd) = client.create(work.fd, "run.sh", 0o644, libc::O_WRONLY);
    client.close(&[fd]);
    assert_ne!(fresh.stat.ino, run.stat.ino);

    // Over an existing file, which goes; its FD now names a deleted file.
    let a = client.walk_to(root.fd, "work/a.txt");
    client.rename(work.fd, "go.sh", work.fd, "a.txt").unwrap();
    assert_eq!(job.read("/work/a.txt").unwrap(), b"#!/bin/sh\necho hi\n");
    assert_eq!(client.fstat(run.fd).ino, run.stat.ino);
    let mut w = Writer::default();
    w.u64(a.fd);
    assert_eq!(client.errno(mid::FSTAT, &w), libc::ENOENT);

    // A checked-out directory moves with everything under it.
    let sub = client.walk_to(root.fd, "work/sub");
    let b = client.walk_to(root.fd, "work/sub/b.txt");
    client.rename(work.fd, "sub", root.fd, "moved").unwrap();
    assert_eq!(job.read("/moved/b.txt").unwrap(), b"bee");
    assert_eq!(client.fstat(b.fd).ino, b.stat.ino);
    assert_eq!(client.fstat(sub.fd).mode & S_IFMT, 0o040_000);

    // POSIX's refusals.
    assert_eq!(
        client
            .rename(root.fd, "moved", root.fd, "work")
            .unwrap_err(),
        libc::ENOTEMPTY
    );
    assert_eq!(
        client
            .rename(root.fd, "moved", work.fd, "a.txt")
            .unwrap_err(),
        libc::ENOTDIR
    );
    assert_eq!(
        client
            .rename(work.fd, "a.txt", root.fd, "moved")
            .unwrap_err(),
        libc::EISDIR
    );
    let inside = client.walk_to(root.fd, "moved");
    assert_eq!(
        client.rename(root.fd, "moved", inside.fd, "x").unwrap_err(),
        libc::EINVAL
    );
    assert_eq!(
        client.rename(work.fd, "nope", work.fd, "x").unwrap_err(),
        libc::ENOENT
    );
}

#[test]
fn modes_sizes_directories_and_links_change_as_asked() {
    let job = job(None);
    let mut client = Client::new(export(&job));
    let root = client.mount();
    client.open_channel();
    let work = client.walk_to(root.fd, "work");

    // chmod
    let a = client.walk_to(root.fd, "work/a.txt");
    assert_eq!(client.set_stat(a.fd, 0x2, 0o4755, 0), (0, 0));
    assert_eq!(client.fstat(a.fd).mode, 0o104_755);
    assert_eq!(job.modes().get(Path::new("/work/a.txt")), Some(0o4755));

    // truncate
    assert_eq!(client.set_stat(a.fd, 0x200, 0, 2), (0, 0));
    assert_eq!(job.read("/work/a.txt").unwrap(), b"he");

    // mkdir with a mode
    let mut w = Writer::default();
    create_common(&mut w, work.fd, 0o700);
    w.string(b"private");
    let reply = client.ok(mid::MKDIR_AT, &w);
    let dir = read_inode(&mut Reader::new(&reply));
    assert_eq!(dir.stat.mode, 0o040_700);
    assert_eq!(job.modes().get(Path::new("/work/private")), Some(0o700));

    // symlink
    let mut w = Writer::default();
    w.u64(work.fd)
        .u32(0)
        .u32(0)
        .string(b"l2")
        .string(b"../work/a.txt");
    let reply = client.ok(mid::SYMLINK_AT, &w);
    let link = read_inode(&mut Reader::new(&reply));
    assert_eq!(link.stat.mode, 0o120_777);
    assert_eq!(link.stat.size, "../work/a.txt".len() as u64);
    assert_eq!(
        job.as_dyn().readlink(Path::new("/work/l2")).unwrap(),
        PathBuf::from("../work/a.txt")
    );
    assert_eq!(client.errno(mid::SYMLINK_AT, &w), libc::EEXIST);

    // No hard links, as under WASIX.
    let mut w = Writer::default();
    w.u64(work.fd).u64(a.fd).string(b"hard");
    assert_eq!(client.errno(mid::LINK_AT, &w), libc::EPERM);

    // Directory reads in several calls, and a rewind starts over.
    let list = client.open(work.fd, libc::O_RDONLY);
    let first = client.getdents(list, -40);
    assert_eq!(first.len(), 1, "a small budget gives one entry at a time");
    let mut seen = first.len();
    loop {
        let more = client.getdents(list, 40);
        if more.is_empty() {
            break;
        }
        seen += more.len();
    }
    assert_eq!(seen, 6);
    assert_eq!(client.getdents(list, -65536).len(), 6);

    // Inode numbers are the same however a file is reached.
    let listed = client.list(work.fd);
    let (_, ino, _) = listed.iter().find(|(n, _, _)| n == "a.txt").unwrap();
    assert_eq!(*ino, a.stat.ino);
}

#[test]
fn a_write_past_the_budget_is_refused() {
    let job = job(Some(10));
    let client = Client::new(export(&job));
    let root = client.mount();
    let work = client.walk_to(root.fd, "work");
    let (_, fd) = client.create(work.fd, "big", 0o644, libc::O_WRONLY);
    client.pwrite(fd, 0, b"0123456789");
    let errno = client.errno(mid::PWRITE, &Client::pwrite_req(fd, 10, b"x"));
    assert_eq!(errno, libc::ENOSPC);
    // Growing it by truncation counts too.
    let big = client.walk_to(root.fd, "work/big");
    let (failed, errno) = client.set_stat(big.fd, 0x200, 0, 1 << 20);
    assert_eq!((failed, errno as i32), (0x200, libc::ENOSPC));
    // Giving bytes back makes room again.
    client.unlink(work.fd, "big", 0).unwrap();
    let (_, fd) = client.create(work.fd, "again", 0o644, libc::O_WRONLY);
    client.pwrite(fd, 0, b"0123456789");
}

#[test]
fn a_read_only_mount_refuses_changes() {
    let job = job(None);
    let mut e = export(&job);
    e.read_only = true;
    let client = Client::new(e);
    let root = client.mount();
    let work = client.walk_to(root.fd, "work");
    let a = client.walk_to(root.fd, "work/a.txt");
    let fd = client.open(a.fd, libc::O_RDONLY);
    assert_eq!(client.pread(fd, 0, 5), b"hello");
    let mut w = Writer::default();
    w.u64(a.fd).u32(libc::O_RDWR as u32).u32(0);
    assert_eq!(client.errno(mid::OPEN_AT, &w), libc::EROFS);
    let mut w = Writer::default();
    create_common(&mut w, work.fd, 0o644);
    w.u32(0).string(b"x");
    assert_eq!(client.errno(mid::OPEN_CREATE_AT, &w), libc::EROFS);
    assert_eq!(client.unlink(work.fd, "a.txt", 0).unwrap_err(), libc::EROFS);
    assert!(job.changes("/").is_empty());
}

#[test]
fn hostile_requests_get_errors_not_a_crash() {
    let job = job(None);
    let mut client = Client::new(export(&job));
    let root = client.mount();
    client.open_channel();

    // Names that would step outside a directory.
    for name in ["..", ".", "a/b", "", "a\0b"] {
        let mut w = Writer::default();
        w.u64(root.fd).u16(1).string(name.as_bytes());
        assert_eq!(
            client.errno(mid::WALK, &w),
            libc::EINVAL,
            "walking {name:?}"
        );
    }
    // Descriptors that do not exist, or of the wrong kind.
    let mut w = Writer::default();
    w.u64(999);
    assert_eq!(client.errno(mid::FSTAT, &w), libc::EBADF);
    let mut w = Writer::default();
    w.u64(0).u64(root.fd).u32(1).u32(0);
    assert_eq!(client.errno(mid::PREAD, &w), libc::EINVAL);
    // Truncated and nonsense messages.
    assert_eq!(client.errno(mid::WALK, &Writer::default()), libc::EIO);
    let mut w = Writer::default();
    w.u64(root.fd).u16(u16::MAX);
    assert_eq!(client.errno(mid::WALK, &w), libc::EIO);
    let mut w = Writer::default();
    w.u64(0).u64(1).u32(1000).bytes(b"short");
    assert_eq!(client.errno(mid::PWRITE, &w), libc::EIO);
    // Messages it does not serve.
    for m in [21u16, 25, 29, 31, 999] {
        assert_eq!(client.errno(m, &Writer::default()), libc::EOPNOTSUPP);
    }
    // A read larger than a message can carry.
    let a = client.walk_to(root.fd, "work/a.txt");
    let fd = client.open(a.fd, libc::O_RDONLY);
    let mut w = Writer::default();
    w.u64(0).u64(fd).u32(MAX_MESSAGE).u32(0);
    assert_eq!(client.errno(mid::PREAD, &w), libc::ENOBUFS);
    // Still serving.
    assert_eq!(client.pread(fd, 0, 5), b"hello");
}

#[test]
fn a_message_over_the_limit_drops_the_connection() {
    let job = job(None);
    let client = Client::new(export(&job));
    client.mount();
    // A header claiming more than the limit: the server hangs up.
    let mut header = Vec::new();
    header.extend_from_slice(&(MAX_MESSAGE + 1).to_le_bytes());
    header.extend_from_slice(&mid::FSTAT.to_le_bytes());
    header.extend_from_slice(&[0, 0]);
    // SAFETY: writing to a socket we own.
    let raw = unsafe { libc::write(client.sock.raw(), header.as_ptr().cast(), header.len()) };
    assert_eq!(raw, 8);
    assert!(client.sock.recv(MAX_MESSAGE, 0).unwrap().is_none());
}

#[test]
fn an_open_fd_outlives_its_control_fd() {
    let job = job(None);
    let client = Client::new(export(&job));
    let root = client.mount();
    let work = client.walk_to(root.fd, "work");
    let a = client.walk_to(root.fd, "work/a.txt");
    let file = client.open(a.fd, libc::O_RDONLY);
    let dir = client.open(work.fd, libc::O_RDONLY);
    client.close(&[a.fd, work.fd]);
    // Renamed from another walk: the open FDs follow.
    client.rename(root.fd, "work", root.fd, "moved").unwrap();
    assert_eq!(client.fstat(file).size, 5);
    assert_eq!(client.pread(file, 0, 5), b"hello");
    assert_eq!(client.fstat(dir).ino, work.stat.ino);
    assert_eq!(client.getdents(dir, -65536).len(), 4);
}
