//! The conversation, end to end over pipes, with a manifest tree in a
//! temporary directory.

mod common;

use std::fs;
use std::sync::{Arc, Mutex};

use common::{Archive, Host, OLD_MTIME, TempDir};
use iwci_guest::{Ended, Local, Platform, VERSION};
use iwci_vm_proto::{GuestMsg, HostMsg, Kind, Network, PROTOCOL, Setup, Shell, write_frame};

#[derive(Default)]
struct Stub {
    setups: Mutex<Vec<Setup>>,
    ready: Mutex<u32>,
}

impl Platform for Stub {
    fn image(&self) -> String {
        "test-image".into()
    }
    fn setup(&self, setup: &Setup) -> Result<Vec<String>, String> {
        if setup.hostname == "bad" {
            return Err("no such host name".into());
        }
        self.setups.lock().unwrap().push(setup.clone());
        Ok(Vec::new())
    }
    fn ready(&self) {
        *self.ready.lock().unwrap() += 1;
    }
}

fn setup(hostname: &str) -> HostMsg {
    HostMsg::Setup(Setup {
        protocol: PROTOCOL,
        time_ms: 1_700_000_000_000,
        hostname: hostname.into(),
        network: Some(Network::standard()),
        scratch: None,
    })
}

#[test]
fn says_hello_then_sets_up_the_machine() {
    let dir = TempDir::new("hello");
    let stub = Arc::new(Stub::default());
    let mut host = Host::start(dir.path(), stub.clone());
    assert_eq!(host.hello.protocol, PROTOCOL);
    assert_eq!(host.hello.os, std::env::consts::OS);
    assert_eq!(host.hello.arch, std::env::consts::ARCH);
    assert_eq!(host.hello.agent, VERSION);
    assert_eq!(host.hello.image, "test-image");
    assert_eq!(host.hello.modes, cfg!(unix));

    host.send(&HostMsg::Setup(Setup {
        protocol: PROTOCOL + 1,
        time_ms: 0,
        hostname: "job".into(),
        network: None,
        scratch: None,
    }));
    match host.receive() {
        GuestMsg::Error { message } => assert!(message.contains("protocol"), "{message}"),
        other => panic!("{other:?}"),
    }
    host.send(&setup("bad"));
    match host.receive() {
        GuestMsg::Error { message } => assert!(message.contains("no such host"), "{message}"),
        other => panic!("{other:?}"),
    }
    host.send(&setup("job-1"));
    assert_eq!(host.receive(), GuestMsg::Ready);
    host.send(&setup("job-1"));
    assert_eq!(host.receive(), GuestMsg::Ready);
    assert_eq!(*stub.ready.lock().unwrap(), 1, "ready runs once");
    let setups = stub.setups.lock().unwrap().clone();
    assert_eq!(setups.len(), 2);
    assert_eq!(setups[0].hostname, "job-1");
    assert_eq!(host.shutdown(), Ended::Shutdown);
}

#[test]
fn the_stream_ending_ends_the_conversation() {
    let dir = TempDir::new("eof");
    let host = Host::start(dir.path(), Arc::new(Local));
    assert_eq!(host.close().unwrap(), Ended::Closed);
}

#[test]
fn errors_keep_the_conversation_going() {
    let dir = TempDir::new("errors");
    let mut host = Host::start(dir.path(), Arc::new(Local));
    write_frame(&mut host.to_guest, Kind::Message, b"{\"op\":\"nonsense\"}").unwrap();
    assert!(matches!(host.receive(), GuestMsg::Error { .. }));
    write_frame(&mut host.to_guest, Kind::Data, b"stray").unwrap();
    assert!(matches!(host.receive(), GuestMsg::Error { .. }));
    let err = host.collect(&["relative"], 100).unwrap_err();
    assert!(err.contains("clean"), "{err}");
    let (deleted, entries, _) = host.collect(&["/nothing-here"], 100).unwrap();
    assert!(deleted.is_empty() && entries.is_empty());
    assert_eq!(host.shutdown(), Ended::Shutdown);
}

