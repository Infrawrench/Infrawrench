//! Catalog and publish behaviour against a `LocalStore` in a temp dir.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Barrier};

use iwci_store::{
    Abi, Catalog, EnvDraft, EnvEntry, Error, FileSource, LocalStore, ManifestOutcome, Namespace,
    ObjectMeta, ObjectStore, PackageSource, RepoId, Resolved, StoreError, ToolDraft, ToolKind,
    ToolRef, keys, publish_env, publish_tool,
};

struct Fixture {
    _dir: tempfile::TempDir,
    files: PathBuf,
    store: Arc<LocalStore>,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let files = dir.path().join("files");
    std::fs::create_dir_all(&files).unwrap();
    let store = Arc::new(LocalStore::new(dir.path().join("store")).unwrap());
    Fixture {
        _dir: dir,
        files,
        store,
    }
}

impl Fixture {
    fn file(&self, name: &str, bytes: &[u8]) -> PathBuf {
        let p = self.files.join(name);
        std::fs::write(&p, bytes).unwrap();
        p
    }

    fn draft(&self, name: &str, version: &str) -> ToolDraft {
        ToolDraft {
            name: name.into(),
            version: version.parse().unwrap(),
            abi: Abi::Wasi,
            module: self.file(
                &format!("{name}-{version}.wasm"),
                format!("\0asm {name} {version}").as_bytes(),
            ),
            files: vec![FileSource {
                guest_path: "/share/data.txt".into(),
                source: self.file("data.txt", b"shared data"),
            }],
            args: vec!["--check".into()],
            env: BTreeMap::new(),
            description: None,
        }
    }

    fn publish(&self, ns: &Namespace, name: &str, versions: &[&str]) {
        for v in versions {
            publish_tool(&*self.store, ns, &self.draft(name, v)).unwrap();
        }
    }

    fn catalog(&self) -> Catalog {
        Catalog::new(self.store.clone())
    }
}

fn repo(id: &str) -> RepoId {
    RepoId::new(id).unwrap()
}

fn r(s: &str) -> ToolRef {
    s.parse().unwrap()
}

fn resolved_version(res: &Resolved) -> String {
    match res {
        Resolved::Tool { manifest, .. } => manifest.version.to_string(),
        Resolved::Env { manifest, .. } => manifest.version.to_string(),
    }
}

#[test]
fn version_selection() {
    let f = fixture();
    f.publish(
        &Namespace::Builtin,
        "gofmt",
        &[
            "1.0.0",
            "1.2.0",
            "1.2.7",
            "1.10.0",
            "2.0.0-rc.1",
            "1.11.0-beta.1",
        ],
    );
    let c = f.catalog();
    let me = repo("r1");
    let pick =
        |req: &str| resolved_version(&c.resolve(&r(&format!("builtin:gofmt@{req}")), &me).unwrap());
    assert_eq!(pick("1"), "1.10.0");
    assert_eq!(pick("1.2"), "1.2.7");
    assert_eq!(pick("1.2.0"), "1.2.0");
    assert_eq!(pick("2.0.0-rc.1"), "2.0.0-rc.1");
    assert_eq!(pick("1.11.0-beta.1"), "1.11.0-beta.1");

    for req in ["2", "1.11", "1.3", "1.2.8", "3"] {
        match c.resolve(&r(&format!("builtin:gofmt@{req}")), &me) {
            Err(Error::NoMatchingVersion { available, .. }) => assert_eq!(
                available,
                [
                    "2.0.0-rc.1",
                    "1.11.0-beta.1",
                    "1.10.0",
                    "1.2.7",
                    "1.2.0",
                    "1.0.0"
                ],
                "{req}"
            ),
            other => panic!("{req}: {other:?}"),
        }
    }
    let err = c
        .resolve(&r("builtin:gofmt@3"), &me)
        .unwrap_err()
        .to_string();
    assert!(
        err.contains("available: 2.0.0-rc.1, 1.11.0-beta.1, 1.10.0"),
        "{err}"
    );
    assert!(matches!(
        c.resolve(&r("builtin:nope@1"), &me),
        Err(Error::NotFound { .. })
    ));
}

