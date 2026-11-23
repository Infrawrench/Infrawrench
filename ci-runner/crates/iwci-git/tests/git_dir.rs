mod support;

use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use iwci_git::{Depth, GitCache, Head};
use iwci_vfs::{Entry, SnapshotBuilder};
use support::{Fixture, TempDir, git, git_or_skip};

/// Writes everything under `from` in the snapshot to `to` on disk, modes
/// and symlinks included, so the git CLI sees the checkout as a job does.
fn dump(builder: &SnapshotBuilder, from: &str, to: &Path) {
    let modes: std::collections::HashMap<_, _> = builder.modes().into_iter().collect();
    for entry in builder.entries() {
        let path = match &entry {
            Entry::Dir { path } | Entry::File { path, .. } | Entry::Symlink { path, .. } => path,
        };
        let Ok(relative) = path.strip_prefix(from) else {
            continue;
        };
        let out = to.join(relative);
        match &entry {
            Entry::Dir { .. } => std::fs::create_dir_all(&out).unwrap(),
            Entry::File { data, .. } => {
                std::fs::write(&out, data.as_ref()).unwrap();
                if let Some(mode) = modes.get(path) {
                    std::fs::set_permissions(&out, std::fs::Permissions::from_mode(*mode)).unwrap();
                }
            }
            Entry::Symlink { target, .. } => std::os::unix::fs::symlink(target, &out).unwrap(),
        }
    }
}

fn checkout(fixture: &Fixture, commit: &str, head: &Head) -> (TempDir, TempDir) {
    let cache_dir = TempDir::new("git-dir");
    let cache = GitCache::new(cache_dir.path()).unwrap();
    let remote = cache.remote(&fixture.url()).unwrap();
    remote
        .fetch_commit(commit, Depth::Shallow(1), None, None)
        .unwrap();
    let builder = SnapshotBuilder::new();
    remote
        .checkout_repository_into(commit, &builder, "/app", head)
        .unwrap();
    let dir = TempDir::new("git-dir-dump");
    dump(&builder, "/app", dir.path());
    (cache_dir, dir)
}

#[test]
fn a_job_clone_answers_the_git_commands_ci_scripts_run() {
    let Some(()) = git_or_skip("a_job_clone_answers_the_git_commands_ci_scripts_run") else {
        return;
    };
    let mut fixture = Fixture::new();
    fixture.write("README.md", b"# Sample\n");
    fixture.write("src/a.ts", b"export const a = 1;\n");
    fixture.write("src/deep/b.ts", b"export const b = 2;\n");
    fixture.write("bin/run.sh", b"#!/bin/sh\n");
    fixture.write(".gitignore", b"node_modules/\n");
    fixture.symlink("link", "src/a.ts");
    std::fs::set_permissions(
        fixture.path().join("bin/run.sh"),
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();
    let commit = fixture.commit("first");

    let (_cache, dir) = checkout(&fixture, &commit, &Head::Branch("feat/x".into()));
    let root = dir.path();

    let mut names: Vec<_> = git(root, &["ls-files"]).lines().map(String::from).collect();
    names.sort();
    assert_eq!(
        names,
        [
            ".gitignore",
            "README.md",
            "bin/run.sh",
            "link",
            "src/a.ts",
            "src/deep/b.ts"
        ]
    );
    // The call that failed in the email-sdk benchmark.
    let policy = git(
        root,
        &["ls-files", "--cached", "--others", "--exclude-standard"],
    );
    assert_eq!(policy.lines().count(), 6, "{policy}");

    assert_eq!(git(root, &["rev-parse", "HEAD"]).trim(), commit);
    assert_eq!(git(root, &["branch", "--show-current"]).trim(), "feat/x");
    assert!(!git(root, &["describe", "--always"]).trim().is_empty());
    // Every tree is there, so `status` (which Go runs to stamp a binary)
    // can compare the index with HEAD, and finds nothing changed.
    assert_eq!(git(root, &["status", "--porcelain"]), "");
    assert_eq!(
        git(root, &["ls-tree", "-r", "--name-only", "HEAD", "src"])
            .lines()
            .count(),
        2
    );

    // A job's edit, and an ignored directory, show as git would show them.
    std::fs::write(root.join("src/deep/b.ts"), "export const b = 3;\n").unwrap();
    std::fs::create_dir_all(root.join("node_modules/x")).unwrap();
    std::fs::write(root.join("node_modules/x/i.js"), "").unwrap();
    std::fs::write(root.join("new.txt"), "").unwrap();
    assert_eq!(
        git(root, &["status", "--porcelain"]),
        " M src/deep/b.ts\n?? new.txt"
    );
}

#[test]
fn a_run_that_is_not_on_a_branch_gets_a_detached_head() {
    let Some(()) = git_or_skip("a_run_that_is_not_on_a_branch_gets_a_detached_head") else {
        return;
    };
    let mut fixture = Fixture::new();
    fixture.write("a.txt", b"a\n");
    let commit = fixture.commit("first");

    let (_cache, dir) = checkout(&fixture, &commit, &Head::Detached);
    let root = dir.path();
    assert_eq!(git(root, &["rev-parse", "HEAD"]).trim(), commit);
    assert_eq!(git(root, &["branch", "--show-current"]).trim(), "");
    assert_eq!(git(root, &["status", "--porcelain"]), "");
}

#[test]
fn a_plain_checkout_has_no_git_dir() {
    let mut fixture = Fixture::new();
    fixture.write("a.txt", b"a\n");
    let commit = fixture.commit("first");
    let cache_dir = TempDir::new("git-dir-plain");
    let cache = GitCache::new(cache_dir.path()).unwrap();
    let remote = cache.remote(&fixture.url()).unwrap();
    remote
        .fetch_commit(&commit, Depth::Shallow(1), None, None)
        .unwrap();
    let builder = SnapshotBuilder::new();
    remote.checkout_into(&commit, &builder, "/app").unwrap();
    assert!(builder.read("/app/.git/HEAD").is_err());
}
