//! Tests use hand-written WAT modules, so nothing here needs the network or a
//! toolchain. Tests that need real binaries (gofmt, bash, ts-rust) read them
//! from paths in environment variables and skip, saying why, when absent.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use iwci_vfs::{Change, Snapshot, SnapshotBuilder};

use super::*;

fn temp_dir(tag: &str) -> PathBuf {
    static N: AtomicU64 = AtomicU64::new(0);
    let dir = std::env::temp_dir().join(format!(
        "iwci-runtime-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A runtime over a throwaway cache directory, removed on drop.
struct TestRuntime {
    runtime: Runtime,
    dir: PathBuf,
}

impl std::ops::Deref for TestRuntime {
    type Target = Runtime;
    fn deref(&self) -> &Runtime {
        &self.runtime
    }
}

impl Drop for TestRuntime {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn runtime() -> TestRuntime {
    let dir = temp_dir("rt");
    TestRuntime {
        runtime: Runtime::new(dir.clone()).unwrap(),
        dir,
    }
}

fn wat_module(name: &str, wat: &str) -> WasmModule {
    WasmModule::new(name, wat::parse_str(wat).unwrap())
}

fn snapshot(files: &[(&str, &str)]) -> Snapshot {
    let builder = SnapshotBuilder::new();
    builder.mkdir_all("/work").unwrap();
    for (path, text) in files {
        builder.write(path, text.as_bytes()).unwrap();
    }
    builder.freeze()
}

fn invocation(fs: DynFs, args: &[&str]) -> Invocation {
    Invocation {
        args: args.iter().map(|s| s.to_string()).collect(),
        env: vec![("GREETING".into(), "hi".into())],
        cwd: "/work".into(),
        fs,
        limits: Limits {
            timeout: Duration::from_secs(30),
            memory_bytes: 64 << 20,
        },
        log: None,
        scratch: None,
        commands: Vec::new(),
        internet: false,
        modes: iwci_vfs::Modes::default(),
        services: Vec::new(),
        cancel: None,
    }
}

/// Prints its arguments and environment (each NUL-separated) on stdout,
/// writes `out.txt` under the preopened root, checks that the host's
/// `/etc/hosts` is not reachable, says hello on stderr and exits 3.
const HELLO: &str = r#"
(module
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_sizes_get" (func $args_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "args_get" (func $args_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_sizes_get" (func $environ_sizes_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "environ_get" (func $environ_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open" (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 2)
  (data (i32.const 100) "work/out.txt")
  (data (i32.const 120) "written by wasm\n")
  (data (i32.const 140) "etc/hosts")
  (data (i32.const 160) "hello stderr\n")
  (data (i32.const 180) "\n")
  (func $write (param $fd i32) (param $ptr i32) (param $len i32)
    (i32.store (i32.const 0) (local.get $ptr))
    (i32.store (i32.const 4) (local.get $len))
    (drop (call $fd_write (local.get $fd) (i32.const 0) (i32.const 1) (i32.const 8))))
  (func (export "_start")
    ;; argv into 2048.., pointers at 1024
    (drop (call $args_sizes_get (i32.const 16) (i32.const 20)))
    (drop (call $args_get (i32.const 1024) (i32.const 2048)))
    (call $write (i32.const 1) (i32.const 2048) (i32.load (i32.const 20)))
    (call $write (i32.const 1) (i32.const 180) (i32.const 1))
    ;; environ into 8192.., pointers at 4096
    (drop (call $environ_sizes_get (i32.const 16) (i32.const 20)))
    (drop (call $environ_get (i32.const 4096) (i32.const 8192)))
    (call $write (i32.const 1) (i32.const 8192) (i32.load (i32.const 20)))
    ;; open /work/out.txt for writing through preopen fd 3 (`/`)
    (if (call $path_open (i32.const 3) (i32.const 0) (i32.const 100) (i32.const 12)
              (i32.const 9) (i64.const -1) (i64.const -1) (i32.const 0) (i32.const 24))
      (then (call $proc_exit (i32.const 40))))
    (call $write (i32.load (i32.const 24)) (i32.const 120) (i32.const 16))
    ;; the host file system must not be there
    (if (i32.eqz (call $path_open (i32.const 3) (i32.const 0) (i32.const 140) (i32.const 9)
              (i32.const 0) (i64.const -1) (i64.const -1) (i32.const 0) (i32.const 28)))
      (then (call $proc_exit (i32.const 42))))
    (call $write (i32.const 2) (i32.const 160) (i32.const 13))
    (call $proc_exit (i32.const 3))))
"#;

#[test]
fn a_command_gets_args_env_and_the_job_fs_and_reports_its_exit() {
    let rt = runtime();
    let job = snapshot(&[("/work/in.txt", "x")]).fork();
    let module = wat_module("hello", HELLO);
    let outcome = rt
        .run_command(&module, invocation(job.as_dyn(), &["one", "two"]))
        .unwrap();
    assert_eq!(outcome.exit_code, 3, "{outcome:?}");
    assert!(!outcome.timed_out && !outcome.out_of_memory && outcome.error.is_none());
    let stdout = String::from_utf8_lossy(&outcome.stdout);
    assert!(stdout.starts_with("hello\0one\0two\0\n"), "{stdout:?}");
    assert!(stdout.contains("GREETING=hi\0"), "{stdout:?}");
    assert_eq!(outcome.stderr, b"hello stderr\n");
    assert_eq!(
        job.changes("/"),
        vec![Change::Added {
            path: "/work/out.txt".into(),
            bytes: b"written by wasm\n".to_vec()
        }]
    );
}

/// Prints the name of every preopened directory, one per line, walking the
/// descriptors from 3 up to the first that is not a preopen.
const PREOPENS: &str = r#"
(module
  (import "wasi_snapshot_preview1" "fd_prestat_get" (func $prestat_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_prestat_dir_name" (func $prestat_dir_name (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 32) "\n")
  (func $write (param $ptr i32) (param $len i32)
    (i32.store (i32.const 0) (local.get $ptr))
    (i32.store (i32.const 4) (local.get $len))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8))))
  (func (export "_start") (local $fd i32) (local $len i32)
    (local.set $fd (i32.const 3))
    (block $done
      (loop $next
        ;; prestat: tag at 16, name length at 20; EBADF ends the list
        (br_if $done (call $prestat_get (local.get $fd) (i32.const 16)))
        (local.set $len (i32.load (i32.const 20)))
        (if (i32.gt_u (local.get $len) (i32.const 1024))
          (then (call $proc_exit (i32.const 2))))
        (if (call $prestat_dir_name (local.get $fd) (i32.const 1024) (local.get $len))
          (then (call $proc_exit (i32.const 3))))
        (call $write (i32.const 1024) (local.get $len))
        (call $write (i32.const 32) (i32.const 1))
        (local.set $fd (i32.add (local.get $fd) (i32.const 1)))
        (br_if $next (i32.lt_u (local.get $fd) (i32.const 64)))))
    (call $proc_exit (i32.const 0))))
"#;

/// Pins the preopen layout every command gets, whatever the `cwd`: fd 3 is
/// wasmer-wasix's virtual root (`create_rootfd`) and fd 4 the job's root,
/// both named `/` and nothing else, with the `cwd` handed over as `$PWD`.
///
/// Do not add the `cwd` as a preopen named `.` to give plain WASI tools a
/// working directory (#906). wasi-libc strips `/` and `.` from preopen names,
/// so both become the empty prefix; it makes a relative path absolute against
/// its own cwd, which is always `/`, before looking it up; and of equal
/// matches it takes the preopen registered last. Measured with a Rust
/// `wasm32-wasip1` program run with `cwd: /work`: with `.` before `/` nothing
/// changes (`.` is still the root), and with `.` after `/` relative paths
/// work but `/`, `/tmp` and every other absolute path resolve inside `/work`,
/// which breaks the scratch mount and tools' data files. See the README's
/// known limitations.
#[test]
fn a_command_sees_only_the_root_preopen_and_its_cwd_as_pwd() {
    let rt = runtime();
    for cwd in ["/work", "/work/nested/deeper", "/"] {
        let job = snapshot(&[("/work/nested/deeper/a.txt", "x")]).fork();
        let mut inv = invocation(job.as_dyn(), &[]);
        inv.cwd = cwd.into();
        let outcome = rt
            .run_command(&wat_module("preopens", PREOPENS), inv.clone())
            .unwrap();
        assert!(outcome.success(), "{cwd}: {outcome:?}");
        assert_eq!(
            String::from_utf8_lossy(&outcome.stdout),
            "/\n/\n",
            "cwd {cwd}"
        );

        let outcome = rt.run_command(&wat_module("hello", HELLO), inv).unwrap();
        let stdout = String::from_utf8_lossy(&outcome.stdout);
        assert!(stdout.contains(&format!("\0PWD={cwd}\0")), "{stdout:?}");
    }
}

/// Puts stdout on descriptors 3 and 4, the two preopens, and writes `a`
/// and `b` through them; reads `/work/in.txt` through 4 by its absolute path
/// (as wasix-libc sends it) and its path relative to `/` (as older C
/// libraries do), and creates `/work/out.txt` through 3; prints what
/// `fd_fdstat_get` says 3 is now, and 1 if a file opened through it may be
/// read (the rights older C libraries ask for before opening); closes both
/// and reads the file through 4 and 3 again; then prints `fd_prestat_get`'s
/// errno for 3, for 4, and for 5 once stdout is put there. Exits with a
/// code from 10 up when a step fails.
const LOW_FDS: &str = r#"
(module
  (import "wasi_snapshot_preview1" "fd_renumber" (func $renumber (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_read" (func $fd_read (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_fdstat_get" (func $fdstat (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_prestat_get" (func $prestat_get (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open" (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 100) "/work/in.txt")
  (data (i32.const 120) "/work/out.txt")
  (data (i32.const 140) "abc")
  (func $write (param $fd i32) (param $ptr i32) (param $len i32) (result i32)
    (i32.store (i32.const 0) (local.get $ptr))
    (i32.store (i32.const 4) (local.get $len))
    (call $fd_write (local.get $fd) (i32.const 0) (i32.const 1) (i32.const 8)))
  (func $digit (param $n i32)
    (i32.store8 (i32.const 200) (i32.add (i32.const 48) (local.get $n)))
    (drop (call $write (i32.const 1) (i32.const 200) (i32.const 1))))
  (func $check (param $errno i32) (param $code i32)
    (if (local.get $errno) (then (call $proc_exit (local.get $code)))))
  ;; opens /work/in.txt through $dir, by its absolute path or (when
  ;; $relative) as `work/in.txt`, and copies it to stdout
  (func $cat_in (param $dir i32) (param $relative i32) (param $code i32)
    (call $check (call $path_open (local.get $dir) (i32.const 0)
      (i32.add (i32.const 100) (local.get $relative)) (i32.sub (i32.const 12) (local.get $relative))
      (i32.const 0) (i64.const -1) (i64.const -1) (i32.const 0) (i32.const 24)) (local.get $code))
    (i32.store (i32.const 32) (i32.const 300))
    (i32.store (i32.const 36) (i32.const 64))
    (call $check (call $fd_read (i32.load (i32.const 24)) (i32.const 32) (i32.const 1) (i32.const 40))
      (i32.add (local.get $code) (i32.const 1)))
    (drop (call $write (i32.const 1) (i32.const 300) (i32.load (i32.const 40))))
    (drop (call $fd_close (i32.load (i32.const 24)))))
  (func (export "_start")
    (call $check (call $renumber (i32.const 1) (i32.const 3)) (i32.const 10))
    (call $check (call $write (i32.const 3) (i32.const 140) (i32.const 1)) (i32.const 11))
    (call $check (call $renumber (i32.const 1) (i32.const 4)) (i32.const 12))
    (call $check (call $write (i32.const 4) (i32.const 141) (i32.const 1)) (i32.const 13))
    (call $cat_in (i32.const 4) (i32.const 0) (i32.const 14))
    (call $cat_in (i32.const 4) (i32.const 1) (i32.const 16))
    (call $check (call $path_open (i32.const 3) (i32.const 0) (i32.const 120) (i32.const 13)
      (i32.const 9) (i64.const -1) (i64.const -1) (i32.const 0) (i32.const 28)) (i32.const 18))
    (call $check (call $write (i32.load (i32.const 28)) (i32.const 142) (i32.const 1)) (i32.const 19))
    (call $check (call $fdstat (i32.const 3) (i32.const 64)) (i32.const 20))
    (call $digit (i32.load8_u (i32.const 64)))
    (call $digit (i64.ne (i64.and (i64.load (i32.const 80)) (i64.const 2)) (i64.const 0)))
    (call $check (call $fd_close (i32.const 3)) (i32.const 21))
    (call $check (call $fd_close (i32.const 4)) (i32.const 22))
    (call $cat_in (i32.const 4) (i32.const 1) (i32.const 23))
    (call $cat_in (i32.const 3) (i32.const 1) (i32.const 25))
    (call $digit (call $prestat_get (i32.const 3) (i32.const 64)))
    (call $digit (call $prestat_get (i32.const 4) (i32.const 64)))
    (call $check (call $renumber (i32.const 1) (i32.const 5)) (i32.const 27))
    (call $digit (call $prestat_get (i32.const 5) (i32.const 64)))))
"#;

/// A program can put its own descriptors on 3 and 4 (#1019), which are the
/// virtual root and the job's `/` preopen: bash's `exec 3>&1` is
/// `dup2(1, 3)`, which wasmer-wasix refused with `ENOTSUP` because 3 was a
/// preopen. The C library found its preopens on those numbers at start-up
/// and keeps sending paths through them, absolute or relative to `/`, so
/// paths must still work once something else is there, or nothing is, and
/// closing that puts the preopen back. 3 must still read as the root
/// preopen to `fd_prestat_get`, which is how a child's C library finds its
/// preopens, and a standard stream must not read as one anywhere, or the
/// child's C library exits with EX_OSERR (#1026, `prestat_fd`).
#[test]
fn a_program_can_replace_the_preopens_and_keep_its_paths() {
    let rt = runtime();
    let job = snapshot(&[("/work/in.txt", "x")]).fork();
    let outcome = rt
        .run_command(
            &wat_module("low-fds", LOW_FDS),
            invocation(job.as_dyn(), &[]),
        )
        .unwrap();
    assert!(outcome.success(), "{outcome:?}");
    // `a` and `b` through 3 and 4; the file through 4 both ways; 3 is now a
    // regular file (stdout) that opens files readable; the file through 4
    // and 3 once closed; then 3 and 4 preopens again (errno 0) and stdout on
    // 5 not one (8, EBADF).
    assert_eq!(String::from_utf8_lossy(&outcome.stdout), "abxx41xx008");
    assert_eq!(
        job.changes("/"),
        vec![Change::Added {
            path: "/work/out.txt".into(),
            bytes: b"c".to_vec()
        }]
    );
}

/// Unlinks directories and a file and removes the directories, exiting with
/// a code naming the first call that did not give the errno it should.
/// Unlinking a directory must fail with EISDIR (31) and change nothing:
/// the C library's `remove` (and so `std::filesystem::remove`, Edge.js's
/// `fs.rmSync`) tries `unlink` before `rmdir`.
const UNLINK_DIRS: &str = r#"
(module
  (import "wasi_snapshot_preview1" "path_unlink_file" (func $unlink (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_remove_directory" (func $rmdir (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 100) "/work/empty")
  (data (i32.const 120) "/work/full")
  (data (i32.const 140) "/work/file")
  (func $expect (param $got i32) (param $want i32) (param $code i32)
    (if (i32.ne (local.get $got) (local.get $want)) (then (call $proc_exit (local.get $code)))))
  (func (export "_start")
    (call $expect (call $unlink (i32.const 3) (i32.const 100) (i32.const 11)) (i32.const 31) (i32.const 10))
    (call $expect (call $rmdir (i32.const 3) (i32.const 100) (i32.const 11)) (i32.const 0) (i32.const 11))
    (call $expect (call $rmdir (i32.const 3) (i32.const 100) (i32.const 11)) (i32.const 44) (i32.const 12))
    (call $expect (call $unlink (i32.const 3) (i32.const 120) (i32.const 10)) (i32.const 31) (i32.const 13))
    (call $expect (call $rmdir (i32.const 3) (i32.const 120) (i32.const 10)) (i32.const 55) (i32.const 14))
    (call $expect (call $unlink (i32.const 3) (i32.const 120) (i32.const 10)) (i32.const 31) (i32.const 15))
    (call $expect (call $rmdir (i32.const 3) (i32.const 120) (i32.const 10)) (i32.const 55) (i32.const 16))
    (call $expect (call $unlink (i32.const 3) (i32.const 140) (i32.const 10)) (i32.const 0) (i32.const 17))
    (call $expect (call $unlink (i32.const 3) (i32.const 140) (i32.const 10)) (i32.const 44) (i32.const 18))))
"#;

/// Unlinking a directory used to take it out of WASIX's directory cache
/// before refusing, so the `rmdir` that follows found nothing (ENOENT) and
/// left the directory where it was: Edge.js's `fs.rmSync(dir, { recursive:
/// true })` removed nothing and reported success (#1049).
#[test]
fn unlinking_a_directory_fails_and_leaves_it_removable() {
    let rt = runtime();
    let builder = SnapshotBuilder::new();
    builder.mkdir_all("/work/empty").unwrap();
    builder.write("/work/full/child/file", b"child").unwrap();
    builder.write("/work/file", b"file").unwrap();
    let job = builder.freeze().fork();
    let outcome = rt
        .run_command(
            &wat_module("unlink-dirs", UNLINK_DIRS),
            invocation(job.as_dyn(), &[]),
        )
        .unwrap();
    assert!(outcome.success(), "{outcome:?}");
    assert_eq!(job.read("/work/full/child/file").unwrap(), b"child");
    assert_eq!(
        job.changes("/"),
        vec![Change::Deleted {
            path: "/work/file".into()
        }]
    );
}

/// Removes directories nothing has looked up yet, exiting with a code
/// naming the first call that did not give the errno it should: ENOTEMPTY
/// (55) for one with entries, ENOTDIR (54) for a file and for a symlink to a
/// directory, ENOENT (44) for nothing, and success for an empty one.
const RMDIR_UNSEEN: &str = r#"
(module
  (import "wasi_snapshot_preview1" "path_remove_directory" (func $rmdir (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 100) "/work/full")
  (data (i32.const 120) "/work/empty")
  (data (i32.const 140) "/work/file")
  (data (i32.const 160) "/work/link")
  (data (i32.const 180) "/work/none")
  (func $expect (param $got i32) (param $want i32) (param $code i32)
    (if (i32.ne (local.get $got) (local.get $want)) (then (call $proc_exit (local.get $code)))))
  (func (export "_start")
    (call $expect (call $rmdir (i32.const 3) (i32.const 100) (i32.const 10)) (i32.const 55) (i32.const 10))
    (call $expect (call $rmdir (i32.const 3) (i32.const 140) (i32.const 10)) (i32.const 54) (i32.const 11))
    (call $expect (call $rmdir (i32.const 3) (i32.const 160) (i32.const 10)) (i32.const 54) (i32.const 12))
    (call $expect (call $rmdir (i32.const 3) (i32.const 180) (i32.const 10)) (i32.const 44) (i32.const 13))
    (call $expect (call $rmdir (i32.const 3) (i32.const 120) (i32.const 11)) (i32.const 0) (i32.const 14))
    (call $expect (call $rmdir (i32.const 3) (i32.const 120) (i32.const 11)) (i32.const 44) (i32.const 15))
    (call $expect (call $rmdir (i32.const 3) (i32.const 100) (i32.const 10)) (i32.const 55) (i32.const 16))))
"#;

/// `rmdir` of a directory nothing had looked up yet found no entry in
/// WASIX's directory cache and answered ENOENT, empty or not (#1057): a
/// recursive delete that calls `rmdir` first and recurses on ENOTEMPTY took
/// a populated checkout directory for gone.
#[test]
fn removing_a_directory_nothing_looked_up_says_what_it_is() {
    let rt = runtime();
    let builder = SnapshotBuilder::new();
    builder.mkdir_all("/work/empty").unwrap();
    builder.write("/work/full/child/file", b"child").unwrap();
    builder.write("/work/file", b"file").unwrap();
    builder.symlink("/work/link", "full").unwrap();
    let job = builder.freeze().fork();
    let outcome = rt
        .run_command(
            &wat_module("rmdir-unseen", RMDIR_UNSEEN),
            invocation(job.as_dyn(), &[]),
        )
        .unwrap();
    assert!(outcome.success(), "{outcome:?}");
    assert_eq!(job.read("/work/full/child/file").unwrap(), b"child");
    assert!(job.as_dyn().metadata(Path::new("/work/empty")).is_err());
    assert_eq!(job.changes("/"), Vec::new());
}

/// Links files and a directory, exiting with a code naming the first call
/// that did not give the errno it should: EPERM (63) for a link, EEXIST (20)
/// onto a name that is there, ENOENT (44) for a name that is not.
const LINKS: &str = r#"
(module
  (import "wasi_snapshot_preview1" "path_link" (func $link (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_filestat_get" (func $stat (param i32 i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_unlink_file" (func $unlink (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 100) "/work/file")
  (data (i32.const 120) "/work/second")
  (data (i32.const 140) "/work/full")
  (data (i32.const 160) "/work/dirlink")
  (data (i32.const 180) "/work/gone")
  (data (i32.const 200) "/work/keep")
  (func $expect (param $got i32) (param $want i32) (param $code i32)
    (if (i32.ne (local.get $got) (local.get $want)) (then (call $proc_exit (local.get $code)))))
  (func (export "_start")
    (call $expect (call $link (i32.const 3) (i32.const 0) (i32.const 100) (i32.const 10)
      (i32.const 3) (i32.const 120) (i32.const 12)) (i32.const 63) (i32.const 10))
    (call $expect (call $stat (i32.const 3) (i32.const 0) (i32.const 120) (i32.const 12) (i32.const 400))
      (i32.const 44) (i32.const 11))
    (call $expect (call $link (i32.const 3) (i32.const 0) (i32.const 140) (i32.const 10)
      (i32.const 3) (i32.const 160) (i32.const 13)) (i32.const 63) (i32.const 12))
    (call $expect (call $link (i32.const 3) (i32.const 0) (i32.const 100) (i32.const 10)
      (i32.const 3) (i32.const 200) (i32.const 10)) (i32.const 20) (i32.const 13))
    (call $expect (call $unlink (i32.const 3) (i32.const 100) (i32.const 10)) (i32.const 0) (i32.const 14))
    (call $expect (call $stat (i32.const 3) (i32.const 0) (i32.const 100) (i32.const 10) (i32.const 400))
      (i32.const 44) (i32.const 15))
    ;; a link onto a deleted snapshot file fails and leaves it deleted
    (call $expect (call $unlink (i32.const 3) (i32.const 180) (i32.const 10)) (i32.const 0) (i32.const 16))
    (call $expect (call $link (i32.const 3) (i32.const 0) (i32.const 200) (i32.const 10)
      (i32.const 3) (i32.const 180) (i32.const 10)) (i32.const 63) (i32.const 17))
    (call $expect (call $stat (i32.const 3) (i32.const 0) (i32.const 180) (i32.const 10) (i32.const 400))
      (i32.const 44) (i32.const 18))))
"#;

/// A job's file system has no hard links, so `link()` fails with EPERM, as
/// on a file system without them (#1052). It used to succeed with a second
/// name only WASIX's cache knew, after which removing the first name
/// removed nothing.
#[test]
fn a_hard_link_is_refused_and_leaves_one_name() {
    let rt = runtime();
    let builder = SnapshotBuilder::new();
    builder.write("/work/full/child/file", b"child").unwrap();
    builder.write("/work/file", b"file").unwrap();
    builder.write("/work/gone", b"gone").unwrap();
    builder.write("/work/keep", b"keep").unwrap();
    let job = builder.freeze().fork();
    let outcome = rt
        .run_command(&wat_module("links", LINKS), invocation(job.as_dyn(), &[]))
        .unwrap();
    assert!(outcome.success(), "{outcome:?}");
    assert_eq!(job.read("/work/keep").unwrap(), b"keep");
    assert_eq!(
        job.changes("/"),
        vec![
            Change::Deleted {
                path: "/work/file".into()
            },
            Change::Deleted {
                path: "/work/gone".into()
            },
        ]
    );
}

/// Renames a new file and a directory with a file in it, and writes the
/// `st_ino` of each as 8 raw bytes: the renamed file by path and by its
/// open descriptor, then the file in the renamed directory and the
/// directory. Exits with a code from 10 up when a call fails.
const RENAMED_INODES: &str = r#"
(module
  (import "wasi_snapshot_preview1" "path_open" (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_filestat_get" (func $fstat (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_filestat_get" (func $stat (param i32 i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_rename" (func $rename (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_create_directory" (func $mkdir (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 100) "/work/b")
  (data (i32.const 110) "/work/c")
  (data (i32.const 120) "/work/d")
  (data (i32.const 130) "/work/d/f")
  (data (i32.const 140) "/work/e")
  (data (i32.const 150) "/work/e/f")
  (func $check (param $errno i32) (param $code i32)
    (if (local.get $errno) (then (call $proc_exit (local.get $code)))))
  ;; writes the st_ino of the filestat at 400
  (func $ino
    (i32.store (i32.const 0) (i32.const 408))
    (i32.store (i32.const 4) (i32.const 8))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8))))
  (func $stat_ino (param $path i32) (param $len i32) (param $code i32)
    (call $check (call $stat (i32.const 3) (i32.const 1) (local.get $path) (local.get $len) (i32.const 400))
      (local.get $code))
    (call $ino))
  (func $create (param $path i32) (param $len i32) (param $code i32) (result i32)
    (call $check (call $path_open (i32.const 3) (i32.const 0) (local.get $path) (local.get $len)
      (i32.const 1) (i64.const -1) (i64.const -1) (i32.const 0) (i32.const 24)) (local.get $code))
    (i32.load (i32.const 24)))
  (func (export "_start")
    (local $fd i32)
    (local.set $fd (call $create (i32.const 100) (i32.const 7) (i32.const 10)))
    (call $check (call $rename (i32.const 3) (i32.const 100) (i32.const 7)
      (i32.const 3) (i32.const 110) (i32.const 7)) (i32.const 11))
    (call $stat_ino (i32.const 110) (i32.const 7) (i32.const 12))
    (call $check (call $fstat (local.get $fd) (i32.const 400)) (i32.const 13))
    (call $ino)
    (call $check (call $fd_close (local.get $fd)) (i32.const 14))
    (call $check (call $mkdir (i32.const 3) (i32.const 120) (i32.const 7)) (i32.const 15))
    (call $check (call $fd_close (call $create (i32.const 130) (i32.const 9) (i32.const 16))) (i32.const 17))
    (call $check (call $stat (i32.const 3) (i32.const 1) (i32.const 130) (i32.const 9) (i32.const 400))
      (i32.const 18))
    (call $check (call $rename (i32.const 3) (i32.const 120) (i32.const 7)
      (i32.const 3) (i32.const 140) (i32.const 7)) (i32.const 19))
    (call $stat_ino (i32.const 150) (i32.const 9) (i32.const 20))
    (call $stat_ino (i32.const 140) (i32.const 7) (i32.const 21))))
"#;

/// A renamed file or directory reports the inode number of its new path,
/// as one looked up there would (#1054). The runner finds a file's mode by
/// that number (`/proc/iwci/ino/`, which Edge.js's and Git's C library
/// read after every `stat`), so with the number of its old path a mode set
/// on a file renamed into place read back as the default: `git init` found
/// modes untrustworthy and set `core.filemode=false`.
#[test]
fn a_renamed_file_has_the_inode_number_of_its_new_path() {
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let outcome = rt
        .run_command(
            &wat_module("renamed-inodes", RENAMED_INODES),
            invocation(job.as_dyn(), &[]),
        )
        .unwrap();
    assert!(outcome.success(), "{outcome:?}");
    let got: Vec<u64> = outcome
        .stdout
        .chunks(8)
        .map(|b| u64::from_le_bytes(b.try_into().unwrap()))
        .collect();
    let ino = |path: &str| crate::modes::ino_of(Path::new(path));
    assert_eq!(
        got,
        vec![
            ino("/work/c"),
            ino("/work/c"),
            ino("/work/e/f"),
            ino("/work/e")
        ]
    );
}

/// Lists `/work/d` as Rust's standard library does, 128 bytes of entries
/// a call, removing each entry it reads before it reads on, as `rm -rf`
/// does, then removes the directory. Exits 10 to 13 when a call fails, and
/// 20 plus the number removed when that is not 6.
const READDIR_UNLINK: &str = r#"
(module
  (import "wasi_snapshot_preview1" "path_open" (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_readdir" (func $readdir (param i32 i32 i32 i64 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_unlink_file" (func $unlink (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_remove_directory" (func $rmdir (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 100) "/work/d")
  (func (export "_start")
    (local $fd i32) (local $cookie i64) (local $used i32) (local $at i32) (local $len i32)
    (local $removed i32)
    ;; a directory, with every right but FD_WRITE (64)
    (if (call $path_open (i32.const 3) (i32.const 0) (i32.const 100) (i32.const 7)
          (i32.const 2) (i64.const -65) (i64.const -1) (i32.const 0) (i32.const 24))
      (then (call $proc_exit (i32.const 10))))
    (local.set $fd (i32.load (i32.const 24)))
    ;; entries at 1024: d_next (u64) at +0, d_namlen (u32) at +16, the name at +24
    (block $done
      (loop $read
        (if (call $readdir (local.get $fd) (i32.const 1024) (i32.const 128) (local.get $cookie)
              (i32.const 28))
          (then (call $proc_exit (i32.const 11))))
        (local.set $used (i32.load (i32.const 28)))
        (local.set $at (i32.const 0))
        (block $batch
          (loop $entry
            (br_if $batch (i32.gt_u (i32.add (local.get $at) (i32.const 24)) (local.get $used)))
            (local.set $len (i32.load (i32.add (i32.const 1040) (local.get $at))))
            (br_if $batch (i32.gt_u (i32.add (i32.add (local.get $at) (i32.const 24)) (local.get $len))
              (local.get $used)))
            ;; `.` and `..` start with a dot; the files do not
            (if (i32.ne (i32.load8_u (i32.add (i32.const 1048) (local.get $at))) (i32.const 46))
              (then
                (if (call $unlink (local.get $fd) (i32.add (i32.const 1048) (local.get $at))
                      (local.get $len))
                  (then (call $proc_exit (i32.const 12))))
                (local.set $removed (i32.add (local.get $removed) (i32.const 1)))))
            (local.set $cookie (i64.load (i32.add (i32.const 1024) (local.get $at))))
            (local.set $at (i32.add (local.get $at) (i32.add (i32.const 24) (local.get $len))))
            (br $entry)))
        (br_if $done (i32.lt_u (local.get $used) (i32.const 128)))
        (br $read)))
    (drop (call $fd_close (local.get $fd)))
    (if (i32.ne (local.get $removed) (i32.const 6))
      (then (call $proc_exit (i32.add (i32.const 20) (local.get $removed)))))
    (if (call $rmdir (i32.const 3) (i32.const 100) (i32.const 7))
      (then (call $proc_exit (i32.const 13))))))
"#;

/// A directory read a few entries a call while its entries are removed
/// gives every entry once (#1078). Each `fd_readdir` listed the directory
/// afresh and took the cookie as a position in that listing, so each entry
/// removed since moved the rest down by one and as many were skipped:
/// `rm -rf` of a directory of three or more files removed some and failed
/// with "Directory not empty".
#[test]
fn reading_a_directory_while_removing_its_entries_misses_none() {
    let rt = runtime();
    let files: Vec<(String, &str)> = (1..=6).map(|i| (format!("/work/d/f{i}"), "x")).collect();
    let files: Vec<(&str, &str)> = files.iter().map(|(p, t)| (p.as_str(), *t)).collect();
    let job = snapshot(&files).fork();
    let outcome = rt
        .run_command(
            &wat_module("readdir-unlink", READDIR_UNLINK),
            invocation(job.as_dyn(), &[]),
        )
        .unwrap();
    assert!(outcome.success(), "{outcome:?}");
    assert!(job.as_dyn().metadata(Path::new("/work/d")).is_err());
}

/// Makes `/work/m/a` with a file in it, renames it to `/work/dist/a`,
/// removes `/work/m`, then stats `..` from a descriptor of the moved
/// directory, as `scandir` does for every entry it reads. Exits with a code
/// from 10 up naming the first call that fails, 19 when `..` is not
/// `/work/dist`.
const MOVED_DIR_PARENT: &str = r#"
(module
  (import "wasi_snapshot_preview1" "path_open" (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $fd_close (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_filestat_get" (func $stat (param i32 i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_rename" (func $rename (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_create_directory" (func $mkdir (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_remove_directory" (func $rmdir (param i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 100) "/work/m")
  (data (i32.const 110) "/work/m/a")
  (data (i32.const 120) "/work/m/a/f")
  (data (i32.const 140) "/work/dist")
  (data (i32.const 160) "/work/dist/a")
  (data (i32.const 180) "..")
  (func $check (param $errno i32) (param $code i32)
    (if (local.get $errno) (then (call $proc_exit (local.get $code)))))
  (func (export "_start")
    (local $fd i32)
    (call $check (call $mkdir (i32.const 3) (i32.const 100) (i32.const 7)) (i32.const 10))
    (call $check (call $mkdir (i32.const 3) (i32.const 110) (i32.const 9)) (i32.const 11))
    (call $check (call $path_open (i32.const 3) (i32.const 0) (i32.const 120) (i32.const 11)
      (i32.const 1) (i64.const -1) (i64.const -1) (i32.const 0) (i32.const 24)) (i32.const 12))
    (call $check (call $fd_close (i32.load (i32.const 24))) (i32.const 12))
    (call $check (call $mkdir (i32.const 3) (i32.const 140) (i32.const 10)) (i32.const 13))
    (call $check (call $rename (i32.const 3) (i32.const 110) (i32.const 9)
      (i32.const 3) (i32.const 160) (i32.const 12)) (i32.const 14))
    (call $check (call $rmdir (i32.const 3) (i32.const 100) (i32.const 7)) (i32.const 15))
    ;; the moved directory, with every right but FD_WRITE (64)
    (call $check (call $path_open (i32.const 3) (i32.const 0) (i32.const 160) (i32.const 12)
      (i32.const 2) (i64.const -65) (i64.const -1) (i32.const 0) (i32.const 24)) (i32.const 16))
    (local.set $fd (i32.load (i32.const 24)))
    ;; filestats at 400 (`..`) and 512 (/work/dist): st_ino at +8
    (call $check (call $stat (local.get $fd) (i32.const 0) (i32.const 180) (i32.const 2) (i32.const 400))
      (i32.const 17))
    (call $check (call $stat (i32.const 3) (i32.const 0) (i32.const 140) (i32.const 10) (i32.const 512))
      (i32.const 18))
    (if (i64.ne (i64.load (i32.const 408)) (i64.load (i32.const 520)))
      (then (call $proc_exit (i32.const 19))))
    (call $check (call $fd_close (local.get $fd)) (i32.const 20))))
"#;

/// A directory renamed into another has that one as its `..` (#1079). It
/// kept its old parent, which only holds it weakly, so once that was
/// removed `..` could not be looked up (EACCES), and neither could the
/// moved directory be listed with `scandir`, which stats every entry it
/// reads, `..` included: Node's `fs.readdirSync` threw.
#[test]
fn a_directory_moved_out_of_a_removed_one_has_its_new_parent() {
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let outcome = rt
        .run_command(
            &wat_module("moved-dir-parent", MOVED_DIR_PARENT),
            invocation(job.as_dyn(), &[]),
        )
        .unwrap();
    assert!(outcome.success(), "{outcome:?}");
    assert_eq!(job.read("/work/dist/a/f").unwrap(), b"");
}

/// Sends `/work/src` into a new `/work/dst` with `sock_send_file`, asking
/// for more than the file holds, and exits with a code from 10 up naming the
/// first call that fails, 13 when it did not send the whole file.
const SENDFILE_TO_FILE: &str = r#"
(module
  (import "wasi_snapshot_preview1" "path_open" (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_close" (func $fd_close (param i32) (result i32)))
  (import "wasix_32v1" "sock_send_file" (func $send_file (param i32 i32 i64 i64 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $proc_exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 100) "/work/src")
  (data (i32.const 120) "/work/dst")
  (func $check (param $errno i32) (param $code i32)
    (if (local.get $errno) (then (call $proc_exit (local.get $code)))))
  (func (export "_start")
    (call $check (call $path_open (i32.const 3) (i32.const 0) (i32.const 100) (i32.const 9)
      (i32.const 0) (i64.const -1) (i64.const -1) (i32.const 0) (i32.const 24)) (i32.const 10))
    (call $check (call $path_open (i32.const 3) (i32.const 0) (i32.const 120) (i32.const 9)
      (i32.const 1) (i64.const -1) (i64.const -1) (i32.const 0) (i32.const 28)) (i32.const 11))
    (call $check (call $send_file (i32.load (i32.const 28)) (i32.load (i32.const 24))
      (i64.const 0) (i64.const 1000) (i32.const 32)) (i32.const 12))
    (if (i64.ne (i64.load (i32.const 32)) (i64.const 14))
      (then (call $proc_exit (i32.const 13))))
    (call $check (call $fd_close (i32.load (i32.const 28))) (i32.const 14))
    (call $check (call $fd_close (i32.load (i32.const 24))) (i32.const 15))))
"#;

/// `sendfile` copies into a file, as on Linux (#1075). wasmer-wasix sent
/// only to sockets and answered EACCES for anything else, and libc++'s
/// `std::filesystem::copy_file` copies with it, so Node's `fs.cpSync` of a
/// directory (which copies in C++) threw.
#[test]
fn sendfile_copies_into_a_file() {
    let rt = runtime();
    let job = snapshot(&[("/work/src", "hello sendfile")]).fork();
    let outcome = rt
        .run_command(
            &wat_module("sendfile-to-file", SENDFILE_TO_FILE),
            invocation(job.as_dyn(), &[]),
        )
        .unwrap();
    assert!(outcome.success(), "{outcome:?}");
    assert_eq!(job.read("/work/dst").unwrap(), b"hello sendfile");
}

/// Prints, as one digit each, the WASI file type `fd_fdstat_get` gives
/// stdin, stdout and stderr, the one `fd_filestat_get` gives a new pipe, the
/// one `fd_fdstat_get` gives stdin once that pipe is put in its place and
/// gives one end of a socket pair, and the one `fd_filestat_get` gives
/// stderr once it is moved to descriptor 9 (`E` if it is refused).
const FILE_TYPES: &str = r#"
(module
  (import "wasi_snapshot_preview1" "fd_fdstat_get" (func $fdstat (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_filestat_get" (func $filestat (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_renumber" (func $renumber (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasix_32v1" "fd_pipe" (func $pipe (param i32 i32) (result i32)))
  (import "wasix_32v1" "sock_pair" (func $sock_pair (param i32 i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func $digit (param $at i32) (param $type i32)
    (i32.store8 (local.get $at) (i32.add (i32.const 48) (local.get $type))))
  (func $fdstat_type (param $fd i32) (param $at i32)
    (if (call $fdstat (local.get $fd) (i32.const 64)) (then (unreachable)))
    (call $digit (local.get $at) (i32.load8_u (i32.const 64))))
  (func (export "_start")
    (call $fdstat_type (i32.const 0) (i32.const 200))
    (call $fdstat_type (i32.const 1) (i32.const 201))
    (call $fdstat_type (i32.const 2) (i32.const 202))
    ;; a pipe: read end at 16, write end at 20; filestat's type is at +16
    (if (call $pipe (i32.const 16) (i32.const 20)) (then (unreachable)))
    (if (call $filestat (i32.load (i32.const 16)) (i32.const 96)) (then (unreachable)))
    (call $digit (i32.const 203) (i32.load8_u (i32.const 112)))
    (if (call $renumber (i32.load (i32.const 16)) (i32.const 0)) (then (unreachable)))
    (call $fdstat_type (i32.const 0) (i32.const 204))
    ;; a socket pair (a stream): ends at 24 and 28
    (if (call $sock_pair (i32.const 1) (i32.const 1) (i32.const 0) (i32.const 24) (i32.const 28))
      (then (unreachable)))
    (call $fdstat_type (i32.load (i32.const 24)) (i32.const 205))
    ;; stderr moved by dup2 keeps the right to be stat'ed
    (if (call $renumber (i32.const 2) (i32.const 9)) (then (unreachable)))
    (if (call $filestat (i32.const 9) (i32.const 96))
      (then (i32.store8 (i32.const 206) (i32.const 69)))
      (else (call $digit (i32.const 206) (i32.load8_u (i32.const 112)))))
    (i32.store (i32.const 0) (i32.const 200))
    (i32.store (i32.const 4) (i32.const 7))
    (drop (call $fd_write (i32.const 1) (i32.const 0) (i32.const 1) (i32.const 8)))))
"#;

/// Nothing a job has is a terminal (#1008): its stdin is empty and its
/// output goes to the log. wasmer-wasix answered "character device" for
/// descriptors 0 to 2 whatever they held, which is what the C library's
/// `isatty` takes for a terminal, so `python` read a piped script as an
/// interactive session and tools coloured the log. What libuv (and so Node)
/// asks next must then be answered, or a child `node`'s output is dropped:
/// `fstat` of a pipe says character device, a socket pair is a stream
/// socket to `fd_fdstat_get` too (libc's `SO_TYPE`), and a descriptor
/// moved by `dup2` can still be stat'ed (vendor/README.md).
#[test]
fn no_descriptor_is_a_terminal() {
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let outcome = rt
        .run_command(
            &wat_module("types", FILE_TYPES),
            invocation(job.as_dyn(), &[]),
        )
        .unwrap();
    assert!(outcome.success(), "{outcome:?}");
    // 4 is a regular file, 2 a character device, 0 unknown (what a pipe is
    // to `fd_fdstat_get`) and 6 a stream socket.
    assert_eq!(String::from_utf8_lossy(&outcome.stdout), "4442062");
}

#[test]
fn an_infinite_loop_is_stopped_by_the_timeout() {
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let module = wat_module(
        "spin",
        r#"(module (memory (export "memory") 1) (func (export "_start") (loop $l (br $l))))"#,
    );
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.limits.timeout = Duration::from_millis(300);
    let outcome = rt.run_command(&module, inv).unwrap();
    assert!(outcome.timed_out, "{outcome:?}");
    assert_eq!(outcome.exit_code, TIMEOUT_EXIT_CODE);
    assert!(outcome.duration < Duration::from_secs(5), "{outcome:?}");
}

/// Sleeps in `poll_oneoff` for `$ns` nanoseconds, `$n` times, writing a
/// dot to stdout after each sleep when `$print` is set.
fn sleeper(ns: u64, times: u32, print: bool) -> WasmModule {
    let wat = format!(
        r#"(module
  (import "wasi_snapshot_preview1" "poll_oneoff" (func $poll (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 200) ".")
  (func (export "_start") (local $i i32)
    ;; one clock subscription at 0: userdata, tag 0 (clock), clock id 1
    ;; (monotonic), relative timeout
    (i32.store8 (i32.const 8) (i32.const 0))
    (i32.store (i32.const 16) (i32.const 1))
    (i64.store (i32.const 24) (i64.const {ns}))
    (i32.store (i32.const 220) (i32.const 200))
    (i32.store (i32.const 224) (i32.const 1))
    (loop $l
      (drop (call $poll (i32.const 0) (i32.const 64) (i32.const 1) (i32.const 128)))
      (if (i32.const {print})
        (then (drop (call $fd_write (i32.const 1) (i32.const 220) (i32.const 1) (i32.const 232)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $l (i32.lt_u (local.get $i) (i32.const {times}))))))"#,
        print = i32::from(print),
    );
    wat_module("sleeper", &wat)
}

/// A job that waits on nothing, using no CPU and printing nothing, is
/// stopped as stalled long before its timeout (#938).
#[cfg(target_os = "linux")]
#[test]
fn a_job_that_waits_on_nothing_is_stopped_as_stalled() {
    let base = runtime();
    let rt = Runtime::new(base.dir.join("stall"))
        .unwrap()
        .with_stall_after(Some(Duration::from_secs(1)));
    let job = snapshot(&[]).fork();
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.limits.timeout = Duration::from_secs(60);
    let outcome = rt
        .run_command(&sleeper(3_600_000_000_000, 1, false), inv)
        .unwrap();
    assert_eq!(
        outcome.stalled_after,
        Some(Duration::from_secs(1)),
        "{outcome:?}"
    );
    assert!(!outcome.timed_out && !outcome.success(), "{outcome:?}");
    assert_eq!(outcome.exit_code, TIMEOUT_EXIT_CODE);
    assert!(outcome.duration < Duration::from_secs(20), "{outcome:?}");
}

/// A compile holds the shared engine's lock, which a job needs to start a
/// process: a job waiting behind another job's compile is not hung, however
/// long the compile takes.
#[cfg(target_os = "linux")]
#[test]
fn a_module_loading_for_any_job_keeps_every_job_from_stalling() {
    let base = runtime();
    let rt = Runtime::new(base.dir.join("stall"))
        .unwrap()
        .with_stall_after(Some(Duration::from_millis(500)));
    let job = snapshot(&[]).fork();
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.limits.timeout = Duration::from_secs(60);
    // Someone's module is loading for as long as this job sleeps: three
    // seconds, six times the window.
    let loading = rt.store.working();
    let outcome = rt
        .run_command(&sleeper(3_000_000_000, 1, false), inv)
        .unwrap();
    drop(loading);
    assert!(outcome.success(), "{outcome:?}");
    assert_eq!(outcome.stalled_after, None, "{outcome:?}");
    assert!(!rt.store.is_working());
}

/// Output keeps a job that uses no CPU alive, and a silent job that keeps
/// computing is left to its timeout: neither is a hang.
#[test]
fn output_or_cpu_use_keeps_a_job_from_stalling() {
    let base = runtime();
    let rt = Runtime::new(base.dir.join("stall"))
        .unwrap()
        .with_stall_after(Some(Duration::from_secs(2)));
    let job = snapshot(&[]).fork();
    // A dot every 200 ms for 6 s: three times the window, never idle for
    // it, with room for a busy machine to hold a dot up.
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.limits.timeout = Duration::from_secs(120);
    let outcome = rt
        .run_command(&sleeper(200_000_000, 30, true), inv)
        .unwrap();
    assert!(outcome.success(), "{outcome:?}");
    assert_eq!(outcome.stdout, ".".repeat(30).as_bytes());

    let spin = wat_module(
        "spin",
        r#"(module (memory (export "memory") 1) (func (export "_start") (loop $l (br $l))))"#,
    );
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.limits.timeout = Duration::from_secs(5);
    let outcome = rt.run_command(&spin, inv).unwrap();
    assert!(outcome.timed_out, "{outcome:?}");
    assert_eq!(outcome.stalled_after, None, "{outcome:?}");
}

#[test]
fn growing_memory_past_the_limit_fails_and_is_reported() {
    let rt = runtime();
    let job = snapshot(&[]).fork();
    // Grows 16 pages (1 MiB) at a time until refused, then exits 1 if it
    // got at least to 1 MiB, 2 if refused at once.
    let module = wat_module(
        "grow",
        r#"(module
          (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
          (memory (export "memory") 1)
          (func (export "_start") (local $grown i32)
            (block $done
              (loop $l
                (br_if $done (i32.eq (memory.grow (i32.const 16)) (i32.const -1)))
                (local.set $grown (i32.add (local.get $grown) (i32.const 1)))
                (br $l)))
            (if (i32.ge_u (local.get $grown) (i32.const 1))
              (then (call $exit (i32.const 1))))
            (call $exit (i32.const 2))))"#,
    );
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.limits.memory_bytes = 8 << 20;
    let outcome = rt.run_command(&module, inv).unwrap();
    assert_eq!(outcome.exit_code, 1, "{outcome:?}");
    assert!(outcome.out_of_memory, "{outcome:?}");
}

#[test]
fn a_trap_is_a_crash_not_an_exit() {
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let module = wat_module(
        "trap",
        r#"(module (memory (export "memory") 1) (func (export "_start") unreachable))"#,
    );
    let outcome = rt
        .run_command(&module, invocation(job.as_dyn(), &[]))
        .unwrap();
    assert_eq!(outcome.exit_code, CRASH_EXIT_CODE, "{outcome:?}");
    assert!(outcome.error.is_some(), "{outcome:?}");
}

#[test]
fn output_past_the_cap_is_truncated() {
    let dir = temp_dir("cap");
    let rt = Runtime::new(dir.clone()).unwrap().with_output_cap(4);
    let job = snapshot(&[]).fork();
    let outcome = rt
        .run_command(&wat_module("hello", HELLO), invocation(job.as_dyn(), &[]))
        .unwrap();
    assert_eq!(outcome.stdout, b"hell");
    assert!(outcome.truncated);
    drop(rt);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn many_jobs_run_at_once_on_one_runtime() {
    let rt = Arc::new(runtime());
    let snap = snapshot(&[]);
    let module = wat_module("hello", HELLO);
    let handles: Vec<_> = (0..8)
        .map(|i| {
            let rt = rt.clone();
            let job = snap.fork();
            let module = module.clone();
            std::thread::spawn(move || {
                let outcome = rt
                    .run_command(&module, invocation(job.as_dyn(), &[&i.to_string()]))
                    .unwrap();
                assert_eq!(outcome.exit_code, 3);
                assert_eq!(job.changes("/work").len(), 1);
            })
        })
        .collect();
    for handle in handles {
        handle.join().unwrap();
    }
    assert_eq!(rt.cache_stats().compiled, 1, "{:?}", rt.cache_stats());
}

#[test]
fn compiled_modules_are_cached_on_disk_and_tampering_forces_a_recompile() {
    let dir = temp_dir("cache");
    let module = wat_module("hello", HELLO);

    let first = Runtime::new(dir.clone()).unwrap();
    first.prepare(&module).unwrap();
    first.prepare(&module).unwrap();
    assert_eq!(first.cache_stats().compiled, 1);
    // Preparing fills the disk, not memory (#1035).
    assert_eq!(first.cache_stats().resident_bytes, 0);
    drop(first);

    let second = Runtime::new(dir.clone()).unwrap();
    second.prepare(&module).unwrap();
    assert_eq!(second.cache_stats().compiled, 0);
    // And the module loaded from disk runs.
    let job = snapshot(&[]).fork();
    assert_eq!(
        second
            .run_command(&module, invocation(job.as_dyn(), &[]))
            .unwrap()
            .exit_code,
        3
    );
    assert_eq!(
        second.cache_stats().from_disk,
        1,
        "{:?}",
        second.cache_stats()
    );
    drop(second);

    let artifact = find(&dir, ".wasmu");
    let mut bytes = std::fs::read(&artifact).unwrap();
    let middle = bytes.len() / 2;
    bytes[middle] ^= 0xff;
    std::fs::write(&artifact, &bytes).unwrap();

    let third = Runtime::new(dir.clone()).unwrap();
    third.prepare(&module).unwrap();
    let stats = third.cache_stats();
    assert_eq!(
        (stats.rejected, stats.compiled, stats.from_disk),
        (1, 1, 0),
        "{stats:?}"
    );
    drop(third);

    // The recompile rewrote a good artifact.
    let fourth = Runtime::new(dir.clone()).unwrap();
    fourth.prepare(&module).unwrap();
    let stats = fourth.cache_stats();
    assert_eq!((stats.rejected, stats.compiled), (0, 0), "{stats:?}");
    drop(fourth);
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_module_whose_bytes_do_not_match_its_hash_is_refused() {
    let rt = runtime();
    let good = wat_module("hello", HELLO);
    let lying = WasmModule::with_sha256("hello", [7; 32], good.bytes.clone());
    assert!(matches!(
        rt.prepare(&lying),
        Err(Error::HashMismatch { .. })
    ));
}

fn find(dir: &Path, suffix: &str) -> PathBuf {
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            return find(&path, suffix);
        }
        if path.to_string_lossy().ends_with(suffix) {
            return path;
        }
    }
    panic!("no {suffix} under {}", dir.display());
}

#[test]
fn jobs_get_a_private_loopback_and_nothing_else() {
    let rt = runtime();
    let (engine, _) = wasix::job_engine(rt.store.generation().engine(), 1 << 20, 1 << 20);
    let job = wasix::JobRuntime::for_tests(&rt.wasix, engine);
    use wasmer_wasix::Runtime as _;
    let net = job.networking();
    let addr: std::net::SocketAddr = "127.0.0.1:80".parse().unwrap();
    let local: std::net::SocketAddr = "0.0.0.0:0".parse().unwrap();
    // Nothing listens yet, so the job's own loopback refuses; the host's is
    // never consulted.
    assert!(futures::executor::block_on(net.connect_tcp(local, addr)).is_err());
    let outside: std::net::SocketAddr = "93.184.216.34:443".parse().unwrap();
    assert!(futures::executor::block_on(net.connect_tcp(local, outside)).is_err());
    let _listener = futures::executor::block_on(net.listen_tcp(addr, false, false, false)).unwrap();
    assert!(futures::executor::block_on(net.connect_tcp(local, addr)).is_ok());
    assert!(futures::executor::block_on(net.resolve("example.com", None, None)).is_err());
    assert!(job.http_client().is_none());
    let query: wasmer_config::package::PackageSource = "wasmer/bash".parse().unwrap();
    assert!(futures::executor::block_on(job.source().query(&query)).is_err());
}

/// A stand-in for ts-rust's module with its exact ABI. `ts_run` echoes the
/// request to stderr, then exercises the host: Read (printed), Write into a
/// directory that does not exist yet, Stat (printed), ReadDir (printed), a
/// Read of a missing file (must be -1) and a Write below a file (must fail
/// with an error text, printed on stderr). It returns 7, and the reply is
/// `[{"x":1}]`.
const FAKE_TSC: &str = r#"
(module
  (import "ts_host" "fs" (func $fs (param i32 i32 i32) (result i32)))
  (import "ts_host" "fs_take" (func $take (param i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "path_open" (func $path_open (param i32 i32 i32 i32 i32 i64 i64 i32 i32) (result i32)))
  (memory (export "memory") 2)
  (global $inlen (mut i32) (i32.const 0))
  (data (i32.const 16) "/p/a.ts")
  (data (i32.const 32) "/p/out/b.js\00hello")
  (data (i32.const 64) "/p")
  (data (i32.const 72) "/p/missing.ts")
  (data (i32.const 96) "[{\"x\":1}]")
  (data (i32.const 120) "\n")
  (data (i32.const 128) "/p/a.ts/x\00y")
  (func $write (param $fd i32) (param $ptr i32) (param $len i32)
    (i32.store (i32.const 0) (local.get $ptr))
    (i32.store (i32.const 4) (local.get $len))
    (drop (call $fd_write (local.get $fd) (i32.const 0) (i32.const 1) (i32.const 8))))
  (func $print (param $n i32)
    (call $take (i32.const 1024))
    (call $write (i32.const 1) (i32.const 1024) (local.get $n))
    (call $write (i32.const 1) (i32.const 120) (i32.const 1)))
  (func (export "ts_input") (param $len i32) (result i32)
    (global.set $inlen (local.get $len))
    (i32.const 4096))
  (func (export "ts_output") (result i32) (i32.const 96))
  (func (export "ts_output_len") (result i32) (i32.const 9))
  (func (export "ts_run") (result i32) (local $n i32)
    (call $write (i32.const 2) (i32.const 4096) (global.get $inlen))
    (call $write (i32.const 2) (i32.const 120) (i32.const 1))
    ;; WASI file access is not part of the shim
    (if (i32.ne (call $path_open (i32.const 3) (i32.const 0) (i32.const 16) (i32.const 7)
              (i32.const 0) (i64.const -1) (i64.const -1) (i32.const 0) (i32.const 24))
            (i32.const 52))
      (then (return (i32.const 9))))
    (local.set $n (call $fs (i32.const 0) (i32.const 16) (i32.const 7)))
    (if (i32.lt_s (local.get $n) (i32.const 0)) (then (return (i32.const 10))))
    (call $print (local.get $n))
    (if (call $fs (i32.const 4) (i32.const 32) (i32.const 17)) (then (return (i32.const 11))))
    (local.set $n (call $fs (i32.const 1) (i32.const 16) (i32.const 7)))
    (call $print (local.get $n))
    (local.set $n (call $fs (i32.const 2) (i32.const 64) (i32.const 2)))
    (call $print (local.get $n))
    (if (i32.ne (call $fs (i32.const 0) (i32.const 72) (i32.const 13)) (i32.const -1))
      (then (return (i32.const 12))))
    (local.set $n (call $fs (i32.const 4) (i32.const 128) (i32.const 11)))
    (if (i32.ge_s (local.get $n) (i32.const -1)) (then (return (i32.const 13))))
    (call $take (i32.const 1024))
    (call $write (i32.const 2) (i32.const 1024) (i32.sub (i32.const -2) (local.get $n)))
    (i32.const 7)))
"#;

#[test]
fn the_tsc_host_serves_file_operations_from_the_job_fs() {
    let rt = runtime();
    let job = snapshot(&[("/p/a.ts", "export const a = 1;\n")]).fork();
    let module = wat_module("tsc", FAKE_TSC);
    let mut inv = invocation(job.as_dyn(), &["-p", "."]);
    inv.cwd = "/p".into();
    let outcome = rt.run_tsc(&module, inv, true).unwrap();
    assert_eq!(outcome.exit_code, 7, "{outcome:?}");
    assert_eq!(outcome.diagnostics_json.as_deref(), Some(r#"[{"x":1}]"#));
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert_eq!(
        stderr, "/p\x001\x00-p\x00.\nmkdir /p/a.ts: not a directory",
        "{outcome:?}"
    );
    let stdout = String::from_utf8_lossy(&outcome.stdout);
    let lines: Vec<&str> = stdout.split('\n').collect();
    assert_eq!(lines[0], "export const a = 1;");
    assert!(lines[2].starts_with("f 20 "), "{stdout:?}");
    let entries = lines[3];
    assert!(
        entries.contains("fa.ts\0") && entries.contains("dout\0"),
        "{stdout:?}"
    );
    assert_eq!(
        job.changes("/p"),
        vec![Change::Added {
            path: "/p/out/b.js".into(),
            bytes: b"hello".to_vec()
        }]
    );
}

#[test]
fn a_tsc_panic_exits_through_proc_exit_with_an_empty_reply() {
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let module = wat_module(
        "tsc-panic",
        r#"(module
          (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
          (memory (export "memory") 1)
          (func (export "ts_input") (param i32) (result i32) (i32.const 1024))
          (func (export "ts_output") (result i32) (i32.const 0))
          (func (export "ts_output_len") (result i32) (i32.const 0))
          (func (export "ts_run") (result i32) (call $exit (i32.const 70)) (i32.const 0)))"#,
    );
    let outcome = rt
        .run_tsc(&module, invocation(job.as_dyn(), &[]), true)
        .unwrap();
    assert_eq!(outcome.exit_code, 70, "{outcome:?}");
    assert_eq!(outcome.diagnostics_json.as_deref(), Some("[]"));
    assert!(outcome.error.is_none());
}

#[test]
fn a_spinning_tsc_is_stopped_by_the_timeout() {
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let module = wat_module(
        "tsc-spin",
        r#"(module
          (memory (export "memory") 1)
          (func (export "ts_input") (param i32) (result i32) (i32.const 1024))
          (func (export "ts_output") (result i32) (i32.const 0))
          (func (export "ts_output_len") (result i32) (i32.const 0))
          (func (export "ts_run") (result i32) (loop $l (br $l)) (i32.const 0)))"#,
    );
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.limits.timeout = Duration::from_millis(200);
    let outcome = rt.run_tsc(&module, inv, false).unwrap();
    assert!(outcome.timed_out, "{outcome:?}");
    assert_eq!(outcome.exit_code, TIMEOUT_EXIT_CODE);
}

#[test]
fn deep_recursion_fits_in_the_tsc_stack() {
    // 200k frames of a function with a few locals is far past wasmer's
    // default 1 MiB stack, and well within the 256 MiB tsc gets.
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let module = wat_module(
        "tsc-deep",
        r#"(module
          (memory (export "memory") 1)
          (func $down (param $n i32) (result i32) (local i64 i64 i64 i64)
            (if (result i32) (i32.eqz (local.get $n))
              (then (i32.const 0))
              (else (i32.add (i32.const 1) (call $down (i32.sub (local.get $n) (i32.const 1)))))))
          (func (export "ts_input") (param i32) (result i32) (i32.const 1024))
          (func (export "ts_output") (result i32) (i32.const 0))
          (func (export "ts_output_len") (result i32) (i32.const 0))
          (func (export "ts_run") (result i32)
            (if (i32.ne (call $down (i32.const 200000)) (i32.const 200000))
              (then (return (i32.const 1))))
            (i32.const 0)))"#,
    );
    let outcome = rt
        .run_tsc(&module, invocation(job.as_dyn(), &[]), false)
        .unwrap();
    assert_eq!(outcome.exit_code, 0, "{outcome:?}");
}

mod host_fs {
    use super::*;
    use crate::tsc::{Reply, fs_call};

    fn call(fs: &DynFs, op: i32, request: &str) -> Reply {
        fs_call(fs.as_ref(), op, request.as_bytes())
    }

    fn text(reply: Reply) -> String {
        match reply {
            Reply::Ok(bytes) => String::from_utf8(bytes).unwrap(),
            other => panic!("{other:?}"),
        }
    }

    fn fixture() -> iwci_vfs::JobFs {
        let builder = SnapshotBuilder::new();
        builder.write("/p/a.ts", b"a").unwrap();
        builder
            .write("/p/node_modules/.pnpm/x/index.d.ts", b"x")
            .unwrap();
        builder.symlink("/p/node_modules/x", ".pnpm/x").unwrap();
        builder.freeze().fork()
    }

    #[test]
    fn stat_and_read_follow_links_and_read_dir_does_not() {
        let job = fixture();
        let fs = job.as_dyn();
        assert!(text(call(&fs, 1, "/p/node_modules/x")).starts_with("d 0 "));
        assert_eq!(text(call(&fs, 0, "/p/node_modules/x/index.d.ts")), "x");
        assert!(text(call(&fs, 1, "/p/a.ts")).starts_with("f 1 "));
        let entries = text(call(&fs, 2, "/p/node_modules"));
        assert!(
            entries.contains("lx\0") && entries.contains("d.pnpm\0"),
            "{entries:?}"
        );
        assert_eq!(call(&fs, 1, "/p/nope"), Reply::Failed);
        assert_eq!(call(&fs, 2, "/p/a.ts"), Reply::Failed);
    }

    #[test]
    fn realpath_resolves_links_and_dot_dot() {
        let job = fixture();
        let fs = job.as_dyn();
        assert_eq!(
            text(call(&fs, 3, "/p/node_modules/x/../x/index.d.ts")),
            "/p/node_modules/.pnpm/x/index.d.ts"
        );
        assert_eq!(text(call(&fs, 3, "/")), "/");
        assert_eq!(call(&fs, 3, "/p/missing"), Reply::Failed);
    }

    #[test]
    fn writes_make_parents_append_and_report_go_errors() {
        let job = fixture();
        let fs = job.as_dyn();
        assert_eq!(call(&fs, 4, "/p/out/deep/a.js\0one"), Reply::Ok(Vec::new()));
        assert_eq!(call(&fs, 5, "/p/out/deep/a.js\0two"), Reply::Ok(Vec::new()));
        assert_eq!(job.read("/p/out/deep/a.js").unwrap(), b"onetwo");
        assert_eq!(
            call(&fs, 4, "/p/out\0x"),
            Reply::Error("open /p/out: is a directory".into())
        );
        assert_eq!(
            call(&fs, 4, "/p/a.ts/b\0x"),
            Reply::Error("mkdir /p/a.ts: not a directory".into())
        );
    }

    #[test]
    fn remove_is_recursive_and_quiet_about_missing_paths() {
        let job = fixture();
        let fs = job.as_dyn();
        assert_eq!(call(&fs, 6, "/p/node_modules"), Reply::Ok(Vec::new()));
        assert_eq!(call(&fs, 6, "/p/never"), Reply::Ok(Vec::new()));
        assert_eq!(call(&fs, 1, "/p/node_modules"), Reply::Failed);
        assert!(job.read("/p/a.ts").is_ok());
        // A directory the job wrote into removes too.
        call(&fs, 4, "/p/out/x.js\0x");
        call(&fs, 4, "/p/out/deep/y.js\0y");
        assert_eq!(call(&fs, 6, "/p/out"), Reply::Ok(Vec::new()));
        assert_eq!(call(&fs, 1, "/p/out"), Reply::Failed);
        assert_eq!(
            job.changes("/p"),
            vec![Change::Deleted {
                path: "/p/node_modules/.pnpm/x/index.d.ts".into()
            },]
        );
    }

    #[test]
    fn chtimes_sets_the_mtime_of_a_written_file() {
        let job = fixture();
        let fs = job.as_dyn();
        call(&fs, 4, "/p/o.js\0x");
        assert_eq!(
            call(&fs, 7, "/p/o.js\0\x00123456789"),
            Reply::Ok(Vec::new())
        );
        assert_eq!(text(call(&fs, 1, "/p/o.js")), "f 1 123456789");
        assert_eq!(
            call(&fs, 7, "/p/none\0\x001"),
            Reply::Error("chtimes /p/none: no such file or directory".into())
        );
    }
}

/// A fixture named by an environment variable. Unset, the test skips, so a
/// plain `cargo test` needs nothing built; with `IWCI_REQUIRE_FIXTURES` set
/// (the CI job that builds the builtins) it fails instead, so a renamed
/// variable or a lost path cannot quietly turn these tests off.
fn fixture(var: &str, what: &str) -> Option<PathBuf> {
    match std::env::var_os(var) {
        Some(path) => Some(PathBuf::from(path)),
        None if std::env::var_os("IWCI_REQUIRE_FIXTURES").is_some() => {
            panic!("IWCI_REQUIRE_FIXTURES is set but {var} is not: {what}")
        }
        None => {
            eprintln!("skipping: set {var} to {what}");
            None
        }
    }
}

/// gofmt built for `GOOS=wasip1`: a real Go runtime under WASI.
#[test]
fn gofmt_lists_and_rewrites_a_badly_formatted_file() {
    // `builtins/gofmt/build.sh` builds one, or
    // `GOOS=wasip1 GOARCH=wasm go build -o gofmt.wasm cmd/gofmt`.
    let Some(path) = fixture("IWCI_TEST_GOFMT_WASM", "a gofmt built for wasip1") else {
        return;
    };
    let bytes = std::fs::read(&path)
        .unwrap_or_else(|e| panic!("IWCI_TEST_GOFMT_WASM={}: {e}", path.display()));
    let rt = runtime();
    let job = snapshot(&[
        (
            "/work/bad.go",
            "package main\nfunc main(){\nprintln( 1 )}\n",
        ),
        ("/work/good.go", "package main\n\nfunc f() {}\n"),
    ])
    .fork();
    // No `PWD`: the runtime sets it from the cwd, which Go's wasip1 port
    // needs to resolve `.`.
    let mut inv = invocation(job.as_dyn(), &["-l", "-w", "."]);
    inv.limits.memory_bytes = 1 << 30;
    let outcome = rt
        .run_command(&WasmModule::new("gofmt", bytes), inv)
        .unwrap();
    assert_eq!(outcome.exit_code, 0, "{outcome:?}");
    assert_eq!(String::from_utf8_lossy(&outcome.stdout), "bad.go\n");
    assert_eq!(
        job.changes("/work"),
        vec![Change::Modified {
            path: "/work/bad.go".into(),
            bytes: b"package main\n\nfunc main() {\n\tprintln(1)\n}\n".to_vec()
        }]
    );
}

/// The packages of an environment `builtins/environments/build.sh` built
/// (a directory with its `build.json`, such as `dist/environment/bash/5.1.17`),
/// or a directory holding just `bash.webc` and `coreutils.webc`.
fn webc_packages() -> Option<Vec<WebcPackage>> {
    let dir = fixture(
        "IWCI_TEST_WEBC_DIR",
        "an environment build directory, or one with bash.webc and coreutils.webc",
    )?;
    let read = |file: &str| {
        std::fs::read(dir.join(file))
            .unwrap_or_else(|e| panic!("IWCI_TEST_WEBC_DIR: {}: {e}", dir.join(file).display()))
    };
    if dir.join("build.json").exists() {
        let build: serde_json::Value = serde_json::from_slice(&read("build.json")).unwrap();
        let packages: Vec<WebcPackage> = build["packages"]
            .as_array()
            .expect("build.json lists packages")
            .iter()
            .map(|p| {
                let field = |k: &str| p[k].as_str().expect("package fields are strings");
                WebcPackage::new(field("name"), field("version"), read(field("file")))
            })
            .collect();
        assert!(
            packages.iter().any(|p| p.name == "wasmer/bash"),
            "the environment has no bash"
        );
        return Some(packages);
    }
    Some(vec![
        WebcPackage::new("wasmer/bash", "1.0.25", read("bash.webc")),
        WebcPackage::new("wasmer/coreutils", "1.0.27", read("coreutils.webc")),
    ])
}

#[test]
fn a_bash_script_spawns_coreutils_writes_files_and_stops_on_false() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let rt = runtime();
    rt.prepare_environment(&packages).unwrap();
    let compiled = rt.cache_stats().compiled;
    assert!(compiled >= 2, "{:?}", rt.cache_stats());
    let job = snapshot(&[("/work/README", "readme\n")]).fork();
    let script = r#"
mkdir -p out/nested
echo "hello $GREETING $1" > out/nested/greeting.txt
cat out/nested/greeting.txt
ls
cat README | wc -l
false
echo unreachable
"#;
    let outcome = rt
        .run_script(
            &packages,
            "bash",
            script,
            invocation(job.as_dyn(), &["arg1"]),
        )
        .unwrap();
    let stdout = String::from_utf8_lossy(&outcome.stdout);
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert_eq!(
        outcome.exit_code, 1,
        "stdout {stdout:?} stderr {stderr:?} {outcome:?}"
    );
    assert!(stdout.contains("hello hi arg1\n"), "{stdout:?} {stderr:?}");
    assert!(
        stdout.contains("README") && stdout.contains("out"),
        "{stdout:?}"
    );
    assert!(stdout.contains('1'), "{stdout:?}");
    assert!(!stdout.contains("unreachable"), "{stdout:?}");
    // Only the script's own write: the commands wasmer-wasix installs in
    // /bin and anything under /tmp or /dev stay out of the job's changes.
    assert_eq!(
        job.changes("/"),
        vec![Change::Added {
            path: "/work/out/nested/greeting.txt".into(),
            bytes: b"hello hi arg1\n".to_vec()
        }]
    );

    // A clean script exits 0, and a second run reuses the compiled commands.
    let job = snapshot(&[]).fork();
    let outcome = rt
        .run_script(
            &packages,
            "bash",
            "echo ok | cat",
            invocation(job.as_dyn(), &[]),
        )
        .unwrap();
    assert_eq!(outcome.exit_code, 0, "{outcome:?}");
    assert_eq!(outcome.stdout, b"ok\n");
    assert_eq!(
        rt.cache_stats().compiled,
        compiled,
        "{:?}",
        rt.cache_stats()
    );
}

/// An argument with a line feed in it reaches a program bash runs whole
/// (#1003): bash's exec joined the arguments with line feeds and WASIX
/// split them there again, so a second bash got `a`, `b` and `c`.
#[test]
fn a_program_bash_runs_gets_an_argument_with_a_line_feed_whole() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let rt = runtime();
    let job = snapshot(&[("/work/README", "readme\n")]).fork();
    let script = "bash -c 'printf \"%s|\" \"$@\"' _ \"a\nb\" c\nenv printf '%s|' \"p\nq\"\n";
    let outcome = rt
        .run_script(&packages, "bash", script, invocation(job.as_dyn(), &[]))
        .unwrap();
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert_eq!(outcome.exit_code, 0, "{stderr:?} {outcome:?}");
    assert_eq!(
        String::from_utf8_lossy(&outcome.stdout),
        "a\nb|c|p\nq|",
        "{stderr:?}"
    );
}

/// A bash script can put its own descriptors on 3 and 4 (#1019), which
/// were the preopens and refused with "Not supported", and its paths, and
/// the programs it starts, keep working after it has and once it closes
/// them again.
#[test]
fn a_bash_script_can_use_descriptors_3_and_4() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let rt = runtime();
    let job = snapshot(&[("/work/README", "readme\n")]).fork();
    let script = "exec 3>&1 4< README\necho three >&3\nread -r line <&4\necho \"$line\"\n\
        cat README\nexec 3>&- 4<&-\necho done > out.txt\ncat out.txt\n";
    let outcome = rt
        .run_script(&packages, "bash", script, invocation(job.as_dyn(), &[]))
        .unwrap();
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert_eq!(outcome.exit_code, 0, "{stderr:?} {outcome:?}");
    assert_eq!(
        String::from_utf8_lossy(&outcome.stdout),
        "three\nreadme\nreadme\ndone\n",
        "{stderr:?}"
    );
}

/// A child's exit status reaches its parent whole (#1053). wasmer-wasix
/// reported it through an `Errno`, which has no value past 78, so every
/// status from 80 up read as 79: `git`'s fatal 128, a shell's 126 and 127,
/// `timeout`'s 124 and 128 plus a signal's number all looked alike.
#[test]
fn a_childs_exit_status_reaches_its_parent_whole() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let script = "set +e\nfor c in 1 78 79 80 126 127 128 200 255; do bash -c \"exit $c\"; printf '%s ' $?; done\n\
        bash -c 'exit 129' & wait $!; echo $?\n";
    let outcome = rt
        .run_script(&packages, "bash", script, invocation(job.as_dyn(), &[]))
        .unwrap();
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert_eq!(outcome.exit_code, 0, "{stderr:?} {outcome:?}");
    assert_eq!(
        String::from_utf8_lossy(&outcome.stdout),
        "1 78 79 80 126 127 128 200 255 129\n",
        "{stderr:?}"
    );
}

/// `rm -rf` of snapshot directories followed by recreating one, the shape
/// of every `rm -rf dist && mkdir dist` build script. The overlay fix in
/// iwci-vfs is what makes this pass.
#[test]
fn a_bash_script_can_rm_rf_and_recreate_snapshot_directories() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let rt = runtime();
    let job = snapshot(&[
        ("/work/nm/a/b/c.js", "c"),
        ("/work/nm/a/d.js", "d"),
        ("/work/dist/old.js", "old"),
    ])
    .fork();
    let script = "rm -rf nm\nrm -rf dist\nmkdir dist\necho new > dist/new.js\nls dist\n";
    let outcome = rt
        .run_script(&packages, "bash", script, invocation(job.as_dyn(), &[]))
        .unwrap();
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert_eq!(outcome.exit_code, 0, "stderr {stderr:?} {outcome:?}");
    assert_eq!(String::from_utf8_lossy(&outcome.stdout), "new.js\n");
    assert_eq!(
        job.changes("/work"),
        vec![
            Change::Added {
                path: "/work/dist/new.js".into(),
                bytes: b"new\n".to_vec()
            },
            Change::Deleted {
                path: "/work/dist/old.js".into()
            },
            Change::Deleted {
                path: "/work/nm/a/b/c.js".into()
            },
            Change::Deleted {
                path: "/work/nm/a/d.js".into()
            },
        ]
    );
}

/// `rm -rf` removes a directory of many files, created by the job or in
/// the snapshot, in one go (#1078).
#[test]
fn a_bash_script_can_rm_rf_a_directory_of_many_files() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let rt = runtime();
    let files: Vec<(String, &str)> = (1..=40)
        .map(|i| (format!("/work/old/file-{i}.js"), "x"))
        .collect();
    let files: Vec<(&str, &str)> = files.iter().map(|(p, t)| (p.as_str(), *t)).collect();
    let job = snapshot(&files).fork();
    let script = "mkdir new\nfor i in $(seq 1 40); do echo x > new/file-$i.js; done\n\
                  rm -rf new old\nls\n";
    let outcome = rt
        .run_script(&packages, "bash", script, invocation(job.as_dyn(), &[]))
        .unwrap();
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert_eq!(outcome.exit_code, 0, "stderr {stderr:?} {outcome:?}");
    assert_eq!(String::from_utf8_lossy(&outcome.stdout), "");
}

/// A script's job has a user database that says who it is, and `SHELL` is
/// in the environment of what it starts (#1077).
#[test]
fn a_bash_script_has_a_user_database_and_a_shell() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let script = "head -n 1 /etc/passwd\nhead -n 1 /etc/group\nenv | grep '^SHELL='\n";
    let outcome = rt
        .run_script(&packages, "bash", script, invocation(job.as_dyn(), &[]))
        .unwrap();
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert_eq!(outcome.exit_code, 0, "stderr {stderr:?} {outcome:?}");
    assert_eq!(
        String::from_utf8_lossy(&outcome.stdout),
        "root:x:0:0:root:/root:/bin/bash\nroot:x:0:\nSHELL=/bin/bash\n"
    );
    assert_eq!(job.changes("/"), Vec::new());
}

#[derive(Debug)]
struct Unlimited(AtomicU64);
impl iwci_vfs::WriteBudget for Unlimited {
    fn take(&self, n: u64) -> bool {
        self.0.fetch_add(n, Ordering::SeqCst);
        true
    }
    fn give(&self, n: u64) {
        self.0.fetch_sub(n, Ordering::SeqCst);
    }
}

/// Writing files from a script, with and without a write budget: the
/// budget wraps every writable file, and must not change what a program
/// can do with one. (`dd` creating a new output file fails under WASIX
/// either way, so it writes into one that exists; see the README.)
#[test]
fn writing_files_behaves_the_same_with_a_write_budget() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let rt = runtime();
    let script = "head -c 4096 /dev/zero > a.bin\ntouch b.bin\ndd if=/dev/zero of=b.bin bs=1024 count=4 conv=notrunc 2>/dev/null\necho more >> a.bin\nwc -c a.bin b.bin\n";
    let mut outputs = Vec::new();
    for limited in [false, true] {
        let budget = Arc::new(Unlimited(AtomicU64::new(0)));
        let snap = snapshot(&[("/work/README", "x")]);
        let job = if limited {
            snap.fork_limited(budget.clone())
        } else {
            snap.fork()
        };
        let outcome = rt
            .run_script(&packages, "bash", script, invocation(job.as_dyn(), &[]))
            .unwrap();
        let stdout = String::from_utf8_lossy(&outcome.stdout).into_owned();
        assert_eq!(
            outcome.exit_code,
            0,
            "limited={limited} {stdout:?} {:?}",
            String::from_utf8_lossy(&outcome.stderr)
        );
        assert!(
            stdout.contains("4101 a.bin") && stdout.contains("4096 b.bin"),
            "limited={limited} {stdout:?}"
        );
        if limited {
            assert_eq!(
                budget.0.load(Ordering::SeqCst),
                4101 + 4096,
                "every byte written is counted once"
            );
        }
        outputs.push(stdout);
    }
    assert_eq!(outputs[0], outputs[1]);
}

#[test]
fn a_spinning_bash_script_is_stopped_by_the_timeout() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.limits.timeout = Duration::from_millis(1500);
    let outcome = rt
        .run_script(&packages, "bash", "while true; do :; done", inv)
        .unwrap();
    assert!(outcome.timed_out, "{outcome:?}");
    assert!(outcome.duration < Duration::from_secs(10), "{outcome:?}");
}

/// An interrupt traps compiled Wasm only, never host code that runs on the
/// Wasm stack (#968). A host function's return path does, and takes the
/// interrupt registry's lock, which `interrupt()` holds while it signals:
/// a thread returning from a host call while its store was interrupted
/// waited for that lock, the signal trapped it there, and what it was doing
/// was abandoned. The first time a thread waits on a `parking_lot` lock it
/// registers a thread-local destructor, and abandoning that left glibc a
/// destructor node with no owner: the thread segfaulted as it exited, which
/// is how test binaries died after killing a job whose forked subshell spun
/// on syscalls. Here a fresh thread calls a host function in a loop while
/// another interrupts its store as fast as it can, and is then joined: it
/// must have been trapped each time, and exit whole. Before the vendored
/// wasmer-vm patch this aborted, segfaulted or deadlocked every time.
#[cfg(target_os = "linux")]
#[test]
fn killing_a_syscall_spinner_leaves_its_threads_whole() {
    use std::sync::atomic::AtomicBool;
    use wasmer::{Function, Instance, Store, imports};

    let engine = crate::cache::build_engine();
    let wasm = wat::parse_str(
        r#"(module
  (import "host" "call" (func $call))
  (func (export "spin") (loop $l (call $call) (br $l))))"#,
    )
    .unwrap();
    let module = wasmer::Module::new(&engine, wasm).unwrap();
    for _ in 0..16 {
        let (engine, module) = (engine.clone(), module.clone());
        std::thread::spawn(move || {
            let mut store = Store::new(engine);
            let call = Function::new_typed(&mut store, || {});
            let imports = imports! { "host" => { "call" => call } };
            let instance = Instance::new(&mut store, &module, &imports).unwrap();
            let spin = instance
                .exports
                .get_typed_function::<(), ()>(&store, "spin")
                .unwrap();
            let interrupter = store.interrupter();
            let stop = Arc::new(AtomicBool::new(false));
            let hammer = {
                let stop = stop.clone();
                std::thread::spawn(move || {
                    while !stop.load(Ordering::Relaxed) {
                        interrupter.interrupt();
                    }
                })
            };
            for _ in 0..20 {
                let err = spin.call(&mut store).unwrap_err();
                assert_eq!(
                    err.clone().to_trap(),
                    Some(wasmer_types::TrapCode::HostInterrupt),
                    "{err}"
                );
            }
            stop.store(true, Ordering::Relaxed);
            hammer.join().unwrap();
        })
        .join()
        .unwrap();
    }
}

/// A script whose processes all wait on nothing is stalled; one with a
/// process computing in silence is not, for as long as it computes. Every
/// process of the job counts: here bash waits in `sleep` while a subshell
/// it forked loops.
#[cfg(target_os = "linux")]
#[test]
fn a_script_stalls_only_when_all_of_it_is_idle() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let base = runtime();
    let rt = Runtime::new(base.dir.join("stall"))
        .unwrap()
        .with_stall_after(Some(Duration::from_secs(2)));
    let job = snapshot(&[]).fork();
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.limits.timeout = Duration::from_secs(120);
    let outcome = rt
        .run_script(&packages, "bash", "echo started; sleep 600", inv)
        .unwrap();
    assert_eq!(
        outcome.stalled_after,
        Some(Duration::from_secs(2)),
        "{outcome:?}"
    );
    assert_eq!(outcome.stdout, b"started\n");
    assert!(outcome.duration < Duration::from_secs(60), "{outcome:?}");

    // The same wait beside a subshell that computes for six seconds, three
    // windows, without a word: the job is left alone while it does, and
    // stalls once it has finished.
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.limits.timeout = Duration::from_secs(120);
    let outcome = rt
        .run_script(
            &packages,
            "bash",
            "(while [ $SECONDS -lt 6 ]; do :; done) & sleep 600",
            inv,
        )
        .unwrap();
    assert_eq!(
        outcome.stalled_after,
        Some(Duration::from_secs(2)),
        "{outcome:?}"
    );
    assert!(!outcome.timed_out, "{outcome:?}");
    assert!(outcome.duration >= Duration::from_secs(7), "{outcome:?}");
    assert!(outcome.duration < Duration::from_secs(90), "{outcome:?}");

    // And beside one that never stops: never stalled, so killed with the
    // job by its timeout. Killing a subshell that spins on syscalls once
    // crashed this test binary as the runtime's threads exited (#968:
    // `killing_a_syscall_spinner_leaves_its_threads_whole`).
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.limits.timeout = Duration::from_secs(8);
    let outcome = rt
        .run_script(
            &packages,
            "bash",
            "(while true; do :; done) & sleep 600",
            inv,
        )
        .unwrap();
    assert!(outcome.timed_out, "{outcome:?}");
    assert_eq!(outcome.stalled_after, None, "{outcome:?}");
}

/// The real compiler: set IWCI_TEST_TS_RUST_WASM to ts-rust's
/// `npm/wasm/ts_rust.wasm`.
#[test]
#[ignore = "needs ts-rust's wasm module (IWCI_TEST_TS_RUST_WASM)"]
fn real_tsc_reports_diagnostics_as_json_and_emits() {
    let path = std::env::var_os("IWCI_TEST_TS_RUST_WASM").expect("IWCI_TEST_TS_RUST_WASM");
    let bytes = std::fs::read(path).unwrap();
    let rt = runtime();
    let job = snapshot(&[
        (
            "/p/tsconfig.json",
            r#"{"compilerOptions":{"outDir":"out","types":[]},"files":["a.ts"]}"#,
        ),
        ("/p/a.ts", "export const n: number = 'one';\n"),
    ])
    .fork();
    let mut inv = invocation(job.as_dyn(), &["-p", "."]);
    inv.cwd = "/p".into();
    inv.limits.memory_bytes = 2 << 30;
    inv.limits.timeout = Duration::from_secs(120);
    let outcome = rt
        .run_tsc(&WasmModule::new("tsc", bytes), inv, true)
        .unwrap();
    assert_eq!(outcome.exit_code, 2, "{outcome:?}");
    let json = outcome.diagnostics_json.unwrap();
    assert!(json.contains(r#""code":2322"#), "{json}");
    assert_eq!(
        job.read("/p/out/a.js").unwrap(),
        b"export const n = 'one';\n"
    );
}

#[test]
fn output_is_handed_to_the_log_sink_as_it_is_written() {
    let rt = runtime();
    let module = wat_module("hello", HELLO);
    let job = snapshot(&[]).fork();
    type Chunks = Vec<(Stream, Vec<u8>)>;
    let seen: Arc<std::sync::Mutex<Chunks>> = Arc::default();
    let sink_seen = seen.clone();
    let mut inv = invocation(job.as_dyn(), &["a"]);
    inv.log = Some(Arc::new(move |stream, data: &[u8]| {
        sink_seen.lock().unwrap().push((stream, data.to_vec()))
    }));
    let outcome = rt.run_command(&module, inv).unwrap();
    let seen = seen.lock().unwrap();
    let streamed: Vec<u8> = seen
        .iter()
        .filter(|(s, _)| *s == Stream::Stdout)
        .flat_map(|(_, d)| d.clone())
        .collect();
    assert!(!streamed.is_empty());
    assert_eq!(
        streamed, outcome.stdout,
        "the sink sees what the capture keeps"
    );
}

/// A process that dies of a signal leaves the runner's account of it at the
/// end of its stderr, in the live log too: here one that raises SIGABRT on
/// itself with no handler, which the host ends with 128 + 6 (#955).
#[test]
fn a_job_killed_by_a_signal_says_who_sent_it() {
    let rt = runtime();
    let module = wat_module(
        "raise",
        r#"(module
  (import "wasi_snapshot_preview1" "proc_raise" (func $raise (param i32) (result i32)))
  (import "wasi_snapshot_preview1" "sched_yield" (func $yield (result i32)))
  (memory (export "memory") 1)
  (func (export "_start")
    (drop (call $raise (i32.const 6)))
    ;; Signals are acted on at a syscall.
    (drop (call $yield))
    (drop (call $yield))))"#,
    );
    let job = snapshot(&[]).fork();
    type Chunks = Vec<(Stream, Vec<u8>)>;
    let seen: Arc<std::sync::Mutex<Chunks>> = Arc::default();
    let sink_seen = seen.clone();
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.log = Some(Arc::new(move |stream, data: &[u8]| {
        sink_seen.lock().unwrap().push((stream, data.to_vec()))
    }));
    let outcome = rt.run_command(&module, inv).unwrap();
    assert_eq!(outcome.exit_code, 134, "{outcome:?}");
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert!(
        stderr.contains("iwci: the job exited with 134 after a signal."),
        "{stderr}"
    );
    assert!(stderr.contains("a guest called proc_raise"), "{stderr}");
    // The live log gets the same words, as stderr.
    let streamed: Vec<u8> = seen
        .lock()
        .unwrap()
        .iter()
        .filter(|(s, _)| *s == Stream::Stderr)
        .flat_map(|(_, d)| d.clone())
        .collect();
    assert_eq!(streamed, outcome.stderr);

    // A job that just fails says nothing more.
    let exit = wat_module(
        "exit",
        r#"(module
  (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
  (memory (export "memory") 1)
  (func (export "_start") (call $exit (i32.const 3))))"#,
    );
    let outcome = rt
        .run_command(&exit, invocation(job.as_dyn(), &[]))
        .unwrap();
    assert_eq!(outcome.exit_code, 3, "{outcome:?}");
    assert!(outcome.stderr.is_empty(), "{outcome:?}");
}

/// wasix-libc's own death by signal: bash sends itself SIGSYS, which it
/// does not handle, so libc prints its line and aborts with 127, as #955's
/// `node` did. The log names the syscall that sent it.
#[test]
fn a_script_killed_by_sigsys_names_the_syscall_that_sent_it() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let outcome = rt
        .run_script(
            &packages,
            "bash",
            "kill -s SYS $$; echo unreachable",
            invocation(job.as_dyn(), &[]),
        )
        .unwrap();
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert_eq!(outcome.exit_code, 127, "{outcome:?} {stderr}");
    assert!(outcome.stdout.is_empty(), "{outcome:?}");
    assert!(
        stderr.contains("Program recieved fatal signal: Bad system call"),
        "{stderr}"
    );
    assert!(
        stderr.contains("iwci: the job exited with 127 after a signal."),
        "{stderr}"
    );
    assert!(stderr.contains("a guest called "), "{stderr}");
    assert!(stderr.contains("Sigsys"), "{stderr}");
    assert!(
        stderr.contains("its thread's task had started "),
        "{stderr}"
    );
    assert!(!stderr.contains("came from the host runtime"), "{stderr}");
}

/// The run's scratch is one file system mounted into every job, inside the
/// job's own `/tmp`, and it outlives each job.
#[test]
fn a_scratch_directory_is_shared_between_separate_runs() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let rt = runtime();
    let scratch = SnapshotBuilder::new().freeze().fork();
    let first = snapshot(&[]).fork();
    let mut inv = invocation(first.as_dyn(), &[]);
    inv.scratch = Some(scratch.as_dyn());
    let outcome = rt
        .run_script(
            &packages,
            "bash",
            "mkdir -p /tmp/workflow/dist && echo built > /tmp/workflow/dist/out.txt && echo private > /tmp/mine.txt",
            inv,
        )
        .unwrap();
    assert_eq!(outcome.exit_code, 0, "{outcome:?}");
    assert_eq!(scratch.read("/dist/out.txt").unwrap(), b"built\n");
    // The scratch is not the job's change, and the job's own /tmp is not
    // shared.
    assert!(first.changes("/").is_empty(), "{:?}", first.changes("/"));

    let second = snapshot(&[]).fork();
    let mut inv = invocation(second.as_dyn(), &[]);
    inv.scratch = Some(scratch.as_dyn());
    let outcome = rt
        .run_script(
            &packages,
            "bash",
            "cat /tmp/workflow/dist/out.txt; test ! -e /tmp/mine.txt",
            inv,
        )
        .unwrap();
    assert_eq!(outcome.exit_code, 0, "{outcome:?}");
    assert_eq!(outcome.stdout, b"built\n");
}

/// `tools:`: a WASI command on PATH, run by name from a script.
#[test]
fn a_script_runs_a_tool_on_path_by_name() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let Some(path) = fixture("IWCI_TEST_GOFMT_WASM", "a gofmt built for wasip1") else {
        return;
    };
    let bytes = std::fs::read(&path).unwrap();
    let rt = runtime();
    let job = snapshot(&[(
        "/work/bad.go",
        "package main\nfunc main(){\nprintln( 1 )}\n",
    )])
    .fork();
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.limits.memory_bytes = 1 << 30;
    inv.commands = vec![PathCommand {
        name: "gofmt".into(),
        module: WasmModule::new("gofmt", bytes),
    }];
    let outcome = rt
        .run_script(&packages, "bash", "command -v gofmt\ngofmt -l .", inv)
        .unwrap();
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert_eq!(outcome.exit_code, 0, "stderr {stderr:?} {outcome:?}");
    assert_eq!(
        String::from_utf8_lossy(&outcome.stdout),
        "/usr/local/bin/gofmt\nbad.go\n"
    );
}

/// A command a script runs that traps, in a script that handles its
/// failure and then fails for its own reasons: the log still says what
/// crashed. (Unhandled, the script ends with the command's status and the
/// job is already reported as a crash.)
#[test]
fn a_trap_in_a_child_process_is_in_the_jobs_log() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.commands = vec![PathCommand {
        name: "boom".into(),
        module: wat_module(
            "boom",
            r#"(module (memory (export "memory") 1) (func (export "_start") unreachable))"#,
        ),
    }];
    let outcome = rt
        .run_script(
            &packages,
            "bash",
            "boom || echo \"boom exited $?\"\nexit 3",
            inv,
        )
        .unwrap();
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert_eq!(outcome.exit_code, 3, "stderr {stderr:?} {outcome:?}");
    assert!(outcome.error.is_none(), "{outcome:?}");
    assert!(
        stderr.contains(
            "iwci: a process or thread of the job crashed, which its exit status (3) does not say:"
        ),
        "{stderr}"
    );
    assert!(stderr.contains("unreachable"), "{stderr}");

    // The same command in a script that passes leaves the log alone.
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.commands = vec![PathCommand {
        name: "boom".into(),
        module: wat_module(
            "boom",
            r#"(module (memory (export "memory") 1) (func (export "_start") unreachable))"#,
        ),
    }];
    let outcome = rt
        .run_script(&packages, "bash", "boom || true", inv)
        .unwrap();
    assert_eq!(outcome.exit_code, 0, "{outcome:?}");
    assert!(outcome.stderr.is_empty(), "{outcome:?}");
}

#[test]
fn node_options_put_the_support_preload_first() {
    let preload = format!("--require {}/preload.cjs", wasix::NODE_SUPPORT_DIR);
    assert_eq!(wasix::node_options(&[]), preload);
    assert_eq!(
        wasix::node_options(&[("NODE_OPTIONS".into(), "--max-old-space-size=512".into())]),
        format!("{preload} --max-old-space-size=512"),
        "what the job set is kept, after the preload"
    );
    assert_eq!(
        wasix::node_options(&[("NODE_OPTIONS".into(), "  ".into())]),
        preload
    );
}

/// A module that takes a while to compile: `functions` functions of a few
/// hundred instructions each, none of them ever called.
fn slow_to_compile(functions: usize) -> Vec<u8> {
    let mut wat = String::from("(module (memory (export \"memory\") 1)\n");
    for f in 0..functions {
        wat.push_str(&format!(
            "(func $f{f} (export \"f{f}\") (param i32 i64) (result i64) (local i32 i64)\n"
        ));
        for i in 0..60 {
            wat.push_str(&format!(
                "local.get 0 i32.const {i} i32.add i32.const 7 i32.mul local.set 2 \
                 local.get 1 local.get 2 i64.extend_i32_u i64.xor i64.const {f} i64.rotl local.set 3 \
                 local.get 3 local.get 2 i32.const 3 i32.and i32.eqz (if (result i64) (then i64.const 1) (else i64.const 2)) i64.add local.set 1\n"
            ));
        }
        wat.push_str("local.get 1)\n");
    }
    wat.push(')');
    wat::parse_str(&wat).unwrap()
}

/// #963: compiling a module used to hold the engine every job shares from
/// start to finish, and starting any process needs that engine too, so
/// every other job stopped starting processes until the compile ended.
#[test]
fn a_process_starts_while_another_job_compiles_a_module() {
    use std::time::Instant;

    let rt = runtime();
    let small = wat_module("hello", HELLO);
    rt.prepare(&small).unwrap();
    let big = WasmModule::new("big", slow_to_compile(3000));
    std::thread::scope(|scope| {
        let compile = scope.spawn(|| {
            let started = Instant::now();
            rt.prepare(&big).unwrap();
            started.elapsed()
        });
        while !rt.store.is_working() {
            std::thread::sleep(Duration::from_millis(1));
        }
        std::thread::sleep(Duration::from_millis(100));
        let started = Instant::now();
        let job = snapshot(&[]).fork();
        let outcome = rt
            .run_command(&small, invocation(job.as_dyn(), &[]))
            .unwrap();
        let took = started.elapsed();
        let compile_took = compile.join().unwrap();
        assert_eq!(outcome.exit_code, 3, "{outcome:?}");
        // Waiting for the compile, the start took nearly all of it.
        assert!(
            took * 4 < compile_took,
            "the process took {took:?} to start, against {compile_took:?} for the compile"
        );
    });
    assert_eq!(rt.cache_stats().compiled, 2, "{:?}", rt.cache_stats());
}

/// Measures #963 on a real module: how long a process takes to start
/// while another job compiles `IWCI_TEST_BIG_WASM` (a wasm module, or a
/// webc whose largest atom is compiled), with `IWCI_BENCH_STARTERS` jobs
/// (default 4) starting processes meanwhile, `IWCI_BENCH_PAUSE_MS` apart
/// (default 0). Prints the numbers; run with `--ignored --nocapture`.
#[test]
#[ignore = "needs a large module (IWCI_TEST_BIG_WASM); prints timings"]
fn bench_process_starts_during_a_compile() {
    use std::sync::atomic::AtomicBool;
    use std::time::Instant;

    let path = std::env::var_os("IWCI_TEST_BIG_WASM").expect("IWCI_TEST_BIG_WASM");
    let bytes = std::fs::read(&path).unwrap();
    let wasm = if bytes.starts_with(b"\0asm") {
        bytes
    } else {
        let version = webc::detect(&bytes[..]).unwrap();
        let container =
            webc::Container::from_bytes_and_version(bytes::Bytes::from(bytes), version).unwrap();
        container
            .atoms()
            .into_values()
            .max_by_key(|a| a.len())
            .expect("the webc has an atom")
            .to_vec()
    };
    let starters: usize = std::env::var("IWCI_BENCH_STARTERS")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(4);
    let pause = Duration::from_millis(
        std::env::var("IWCI_BENCH_PAUSE_MS")
            .ok()
            .and_then(|n| n.parse().ok())
            .unwrap_or(0),
    );
    let big = WasmModule::new("big", wasm);
    let rt = runtime();
    let small = wat_module("hello", HELLO);
    rt.prepare(&small).unwrap();
    let start_one = || {
        let job = snapshot(&[]).fork();
        let started = Instant::now();
        let outcome = rt
            .run_command(&small, invocation(job.as_dyn(), &[]))
            .unwrap();
        assert_eq!(outcome.exit_code, 3, "{outcome:?}");
        started.elapsed()
    };
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    let summary = |label: &str, mut all: Vec<Duration>| {
        if all.is_empty() {
            println!("{label}: no starts");
            return;
        }
        all.sort();
        let at = |q: f64| all[((all.len() - 1) as f64 * q).round() as usize];
        println!(
            "{label}: {} starts, median {:.1} ms, p90 {:.1} ms, max {:.1} ms",
            all.len(),
            ms(at(0.5)),
            ms(at(0.9)),
            ms(at(1.0))
        );
    };
    summary("idle", (0..20).map(|_| start_one()).collect());

    let compiled = AtomicBool::new(false);
    let (compile_took, during) = std::thread::scope(|scope| {
        let compile = scope.spawn(|| {
            let started = Instant::now();
            rt.prepare(&big).unwrap();
            compiled.store(true, Ordering::SeqCst);
            started.elapsed()
        });
        while !rt.store.is_working() {
            std::thread::sleep(Duration::from_millis(1));
        }
        let jobs: Vec<_> = (0..starters)
            .map(|_| {
                scope.spawn(|| {
                    let mut took = Vec::new();
                    while !compiled.load(Ordering::SeqCst) {
                        took.push(start_one());
                        std::thread::sleep(pause);
                    }
                    took
                })
            })
            .collect();
        let during: Vec<Duration> = jobs.into_iter().flat_map(|j| j.join().unwrap()).collect();
        (compile.join().unwrap(), during)
    });
    println!(
        "compile of {} MiB of wasm: {:.0} ms",
        big.bytes.len() >> 20,
        ms(compile_took)
    );
    summary(&format!("during the compile, {starters} jobs"), during);

    // The artifact is on disk now: a fresh runtime over the same cache
    // loads it, which still takes the shared engine for a moment.
    let again = Runtime::new(rt.dir.clone()).unwrap();
    let started = Instant::now();
    again.prepare(&big).unwrap();
    println!("load from disk: {:.0} ms", ms(started.elapsed()));
}

/// A command sed's `e` runs reaches the shell whole (#1022): sed's
/// `posix_spawn` joined `sh -c`'s arguments with line feeds and WASIX split
/// them there again, so the shell got the command up to its first line feed.
#[test]
fn a_command_sed_runs_gets_its_line_feeds() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let rt = runtime();
    let job = snapshot(&[("/work/cmd.txt", "printf '%s|' 'a\nb'\n")]).fork();
    let outcome = rt
        .run_script(
            &packages,
            "bash",
            "sed 'N;s/^//e' cmd.txt\n",
            invocation(job.as_dyn(), &[]),
        )
        .unwrap();
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert_eq!(outcome.exit_code, 0, "{stderr:?} {outcome:?}");
    assert_eq!(
        String::from_utf8_lossy(&outcome.stdout),
        "a\nb|\n",
        "{stderr:?}"
    );
}

/// A process can start more children over its life than the job may have
/// at once (#1082). `posix_spawn` (sed's `e` here, Go's `os/exec`, Node's
/// `child_process`) left each child's main thread with the parent, so a
/// child that had exited and been waited for still counted against
/// `MAX_TASKS`, and the 512th spawn failed with "Operation not permitted".
#[test]
fn a_process_can_spawn_more_children_than_the_task_limit_one_by_one() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let children = wasix::MAX_TASKS + 100;
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.limits.timeout = Duration::from_secs(300);
    let outcome = rt
        .run_script(
            &packages,
            "bash",
            &format!("set -o pipefail\nseq {children} | sed 's/.*/echo x/e' | wc -l\n"),
            inv,
        )
        .unwrap();
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert_eq!(outcome.exit_code, 0, "{stderr:?} {outcome:?}");
    assert_eq!(
        String::from_utf8_lossy(&outcome.stdout).trim(),
        children.to_string(),
        "{stderr:?}"
    );
}

// Services (`background.rs`). The first tests use hand-written WASIX
// modules, so they need nothing built; the bash and Node ones read an
// environment like the tests above.

/// A WASIX server: after `delay_ms` it listens on `127.0.0.1:port`, says so
/// on stdout, and then sleeps for good, or spins without a single syscall
/// (so only the watchdog can stop it) when `spin` is set.
fn listener(port: u16, delay_ms: u64, spin: bool) -> WasmModule {
    let msg = format!("listening on {port}\\n");
    let len = msg.len() - 1;
    let body = if spin {
        ""
    } else {
        "(call $sleep (i64.const 50000000))"
    };
    // A relative timeout of 0 never returns from WASIX's `poll_oneoff`.
    let delay = if delay_ms == 0 {
        String::new()
    } else {
        format!("(call $sleep (i64.const {}))", delay_ms * 1_000_000)
    };
    let wat = format!(
        r#"(module
  (import "wasix_32v1" "sock_open" (func $open (param i32 i32 i32 i32) (result i32)))
  (import "wasix_32v1" "sock_bind" (func $bind (param i32 i32) (result i32)))
  (import "wasix_32v1" "sock_listen" (func $listen (param i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "poll_oneoff" (func $poll (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 300) "{msg}")
  (func $sleep (param $ns i64)
    ;; one relative clock subscription (see `sleeper`)
    (i32.store8 (i32.const 8) (i32.const 0))
    (i32.store (i32.const 16) (i32.const 1))
    (i64.store (i32.const 24) (local.get $ns))
    (drop (call $poll (i32.const 0) (i32.const 64) (i32.const 1) (i32.const 128))))
  (func (export "_start")
    {delay}
    ;; an IPv4 (1) stream (1) socket, its descriptor at 400
    (if (call $open (i32.const 1) (i32.const 1) (i32.const 0) (i32.const 400))
      (then (call $exit (i32.const 10))))
    ;; __wasi_addr_port_t at 500: family, padding, port, 127.0.0.1
    (i32.store8 (i32.const 500) (i32.const 1))
    (i32.store16 (i32.const 502) (i32.const {port}))
    (i32.store (i32.const 504) (i32.const 0x0100007f))
    (if (call $bind (i32.load (i32.const 400)) (i32.const 500))
      (then (call $exit (i32.const 11))))
    (if (call $listen (i32.load (i32.const 400)) (i32.const 16))
      (then (call $exit (i32.const 12))))
    (i32.store (i32.const 220) (i32.const 300))
    (i32.store (i32.const 224) (i32.const {len}))
    (drop (call $fd_write (i32.const 1) (i32.const 220) (i32.const 1) (i32.const 232)))
    (loop $l {body} (br $l))))"#,
    );
    wat_module("listener", &wat)
}

/// Says `bye` on stderr and exits 3.
const QUITTER: &str = r#"
(module
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 300) "bye\n")
  (func (export "_start")
    (i32.store (i32.const 220) (i32.const 300))
    (i32.store (i32.const 224) (i32.const 4))
    (drop (call $fd_write (i32.const 2) (i32.const 220) (i32.const 1) (i32.const 232)))
    (call $exit (i32.const 3))))
"#;

fn module_service(name: &str, module: WasmModule, ready: Ready, timeout: Duration) -> Service {
    Service {
        name: name.into(),
        program: ServiceProgram::Command {
            module,
            args: Vec::new(),
        },
        env: Vec::new(),
        ready,
        ready_timeout: timeout,
    }
}

fn script_service(
    name: &str,
    packages: &[WebcPackage],
    script: &str,
    env: &[(&str, &str)],
    ready: Ready,
) -> Service {
    Service {
        name: name.into(),
        program: ServiceProgram::Script {
            packages: packages.to_vec(),
            entry: "bash".into(),
            script: script.into(),
        },
        env: env
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect(),
        ready,
        ready_timeout: Duration::from_secs(20),
    }
}

#[test]
fn a_job_starts_once_its_service_listens_on_its_port() {
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.services = vec![module_service(
        "web",
        listener(4444, 300, false),
        Ready::Port(4444),
        Duration::from_secs(10),
    )];
    let outcome = rt.run_command(&wat_module("hello", HELLO), inv).unwrap();
    // HELLO ran (it exits 3 and writes out.txt) after the service was
    // ready, and the service's output is in the job's stderr.
    assert_eq!(outcome.exit_code, 3, "{outcome:?}");
    assert_eq!(outcome.service_failure, None);
    assert!(
        outcome.duration >= Duration::from_millis(300),
        "{outcome:?}"
    );
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert!(
        stderr.contains("[service web] listening on 4444\n"),
        "{stderr:?}"
    );
    assert!(job.read("/work/out.txt").is_ok());
    // The service, still running, was stopped promptly once the job ended.
    assert!(outcome.duration < Duration::from_secs(4), "{outcome:?}");
}

#[test]
fn a_service_that_is_never_ready_fails_the_job_in_its_time_without_running_it() {
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.services = vec![module_service(
        "db",
        listener(4444, 0, false),
        Ready::Port(5432),
        Duration::from_secs(1),
    )];
    let outcome = rt.run_command(&wat_module("hello", HELLO), inv).unwrap();
    assert_eq!(outcome.exit_code, 1, "{outcome:?}");
    assert!(!outcome.success());
    assert_eq!(
        outcome.service_failure.as_deref(),
        Some("service `db` was not ready after 1s: nothing listened on port 5432")
    );
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert!(
        stderr.ends_with(
            "iwci: service `db` was not ready after 1s: nothing listened on port 5432\n"
        ),
        "{stderr:?}"
    );
    // The job never ran.
    assert!(job.read("/work/out.txt").is_err());
    assert!(outcome.duration < Duration::from_secs(5), "{outcome:?}");

    // The job's own timeout bounds the wait too.
    let mut inv = invocation(snapshot(&[]).fork().as_dyn(), &[]);
    inv.limits.timeout = Duration::from_secs(1);
    inv.services = vec![module_service(
        "db",
        listener(4444, 0, false),
        Ready::Port(5432),
        Duration::from_secs(60),
    )];
    let outcome = rt.run_command(&wat_module("hello", HELLO), inv).unwrap();
    assert!(
        outcome
            .service_failure
            .as_deref()
            .is_some_and(|f| f.contains("when the job's timeout ran out")),
        "{outcome:?}"
    );
    assert!(outcome.duration < Duration::from_secs(5), "{outcome:?}");
}

#[test]
fn a_service_that_exits_before_it_is_ready_fails_the_job() {
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.services = vec![module_service(
        "db",
        wat_module("quitter", QUITTER),
        Ready::Port(5432),
        Duration::from_secs(30),
    )];
    let outcome = rt.run_command(&wat_module("hello", HELLO), inv).unwrap();
    assert_eq!(
        outcome.service_failure.as_deref(),
        Some("service `db` exited with 3 before it was ready"),
        "{outcome:?}"
    );
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert!(stderr.starts_with("[service db] bye\n"), "{stderr:?}");
    assert!(job.read("/work/out.txt").is_err());
    assert!(outcome.duration < Duration::from_secs(5), "{outcome:?}");
}

#[test]
fn a_service_that_ignores_its_stop_is_ended_and_never_holds_the_job() {
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let mut inv = invocation(job.as_dyn(), &[]);
    // It spins without a syscall once listening, so no signal reaches it;
    // only the watchdog stops it.
    inv.services = vec![module_service(
        "spin",
        listener(4445, 0, true),
        Ready::Port(4445),
        Duration::from_secs(10),
    )];
    let outcome = rt.run_command(&wat_module("hello", HELLO), inv).unwrap();
    assert_eq!(outcome.exit_code, 3, "{outcome:?}");
    assert!(!outcome.timed_out, "{outcome:?}");
    assert!(
        outcome.duration < background::STOP_GRACE + Duration::from_secs(3),
        "{outcome:?}"
    );
}

/// How `blocker` waits once it listens on `127.0.0.1:port`.
#[derive(Clone, Copy)]
enum Block {
    /// In `sock_accept` for a client nobody sends.
    Accept,
    /// In `sock_accept`, with an accept timeout of this many milliseconds
    /// set on the socket before it binds.
    AcceptWithin(u64),
    /// In `sock_recv` on a connection it made to itself, for data nobody
    /// sends.
    Recv,
}

/// A WASIX program that blocks in a socket call (`Block`) and exits with
/// the errno it returns. With `handler`, it registers a signal handler that
/// exits with 100 plus the signal's number.
fn blocker(port: u16, block: Block, handler: bool) -> WasmModule {
    let handler = if handler {
        r#"(call $callback_signal (i32.const 1000) (i32.const 9))"#
    } else {
        ""
    };
    // An OptionTimestamp at 700: tag 1 (some), nanoseconds at 708; 22 is
    // `Sockoption::AcceptTimeout`.
    let timeout = match block {
        Block::AcceptWithin(ms) => format!(
            r#"(i32.store8 (i32.const 700) (i32.const 1))
    (i64.store (i32.const 708) (i64.const {}))
    (if (call $set_time (i32.load (i32.const 400)) (i32.const 22) (i32.const 700))
      (then (call $exit (i32.const 13))))"#,
            ms * 1_000_000
        ),
        _ => String::new(),
    };
    let wait = match block {
        Block::Accept | Block::AcceptWithin(_) => {
            r#"(call $exit (call $accept (i32.load (i32.const 400)) (i32.const 0) (i32.const 408) (i32.const 600)))"#
        }
        Block::Recv => {
            r#"(call $socket (i32.const 404))
    (if (call $connect (i32.load (i32.const 404)) (i32.const 500))
      (then (call $exit (i32.const 14))))
    (if (call $accept (i32.load (i32.const 400)) (i32.const 0) (i32.const 408) (i32.const 600))
      (then (call $exit (i32.const 15))))
    ;; one 16-byte buffer at 900
    (i32.store (i32.const 800) (i32.const 900))
    (i32.store (i32.const 804) (i32.const 16))
    (call $exit (call $recv (i32.load (i32.const 408)) (i32.const 800) (i32.const 1) (i32.const 0) (i32.const 820) (i32.const 824)))"#
        }
    };
    let wat = format!(
        r#"(module
  (import "wasix_32v1" "sock_open" (func $open (param i32 i32 i32 i32) (result i32)))
  (import "wasix_32v1" "sock_bind" (func $bind (param i32 i32) (result i32)))
  (import "wasix_32v1" "sock_listen" (func $listen (param i32 i32) (result i32)))
  (import "wasix_32v1" "sock_accept" (func $accept (param i32 i32 i32 i32) (result i32)))
  (import "wasix_32v1" "sock_connect" (func $connect (param i32 i32) (result i32)))
  (import "wasix_32v1" "sock_recv" (func $recv (param i32 i32 i32 i32 i32 i32) (result i32)))
  (import "wasix_32v1" "sock_set_opt_time" (func $set_time (param i32 i32 i32) (result i32)))
  (import "wasix_32v1" "callback_signal" (func $callback_signal (param i32 i32)))
  (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
  (memory (export "memory") 1)
  (data (i32.const 1000) "signalled")
  (func (export "signalled") (param $sig i32)
    (call $exit (i32.add (i32.const 100) (local.get $sig))))
  ;; an IPv4 (1) stream (1) socket, its descriptor at $at
  (func $socket (param $at i32)
    (if (call $open (i32.const 1) (i32.const 1) (i32.const 0) (local.get $at))
      (then (call $exit (i32.const 10)))))
  (func (export "_start")
    {handler}
    (call $socket (i32.const 400))
    ;; __wasi_addr_port_t at 500: family, padding, port, 127.0.0.1
    (i32.store8 (i32.const 500) (i32.const 1))
    (i32.store16 (i32.const 502) (i32.const {port}))
    (i32.store (i32.const 504) (i32.const 0x0100007f))
    {timeout}
    (if (call $bind (i32.load (i32.const 400)) (i32.const 500))
      (then (call $exit (i32.const 11))))
    (if (call $listen (i32.load (i32.const 400)) (i32.const 16))
      (then (call $exit (i32.const 12))))
    {wait}))"#,
    );
    wat_module("blocker", &wat)
}

#[test]
fn a_blocking_accept_or_recv_is_stopped_by_the_timeout() {
    // An accept or a receive waits with no time limit (#1046), so it has
    // to wake for the SIGKILL that ends the job. Before, it slept through
    // it until wasmer's 30 s default ran out, so the job was only marked
    // finished after the 5 s kill grace, its thread still blocked.
    for block in [Block::Accept, Block::Recv] {
        for handler in [false, true] {
            let rt = runtime();
            let job = snapshot(&[]).fork();
            let mut inv = invocation(job.as_dyn(), &[]);
            inv.limits.timeout = Duration::from_millis(300);
            let outcome = rt.run_command(&blocker(4460, block, handler), inv).unwrap();
            assert!(outcome.timed_out, "{outcome:?}");
            assert_eq!(outcome.exit_code, TIMEOUT_EXIT_CODE);
            assert!(outcome.duration < Duration::from_secs(3), "{outcome:?}");
        }
    }
}

#[test]
fn an_accept_timeout_the_program_sets_still_applies() {
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let outcome = rt
        .run_command(
            &blocker(4461, Block::AcceptWithin(200), false),
            invocation(job.as_dyn(), &[]),
        )
        .unwrap();
    // 73 is ETIMEDOUT.
    assert_eq!(outcome.exit_code, 73, "{outcome:?}");
    assert!(outcome.duration < Duration::from_secs(3), "{outcome:?}");
}

#[test]
fn a_service_blocked_in_accept_takes_its_sigterm() {
    // A service waiting for a client that never came is stopped by the
    // SIGTERM that ends it, here through its own handler (exit 115),
    // rather than sleeping through it until the SIGKILL after the grace.
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.services = vec![module_service(
        "idle",
        blocker(4462, Block::Accept, true),
        Ready::Port(4462),
        Duration::from_secs(10),
    )];
    let outcome = rt.run_command(&wat_module("hello", HELLO), inv).unwrap();
    assert_eq!(outcome.exit_code, 3, "{outcome:?}");
    assert!(outcome.duration < background::STOP_GRACE, "{outcome:?}");
}

#[test]
fn services_have_ports_of_the_jobs_loopback_and_a_service_failing_to_bind_says_so() {
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let mut inv = invocation(job.as_dyn(), &[]);
    // Two services on one port: the second cannot bind it, because both are
    // on the job's one loopback.
    inv.services = vec![
        module_service(
            "a",
            listener(4446, 0, false),
            Ready::Port(4446),
            Duration::from_secs(10),
        ),
        module_service(
            "b",
            listener(4446, 200, false),
            Ready::Port(4447),
            Duration::from_secs(10),
        ),
    ];
    let outcome = rt.run_command(&wat_module("hello", HELLO), inv).unwrap();
    assert_eq!(
        outcome.service_failure.as_deref(),
        Some("service `b` exited with 11 before it was ready"),
        "{outcome:?}"
    );
}

#[test]
fn a_bash_service_is_ready_by_its_log_and_gets_its_own_env() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let rt = runtime();
    // Compiled first, so the time below is the job's and its service's.
    rt.prepare_environment(&packages).unwrap();
    let job = snapshot(&[]).fork();
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.services = vec![script_service(
        "db",
        &packages,
        // A partial line first, which is only checked once it is whole.
        "sleep 0.3; printf 'secret is %s, ' \"$PASSWORD\"; echo \"greeting is ${GREETING-unset}\"; echo 'db ready on 5432' >&2; exec sleep 300",
        &[("PASSWORD", "hunter2-value")],
        Ready::Log("ready on [0-9]+$".into()),
    )];
    let outcome = rt
        .run_script(&packages, "bash", "echo job ran", inv)
        .unwrap();
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert_eq!(outcome.exit_code, 0, "{outcome:?} {stderr}");
    assert_eq!(outcome.stdout, b"job ran\n");
    // Its output is the job's, line by line (the scheduler masks it); the
    // job's `env:` is not the service's.
    assert!(
        stderr.contains("[service db] secret is hunter2-value, greeting is unset\n"),
        "{stderr:?}"
    );
    assert!(
        stderr.contains("[service db] db ready on 5432\n"),
        "{stderr:?}"
    );
    // `exec sleep 300` was stopped with the job, without waiting for it.
    assert!(
        outcome.duration < background::STOP_GRACE + Duration::from_secs(2),
        "{outcome:?}"
    );
}

#[test]
fn a_bash_service_is_ready_when_its_check_passes_and_shares_the_jobs_files() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.services = vec![script_service(
        "flag",
        &packages,
        "sleep 0.5; echo up > /work/flag; exec sleep 300",
        &[],
        Ready::Command("test -e /work/flag".into()),
    )];
    let outcome = rt
        .run_script(&packages, "bash", "cat /work/flag", inv)
        .unwrap();
    assert_eq!(outcome.exit_code, 0, "{outcome:?}");
    assert_eq!(outcome.stdout, b"up\n");

    // A check that never passes fails the job with its last output.
    let job = snapshot(&[]).fork();
    let mut inv = invocation(job.as_dyn(), &[]);
    let mut service = script_service(
        "flag",
        &packages,
        "exec sleep 300",
        &[],
        Ready::Command("echo not yet; exit 4".into()),
    );
    service.ready_timeout = Duration::from_secs(2);
    inv.services = vec![service];
    let outcome = rt
        .run_script(&packages, "bash", "echo job ran", inv)
        .unwrap();
    assert_eq!(
        outcome.service_failure.as_deref(),
        Some(
            "service `flag` was not ready after 2s: its ready check never passed (the last one exited with 4)"
        ),
        "{outcome:?}"
    );
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert!(
        stderr.contains("[service flag] ready check: not yet\n"),
        "{stderr:?}"
    );
    assert!(outcome.stdout.is_empty(), "{outcome:?}");
}

#[test]
fn a_service_that_exits_while_the_job_runs_is_reported() {
    let Some(packages) = webc_packages() else {
        return;
    };
    let rt = runtime();
    let mut inv = invocation(snapshot(&[]).fork().as_dyn(), &[]);
    inv.services = vec![script_service(
        "flaky",
        &packages,
        "echo started; sleep 0.2; exit 7",
        &[],
        Ready::Started,
    )];
    let outcome = rt
        .run_script(&packages, "bash", "sleep 1; echo done", inv)
        .unwrap();
    assert_eq!(outcome.exit_code, 0, "{outcome:?}");
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert!(
        stderr.contains("[service flaky] started\n")
            && stderr.contains("iwci: service `flaky` exited with 7 while the job ran\n"),
        "{stderr:?}"
    );
}

/// The `bash-node` environment `builtins/environments/build.sh` built, for
/// the Node services below.
#[cfg(feature = "node")]
fn node_packages() -> Option<Vec<WebcPackage>> {
    let dir = fixture(
        "IWCI_TEST_NODE_WEBC_DIR",
        "the bash-node environment's build directory",
    )?;
    let read = |file: &str| std::fs::read(dir.join(file)).unwrap();
    let build: serde_json::Value = serde_json::from_slice(&read("build.json")).unwrap();
    Some(
        build["packages"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| {
                let field = |k: &str| p[k].as_str().unwrap();
                WebcPackage::new(field("name"), field("version"), read(field("file")))
            })
            .collect(),
    )
}

/// A small Node HTTP server as a service, ready by its port and by its log,
/// reached from the job by the service's name.
#[cfg(feature = "node")]
#[test]
fn a_node_server_is_a_service_the_job_reaches_by_name() {
    let Some(packages) = node_packages() else {
        return;
    };
    let rt = runtime();
    let server = r#"node -e '
const http = require("http");
http.createServer((req, res) => res.end("hello from " + process.env.WHO))
  .listen(3000, "127.0.0.1", () => console.log("api listening on 3000"));
'"#;
    for ready in [Ready::Port(3000), Ready::Log("listening on 3000".into())] {
        let job = snapshot(&[]).fork();
        let mut inv = invocation(job.as_dyn(), &[]);
        inv.limits.memory_bytes = 2 << 30;
        inv.limits.timeout = Duration::from_secs(120);
        let mut service =
            script_service("api", &packages, server, &[("WHO", "api")], ready.clone());
        service.ready_timeout = Duration::from_secs(60);
        inv.services = vec![service];
        let outcome = rt
            .run_script(
                &packages,
                "bash",
                r#"node -e 'fetch("http://api:3000/").then(r => r.text()).then(t => console.log(t))'"#,
                inv,
            )
            .unwrap();
        let stderr = String::from_utf8_lossy(&outcome.stderr);
        assert_eq!(outcome.exit_code, 0, "{ready:?}: {outcome:?} {stderr}");
        assert_eq!(
            String::from_utf8_lossy(&outcome.stdout),
            "hello from api\n",
            "{ready:?}: {stderr}"
        );
        assert!(
            stderr.contains("[service api] api listening on 3000\n"),
            "{stderr:?}"
        );
    }
}

/// Cancels `cancel` after `after`, from another thread, as the server does
/// when `POST /v1/runs/{id}/cancel` comes in.
fn cancel_after(cancel: &Cancel, after: Duration) {
    let cancel = cancel.clone();
    std::thread::spawn(move || {
        std::thread::sleep(after);
        cancel.cancel();
    });
}

#[test]
fn a_cancelled_job_and_its_service_are_stopped_as_a_timeout_would_stop_them() {
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.limits.timeout = Duration::from_secs(120);
    // The service spins without a syscall once listening, so only the
    // watchdog stops it; the job spins too.
    inv.services = vec![module_service(
        "spin",
        listener(4446, 0, true),
        Ready::Port(4446),
        Duration::from_secs(10),
    )];
    let cancel = Cancel::new();
    inv.cancel = Some(cancel.clone());
    cancel_after(&cancel, Duration::from_millis(500));
    let module = wat_module(
        "spin",
        r#"(module (memory (export "memory") 1) (func (export "_start") (loop $l (br $l))))"#,
    );
    let outcome = rt.run_command(&module, inv).unwrap();
    assert!(outcome.cancelled, "{outcome:?}");
    assert!(!outcome.timed_out && !outcome.success(), "{outcome:?}");
    assert_eq!(outcome.exit_code, TIMEOUT_EXIT_CODE);
    assert_eq!(outcome.service_failure, None);
    let stderr = String::from_utf8_lossy(&outcome.stderr);
    assert!(
        stderr.contains("[service spin] listening on 4446"),
        "{stderr:?}"
    );
    // Both are gone well within the service's stop grace, not at the
    // job's two-minute timeout.
    assert!(
        outcome.duration < background::STOP_GRACE + Duration::from_secs(4),
        "{outcome:?}"
    );
}

#[test]
fn a_job_cancelled_while_its_service_starts_never_runs() {
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.services = vec![module_service(
        "db",
        listener(4447, 0, false),
        Ready::Port(5432),
        Duration::from_secs(60),
    )];
    let cancel = Cancel::new();
    inv.cancel = Some(cancel.clone());
    cancel_after(&cancel, Duration::from_millis(300));
    let outcome = rt.run_command(&wat_module("hello", HELLO), inv).unwrap();
    assert!(outcome.cancelled, "{outcome:?}");
    assert_eq!(
        outcome.service_failure, None,
        "a cancel is not the service's fault"
    );
    assert!(job.read("/work/out.txt").is_err(), "the job never ran");
    assert!(outcome.duration < Duration::from_secs(5), "{outcome:?}");
}

#[test]
fn a_cancelled_tsc_is_stopped() {
    let rt = runtime();
    let job = snapshot(&[]).fork();
    let module = wat_module(
        "tsc-spin",
        r#"(module
          (memory (export "memory") 1)
          (func (export "ts_input") (param i32) (result i32) (i32.const 1024))
          (func (export "ts_output") (result i32) (i32.const 0))
          (func (export "ts_output_len") (result i32) (i32.const 0))
          (func (export "ts_run") (result i32) (loop $l (br $l)) (i32.const 0)))"#,
    );
    let mut inv = invocation(job.as_dyn(), &[]);
    inv.limits.timeout = Duration::from_secs(120);
    let cancel = Cancel::new();
    inv.cancel = Some(cancel.clone());
    cancel_after(&cancel, Duration::from_millis(300));
    let outcome = rt.run_tsc(&module, inv, false).unwrap();
    assert!(outcome.cancelled && !outcome.timed_out, "{outcome:?}");
    assert_eq!(outcome.exit_code, TIMEOUT_EXIT_CODE);
    assert!(outcome.duration < Duration::from_secs(5), "{outcome:?}");
}