#[test]
fn put_writes_files_with_their_modes_and_times() {
    let dir = TempDir::new("put");
    let mut host = Host::start(dir.path(), Arc::new(Local));
    let archive = Archive::new()
        .dir("app", 0o755)
        .file("app/run.sh", b"#!/bin/sh\necho hi\n", 0o755)
        .file("app/deep/er/file.txt", b"content", 0o640)
        .symlink("app/link", "run.sh")
        .build();
    let done = host.put_ok(&archive);
    assert_eq!(done.entries, 4);
    assert_eq!(done.bytes, 18 + 7);
    let run = dir.path().join("app/run.sh");
    assert_eq!(fs::read(&run).unwrap(), b"#!/bin/sh\necho hi\n");
    let meta = fs::metadata(&run).unwrap();
    assert_eq!(
        meta.modified().unwrap(),
        std::time::UNIX_EPOCH + std::time::Duration::from_secs(OLD_MTIME)
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(meta.permissions().mode() & 0o777, 0o755);
        let deep = fs::metadata(dir.path().join("app/deep/er/file.txt")).unwrap();
        assert_eq!(deep.permissions().mode() & 0o777, 0o640);
        assert_eq!(
            fs::read_link(dir.path().join("app/link")).unwrap(),
            std::path::Path::new("run.sh")
        );
    }
    // Nothing changed: nothing is sent.
    let (deleted, entries, done) = host.collect(&["/app"], u64::MAX).unwrap();
    assert!(deleted.is_empty(), "{deleted:?}");
    assert!(entries.is_empty(), "{entries:?}");
    assert_eq!(done.entries, 0);
    host.shutdown();
}

#[test]
fn refused_entries_fail_the_put_and_nothing_else() {
    let dir = TempDir::new("refused");
    let mut host = Host::start(dir.path(), Arc::new(Local));
    for (archive, why) in [
        (
            Archive::new().raw("../x", tar::EntryType::Regular, None),
            "clean",
        ),
        (
            Archive::new().raw("app/../../x", tar::EntryType::Regular, None),
            "clean",
        ),
        (
            Archive::new().raw("/etc/passwd", tar::EntryType::Regular, None),
            "absolute",
        ),
        (
            Archive::new().raw("app/hard", tar::EntryType::Link, Some("app/x")),
            "hard link",
        ),
        (
            Archive::new().raw("app/dev", tar::EntryType::Char, None),
            "device",
        ),
        (
            Archive::new().raw("app/fifo", tar::EntryType::Fifo, None),
            "FIFO",
        ),
    ] {
        match host.put(&archive.build()) {
            GuestMsg::Error { message } => assert!(message.contains(why), "{why}: {message}"),
            other => panic!("{why}: {other:?}"),
        }
    }
    assert!(!dir.path().parent().unwrap().join("x").exists());
    #[cfg(unix)]
    {
        // Through a link the archive made: refused, not followed.
        let outside = TempDir::new("outside");
        let archive = Archive::new()
            .symlink("esc", outside.path().to_str().unwrap())
            .file("esc/owned", b"x", 0o644)
            .build();
        match host.put(&archive) {
            GuestMsg::Error { message } => assert!(message.contains("symbolic link"), "{message}"),
            other => panic!("{other:?}"),
        }
        assert!(!outside.path().join("owned").exists());
    }
    // And the conversation goes on.
    let done = host.put_ok(&Archive::new().file("ok.txt", b"ok", 0o644).build());
    assert_eq!(done.entries, 1);
    host.shutdown();
}

fn touch_later(path: &std::path::Path, content: &[u8]) {
    fs::write(path, content).unwrap();
}

/// Returns once the clock that stamps files has moved past the moment of
/// the call, writing `probe` until its time changes. File times come from a
/// coarse clock: Linux's ticks (4 ms at 250 Hz) wherever a file system has
/// no fine-grained times, as ext4 and tmpfs before 6.13 do, and Windows'
/// (about 15.6 ms). A write within the put's tick left a file the put's
/// change time, so a rewrite of the same size with its modification time
/// put back looked unchanged, and this test failed now and then on ci-1. A
/// job starts well after its tree arrives, so only a test is that quick.
fn next_tick(probe: &std::path::Path) {
    fs::write(probe, b"0").unwrap();
    let first = fs::metadata(probe).unwrap().modified().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while fs::metadata(probe).unwrap().modified().unwrap() == first {
        assert!(
            std::time::Instant::now() < deadline,
            "file times stood still"
        );
        std::thread::sleep(std::time::Duration::from_millis(1));
        fs::write(probe, b"1").unwrap();
    }
}