#[test]
fn resolve_returns_verified_blobs() {
    let f = fixture();
    f.publish(&Namespace::Builtin, "tsc", &["7.1.3"]);
    let res = f
        .catalog()
        .resolve(&r("builtin:tsc@7"), &repo("r"))
        .unwrap();
    let Resolved::Tool {
        manifest,
        module,
        files,
        manifest_sha256,
    } = res
    else {
        panic!("not a tool");
    };
    assert_eq!(&*module.bytes, b"\0asm tsc 7.1.3");
    assert_eq!(module.sha256, manifest.module.sha256);
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].0, "/share/data.txt");
    assert_eq!(&*files[0].1.bytes, b"shared data");
    let stored = f.store.get("builtins/tsc/7.1.3.json").unwrap().unwrap();
    assert_eq!(manifest_sha256, keys::sha256_hex(&stored));
}

#[test]
fn environments_resolve() {
    let f = fixture();
    let draft = EnvDraft {
        name: "node".into(),
        version: "22.1.0".parse().unwrap(),
        packages: vec![
            PackageSource {
                name: "wasmer/bash".into(),
                version: "1.0.24".parse().unwrap(),
                source: f.file("bash.webc", b"bash webc"),
            },
            PackageSource {
                name: "wasmer/coreutils".into(),
                version: "1.0.0".parse().unwrap(),
                source: f.file("coreutils.webc", b"coreutils webc"),
            },
        ],
        entry: EnvEntry::Bash,
        env: BTreeMap::from([("PATH".into(), "/bin".into())]),
        description: Some("bash, coreutils".into()),
    };
    let (_, report) = publish_env(&*f.store, &draft).unwrap();
    assert_eq!(report.manifest_key, "environments/node/22.1.0.json");
    let res = f.catalog().resolve(&r("env:node@22"), &repo("r")).unwrap();
    let Resolved::Env {
        manifest, packages, ..
    } = res
    else {
        panic!("not an env");
    };
    assert_eq!(manifest.packages.len(), 2);
    assert_eq!(&*packages[0].bytes, b"bash webc");
    assert_eq!(&*packages[1].bytes, b"coreutils webc");
    // `env:` and `builtin:` are separate namespaces.
    assert!(matches!(
        f.catalog().resolve(&r("builtin:node@22"), &repo("r")),
        Err(Error::NotFound { .. })
    ));
}

