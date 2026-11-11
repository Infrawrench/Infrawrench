mod support;

use std::path::Path;

use iwci_git::{Depth, GitCache, GitError, Identity};
use iwci_vfs::virtual_fs::FileSystem;
use iwci_vfs::{Change, SnapshotBuilder};
use support::{Fixture, TempDir, git_dir, git_or_skip};

fn cache() -> (TempDir, GitCache) {
    let dir = TempDir::new("cache");
    let cache = GitCache::new(dir.path()).unwrap();
    (dir, cache)
}

fn commit_count(git: &Path) -> usize {
    git_dir(git, &["rev-list", "--all", "--count"])
        .parse()
        .unwrap()
}

/// A small repository with the entry kinds a checkout has to handle.
fn sample() -> (Fixture, String, String) {
    let mut f = Fixture::new();
    f.write("README.md", b"first\n");
    let first = f.commit("first");
    f.write("README.md", b"# Sample\n");
    f.write("src/a.ts", b"export const a = 1;\n");
    f.write("src/deep/nested/b.ts", b"export const b = 2;\n");
    f.write("bin/run.sh", b"#!/bin/sh\necho hi\n");
    std::fs::set_permissions(
        f.path().join("bin/run.sh"),
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    f.symlink("link-to-a", "src/a.ts");
    f.symlink("src/up", "../README.md");
    f.write("empty.txt", b"");
    // A gitlink, as `git submodule add` would leave it, without needing a
    // second repository.
    f.git(&["add", "-A"]);
    f.git(&[
        "update-index",
        "--add",
        "--cacheinfo",
        &format!("160000,{first},vendor/sub"),
    ]);
    let second = f.commit_staged("second");
    (f, first, second)
}

#[test]
fn shallow_fetch_then_checkout_writes_files_symlinks_and_skips_submodules() {
    let Some(()) = git_or_skip("shallow_fetch_then_checkout") else {
        return;
    };
    let (f, first, second) = sample();
    let (_dir, cache) = cache();
    let remote = cache.remote(&f.url()).unwrap();
    assert!(!remote.has_commit(&second).unwrap());

    let fetched = remote
        .fetch_commit(&second, Depth::Shallow(1), None, None)
        .unwrap();
    assert!(fetched.from_network);
    assert!(!fetched.via_ref_hint);
    assert_eq!(fetched.commit, second);
    assert!(fetched.objects_received > 0);
    // Depth 1: the parent is not there.
    assert!(remote.has_commit(&second).unwrap());
    assert!(!remote.has_commit(&first).unwrap());
    assert_eq!(commit_count(remote.git_dir()), 1);

    let builder = SnapshotBuilder::new();
    let out = remote.checkout_into(&second, &builder, "/app").unwrap();
    assert_eq!(builder.read("/app/README.md").unwrap(), b"# Sample\n");
    assert_eq!(
        builder.read("/app/src/a.ts").unwrap(),
        b"export const a = 1;\n"
    );
    assert_eq!(
        builder.read("/app/src/deep/nested/b.ts").unwrap(),
        b"export const b = 2;\n"
    );
    assert_eq!(
        builder.read("/app/bin/run.sh").unwrap(),
        b"#!/bin/sh\necho hi\n"
    );
    assert_eq!(builder.read("/app/empty.txt").unwrap(), b"");
    let fs = builder.fs();
    assert_eq!(
        fs.readlink(Path::new("/app/link-to-a")).unwrap(),
        Path::new("src/a.ts")
    );
    assert_eq!(
        fs.readlink(Path::new("/app/src/up")).unwrap(),
        Path::new("../README.md")
    );
    // Reads follow the links.
    assert_eq!(
        builder.read("/app/link-to-a").unwrap(),
        b"export const a = 1;\n"
    );
    assert_eq!(builder.read("/app/src/up").unwrap(), b"# Sample\n");
    assert!(!builder.is_dir("/app/vendor/sub"));

    assert_eq!(out.files, 5, "{out:#?}");
    assert_eq!(out.executables, 1);
    assert_eq!(out.symlinks, 2);
    // src, src/deep, src/deep/nested, bin, vendor.
    assert_eq!(out.directories, 5, "{out:#?}");
    assert_eq!(out.submodules.len(), 1);
    assert_eq!(out.submodules[0].path, "vendor/sub");
    assert_eq!(out.submodules[0].commit, first);
    assert_eq!(out.tree, fetched.tree);

    // A second checkout over the first is refused rather than merged.
    assert!(matches!(
        remote.checkout_into(&second, &builder, "/app"),
        Err(GitError::TargetNotEmpty(_))
    ));
    // An existing empty directory is fine.
    builder.mkdir_all("/other").unwrap();
    remote.checkout_into(&second, &builder, "/other").unwrap();

    // Git's executable bit is the file's mode in the snapshot (#959).
    let snapshot = builder.freeze();
    assert_eq!(snapshot.mode("/app/bin/run.sh"), Some(0o755));
    assert_eq!(snapshot.mode("/other/bin/run.sh"), Some(0o755));
    assert_eq!(snapshot.mode("/app/README.md"), None);
}

#[test]
fn a_cached_commit_needs_no_network() {
    let Some(()) = git_or_skip("a_cached_commit_needs_no_network") else {
        return;
    };
    let (f, _, second) = sample();
    let (_dir, cache) = cache();
    let url = f.url();
    let first = cache
        .fetch_commit(&url, &second, Depth::Shallow(1), None)
        .unwrap();
    assert!(first.from_network);

    // With the remote gone, anything that tried the network would fail.
    let moved = f.path().with_extension("moved");
    std::fs::rename(f.path(), &moved).unwrap();
    let again = cache
        .fetch_commit(&url, &second, Depth::Shallow(1), None)
        .unwrap();
    assert!(!again.from_network);
    assert_eq!(again.objects_received, 0);
    assert_eq!(again.tree, first.tree);
    let builder = SnapshotBuilder::new();
    cache
        .remote(&url)
        .unwrap()
        .checkout_into(&second, &builder, "/app")
        .unwrap();
    assert_eq!(builder.read("/app/README.md").unwrap(), b"# Sample\n");

    // Other spellings of the URL hit the same cache.
    let spelled = format!("{url}.git/");
    assert!(
        !cache
            .fetch_commit(&spelled, &second, Depth::Shallow(1), None)
            .unwrap()
            .from_network
    );

    // Asking for more history than is cached does need the remote, and
    // fails cleanly while it is gone.
    assert!(
        cache
            .fetch_commit(&url, &second, Depth::Shallow(2), None)
            .is_err()
    );
    std::fs::rename(&moved, f.path()).unwrap();
    let deeper = cache
        .fetch_commit(&url, &second, Depth::Shallow(2), None)
        .unwrap();
    assert!(deeper.from_network);
    assert!(
        cache
            .remote(&url)
            .unwrap()
            .has_commit(&deeper.commit)
            .unwrap()
    );
}

#[test]
fn a_newer_commit_fetches_only_what_changed() {
    let Some(()) = git_or_skip("a_newer_commit_fetches_only_what_changed") else {
        return;
    };
    let (mut f, _, second) = sample();
    for i in 0..50 {
        f.write(
            &format!("pkg/file{i}.txt"),
            format!("content {i}\n").as_bytes(),
        );
    }
    let third = f.commit("third");
    f.write("pkg/file7.txt", b"changed\n");
    let fourth = f.commit("fourth");

    let (_dir, cache) = cache();
    let remote = cache.remote(&f.url()).unwrap();
    let a = remote
        .fetch_commit(&third, Depth::Shallow(1), None, None)
        .unwrap();
    let b = remote
        .fetch_commit(&fourth, Depth::Shallow(1), None, None)
        .unwrap();
    assert!(b.from_network);
    // The commit, the root tree, pkg/ and one blob; not the 50 files again.
    // gix completes the thin pack it is sent by appending the delta bases
    // it already had, which the count includes, so allow a few over four.
    assert!(
        b.objects_received <= 8,
        "received {} objects for a one-file change (first fetch: {})",
        b.objects_received,
        a.objects_received
    );
    assert!(a.objects_received > 50);

    let builder = SnapshotBuilder::new();
    remote.checkout_into(&fourth, &builder, "/app").unwrap();
    assert_eq!(builder.read("/app/pkg/file7.txt").unwrap(), b"changed\n");
    assert_eq!(builder.read("/app/pkg/file8.txt").unwrap(), b"content 8\n");
    // The older one is still checkout-able from the same cache.
    let older = SnapshotBuilder::new();
    remote.checkout_into(&third, &older, "/app").unwrap();
    assert_eq!(older.read("/app/pkg/file7.txt").unwrap(), b"content 7\n");
    let _ = second;
}

#[test]
fn full_depth_fetches_all_history_even_into_a_shallow_cache() {
    let Some(()) = git_or_skip("full_depth_fetches_all_history") else {
        return;
    };
    let (f, first, second) = sample();
    let (_dir, cache) = cache();
    let remote = cache.remote(&f.url()).unwrap();
    remote
        .fetch_commit(&second, Depth::Shallow(1), None, None)
        .unwrap();
    assert!(!remote.has_commit(&first).unwrap());
    let full = remote
        .fetch_commit(&second, Depth::Full, None, None)
        .unwrap();
    assert!(full.from_network);
    assert!(remote.has_commit(&first).unwrap());
    assert!(
        !remote.git_dir().join("shallow").exists() || {
            std::fs::read_to_string(remote.git_dir().join("shallow"))
                .unwrap()
                .trim()
                .is_empty()
        }
    );
    assert!(
        !remote
            .fetch_commit(&second, Depth::Full, None, None)
            .unwrap()
            .from_network
    );
}

#[test]
fn a_refused_sha_falls_back_to_the_ref_hint() {
    let Some(()) = git_or_skip("a_refused_sha_falls_back_to_the_ref_hint") else {
        return;
    };
    let (mut f, _, second) = sample();
    f.write("later.txt", b"later\n");
    let third = f.commit("third");
    f.write("later.txt", b"later still\n");
    let _fourth = f.commit("fourth");

    let (_dir, cache) = cache();
    let remote = cache.remote(&f.url()).unwrap();
    remote
        .fetch_commit(&second, Depth::Shallow(1), None, None)
        .unwrap();
    // Protocol v0/v1 `git-upload-pack` only serves advertised tips unless
    // the server opts in, which is the refusal GitHub-alikes without v2
    // give. `third` is not a tip.
    git_dir(remote.git_dir(), &["config", "protocol.version", "1"]);

    let err = remote
        .fetch_commit(&third, Depth::Shallow(1), None, None)
        .unwrap_err();
    assert!(!matches!(err, GitError::NotReachable { .. }), "{err}");

    let fetched = remote
        .fetch_commit(&third, Depth::Shallow(1), None, Some("main"))
        .unwrap();
    assert!(fetched.from_network);
    assert!(fetched.via_ref_hint);
    let builder = SnapshotBuilder::new();
    remote.checkout_into(&third, &builder, "/app").unwrap();
    assert_eq!(builder.read("/app/later.txt").unwrap(), b"later\n");

    // A sha the hint does not lead to is reported as such.
    let unrelated = "1111111111111111111111111111111111111111";
    let err = remote
        .fetch_commit(unrelated, Depth::Shallow(1), None, Some("refs/heads/main"))
        .unwrap_err();
    match err {
        GitError::FetchFailed { by_hint, .. } => {
            assert!(
                matches!(*by_hint, GitError::NotReachable { .. }),
                "{by_hint}"
            );
        }
        other => panic!("{other}"),
    }
}

#[test]
fn bad_inputs_are_refused_before_any_io() {
    let (_dir, cache) = cache();
    let remote = cache.remote("https://github.com/o/r.git").unwrap();
    assert!(matches!(
        remote.fetch_commit("abc", Depth::Shallow(1), None, None),
        Err(GitError::BadObjectId(_))
    ));
    assert!(matches!(
        remote.fetch_commit(&"a".repeat(40), Depth::Shallow(1), None, Some("a:b")),
        Err(GitError::BadRefHint(_))
    ));
    assert!(matches!(
        remote.checkout_into(&"a".repeat(40), &SnapshotBuilder::new(), "/app"),
        Err(GitError::NotFetched(_))
    ));
    assert!(!remote.git_dir().exists());
}

#[test]
fn changed_paths_lists_adds_edits_deletes_and_type_changes() {
    let Some(()) = git_or_skip("changed_paths") else {
        return;
    };
    let mut f = Fixture::new();
    f.write("keep/a.txt", b"a\n");
    f.write("keep/deep/b.txt", b"b\n");
    f.write("edit.txt", b"1\n");
    f.write("gone/x.txt", b"x\n");
    f.write("gone/y.txt", b"y\n");
    f.write("becomes-dir", b"file\n");
    f.write("mode.sh", b"echo\n");
    f.write("swap", b"plain\n");
    let base = f.commit("base");
    // Something in between, so head's depth-1 fetch does not include base.
    f.write("between.txt", b"between\n");
    f.commit("between");
    f.write("edit.txt", b"2\n");
    f.remove("gone");
    f.remove("becomes-dir");
    f.write("becomes-dir/inner.txt", b"inner\n");
    f.write("new/n.txt", b"n\n");
    std::fs::set_permissions(
        f.path().join("mode.sh"),
        std::os::unix::fs::PermissionsExt::from_mode(0o755),
    )
    .unwrap();
    f.remove("swap");
    f.symlink("swap", "edit.txt");
    let head = f.commit("head");

    let (_dir, cache) = cache();
    let remote = cache.remote(&f.url()).unwrap();
    remote
        .fetch_commit(&head, Depth::Shallow(1), None, None)
        .unwrap();
    assert!(matches!(
        remote.changed_paths(&base, &head),
        Err(GitError::NotFetched(_))
    ));
    remote
        .fetch_commit(&base, Depth::Shallow(1), None, None)
        .unwrap();
    let changed = remote.changed_paths(&base, &head).unwrap();
    assert_eq!(
        changed,
        [
            "becomes-dir",
            "becomes-dir/inner.txt",
            "between.txt",
            "edit.txt",
            "gone/x.txt",
            "gone/y.txt",
            "mode.sh",
            "new/n.txt",
            "swap",
        ]
    );
    assert!(remote.changed_paths(&head, &head).unwrap().is_empty());
    // The reverse direction names the same paths.
    assert_eq!(remote.changed_paths(&head, &base).unwrap(), changed);
}

fn identity(name: &str, time: i64) -> Identity {
    Identity {
        name: name.into(),
        email: format!("{}@example.invalid", name.to_lowercase()),
        time,
        utc_offset: 3600,
    }
}

#[test]
fn commit_changes_builds_on_head_and_exports_what_is_new() {
    let Some(()) = git_or_skip("commit_changes") else {
        return;
    };
    let (f, _, head) = sample();
    let (_dir, cache) = cache();
    let remote = cache.remote(&f.url()).unwrap();
    remote
        .fetch_commit(&head, Depth::Shallow(1), None, None)
        .unwrap();

    let changes = vec![
        Change::Modified {
            path: "/app/src/a.ts".into(),
            bytes: b"export const a = 10;\n".to_vec(),
        },
        Change::Modified {
            path: "/app/bin/run.sh".into(),
            bytes: b"#!/bin/sh\necho formatted\n".to_vec(),
        },
        Change::Added {
            path: "/app/src/new/c.ts".into(),
            bytes: b"export const c = 3;\n".to_vec(),
        },
        Change::Deleted {
            path: "/app/src/deep/nested/b.ts".into(),
        },
    ];
    let new = remote
        .commit_changes(
            &head,
            &changes,
            "/app",
            "style: format",
            &identity("Author", 1_700_100_000),
            &identity("Bot", 1_700_100_060),
        )
        .unwrap();
    assert_eq!(new.parent, head);
    let git = remote.git_dir();

    // The tree, as git itself reads it.
    let listing = git_dir(git, &["ls-tree", "-r", "--full-tree", &new.commit]);
    let mut lines: Vec<&str> = listing.lines().collect();
    lines.sort();
    let entry = |path: &str| -> String {
        lines
            .iter()
            .find(|l| l.ends_with(&format!("\t{path}")))
            .unwrap_or_else(|| panic!("{path} missing from\n{listing}"))
            .split_whitespace()
            .take(2)
            .collect::<Vec<_>>()
            .join(" ")
    };
    assert_eq!(entry("bin/run.sh"), "100755 blob");
    assert_eq!(entry("src/a.ts"), "100644 blob");
    assert_eq!(entry("src/new/c.ts"), "100644 blob");
    assert_eq!(entry("link-to-a"), "120000 blob");
    assert_eq!(entry("vendor/sub"), "160000 commit");
    assert!(
        !listing.contains("src/deep"),
        "an emptied directory stays: {listing}"
    );
    assert_eq!(
        git_dir(
            git,
            &["cat-file", "-p", &format!("{}:src/a.ts", new.commit)]
        ),
        "export const a = 10;"
    );
    assert_eq!(
        git_dir(
            git,
            &["cat-file", "-p", &format!("{}:src/new/c.ts", new.commit)]
        ),
        "export const c = 3;"
    );
    let raw = git_dir(git, &["cat-file", "-p", &new.commit]);
    assert!(raw.contains(&format!("parent {head}")), "{raw}");
    assert!(
        raw.contains("author Author <author@example.invalid> 1700100000 +0100"),
        "{raw}"
    );
    assert!(
        raw.contains("committer Bot <bot@example.invalid> 1700100060 +0100"),
        "{raw}"
    );
    assert!(raw.ends_with("style: format"), "{raw}");
    assert_eq!(
        git_dir(git, &["rev-parse", &format!("{}^{{tree}}", new.commit)]),
        new.tree
    );

    // The export: the three new blobs, the root, src, src/new and bin
    // trees (src/deep went away), then the commit, each hashing to its id.
    let objects = remote.export_objects(&new.commit).unwrap();
    let kinds: Vec<&str> = objects.iter().map(|o| o.kind.as_str()).collect();
    assert_eq!(
        kinds,
        [
            "blob", "blob", "blob", "tree", "tree", "tree", "tree", "commit"
        ],
        "{objects:#?}"
    );
    assert_eq!(objects.last().unwrap().id, new.commit);
    assert_eq!(
        objects[objects.len() - 2].id,
        new.tree,
        "the root tree comes last of the trees"
    );
    for object in &objects {
        let hashed = support::git_with_input(
            git.parent().unwrap(),
            &[
                "hash-object",
                "-t",
                object.kind.as_str(),
                "--stdin",
                "--literally",
            ],
            Some(&object.data),
        );
        assert_eq!(hashed, object.id);
    }

    // The new commit checks out like any other.
    let builder = SnapshotBuilder::new();
    remote.checkout_into(&new.commit, &builder, "/app").unwrap();
    assert_eq!(
        builder.read("/app/src/new/c.ts").unwrap(),
        b"export const c = 3;\n"
    );
    assert!(!builder.is_dir("/app/src/deep"));

    // Paths outside the checkout, or into a .git directory, are refused.
    for bad in [
        "/elsewhere/x",
        "/app",
        "/app/.git/config",
        "/app/src/.GIT/hooks/x",
    ] {
        let err = remote
            .commit_changes(
                &head,
                &[Change::Added {
                    path: bad.into(),
                    bytes: b"x".to_vec(),
                }],
                "/app",
                "x",
                &identity("A", 0),
                &identity("A", 0),
            )
            .unwrap_err();
        assert!(
            matches!(
                err,
                GitError::OutsidePrefix { .. } | GitError::UnsafeEntry { .. }
            ),
            "{bad}: {err}"
        );
    }
    // A change set that changes nothing is reported, not committed.
    let err = remote
        .commit_changes(
            &head,
            &[Change::Modified {
                path: "/app/README.md".into(),
                bytes: b"# Sample\n".to_vec(),
            }],
            "/app",
            "noop",
            &identity("A", 0),
            &identity("A", 0),
        )
        .unwrap_err();
    assert!(matches!(err, GitError::NothingToCommit(_)), "{err}");
}

#[test]
fn concurrent_fetches_of_one_remote_serialise() {
    let Some(()) = git_or_skip("concurrent_fetches_of_one_remote_serialise") else {
        return;
    };
    let (f, _, second) = sample();
    let (_dir, cache) = cache();
    let url = f.url();
    let results: Vec<_> = std::thread::scope(|scope| {
        let handles: Vec<_> = (0..4)
            .map(|_| scope.spawn(|| cache.fetch_commit(&url, &second, Depth::Shallow(1), None)))
            .collect();
        handles
            .into_iter()
            .map(|h| h.join().unwrap().unwrap())
            .collect()
    });
    // Whoever got the lock first fetched; everyone after found it cached.
    assert_eq!(results.iter().filter(|r| r.from_network).count(), 1);
    let remote = cache.remote(&url).unwrap();
    assert_eq!(
        std::fs::read_dir(remote.git_dir().join("objects/pack"))
            .unwrap()
            .filter(|e| e
                .as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|x| x == "pack"))
            .count(),
        1
    );
    git_dir(remote.git_dir(), &["fsck", "--no-dangling"]);
}

