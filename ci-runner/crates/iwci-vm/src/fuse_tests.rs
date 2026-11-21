//! The FUSE server over an in-memory file system, request by request.

use super::*;

fn server() -> (Server, iwci_vfs::JobFs) {
    let fs = iwci_vfs::SnapshotBuilder::new().freeze().fork();
    (Server::new(fs.as_dyn(), fs.modes()), fs)
}

/// A request: header (40 bytes) then `body`.
fn req(opcode: u32, node: u64, body: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    out.extend_from_slice(&((IN_HEADER + body.len()) as u32).to_le_bytes());
    out.extend_from_slice(&opcode.to_le_bytes());
    out.extend_from_slice(&7u64.to_le_bytes()); // unique
    out.extend_from_slice(&node.to_le_bytes());
    out.resize(IN_HEADER, 0);
    out.extend_from_slice(body);
    out
}

fn name(n: &str) -> Vec<u8> {
    let mut b = n.as_bytes().to_vec();
    b.push(0);
    b
}

fn le32(v: u32) -> Vec<u8> {
    v.to_le_bytes().to_vec()
}

fn le64(v: u64) -> Vec<u8> {
    v.to_le_bytes().to_vec()
}

/// The reply's error (`-errno`) and body.
fn call(s: &Server, opcode: u32, node: u64, body: &[u8]) -> (i32, Vec<u8>) {
    let out = s.handle(&req(opcode, node, body)).expect("a reply");
    let len = u32::from_le_bytes(out[0..4].try_into().unwrap()) as usize;
    assert_eq!(len, out.len());
    let error = i32::from_le_bytes(out[4..8].try_into().unwrap());
    assert_eq!(u64::from_le_bytes(out[8..16].try_into().unwrap()), 7);
    (error, out[16..].to_vec())
}

fn ok(s: &Server, opcode: u32, node: u64, body: &[u8]) -> Vec<u8> {
    let (error, body) = call(s, opcode, node, body);
    assert_eq!(error, 0, "opcode {opcode}");
    body
}

fn u64_at(b: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(b[at..at + 8].try_into().unwrap())
}

fn u32_at(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(b[at..at + 4].try_into().unwrap())
}

/// `CREATE` in `parent`: the new node and its handle.
fn create(s: &Server, parent: u64, n: &str, mode: u32) -> (u64, u64) {
    let mut body = Vec::new();
    body.extend(le32(O_RDWR | O_CREAT));
    body.extend(le32(mode));
    body.extend(le32(0o022));
    body.extend(le32(0));
    body.extend(name(n));
    let out = ok(s, CREATE, parent, &body);
    assert_eq!(out.len(), 128 + 16);
    (u64_at(&out, 0), u64_at(&out, 128))
}

fn write(s: &Server, fh: u64, offset: u64, data: &[u8]) {
    let mut body = Vec::new();
    body.extend(le64(fh));
    body.extend(le64(offset));
    body.extend(le32(data.len() as u32));
    body.extend([0u8; 20]);
    body.extend(data);
    let out = ok(s, WRITE, 0, &body);
    assert_eq!(u32_at(&out, 0), data.len() as u32);
}

fn read(s: &Server, fh: u64, offset: u64, size: u32) -> Vec<u8> {
    let mut body = Vec::new();
    body.extend(le64(fh));
    body.extend(le64(offset));
    body.extend(le32(size));
    body.extend([0u8; 20]);
    ok(s, READ, 0, &body)
}

fn release(s: &Server, fh: u64) {
    let mut body = le64(fh);
    body.extend([0u8; 16]);
    ok(s, RELEASE, 0, &body);
}

fn lookup(s: &Server, parent: u64, n: &str) -> (i32, Vec<u8>) {
    call(s, LOOKUP, parent, &name(n))
}

/// The attributes in an entry reply: size and mode.
fn entry_size_mode(entry: &[u8]) -> (u64, u32) {
    (u64_at(entry, 40 + 8), u32_at(entry, 40 + 60))
}

fn list(s: &Server, node: u64) -> Vec<String> {
    let out = ok(s, OPENDIR, node, &[0u8; 8]);
    let fh = u64_at(&out, 0);
    let mut body = Vec::new();
    body.extend(le64(fh));
    body.extend(le64(0));
    body.extend(le32(4096));
    body.extend([0u8; 20]);
    let out = ok(s, READDIR, 0, &body);
    let mut names = Vec::new();
    let mut at = 0;
    while at < out.len() {
        let len = u32_at(&out, at + 16) as usize;
        names.push(String::from_utf8(out[at + 24..at + 24 + len].to_vec()).unwrap());
        at += (24 + len).div_ceil(8) * 8;
    }
    release(s, fh);
    names.sort();
    names
}