#[test]
fn bad_manifests_are_refused() {
    let f = fixture();
    let me = repo("r");
    let h = keys::sha256_hex(b"x");
    let write = |key: &str, json: String| {
        f.store
            .put(key, json.as_bytes(), "application/json")
            .unwrap()
    };
    write("builtins/a/1.0.0.json", "{not json".into());
    write(
        "builtins/b/1.0.0.json",
        format!(
            r#"{{"schema":1,"name":"b","version":"1.0.0","abi":"wasi","module":{{"sha256":"{h}","size":1}},"surprise":1}}"#
        ),
    );
    write(
        "builtins/c/1.0.0.json",
        format!(
            r#"{{"schema":2,"name":"c","version":"1.0.0","abi":"wasi","module":{{"sha256":"{h}","size":1}}}}"#
        ),
    );
    // Valid manifest, but for another name than its key.
    write(
        "builtins/d/1.0.0.json",
        format!(
            r#"{{"schema":1,"name":"other","version":"1.0.0","abi":"wasi","module":{{"sha256":"{h}","size":1}}}}"#
        ),
    );
    // Valid manifest, but for another version than its key.
    write(
        "builtins/e/1.0.0.json",
        format!(
            r#"{{"schema":1,"name":"e","version":"1.0.1","abi":"wasi","module":{{"sha256":"{h}","size":1}}}}"#
        ),
    );
    write(
        "builtins/g/1.0.0.json",
        format!(
            r#"{{"schema":1,"name":"g","version":"1.0.0","abi":"wasi","module":{{"sha256":"{h}","size":1}},
                "files":[{{"path":"../etc/passwd","sha256":"{h}","size":1}}]}}"#
        ),
    );
    let c = f.catalog();
    for (name, want) in [
        ("a", "malformed"),
        ("b", "unknown field"),
        ("c", "unsupported manifest schema 2"),
        ("d", "its key says d@1.0.0"),
        ("e", "its key says e@1.0.0"),
        ("g", "files[0].path"),
    ] {
        let err = c
            .resolve(&r(&format!("builtin:{name}@1")), &me)
            .unwrap_err();
        assert!(matches!(err, Error::Manifest { .. }), "{name}: {err:?}");
        assert!(err.to_string().contains(want), "{name}: {err}");
    }
    // Stray keys under a name's prefix are not versions.
    write("builtins/h/notes.txt", String::new());
    write("builtins/h/1.0.0.json.bak", String::new());
    write("builtins/h/nested/1.0.0.json", String::new());
    assert!(matches!(
        c.resolve(&r("builtin:h@1"), &me),
        Err(Error::NotFound { .. })
    ));
}

#[test]
fn blob_mismatches_are_refused() {
    let f = fixture();
    let me = repo("r");
    let (m, _) = publish_tool(&*f.store, &Namespace::Builtin, &f.draft("tsc", "1.0.0")).unwrap();
    let key = keys::blob_key(&m.module.sha256).unwrap();
    let good = f.store.get(&key).unwrap().unwrap();

    // Same length, different content.
    let mut flipped = good.clone();
    flipped[0] ^= 1;
    f.store.put(&key, &flipped, "").unwrap();
    match f.catalog().resolve(&r("builtin:tsc@1"), &me) {
        Err(Error::BlobMismatch { actual_sha256, .. }) => {
            assert_eq!(actual_sha256, keys::sha256_hex(&flipped))
        }
        other => panic!("{other:?}"),
    }
    // Truncated.
    f.store.put(&key, &good[..3], "").unwrap();
    assert!(matches!(
        f.catalog().resolve(&r("builtin:tsc@1"), &me),
        Err(Error::BlobMismatch { actual_size: 3, .. })
    ));
    // Missing.
    std::fs::remove_file(f.store.root().join(&key)).unwrap();
    assert!(matches!(
        f.catalog().resolve(&r("builtin:tsc@1"), &me),
        Err(Error::BlobMissing { .. })
    ));
    // Right content, but the manifest lies about the size.
    f.store.put(&key, &good, "").unwrap();
    let mut lying = m.clone();
    lying.version = "1.0.1".parse().unwrap();
    lying.module.size += 1;
    f.store
        .put("builtins/tsc/1.0.1.json", &lying.to_json(), "")
        .unwrap();
    assert!(matches!(
        f.catalog().resolve(&r("builtin:tsc@1.0.1"), &me),
        Err(Error::BlobMismatch { .. })
    ));
}