#[test]
fn collect_sends_exactly_what_changed() {
    let dir = TempDir::new("collect");
    let root = dir.path();
    let mut host = Host::start(root, Arc::new(Local));
    let archive = Archive::new()
        .dir("app", 0o755)
        .file("app/keep.txt", b"keep", 0o644)
        .file("app/change.txt", b"aaaa", 0o644)
        .file("app/same-size.txt", b"1234", 0o644)
        .file("app/del.txt", b"del", 0o644)
        .file("app/gone/x.txt", b"x", 0o644)
        .file("app/redo/y.txt", b"y", 0o644)
        .file("app/kept-dir/k.txt", b"k", 0o644)
        .file("other/untouched.txt", b"o", 0o644)
        .symlink("app/link", "keep.txt")
        .symlink("app/link-same", "keep.txt")
        .build();
    host.put_ok(&archive);
    // Outside the paths collected below.
    next_tick(&root.join("tick"));

    // What the job does.
    let app = root.join("app");
    touch_later(&app.join("change.txt"), b"bbbbbb");
    // Same size, and the old time put back: only the change time tells.
    fs::write(app.join("same-size.txt"), b"5678").unwrap();
    fs::File::options()
        .write(true)
        .open(app.join("same-size.txt"))
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(OLD_MTIME))
        .unwrap();
    fs::remove_file(app.join("del.txt")).unwrap();
    fs::remove_dir_all(app.join("gone")).unwrap();
    fs::remove_dir_all(app.join("redo")).unwrap();
    fs::create_dir(app.join("redo")).unwrap();
    fs::write(app.join("redo/z.txt"), b"zz").unwrap();
    fs::write(app.join("new.txt"), b"new").unwrap();
    fs::create_dir_all(app.join("newdir/inner")).unwrap();
    fs::write(app.join("newdir/inner/n.txt"), b"n").unwrap();
    fs::write(app.join("kept-dir/added.txt"), b"a").unwrap();
    #[cfg(unix)]
    {
        fs::remove_file(app.join("link")).unwrap();
        std::os::unix::fs::symlink("new.txt", app.join("link")).unwrap();
        std::os::unix::fs::symlink("/usr/lib", app.join("abs-link")).unwrap();
    }

    let (deleted, entries, done) = host.collect(&["/app", "/app/newdir"], u64::MAX).unwrap();
    assert_eq!(deleted, vec!["/app/del.txt", "/app/gone", "/app/redo"]);
    let summary: Vec<(String, char)> = entries.iter().map(|e| (e.path.clone(), e.kind)).collect();
    let want: Vec<(String, char)> = [
        ("app/abs-link", 'l'),
        ("app/change.txt", 'f'),
        ("app/kept-dir/added.txt", 'f'),
        ("app/link", 'l'),
        ("app/new.txt", 'f'),
        ("app/newdir", 'd'),
        ("app/newdir/inner", 'd'),
        ("app/newdir/inner/n.txt", 'f'),
        ("app/redo", 'd'),
        ("app/redo/z.txt", 'f'),
        ("app/same-size.txt", 'f'),
    ]
    .into_iter()
    // The links are made on Unix only.
    .filter(|(_, kind)| cfg!(unix) || *kind != 'l')
    .map(|(path, kind)| (path.to_owned(), kind))
    .collect();
    assert_eq!(summary, want);
    let by_path = |p: &str| entries.iter().find(|e| e.path == p).unwrap();
    assert_eq!(by_path("app/change.txt").data, b"bbbbbb");
    assert_eq!(by_path("app/redo/z.txt").data, b"zz");
    #[cfg(unix)]
    {
        assert_eq!(by_path("app/link").link.as_deref(), Some("new.txt"));
        // A link the job made to a machine path keeps its target.
        assert_eq!(by_path("app/abs-link").link.as_deref(), Some("/usr/lib"));
        assert_eq!(by_path("app/change.txt").mode & 0o777, 0o644);
        assert_eq!(by_path("app/same-size.txt").data, b"5678");
    }
    assert_eq!(done.entries, entries.len() as u64);
    assert_eq!(
        done.bytes,
        entries.iter().map(|e| e.data.len() as u64).sum::<u64>()
    );
    assert!(!done.truncated);

    // Asking for the deleted file itself.
    let (deleted, entries, _) = host.collect(&["/app/del.txt"], u64::MAX).unwrap();
    assert_eq!(deleted, vec!["/app/del.txt"]);
    assert!(entries.is_empty());
    host.shutdown();
}