#[test]
fn init_takes_only_what_both_sides_offer() {
    let (s, _) = server();
    let mut body = Vec::new();
    body.extend(le32(7));
    body.extend(le32(38));
    body.extend(le32(128 << 10));
    body.extend(le32(ASYNC_READ | BIG_WRITES | (1 << 16)));
    body.extend([0u8; 48]);
    let out = ok(&s, INIT, 0, &body);
    assert_eq!(out.len(), 64);
    assert_eq!((u32_at(&out, 0), u32_at(&out, 4)), (7, KERNEL_MINOR));
    // Write-back caching (1 << 16) was offered and is not taken.
    assert_eq!(u32_at(&out, 12), ASYNC_READ | BIG_WRITES);
    assert_eq!(u32_at(&out, 20), MAX_IO);
}

#[test]
fn a_file_made_written_and_read_lands_in_the_served_file_system() {
    let (s, fs) = server();
    let (node, fh) = create(&s, ROOT, "out.txt", 0o755);
    write(&s, fh, 0, b"hello ");
    write(&s, fh, 6, b"world");
    assert_eq!(read(&s, fh, 0, 100), b"hello world");
    assert_eq!(read(&s, fh, 6, 3), b"wor");
    release(&s, fh);
    assert_eq!(fs.read("/out.txt").unwrap(), b"hello world");

    let (error, entry) = lookup(&s, ROOT, "out.txt");
    assert_eq!(error, 0);
    assert_eq!(u64_at(&entry, 0), node, "the same name, the same node");
    let (size, mode) = entry_size_mode(&entry);
    assert_eq!((size, mode), (11, S_IFREG | 0o755));
    assert_eq!(list(&s, ROOT), [".", "..", "out.txt"]);
    assert_eq!(lookup(&s, ROOT, "missing").0, -ENOENT);
}

#[test]
fn directories_renames_and_removals() {
    let (s, fs) = server();
    let mut body = le32(0o755);
    body.extend(le32(0));
    body.extend(name("dir"));
    let dir = u64_at(&ok(&s, MKDIR, ROOT, &body), 0);
    let (file, fh) = create(&s, dir, "a.txt", 0o644);
    write(&s, fh, 0, b"x");
    release(&s, fh);
    assert_eq!(call(&s, RMDIR, ROOT, &name("dir")).0, -ENOTEMPTY);

    // Renaming the directory moves the node under it too.
    let mut body = le64(ROOT);
    body.extend(name("dir"));
    body.extend(name("moved"));
    ok(&s, RENAME, ROOT, &body);
    assert!(fs.read("/moved/a.txt").is_ok());
    let out = ok(&s, GETATTR, file, &[0u8; 16]);
    assert_eq!(
        u64_at(&out, 16 + 8),
        1,
        "a.txt, found by its node after the move"
    );

    // RENAME_NOREPLACE refuses to replace.
    let (_, fh) = create(&s, ROOT, "b.txt", 0o644);
    release(&s, fh);
    let mut body = le64(dir);
    body.extend(le32(RENAME_NOREPLACE));
    body.extend(le32(0));
    body.extend(name("a.txt"));
    body.extend(name("b.txt"));
    let mut body2 = le64(ROOT);
    body2.extend(le32(RENAME_NOREPLACE));
    body2.extend(le32(0));
    body2.extend(name("a.txt"));
    body2.extend(name("b.txt"));
    let moved = u64_at(&lookup(&s, ROOT, "moved").1, 0);
    assert_eq!(call(&s, RENAME2, moved, &body2).0, -EEXIST);
    let _ = body;

    ok(&s, UNLINK, moved, &name("a.txt"));
    ok(&s, RMDIR, ROOT, &name("moved"));
    assert_eq!(list(&s, ROOT), [".", "..", "b.txt"]);
    assert_eq!(call(&s, UNLINK, ROOT, &name("nope")).0, -ENOENT);
}

#[test]
fn size_and_mode_are_set_and_a_symlink_reads_back() {
    let (s, fs) = server();
    let (node, fh) = create(&s, ROOT, "f", 0o644);
    write(&s, fh, 0, b"0123456789");
    release(&s, fh);
    let mut body = le32(FATTR_SIZE | FATTR_MODE);
    body.extend(le32(0));
    body.extend(le64(0));
    body.extend(le64(4)); // size
    body.extend([0u8; 8 + 8 + 8 + 8 + 12]);
    body.extend(le32(0o700)); // mode
    body.extend([0u8; 16]);
    let out = ok(&s, SETATTR, node, &body);
    assert_eq!(u64_at(&out, 16 + 8), 4);
    assert_eq!(u32_at(&out, 16 + 60), S_IFREG | 0o700);
    assert_eq!(fs.read("/f").unwrap(), b"0123");

    let mut body = name("link");
    body.extend(name("f"));
    let link = u64_at(&ok(&s, SYMLINK, ROOT, &body), 0);
    assert_eq!(ok(&s, READLINK, link, &[]), b"f");
}