#[test]
fn repo_refs_stay_in_their_repo() {
    let f = fixture();
    let alice = repo("alice");
    let alice2 = repo("alice2");
    let mallory = repo("mallory");
    f.publish(&Namespace::Repo(alice.clone()), "secret-tool", &["1.0.0"]);
    f.publish(&Namespace::Repo(alice2.clone()), "other", &["1.0.0"]);
    f.publish(&Namespace::Builtin, "tsc", &["7.0.0"]);
    let c = f.catalog();

    assert!(c.resolve(&r("repo:secret-tool@1"), &alice).is_ok());
    assert!(matches!(
        c.resolve(&r("repo:secret-tool@1"), &mallory),
        Err(Error::NotFound { .. })
    ));
    // `alice` is a string prefix of `alice2`; the namespaces must not bleed.
    assert!(matches!(
        c.resolve(&r("repo:other@1"), &alice),
        Err(Error::NotFound { .. })
    ));
    assert!(matches!(
        c.resolve(&r("repo:secret-tool@1"), &alice2),
        Err(Error::NotFound { .. })
    ));
    // A repo ref never falls back to builtins.
    assert!(matches!(
        c.resolve(&r("repo:tsc@7"), &mallory),
        Err(Error::NotFound { .. })
    ));

    // Crafted names cannot be parsed into a reference...
    for s in [
        "repo:../alice/tools/secret-tool@1",
        "repo:..%2falice@1",
        "repo:a/b@1",
        "repo:.@1",
        "repo:Secret-Tool@1",
    ] {
        assert!(s.parse::<ToolRef>().is_err(), "{s}");
    }
    // ...nor sneak past `resolve` when the struct is built by hand.
    for name in [
        "../alice/tools/secret-tool",
        "../../repos/alice/tools/secret-tool",
        "",
        "..",
    ] {
        let crafted = ToolRef {
            kind: ToolKind::Repo,
            name: name.into(),
            version_req: "1".parse().unwrap(),
        };
        assert!(
            matches!(c.resolve(&crafted, &mallory), Err(Error::InvalidRef { .. })),
            "{name}"
        );
    }
    // Repository ids cannot traverse either.
    for id in ["../alice", "alice/..", "..", "a/b", "mallory/../alice"] {
        assert!(RepoId::new(id).is_err(), "{id}");
    }
}

#[test]
fn publish_is_immutable_and_idempotent() {
    let f = fixture();
    let draft = f.draft("tsc", "7.1.3");
    let (_, first) = publish_tool(&*f.store, &Namespace::Builtin, &draft).unwrap();
    assert_eq!(first.outcome, ManifestOutcome::Created);
    assert_eq!(first.uploaded.len(), 2);
    assert!(first.skipped.is_empty());

    let (_, again) = publish_tool(&*f.store, &Namespace::Builtin, &draft).unwrap();
    assert_eq!(again.outcome, ManifestOutcome::AlreadyPublished);
    assert!(again.uploaded.is_empty());
    assert_eq!(again.skipped.len(), 2);
    assert_eq!(again.manifest_sha256, first.manifest_sha256);

    // Different content under the same version is refused, and nothing is
    // uploaded for it.
    let mut changed = draft.clone();
    changed.module = f.file("changed.wasm", b"\0asm different");
    let before = f.store.list("blobs/").unwrap();
    assert!(matches!(
        publish_tool(&*f.store, &Namespace::Builtin, &changed),
        Err(Error::VersionExists { .. })
    ));
    assert_eq!(f.store.list("blobs/").unwrap(), before);
    let mut changed_args = draft.clone();
    changed_args.args.push("--more".into());
    assert!(matches!(
        publish_tool(&*f.store, &Namespace::Builtin, &changed_args),
        Err(Error::VersionExists { .. })
    ));

    // A new version sharing a data file reuses its blob.
    let (_, next) = publish_tool(&*f.store, &Namespace::Builtin, &f.draft("tsc", "7.1.4")).unwrap();
    assert_eq!(next.uploaded.len(), 1);
    assert_eq!(next.skipped.len(), 1);

    // Invalid drafts never reach the store.
    let mut bad = f.draft("tsc", "7.1.5");
    bad.files[0].guest_path = "relative/path".into();
    assert!(matches!(
        publish_tool(&*f.store, &Namespace::Builtin, &bad),
        Err(Error::Manifest { .. })
    ));
    assert!(f.store.get("builtins/tsc/7.1.5.json").unwrap().is_none());
    assert!(publish_tool(&*f.store, &Namespace::Environment, &f.draft("tsc", "7.1.6")).is_err());
}

