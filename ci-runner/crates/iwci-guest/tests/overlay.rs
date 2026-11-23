//! The overlay tree's judgement, on hand-made upper and lower directories.
//! Real whiteouts need root, so the markers here are given as data: a
//! test probe names which upper paths are whiteouts and which directories
//! are opaque.

#![cfg(unix)]

mod common;

use std::collections::HashSet;
use std::fs::{self, Metadata};
use std::path::{Path, PathBuf};

use common::{Archive, TempDir};
use iwci_guest::plan::Probe;
use iwci_guest::{Overlay, Root, Tree};

struct Markers {
    whiteouts: HashSet<PathBuf>,
    opaque: HashSet<PathBuf>,
}

impl Probe for Markers {
    fn whiteout(&self, path: &Path, _meta: &Metadata) -> bool {
        self.whiteouts.contains(path)
    }
    fn opaque(&self, path: &Path) -> bool {
        self.opaque.contains(path)
    }
}

fn file(path: PathBuf, content: &[u8]) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, content).unwrap();
}

#[test]
fn whiteouts_opaque_directories_and_copies_up() {
    let dir = TempDir::new("overlay");
    let upper = dir.path().join("upper");
    let lower = dir.path().join("lower");
    let base = dir.path().join("base");
    fs::create_dir_all(&upper).unwrap();

    // The machine before the job: a workspace layer over a base layer.
    file(lower.join("app/a.txt"), b"a");
    file(lower.join("app/b.txt"), b"b");
    file(lower.join("app/d/old.txt"), b"old");
    fs::create_dir_all(lower.join("app/g")).unwrap();
    fs::create_dir_all(lower.join("app/same")).unwrap();
    file(base.join("gone/sub/x"), b"x");
    file(base.join("etc/os-release"), b"os");

    // The job's own files, put before it runs (written into the upper
    // directory directly, standing in for the merged view).
    let probe = Markers {
        whiteouts: [upper.join("app/b.txt"), upper.join("gone")]
            .into_iter()
            .collect(),
        opaque: [upper.join("app/d")].into_iter().collect(),
    };
    let mut tree = Overlay::new(
        Root::Dir(upper.clone()),
        upper.clone(),
        vec![lower.clone(), base.clone()],
        Box::new(probe),
    );
    fs::create_dir_all(upper.join("app")).unwrap();
    tree.put(
        &mut Archive::new()
            .file("app/p.txt", b"p", 0o644)
            .file("app/q.txt", b"q", 0o644)
            .file("app/pd/r.txt", b"r", 0o644)
            .build()
            .as_slice(),
    )
    .unwrap();

    // What the job did, as the upper directory records it.
    file(upper.join("app/a.txt"), b"a, changed"); // copied up
    file(upper.join("app/b.txt"), b""); // the whiteout's stand-in
    fs::create_dir_all(upper.join("app/d")).unwrap(); // deleted, made again
    file(upper.join("app/d/new.txt"), b"new");
    file(upper.join("app/g"), b"a file where a directory was");
    file(upper.join("app/new.txt"), b"new");
    fs::remove_file(upper.join("app/q.txt")).unwrap(); // only the job's: no whiteout
    fs::remove_dir_all(upper.join("app/pd")).unwrap();
    file(upper.join("gone"), b""); // a whiteout over a whole directory
    file(upper.join(".iwci/rw/x"), b"the agent's own");
    file(upper.join("iwci/run/script-1.sh"), b"true");

    let plan = tree
        .plan(&["/app".into(), "/gone/sub".into()], None)
        .unwrap();
    assert_eq!(
        plan.deleted,
        vec![
            "/app/b.txt",
            "/app/d",
            "/app/g",
            "/app/pd",
            "/app/q.txt",
            "/gone/sub"
        ]
    );
    let sent: Vec<&str> = plan.items.iter().map(|i| i.unix.as_str()).collect();
    assert_eq!(
        sent,
        vec![
            "/app/a.txt",
            "/app/d",
            "/app/d/new.txt",
            "/app/g",
            "/app/new.txt"
        ]
    );

    // The whole tree: the agent's own directories are never looked at,
    // and the machine's unchanged files are not in the upper directory.
    let plan = tree.plan(&["/".into()], None).unwrap();
    assert!(
        plan.items
            .iter()
            .all(|i| !i.unix.starts_with("/.iwci") && !i.unix.starts_with("/iwci/run")),
        "{:?}",
        plan.items
    );
    assert!(plan.deleted.contains(&"/gone".to_string()));
}