#[test]
fn too_many_packs_starts_the_remote_over() {
    let Some(()) = git_or_skip("too_many_packs_starts_the_remote_over") else {
        return;
    };
    let mut f = Fixture::new();
    let (_dir, cache) = cache();
    let cache = cache.with_max_packs(2);
    let remote = cache.remote(&f.url()).unwrap();
    let mut shas = Vec::new();
    for i in 0..4 {
        f.write("n.txt", format!("{i}\n").as_bytes());
        let sha = f.commit(&format!("c{i}"));
        remote
            .fetch_commit(&sha, Depth::Shallow(1), None, None)
            .unwrap();
        shas.push(sha);
    }
    let packs = std::fs::read_dir(remote.git_dir().join("objects/pack"))
        .unwrap()
        .filter(|e| {
            e.as_ref()
                .unwrap()
                .path()
                .extension()
                .is_some_and(|x| x == "pack")
        })
        .count();
    assert!(packs <= 2, "{packs} packs");
    assert!(remote.has_commit(shas.last().unwrap()).unwrap());
}

#[test]
fn a_branch_resolves_to_its_current_head() {
    let Some(()) = git_or_skip("a_branch_resolves_to_its_current_head") else {
        return;
    };
    let (mut f, _first, second) = sample();
    let (_dir, cache) = cache();
    let remote = cache.remote(&f.url()).unwrap();
    let branch = f
        .git(&["rev-parse", "--abbrev-ref", "HEAD"])
        .trim()
        .to_string();
    let fetched = remote
        .fetch_branch(&branch, Depth::Shallow(1), None)
        .unwrap();
    assert_eq!(fetched.commit, second);
    assert!(remote.has_commit(&second).unwrap());

    // The branch moves; the next fetch follows it.
    f.write("README.md", b"third\n");
    let third = f.commit("third");
    assert_eq!(
        remote
            .fetch_branch(&branch, Depth::Shallow(1), None)
            .unwrap()
            .commit,
        third
    );

    // A missing branch and a malformed name are errors, not a fetch of
    // something else.
    assert!(
        remote
            .fetch_branch("no-such-branch", Depth::Shallow(1), None)
            .is_err()
    );
    for bad in ["main:evil", "*", "../x", "+main", "a b"] {
        assert!(
            remote.fetch_branch(bad, Depth::Shallow(1), None).is_err(),
            "{bad}"
        );
    }
}