#[test]
fn what_the_guest_sends_is_never_trusted() {
    let (s, _) = server();
    for bad in ["..", ".", "a/b", ""] {
        assert_eq!(lookup(&s, ROOT, bad).0, -EINVAL, "{bad:?}");
    }
    assert_eq!(lookup(&s, ROOT, &"x".repeat(300)).0, -ENAMETOOLONG);
    // A name with no end, a request shorter than its header says, and one
    // shorter than a header.
    assert_eq!(call(&s, LOOKUP, ROOT, b"abc").0, -EINVAL);
    let mut short = req(LOOKUP, ROOT, &name("a"));
    short[0..4].copy_from_slice(&1000u32.to_le_bytes());
    let out = s.handle(&short).unwrap();
    assert_eq!(i32::from_le_bytes(out[4..8].try_into().unwrap()), -EINVAL);
    assert!(s.handle(&[1, 2, 3]).is_none());
    // A node or handle it never gave.
    assert_eq!(call(&s, GETATTR, 999, &[0u8; 16]).0, -ENOENT);
    assert_eq!(read_error(&s, 42), -EBADF);
    // What it does not do, it says so.
    assert_eq!(call(&s, 8, ROOT, &[0u8; 16]).0, -ENOSYS);
    assert_eq!(call(&s, 22, ROOT, &[0u8; 16]).0, -ENOSYS);
    // Forgetting has no answer.
    assert!(s.handle(&req(FORGET, ROOT, &le64(1))).is_none());
    assert!(s.handle(&req(INTERRUPT, 0, &le64(1))).is_none());
}

fn read_error(s: &Server, fh: u64) -> i32 {
    let mut body = Vec::new();
    body.extend(le64(fh));
    body.extend(le64(0));
    body.extend(le32(10));
    body.extend([0u8; 20]);
    call(s, READ, 0, &body).0
}

#[test]
fn a_forgotten_node_is_gone_and_its_name_gets_a_new_one() {
    let (s, _) = server();
    let (node, fh) = create(&s, ROOT, "f", 0o644);
    release(&s, fh);
    s.handle(&req(FORGET, node, &le64(1)));
    assert_eq!(call(&s, GETATTR, node, &[0u8; 16]).0, -ENOENT);
    let again = u64_at(&lookup(&s, ROOT, "f").1, 0);
    assert_ne!(again, node);
    // A batch forgets each.
    let mut body = le32(1);
    body.extend(le32(0));
    body.extend(le64(again));
    body.extend(le64(1));
    assert!(s.handle(&req(BATCH_FORGET, 0, &body)).is_none());
    assert_eq!(call(&s, GETATTR, again, &[0u8; 16]).0, -ENOENT);
    // The root is never forgotten.
    s.handle(&req(FORGET, ROOT, &le64(100)));
    ok(&s, GETATTR, ROOT, &[0u8; 16]);
}

#[test]
fn modes_live_in_the_served_file_systems_record_so_the_next_machine_sees_them() {
    let (s, fs) = server();
    let (node, fh) = create(&s, ROOT, "run.sh", 0o644);
    release(&s, fh);
    let mut body = le32(FATTR_MODE);
    body.extend(le32(0));
    body.extend(le64(0));
    body.extend(le64(0));
    body.extend([0u8; 8 + 8 + 8 + 8 + 12]);
    body.extend(le32(0o755));
    body.extend([0u8; 16]);
    ok(&s, SETATTR, node, &body);
    assert_eq!(fs.modes().get(Path::new("/run.sh")), Some(0o755));
    // A new server, as the next machine gets, over the same files.
    let next = Server::new(fs.as_dyn(), fs.modes());
    let (_, entry) = lookup(&next, ROOT, "run.sh");
    assert_eq!(entry_size_mode(&entry).1, S_IFREG | 0o755);
    // A rename takes the mode along.
    let mut body = le64(ROOT);
    body.extend(name("run.sh"));
    body.extend(name("go.sh"));
    ok(&next, RENAME, ROOT, &body);
    assert_eq!(fs.modes().get(Path::new("/go.sh")), Some(0o755));
}