#[test]
fn a_directory_copied_up_is_sent_only_when_its_mode_changed() {
    use std::os::unix::fs::PermissionsExt;
    let dir = TempDir::new("overlay-mode");
    let upper = dir.path().join("upper");
    let lower = dir.path().join("lower");
    fs::create_dir_all(lower.join("app/x")).unwrap();
    fs::create_dir_all(lower.join("app/y")).unwrap();
    fs::create_dir_all(upper.join("app/x")).unwrap();
    fs::create_dir_all(upper.join("app/y")).unwrap();
    fs::set_permissions(upper.join("app/y"), fs::Permissions::from_mode(0o700)).unwrap();
    let tree = Overlay::new(
        Root::Dir(upper.clone()),
        upper.clone(),
        vec![lower],
        Box::new(Markers {
            whiteouts: HashSet::new(),
            opaque: HashSet::new(),
        }),
    );
    let plan = tree.plan(&["/app".into()], None).unwrap();
    let sent: Vec<&str> = plan.items.iter().map(|i| i.unix.as_str()).collect();
    assert_eq!(sent, vec!["/app/y"]);
    assert!(plan.deleted.is_empty());
}

#[test]
fn put_refuses_the_agents_own_directory() {
    let dir = TempDir::new("overlay-reserved");
    let mut tree = Overlay::new(
        Root::Dir(dir.path().to_owned()),
        dir.path().to_owned(),
        Vec::new(),
        Box::new(Markers {
            whiteouts: HashSet::new(),
            opaque: HashSet::new(),
        }),
    );
    let err = tree
        .put(
            &mut Archive::new()
                .file(".iwci/rw/upper/x", b"x", 0o644)
                .build()
                .as_slice(),
        )
        .unwrap_err();
    assert!(err.to_string().contains("refused"), "{err}");
}

/// A directory no lower layer has is looked up once, not once per file
/// below it (each lookup in the top layer is a round trip to the runner);
/// everything below it is still sent, and a sibling the lower layer does
/// have is still judged against it.
#[test]
fn everything_below_a_new_directory_is_sent() {
    let dir = TempDir::new("overlay-new-dir");
    let upper = dir.path().join("upper");
    let lower = dir.path().join("lower");
    file(lower.join("root/.cache/kept/x"), b"x");
    for i in 0..50 {
        file(
            upper.join(format!("root/.store/v3/files/{:02}/f", i % 7)),
            b"f",
        );
        file(upper.join(format!("root/.store/v3/index/{i}")), b"i");
    }
    fs::create_dir_all(upper.join("root/.cache/kept")).unwrap();
    file(upper.join("root/.cache/kept/y"), b"y");
    let tree = Overlay::new(
        Root::Dir(upper.clone()),
        upper.clone(),
        vec![lower.clone()],
        Box::new(Markers {
            whiteouts: HashSet::new(),
            opaque: HashSet::new(),
        }),
    );
    let plan = tree.plan(&["/root".into()], None).unwrap();
    let sent: HashSet<&str> = plan.items.iter().map(|i| i.unix.as_str()).collect();
    assert!(sent.contains("/root/.store"));
    assert!(sent.contains("/root/.store/v3/files/06/f"));
    assert_eq!(
        sent.iter()
            .filter(|p| p.starts_with("/root/.store/v3/index/"))
            .count(),
        50
    );
    assert!(sent.contains("/root/.cache/kept/y"));
    assert!(
        !sent.contains("/root/.cache/kept"),
        "an unchanged directory"
    );
    assert!(plan.deleted.is_empty());
}
