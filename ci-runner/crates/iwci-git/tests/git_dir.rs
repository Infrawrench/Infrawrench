mod support;

use std::path::Path;

use iwci_git::{Depth, GitCache};
use iwci_vfs::SnapshotBuilder;
use support::{Fixture, TempDir, git, git_or_skip};

/// Copy the whole VFS tree under `from` into `to`, so the git CLI can read
/// the snapshot the same way a job would.
fn dump(builder: &SnapshotBuilder, from: &str, to: &Path) {
    for path in iwci_vfs::list_files(builder.fs(), from) {
        let bytes = builder.read(&path).unwrap();
        let relative = path.strip_prefix(from).unwrap();
        let out = to.join(relative);
        std::fs::create_dir_all(out.parent().unwrap()).unwrap();
        std::fs::write(out, bytes).unwrap();
    }
}

#[test]
fn a_checkout_can_answer_ls_files_rev_parse_and_describe() {
    let Some(()) = git_or_skip("vfs_mocked_git") else {
        return;
    };
    let mut fixture = Fixture::new();
    fixture.write("README.md", b"# Sample\n");
    fixture.write("src/a.ts", b"export const a = 1;\n");
    fixture.write("bin/run.sh", b"#!/bin/sh\n");
    let commit = fixture.commit("first");

    let cache_dir = TempDir::new("git-dir");
    let cache = GitCache::new(cache_dir.path()).unwrap();
    let remote = cache.remote(&fixture.url()).unwrap();
    remote
        .fetch_commit(&commit, Depth::Shallow(1), None, None)
        .unwrap();

    let builder = SnapshotBuilder::new();
    remote.checkout_into(&commit, &builder, "/app").unwrap();

    let dir = TempDir::new("git-dir-dump");
    dump(&builder, "/app", dir.path());

    let root = dir.path();
    let ls_files = git(root, &["ls-files"]);
    let mut names = ls_files.lines().collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, vec!["README.md", "bin/run.sh", "src/a.ts"]);

    // The exact call that failed in the email-sdk benchmark.
    let policy = git(
        root,
        &["ls-files", "--cached", "--others", "--exclude-standard"],
    );
    assert_eq!(policy.lines().count(), 3, "{policy}");

    assert_eq!(git(root, &["rev-parse", "HEAD"]).trim(), commit);
    assert!(!git(root, &["describe", "--always"]).trim().is_empty());
}