#[test]
fn a_read_only_server_refuses_every_write_and_lets_the_kernel_cache() {
    let fs = iwci_vfs::SnapshotBuilder::new().freeze().fork();
    fs.write("/app/a.txt", b"source").unwrap();
    let s = Server::read_only(fs.as_dyn(), fs.modes());
    let (error, entry) = lookup(&s, ROOT, "app");
    assert_eq!(error, 0);
    assert_eq!(u64_at(&entry, 16), READ_ONLY_VALID_SECS, "names are kept");
    let app = u64_at(&entry, 0);
    let file = u64_at(&lookup(&s, app, "a.txt").1, 0);
    // No OPEN: the kernel reads by node, with no handle.
    assert_eq!(call(&s, OPEN, file, &[0u8; 8]).0, -ENOSYS);
    let mut body = Vec::new();
    body.extend(le64(0));
    body.extend(le64(2));
    body.extend(le32(100));
    body.extend([0u8; 20]);
    assert_eq!(ok(&s, READ, file, &body), b"urce");
    assert_eq!(call(&s, FLUSH, file, &[0u8; 24]).0, -ENOSYS);
    // A listing is kept by the kernel across opens.
    let dir = ok(&s, OPENDIR, app, &[0u8; 8]);
    assert_eq!(u32_at(&dir, 8), FOPEN_KEEP_CACHE | FOPEN_CACHE_DIR);
    // Every way of writing is refused.
    let mut wr = le32(O_RDWR);
    wr.extend(le32(0));
    assert_eq!(call(&s, OPEN, file, &wr).0, -EROFS);
    let mut trunc = le32(O_TRUNC);
    trunc.extend(le32(0));
    assert_eq!(call(&s, OPEN, file, &trunc).0, -EROFS);
    let mut create = le32(O_RDWR | O_CREAT);
    create.extend(le32(0o644));
    create.extend(le32(0));
    create.extend(le32(0));
    create.extend(name("new"));
    assert_eq!(call(&s, CREATE, app, &create).0, -EROFS);
    assert_eq!(call(&s, UNLINK, app, &name("a.txt")).0, -EROFS);
    let mut mkdir = le32(0o755);
    mkdir.extend(le32(0));
    mkdir.extend(name("d"));
    assert_eq!(call(&s, MKDIR, app, &mkdir).0, -EROFS);
    assert_eq!(call(&s, SETATTR, file, &[0u8; 88]).0, -EROFS);
    assert_eq!(fs.read("/app/a.txt").unwrap(), b"source");
}

#[test]
fn readdirplus_gives_each_entry_its_attributes_and_counts_it_as_a_lookup() {
    let (s, fs) = server();
    fs.write("/d/a.txt", b"12345").unwrap();
    fs.write("/d/b.txt", b"1").unwrap();
    let d = u64_at(&lookup(&s, ROOT, "d").1, 0);
    let fh = u64_at(&ok(&s, OPENDIR, d, &[0u8; 8]), 0);
    let mut body = Vec::new();
    body.extend(le64(fh));
    body.extend(le64(0));
    body.extend(le32(4096));
    body.extend([0u8; 20]);
    let out = ok(&s, READDIRPLUS, 0, &body);
    let mut at = 0;
    let mut seen = Vec::new();
    while at < out.len() {
        let node = u64_at(&out, at);
        let size = u64_at(&out, at + 40 + 8);
        let len = u32_at(&out, at + 128 + 16) as usize;
        let name = String::from_utf8(out[at + 128 + 24..at + 128 + 24 + len].to_vec()).unwrap();
        seen.push((name, node != 0, size));
        at += 128 + (24 + len).div_ceil(8) * 8;
    }
    seen.sort();
    assert_eq!(
        seen,
        [
            (".".to_string(), false, 0),
            ("..".to_string(), false, 0),
            ("a.txt".to_string(), true, 5),
            ("b.txt".to_string(), true, 1),
        ]
    );
    // a.txt was looked up by the listing: one forget and it is gone.
    let a = u64_at(&lookup(&s, d, "a.txt").1, 0);
    s.handle(&req(FORGET, a, &le64(2)));
    assert_eq!(call(&s, GETATTR, a, &[0u8; 16]).0, -ENOENT);
}

#[test]
fn only_a_read_only_server_takes_no_open() {
    let mut body = Vec::new();
    body.extend(le32(7));
    body.extend(le32(38));
    body.extend(le32(0));
    body.extend(le32(NO_OPEN_SUPPORT | ASYNC_READ));
    body.extend([0u8; 48]);
    let (rw, _) = server();
    assert_eq!(u32_at(&ok(&rw, INIT, 0, &body), 12), ASYNC_READ);
    let fs = iwci_vfs::SnapshotBuilder::new().freeze().fork();
    let ro = Server::read_only(fs.as_dyn(), fs.modes());
    assert_eq!(
        u32_at(&ok(&ro, INIT, 0, &body), 12),
        ASYNC_READ | NO_OPEN_SUPPORT
    );
}