#[test]
fn publish_races_resolve_to_one_winner() {
    let f = fixture();
    let a = f.draft("race", "1.0.0");
    let mut b = a.clone();
    b.args = vec!["--other".into()];
    let store = f.store.clone();
    let barrier = Arc::new(Barrier::new(2));
    let handles: Vec<_> = [a, b]
        .into_iter()
        .map(|d| {
            let (store, barrier) = (store.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                publish_tool(&*store, &Namespace::Builtin, &d)
            })
        })
        .collect();
    let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
    let created = results.iter().filter(|r| r.is_ok()).count();
    let refused = results
        .iter()
        .filter(|r| matches!(r, Err(Error::VersionExists { .. })))
        .count();
    assert_eq!((created, refused), (1, 1), "{results:?}");
}

/// Counts listings, to show a run lists each name once.
struct CountingStore {
    inner: Arc<LocalStore>,
    lists: AtomicUsize,
    gets: AtomicUsize,
}

impl ObjectStore for CountingStore {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, StoreError> {
        self.gets.fetch_add(1, Ordering::SeqCst);
        self.inner.get(key)
    }
    fn head(&self, key: &str) -> Result<Option<ObjectMeta>, StoreError> {
        self.inner.head(key)
    }
    fn put(&self, key: &str, bytes: &[u8], ct: &str) -> Result<(), StoreError> {
        self.inner.put(key, bytes, ct)
    }
    fn put_if_absent(&self, key: &str, bytes: &[u8], ct: &str) -> Result<bool, StoreError> {
        self.inner.put_if_absent(key, bytes, ct)
    }
    fn list(&self, prefix: &str) -> Result<Vec<String>, StoreError> {
        self.lists.fetch_add(1, Ordering::SeqCst);
        self.inner.list(prefix)
    }
    fn delete(&self, key: &str) -> Result<(), StoreError> {
        self.inner.delete(key)
    }
}

#[test]
fn a_matrix_lists_and_fetches_once() {
    let f = fixture();
    f.publish(&Namespace::Builtin, "tsc", &["7.0.0", "7.1.0"]);
    let counting = Arc::new(CountingStore {
        inner: f.store.clone(),
        lists: AtomicUsize::new(0),
        gets: AtomicUsize::new(0),
    });
    let catalog = Arc::new(Catalog::new(counting.clone()));
    let barrier = Arc::new(Barrier::new(20));
    let handles: Vec<_> = (0..20)
        .map(|i| {
            let (catalog, barrier) = (catalog.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                let req = if i % 2 == 0 {
                    "builtin:tsc@7"
                } else {
                    "builtin:tsc@7.1"
                };
                catalog
                    .resolve(&r(req), &repo("r"))
                    .map(|res| resolved_version(&res))
            })
        })
        .collect();
    for h in handles {
        assert_eq!(h.join().unwrap().unwrap(), "7.1.0");
    }
    assert_eq!(counting.lists.load(Ordering::SeqCst), 1);
    // One manifest, one module, one data file.
    assert_eq!(counting.gets.load(Ordering::SeqCst), 3);
    assert_eq!(
        catalog
            .versions(ToolKind::Builtin, "tsc", &repo("r"))
            .unwrap(),
        vec!["7.1.0".parse().unwrap(), "7.0.0".parse().unwrap()]
    );
    assert_eq!(counting.lists.load(Ordering::SeqCst), 1);
}

#[test]
fn tool_ref_round_trip() {
    for s in [
        "builtin:tsc@7",
        "repo:my-lint@1.2",
        "env:node@22.1.0",
        "builtin:x@1.0.0-rc.1",
    ] {
        assert_eq!(r(s).to_string(), s);
    }
    for bad in [
        "tsc@7",
        "builtin:tsc",
        "builtin:tsc@",
        "builtin:tsc@v7",
        "npm:x@1",
        "builtin:tsc@1.2.3+b",
    ] {
        assert!(bad.parse::<ToolRef>().is_err(), "{bad}");
    }
}