#[test]
fn what_git_ignores_in_the_repository_stays_unless_asked_for() {
    let dir = TempDir::new("ignored");
    let root = dir.path();
    let mut host = Host::start(root, Arc::new(Local));
    host.put_ok(
        &Archive::new()
            .file("app/.gitignore", b"node_modules/\n/dist\n*.log\n", 0o644)
            .file("app/src/a.ts", b"a", 0o644)
            .file("app/pkg/.gitignore", b"!keep.log\n", 0o644)
            // Tracked although a rule matches it now.
            .file("app/old.log", b"old", 0o644)
            .build(),
    );
    let app = root.join("app");
    fs::create_dir_all(app.join("node_modules/dep")).unwrap();
    fs::write(app.join("node_modules/dep/index.js"), b"dep").unwrap();
    fs::create_dir_all(app.join("dist/assets")).unwrap();
    fs::write(app.join("dist/main.js"), b"main").unwrap();
    fs::write(app.join("dist/assets/a.css"), b"css").unwrap();
    fs::write(app.join("build.log"), b"log").unwrap();
    fs::write(app.join("pkg/keep.log"), b"keep").unwrap();
    fs::write(app.join("old.log"), b"older").unwrap();
    fs::write(app.join("src/b.ts"), b"b").unwrap();

    // `dist` is an artifact: asked for on its own, it comes back whole.
    let (deleted, entries, _) = host
        .collect_in(Some("/app"), &["/app/dist", "/app/src"], u64::MAX)
        .unwrap();
    assert!(deleted.is_empty());
    let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "app/old.log",
            "app/pkg/keep.log",
            "app/src/b.ts",
            "app/dist",
            "app/dist/assets",
            "app/dist/assets/a.css",
            "app/dist/main.js",
        ]
    );

    // Deleting what the repository had is still a change.
    fs::remove_file(app.join("old.log")).unwrap();
    let (deleted, _, _) = host.collect_in(Some("/app"), &[], u64::MAX).unwrap();
    assert_eq!(deleted, ["/app/old.log"]);
    host.shutdown();
}

#[cfg(unix)]
#[test]
fn a_changed_mode_is_sent() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new("mode");
    let mut host = Host::start(dir.path(), Arc::new(Local));
    host.put_ok(
        &Archive::new()
            .file("app/tool", b"x", 0o644)
            .dir("app/d", 0o755)
            .build(),
    );
    fs::set_permissions(
        dir.path().join("app/tool"),
        fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    fs::set_permissions(dir.path().join("app/d"), fs::Permissions::from_mode(0o700)).unwrap();
    let (_, entries, _) = host.collect(&["/app"], u64::MAX).unwrap();
    let summary: Vec<(String, u32)> = entries
        .iter()
        .map(|e| (e.path.clone(), e.mode & 0o777))
        .collect();
    assert_eq!(
        summary,
        vec![
            ("app/d".to_string(), 0o700),
            ("app/tool".to_string(), 0o755)
        ]
    );
    host.shutdown();
}

#[test]
fn collect_stops_at_max_bytes() {
    let dir = TempDir::new("max");
    let mut host = Host::start(dir.path(), Arc::new(Local));
    host.put_ok(&Archive::new().dir("out", 0o755).build());
    fs::write(dir.path().join("out/a"), [1u8; 10]).unwrap();
    fs::write(dir.path().join("out/b"), [2u8; 10]).unwrap();
    fs::write(dir.path().join("out/c"), [3u8; 1]).unwrap();
    let (_, entries, done) = host.collect(&["/out"], 15).unwrap();
    let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(paths, vec!["out/a"]);
    assert!(done.truncated);
    assert_eq!(done.bytes, 10);
    assert_eq!(done.entries, 1);
    let (_, entries, done) = host.collect(&["/out"], 21).unwrap();
    assert_eq!(entries.len(), 3);
    assert!(!done.truncated);
    host.shutdown();
}

#[test]
fn a_put_cut_short_breaks_the_stream() {
    let dir = TempDir::new("cut");
    let mut host = Host::start(dir.path(), Arc::new(Local));
    host.send(&HostMsg::Put);
    let archive = Archive::new().file("a", b"a", 0o644).build();
    write_frame(&mut host.to_guest, Kind::Data, &archive[..100]).unwrap();
    // No DataEnd: a message instead, which the agent cannot take as data.
    iwci_vm_proto::send(&mut host.to_guest, &HostMsg::Shutdown).unwrap();
    assert!(host.close().is_err());
}

#[cfg(unix)]
mod exec {
    use super::*;

