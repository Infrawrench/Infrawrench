//! Checkout timing on a monorepo-sized tree. Ignored by default because it
//! builds a large fixture; run with
//!
//! ```text
//! cargo test -p iwci-git --release --test timing -- --ignored --nocapture
//! ```
//!
//! `IWCI_GIT_BENCH_FILES` sets the file count (default 30000), and
//! `IWCI_GIT_BENCH_REPO` points it at an existing local repository instead,
//! fetched over `file://` at depth 1.

mod support;

use std::fmt::Write as _;
use std::time::Instant;

use iwci_git::{Depth, GitCache};
use iwci_vfs::SnapshotBuilder;
use support::{TempDir, git, git_or_skip, git_with_input};

/// A fast-import stream for `files` files spread over a few thousand
/// directories, sized roughly like source code (100 B to 6 KiB). The
/// content is ASCII, so the stream is built as a string.
fn synthetic_stream(files: usize) -> Vec<u8> {
    let mut out = String::with_capacity(files * 2200);
    let mut text = String::new();
    for i in 0..files {
        text.clear();
        let lines = 2 + (i * 7919) % 120;
        for line in 0..lines {
            let _ = writeln!(text, "export const value_{i}_{line} = {};", line * 31 + i);
        }
        let _ = writeln!(out, "blob\nmark :{}\ndata {}\n{text}", i + 1, text.len());
    }
    out.push_str("commit refs/heads/main\ncommitter Bench <bench@example.invalid> 1700000000 +0000\ndata 5\nbench\n");
    for i in 0..files {
        let package = i % 300;
        let dir = (i / 300) % 12;
        let _ = writeln!(
            out,
            "M 100644 :{} packages/p{package}/src/d{dir}/file{i}.ts",
            i + 1
        );
    }
    out.push('\n');
    out.into_bytes()
}

#[test]
#[ignore = "builds a large fixture; run explicitly for timing"]
fn checkout_timing() {
    let Some(()) = git_or_skip("checkout_timing") else {
        return;
    };
    let fixture = TempDir::new("bench-remote");
    let url = match std::env::var("IWCI_GIT_BENCH_REPO") {
        Ok(path) => format!("file://{path}"),
        Err(_) => {
            let files: usize = std::env::var("IWCI_GIT_BENCH_FILES")
                .ok()
                .and_then(|v| v.parse().ok())
                .unwrap_or(30_000);
            git(fixture.path(), &["init", "-q", "--bare", "-b", "main"]);
            let started = Instant::now();
            git_with_input(
                fixture.path(),
                &["fast-import", "--quiet"],
                Some(&synthetic_stream(files)),
            );
            eprintln!("fixture: {files} files in {:?}", started.elapsed());
            format!("file://{}", fixture.path().display())
        }
    };
    let head = git(std::path::Path::new("/"), &["ls-remote", &url, "HEAD"]);
    let head = head.split_whitespace().next().unwrap().to_owned();

    let dir = TempDir::new("bench-cache");
    let cache = GitCache::new(dir.path()).unwrap();
    let remote = cache.remote(&url).unwrap();

    let started = Instant::now();
    let fetched = remote
        .fetch_commit(&head, Depth::Shallow(1), None, None)
        .unwrap();
    eprintln!(
        "fetch (depth 1, cold): {:?}, {} objects",
        started.elapsed(),
        fetched.objects_received
    );
    let started = Instant::now();
    remote
        .fetch_commit(&head, Depth::Shallow(1), None, None)
        .unwrap();
    eprintln!("fetch (cached): {:?}", started.elapsed());

    // Decoding alone: every tree and blob read the way checkout reads them.
    {
        use gix::objs::FindExt;
        let repo = gix::open(remote.git_dir()).unwrap();
        let started = Instant::now();
        let tree = repo
            .find_commit(gix::ObjectId::from_hex(head.as_bytes()).unwrap())
            .unwrap()
            .tree_id()
            .unwrap()
            .detach();
        let mut stack = vec![tree];
        let (mut blobs, mut bytes) = (0usize, 0usize);
        let mut buf = Vec::new();
        let mut blob = Vec::new();
        while let Some(id) = stack.pop() {
            let entries: Vec<_> = repo
                .objects
                .find_tree_iter(&id, &mut buf)
                .unwrap()
                .map(|e| {
                    let e = e.unwrap();
                    (e.mode.is_tree(), e.mode.is_blob(), e.oid.to_owned())
                })
                .collect();
            for (is_tree, is_blob, oid) in entries {
                if is_tree {
                    stack.push(oid);
                } else if is_blob {
                    bytes += repo.objects.find_blob(&oid, &mut blob).unwrap().data.len();
                    blobs += 1;
                }
            }
        }
        eprintln!(
            "decode only: {:?} for {blobs} blobs, {bytes} bytes",
            started.elapsed()
        );
    }

    for round in 0..3 {
        let builder = SnapshotBuilder::new();
        let started = Instant::now();
        let out = remote.checkout_into(&head, &builder, "/app").unwrap();
        eprintln!(
            "checkout {round}: {:?} for {} files, {} dirs, {} symlinks, {:.1} MiB",
            started.elapsed(),
            out.files,
            out.directories,
            out.symlinks,
            out.bytes as f64 / (1024.0 * 1024.0)
        );
    }
}

/// The two halves of a checkout measured apart: writing files into the
/// in-memory file system, and decoding blobs out of the packs.
#[test]
#[ignore = "timing only"]
fn checkout_parts_timing() {
    use iwci_vfs::virtual_fs::FileSystem;
    let builder = SnapshotBuilder::new();
    let fs = builder.fs();
    let started = Instant::now();
    for d in 0..4200 {
        fs.create_dir(std::path::Path::new(&format!("/d{d}")))
            .unwrap();
    }
    eprintln!("4200 mkdir: {:?}", started.elapsed());
    let started = Instant::now();
    for i in 0..30_000 {
        builder
            .write(
                format!("/d{}/file{i}.ts", i % 4200),
                b"export const x = 1;\n",
            )
            .unwrap();
    }
    eprintln!("30000 writes: {:?}", started.elapsed());
}