    #[test]
    fn streams_output_and_reports_the_exit() {
        let dir = TempDir::new("exec");
        let mut host = Host::start(dir.path(), Arc::new(Local));
        host.put_ok(&Archive::new().dir("work", 0o755).build());
        let (out, err, exited) = host.exec(
            Shell::Sh,
            "echo out\necho err >&2\necho \"$HOME $IWCI_TEST\"\npwd -P\nexit 3\n",
            &[("HOME", "/override"), ("IWCI_TEST", "set")],
            "/work",
        );
        let exited = exited.unwrap();
        assert_eq!(exited.code, 3);
        assert_eq!(exited.signal, None);
        let work = dir.path().join("work");
        assert_eq!(out, format!("out\n/override set\n{}\n", work.display()));
        assert_eq!(err, "err\n");
        // The script's file is not left in the tree.
        let (_, entries, _) = host.collect(&["/"], u64::MAX).unwrap();
        assert!(
            entries.iter().all(|e| !e.path.starts_with("iwci/run")),
            "{entries:?}"
        );
        host.shutdown();
    }

    #[test]
    fn set_e_and_unset_variables_stop_the_script() {
        let dir = TempDir::new("sete");
        let mut host = Host::start(dir.path(), Arc::new(Local));
        let (out, _, exited) = host.exec(Shell::Sh, "echo before\nfalse\necho after\n", &[], "/");
        assert_eq!(out, "before\n");
        assert_eq!(exited.unwrap().code, 1);
        let (out, _, exited) = host.exec(
            Shell::Sh,
            "echo \"$NOT_SET_ANYWHERE\"\necho after\n",
            &[],
            "/",
        );
        assert_eq!(out, "");
        assert_ne!(exited.unwrap().code, 0);
        // bash also stops on a failure inside a pipeline.
        let (out, _, exited) = host.exec(Shell::Bash, "false | true\necho after\n", &[], "/");
        assert_eq!(out, "");
        assert_eq!(exited.unwrap().code, 1);
        host.shutdown();
    }

    #[test]
    fn a_signal_is_reported_as_one() {
        let dir = TempDir::new("signal");
        let mut host = Host::start(dir.path(), Arc::new(Local));
        let (_, _, exited) = host.exec(Shell::Sh, "kill -TERM $$\n", &[], "/");
        let exited = exited.unwrap();
        assert_eq!(exited.signal, Some(15));
        assert_eq!(exited.code, 128 + 15);
        host.shutdown();
    }

    #[test]
    fn what_the_script_leaves_running_is_ended() {
        let dir = TempDir::new("background");
        let mut host = Host::start(dir.path(), Arc::new(Local));
        let started = std::time::Instant::now();
        let (out, _, exited) = host.exec(Shell::Sh, "sleep 30 &\necho started\n", &[], "/");
        assert_eq!(out, "started\n");
        assert_eq!(exited.unwrap().code, 0);
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
        host.shutdown();
    }

    #[test]
    fn large_output_arrives_whole() {
        let dir = TempDir::new("large");
        let mut host = Host::start(dir.path(), Arc::new(Local));
        let (out, _, exited) = host.exec(
            Shell::Sh,
            "i=0\nwhile [ $i -lt 20000 ]; do echo \"line $i of the output\"; i=$((i+1)); done\n",
            &[],
            "/",
        );
        assert_eq!(exited.unwrap().code, 0);
        assert_eq!(out.lines().count(), 20000);
        assert_eq!(out.lines().last(), Some("line 19999 of the output"));
        host.shutdown();
    }

    #[test]
    fn the_script_sees_the_files_put_and_collect_sees_its_own() {
        let dir = TempDir::new("roundtrip");
        let mut host = Host::start(dir.path(), Arc::new(Local));
        host.put_ok(&Archive::new().file("app/in.txt", b"input\n", 0o644).build());
        let (_, _, exited) = host.exec(
            Shell::Sh,
            "cat in.txt > out.txt\nrm in.txt\nmkdir -p dist && echo built > dist/a\n",
            &[],
            "/app",
        );
        assert_eq!(exited.unwrap().code, 0);
        let (deleted, entries, _) = host.collect(&["/app"], u64::MAX).unwrap();
        assert_eq!(deleted, vec!["/app/in.txt"]);
        let paths: Vec<&str> = entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, vec!["app/dist", "app/dist/a", "app/out.txt"]);
        host.shutdown();
    }
}

#[test]
fn a_missing_working_directory_is_an_error() {
    let dir = TempDir::new("cwd");
    let mut host = Host::start(dir.path(), Arc::new(Local));
    let (_, _, result) = host.exec(Shell::Sh, "true", &[], "/no/such/dir");
    let message = result.unwrap_err();
    assert!(message.contains("/no/such/dir"), "{message}");
    let (_, _, result) = host.exec(Shell::Sh, "true", &[], "../up");
    assert!(result.is_err());
    // Still serving.
    assert!(host.collect(&["/"], 0).is_ok());
    host.shutdown();
}
