//! Installs against the lockfile a real npm wrote (`fixtures/`, made by
//! `fixtures/generate.sh`), compared with the `node_modules` that `npm ci`
//! laid out for it, plus hand-written lockfiles for the rules the fixture
//! does not reach. Nothing here reaches the network: the registry is a
//! `MemoryFetcher` over the tarballs committed beside the lockfile.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Mutex;

use iwci_vfs::Entry as FsEntry;

use super::*;
use crate::fetch::MemoryFetcher;

const ROOT: &str = "/app";

macro_rules! fixture {
    ($path:literal) => {
        include_str!(concat!("fixtures/", $path))
    };
}

const TARBALLS: [(&str, &[u8]); 5] = [
    (
        "https://registry.npmjs.org/is-number/-/is-number-6.0.0.tgz",
        include_bytes!("fixtures/tarballs/is-number-6.0.0.tgz"),
    ),
    (
        "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
        include_bytes!("fixtures/tarballs/is-number-7.0.0.tgz"),
    ),
    (
        "https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz",
        include_bytes!("fixtures/tarballs/is-odd-3.0.1.tgz"),
    ),
    (
        "https://registry.npmjs.org/ms/-/ms-2.1.2.tgz",
        include_bytes!("fixtures/tarballs/ms-2.1.2.tgz"),
    ),
    (
        "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz",
        include_bytes!("fixtures/tarballs/ms-2.1.3.tgz"),
    ),
];

const WITHBUNDLE: &[u8] = include_bytes!("fixtures/workspace/vendor/withbundle-1.0.0.tgz");

/// The real tarballs, checked against the lockfile like any download.
fn registry() -> MemoryFetcher {
    let fetcher = MemoryFetcher::new();
    for (url, bytes) in TARBALLS {
        fetcher.insert(url, bytes);
    }
    fetcher
}

/// A registry that has every package: the real tarballs where there is
/// one (still verified, under whatever host they were asked for), and a
/// stand-in for the rest, which is not: esbuild and its platform builds
/// are too big to commit.
struct AnyRegistry {
    real: MemoryFetcher,
    requests: Mutex<Vec<String>>,
}

impl AnyRegistry {
    fn new() -> Self {
        Self {
            real: registry(),
            requests: Mutex::new(Vec::new()),
        }
    }

    fn requests(&self) -> Vec<String> {
        let mut requests = self.requests.lock().unwrap().clone();
        requests.sort();
        requests
    }
}

/// A gzipped package tarball with these files under `package/`.
fn tarball(files: &[(&str, &str)]) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut builder = tar::Builder::new(encoder);
    for (path, data) in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        builder
            .append_data(&mut header, format!("package/{path}"), data.as_bytes())
            .unwrap();
    }
    builder.into_inner().unwrap().finish().unwrap()
}

impl Fetcher for AnyRegistry {
    fn fetch(
        &self,
        url: &str,
        integrity: &Integrity,
    ) -> std::result::Result<Arc<[u8]>, FetchError> {
        self.requests.lock().unwrap().push(url.to_string());
        let path = url.split_once("://").map_or(url, |(_, rest)| rest);
        let path = path.split_once('/').map_or("", |(_, path)| path);
        for (known, _) in TARBALLS {
            if known.ends_with(&format!("/{path}")) || known == url {
                return self.real.fetch(known, integrity);
            }
        }
        // A version's manifest, which a WebAssembly build is looked up
        // in: this registry has none, so the native package stays.
        if !url.ends_with(".tgz") {
            return Err(FetchError::NotFound {
                url: url.to_string(),
            });
        }
        // esbuild's command, so `.bin` is what npm made of the real one.
        if url.ends_with("/esbuild/-/esbuild-0.25.0.tgz") {
            return Ok(tarball(&[
                (
                    "package.json",
                    r#"{"name":"esbuild","version":"0.25.0","bin":{"esbuild":"bin/esbuild"}}"#,
                ),
                ("bin/esbuild", "#!/usr/bin/env node\n"),
            ])
            .into());
        }
        let package = format!("{{\"from\":\"{url}\"}}");
        Ok(tarball(&[
            ("package.json", &package),
            ("index.js", "module.exports = 1;\n"),
        ])
        .into())
    }
}

fn project(files: &[(&str, &str)]) -> SnapshotBuilder {
    let builder = SnapshotBuilder::new();
    for (path, contents) in files {
        builder
            .write(format!("{ROOT}/{path}"), contents.as_bytes())
            .unwrap();
    }
    builder
}

fn workspace_with(lock: &str, manifest: &str) -> SnapshotBuilder {
    let builder = project(&[
        ("package.json", manifest),
        ("package-lock.json", lock),
        (
            "packages/a/package.json",
            fixture!("workspace/packages/a/package.json"),
        ),
        ("packages/a/cli.js", fixture!("workspace/packages/a/cli.js")),
        (
            "packages/b/package.json",
            fixture!("workspace/packages/b/package.json"),
        ),
    ]);
    builder
        .write(format!("{ROOT}/vendor/withbundle-1.0.0.tgz"), WITHBUNDLE)
        .unwrap();
    builder
}

fn workspace() -> SnapshotBuilder {
    workspace_with(
        fixture!("workspace/package-lock.json"),
        fixture!("workspace/package.json"),
    )
}

/// What `fixtures/generate.sh` records of a real install: every symlink
/// (`L`, or `B` for a command in a `.bin`) and every package directory
/// (`P`), relative to the project.
fn layout(builder: &SnapshotBuilder) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let relative = |path: &Path| {
        path.strip_prefix(ROOT)
            .unwrap()
            .to_string_lossy()
            .into_owned()
    };
    for entry in builder.entries() {
        match entry {
            FsEntry::Symlink { path, target } => {
                let kind = if path.parent().is_some_and(|p| p.ends_with(".bin")) {
                    "B"
                } else {
                    "L"
                };
                out.insert(format!(
                    "{kind} {} -> {}",
                    relative(&path),
                    target.display()
                ));
            }
            FsEntry::File { path, .. } if path.ends_with("package.json") => {
                let dir = relative(path.parent().unwrap());
                let Some((_, name)) = dir.rsplit_once("node_modules/") else {
                    continue;
                };
                let parts = name.split('/').count();
                if parts == 1 || (parts == 2 && name.starts_with('@')) {
                    out.insert(format!("P {dir}"));
                }
            }
            _ => {}
        }
    }
    out
}

fn recorded(layout: &str) -> BTreeSet<String> {
    layout.lines().map(str::to_string).collect()
}

/// The fixture's recorded tree, commands included.
fn recorded_workspace() -> BTreeSet<String> {
    let mut all = recorded(fixture!("workspace/layout.txt"));
    all.extend(recorded(fixture!("workspace/bins.txt")));
    all
}

fn read(builder: &SnapshotBuilder, path: &str) -> String {
    String::from_utf8(builder.read(format!("{ROOT}/{path}")).unwrap()).unwrap()
}

/// The Mac the fixture's layout was recorded on.
fn darwin() -> NpmOptions {
    NpmOptions {
        platform: Some(Platform {
            os: "darwin".to_string(),
            cpu: "arm64".to_string(),
            libc: None,
        }),
        ..NpmOptions::default()
    }
}

#[test]
fn a_workspace_gets_the_tree_npm_ci_made() {
    let builder = workspace();
    let fetcher = AnyRegistry::new();
    let report = install(&builder, ROOT, &fetcher, &darwin()).unwrap();
    assert_eq!(layout(&builder), recorded_workspace());
    assert_eq!(report.lockfile, "package-lock.json");
    assert_eq!(report.lockfile_version, 3);
    // Every directory but the bundled one, from as many tarballs (isnum
    // and is-odd's is-number are the same one).
    assert_eq!((report.packages, report.tarballs), (10, 9));
    assert_eq!((report.links, report.bundled), (2, 1));
    // `esbuild` is esbuild's though withbundle names one too (the first
    // package in path order keeps it), `withbundle` is withbundle's though
    // the workspace @fixture/a names one too (packages link before
    // workspaces), and `fixture-a` is linked through the workspace's link.
    assert_eq!(report.bins, 3);
    // The 24 other builds of esbuild.
    assert_eq!(report.skipped_optional.len(), 24);
    assert!(
        !report
            .skipped_optional
            .contains(&"node_modules/@esbuild/darwin-arm64".to_string())
    );

    // The conflicting versions sit where the lockfile put them.
    assert!(read(&builder, "node_modules/is-number/package.json").contains("\"7.0.0\""));
    assert!(
        read(
            &builder,
            "node_modules/is-odd/node_modules/is-number/package.json"
        )
        .contains("\"6.0.0\"")
    );
    assert!(read(&builder, "node_modules/ms/package.json").contains("\"2.1.3\""));
    assert!(read(&builder, "packages/b/node_modules/ms/package.json").contains("\"2.1.2\""));
    // An alias is the aliased package under the alias's name.
    let isnum = read(&builder, "node_modules/isnum/package.json");
    assert!(isnum.contains("\"name\": \"is-number\"") && isnum.contains("\"6.0.0\""));
    // The bundled package came out of its bundler's tarball, which came
    // out of the repository.
    assert_eq!(
        read(
            &builder,
            "node_modules/withbundle/node_modules/inner/index.js"
        ),
        "module.exports = \"inner\";\n"
    );
    let requests = fetcher.requests();
    assert!(requests.iter().all(|url| !url.contains("inner")));
    assert!(requests.iter().all(|url| !url.contains("withbundle")));
    assert_eq!(
        report.warnings,
        vec![
            "npm ci would have run the install scripts of 2 packages (esbuild@0.25.0, fsevents@2.3.3); nothing here runs them"
                .to_string()
        ]
    );
}

#[test]
fn the_isolate_leaves_out_native_optional_packages() {
    let builder = workspace();
    let report = install(&builder, ROOT, &AnyRegistry::new(), &NpmOptions::default()).unwrap();
    let mut expected = recorded_workspace();
    expected.remove("P node_modules/@esbuild/darwin-arm64");
    expected.remove("P node_modules/fsevents");
    assert_eq!(layout(&builder), expected);
    // Every build of esbuild, and fsevents (darwin only).
    assert_eq!(report.skipped_optional.len(), 26);
    assert!(
        report
            .skipped_optional
            .contains(&"node_modules/fsevents".to_string())
    );
    // esbuild itself is not optional, so it is installed.
    assert!(builder.is_file(format!("{ROOT}/node_modules/esbuild/package.json")));
    assert!(report.warnings[0].contains("1 package (esbuild@0.25.0)"));
}

#[test]
fn the_registry_tarballs_are_verified() {
    // Only the real tarballs, so every one is checked against the lockfile;
    // dev and optional packages are left out to stay within them.
    let lock = fixture!("workspace/package-lock.json");
    let options = NpmOptions {
        include_dev: false,
        ..NpmOptions::default()
    };
    let report = install(&workspace(), ROOT, &registry(), &options).unwrap();
    // Five from the registry, one from the repository.
    assert_eq!(report.tarballs, 6);

    let tampered = lock.replace(
        // ms 2.1.3's.
        "sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==",
        "sha512-AAAAubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==",
    );
    assert_ne!(tampered, lock);
    let builder = workspace_with(&tampered, fixture!("workspace/package.json"));
    let error = install(&builder, ROOT, &registry(), &options).unwrap_err();
    assert!(
        matches!(
            &error,
            NpmError::Fetch {
                source: FetchError::IntegrityMismatch { .. },
                ..
            }
        ),
        "{error}"
    );

    // And so is the tarball in the repository.
    let builder = workspace();
    builder
        .write(
            format!("{ROOT}/vendor/withbundle-1.0.0.tgz"),
            &tarball(&[("package.json", "{}")]),
        )
        .unwrap();
    let error = install(&builder, ROOT, &registry(), &options).unwrap_err();
    assert!(error.to_string().contains("does not match"), "{error}");
}

#[test]
fn dev_packages_can_be_left_out() {
    let builder = workspace();
    let options = NpmOptions {
        include_dev: false,
        ..NpmOptions::default()
    };
    let report = install(&builder, ROOT, &registry(), &options).unwrap();
    assert!(!builder.is_dir(format!("{ROOT}/node_modules/esbuild")));
    // fsevents is optional but not dev: still a platform question.
    assert_eq!(report.skipped_optional, vec!["node_modules/fsevents"]);
}

#[test]
fn a_lockfile_behind_package_json_is_refused() {
    let manifest = fixture!("workspace/package.json").replace(
        "\"is-odd\": \"3.0.1\",",
        "\"is-odd\": \"3.0.1\",\n    \"left-pad\": \"1.3.0\",",
    );
    let builder = workspace_with(fixture!("workspace/package-lock.json"), &manifest);
    let error = install(&builder, ROOT, &AnyRegistry::new(), &darwin()).unwrap_err();
    let message = error.to_string();
    assert!(
        message.contains("out of sync with package.json"),
        "{message}"
    );
    assert!(message.contains("left-pad is missing"), "{message}");

    // A workspace's own package.json counts too.
    let builder = workspace();
    builder
        .write(
            format!("{ROOT}/packages/a/package.json"),
            b"{\"name\":\"@fixture/a\",\"version\":\"1.0.0\"}",
        )
        .unwrap();
    let error = install(&builder, ROOT, &AnyRegistry::new(), &darwin()).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("ms is no longer in packages/a/package.json"),
        "{error}"
    );
}

/// A hand-written v3 lockfile over `packages`, with a root that declares
/// `root_deps`, and a matching `package.json`.
fn handwritten(root_deps: &str, packages: &str) -> SnapshotBuilder {
    let lock = format!(
        r#"{{"name":"t","lockfileVersion":3,"requires":true,"packages":{{"":{{"name":"t",{root_deps}}}{packages}}}}}"#
    );
    project(&[
        ("package.json", &format!("{{\"name\":\"t\",{root_deps}}}")),
        ("package-lock.json", &lock),
    ])
}

const FAKE_INTEGRITY: &str = "sha512-AAAA";

fn registry_entry(name: &str, extra: &str) -> String {
    let basename = name.rsplit('/').next().unwrap();
    format!(
        r#","node_modules/{name}":{{"version":"1.0.0","resolved":"https://registry.npmjs.org/{name}/-/{basename}-1.0.0.tgz","integrity":"{FAKE_INTEGRITY}"{extra}}}"#
    )
}

#[test]
fn a_failed_optional_package_takes_its_optional_set_with_it() {
    // root -optional-> a -> b -> native (linux x64): b and a need it
    // without an option, so the set reaches back to the optional edge from
    // the root. shared is also the root's own dependency, so it stays;
    // only-b goes with b. wasm asks for wasm32, which the isolate is.
    let packages = [
        registry_entry(
            "a",
            r#","optional":true,"dependencies":{"b":"1.0.0","shared":"1.0.0"}"#,
        ),
        registry_entry(
            "b",
            r#","optional":true,"dependencies":{"native":"1.0.0","only-b":"1.0.0"}"#,
        ),
        registry_entry("native", r#","optional":true,"os":["linux"],"cpu":["x64"]"#),
        registry_entry("only-b", r#","optional":true"#),
        registry_entry("shared", ""),
        registry_entry("wasm", r#","optional":true,"cpu":["wasm32"]"#),
        // Not optional: installed whatever it says, as inert files.
        registry_entry("pinned", r#","os":["win32"],"cpu":["x64"]"#),
    ]
    .concat();
    let builder = handwritten(
        r#""dependencies":{"shared":"1.0.0","pinned":"1.0.0"},"optionalDependencies":{"a":"1.0.0","wasm":"1.0.0"}"#,
        &packages,
    );
    let report = install(&builder, ROOT, &AnyRegistry::new(), &NpmOptions::default()).unwrap();
    assert_eq!(
        report.skipped_optional,
        vec![
            "node_modules/a",
            "node_modules/b",
            "node_modules/native",
            "node_modules/only-b"
        ]
    );
    let installed: Vec<String> = layout(&builder).into_iter().collect();
    assert_eq!(
        installed,
        vec![
            "P node_modules/pinned",
            "P node_modules/shared",
            "P node_modules/wasm"
        ]
    );

    // On linux x64 everything is there.
    let options = NpmOptions {
        platform: Some(Platform {
            os: "linux".to_string(),
            cpu: "x64".to_string(),
            libc: Some("glibc".to_string()),
        }),
        ..NpmOptions::default()
    };
    let builder = handwritten(
        r#""dependencies":{"shared":"1.0.0","pinned":"1.0.0"},"optionalDependencies":{"a":"1.0.0","wasm":"1.0.0"}"#,
        &packages,
    );
    let report = install(&builder, ROOT, &AnyRegistry::new(), &options).unwrap();
    assert_eq!(report.skipped_optional, vec!["node_modules/wasm"]);
}

#[test]
fn npmrc_moves_the_registry() {
    let packages = [
        registry_entry("ms", ""),
        // No `resolved` (`omit-lockfile-registry-resolved`): built from the
        // scope's registry.
        r#","node_modules/@corp/lib":{"version":"2.0.0","integrity":"sha512-AAAA"}"#.to_string(),
        // Somewhere else entirely: left alone.
        r#","node_modules/other":{"version":"1.0.0","resolved":"https://cdn.example.com/other-1.0.0.tgz","integrity":"sha512-AAAA"}"#
            .to_string(),
    ]
    .concat();
    let builder = handwritten(
        r#""dependencies":{"ms":"1.0.0","@corp/lib":"2.0.0","other":"1.0.0"}"#,
        &packages,
    );
    builder
        .write(
            format!("{ROOT}/.npmrc"),
            b"registry=https://mirror.example.com/npm/\n@corp:registry=https://corp.example.com/\n//corp.example.com/:_authToken=${TOKEN}\n",
        )
        .unwrap();
    let fetcher = AnyRegistry::new();
    install(&builder, ROOT, &fetcher, &NpmOptions::default()).unwrap();
    assert_eq!(
        fetcher.requests(),
        vec![
            "https://cdn.example.com/other-1.0.0.tgz",
            "https://corp.example.com/@corp/lib/-/lib-2.0.0.tgz",
            "https://mirror.example.com/npm/ms/-/ms-1.0.0.tgz",
        ]
    );
}

#[test]
fn registry_rewrites_follow_replace_registry_host() {
    let options = NpmOptions::default();
    let settings = |npmrc: &str| {
        let bytes = npmrc.as_bytes().to_vec();
        Settings::read_with(&move |_| Some(bytes.clone()), Path::new("/app"))
    };
    let npmjs = "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz";
    let mirror = settings("registry=https://mirror.example.com:8443/npm\n");
    assert_eq!(
        mirror.rewrite(npmjs, &options),
        "https://mirror.example.com:8443/npm/ms/-/ms-2.1.3.tgz"
    );
    // Already under the registry's path: not doubled.
    assert_eq!(
        mirror.rewrite("https://registry.npmjs.org/npm/ms/-/ms-2.1.3.tgz", &options),
        "https://mirror.example.com:8443/npm/ms/-/ms-2.1.3.tgz"
    );
    let never = settings("registry=https://mirror.example.com/\nreplace-registry-host=never\n");
    assert_eq!(never.rewrite(npmjs, &options), npmjs);
    let always = settings("registry=https://mirror.example.com/\nreplace-registry-host=always\n");
    assert_eq!(
        always.rewrite("https://old.example.com/ms/-/ms-2.1.3.tgz", &options),
        "https://mirror.example.com/ms/-/ms-2.1.3.tgz"
    );
    let host = settings(
        "registry=https://mirror.example.com/\nreplace-registry-host=https://old.example.com/repo\n",
    );
    assert_eq!(
        host.rewrite("https://old.example.com/repo/ms/-/ms-2.1.3.tgz", &options),
        "https://mirror.example.com/ms/-/ms-2.1.3.tgz"
    );
    assert_eq!(host.rewrite(npmjs, &options), npmjs);
    // The default registry is itself: nothing moves.
    assert_eq!(Settings::default().rewrite(npmjs, &options), npmjs);
}

#[test]
fn the_projects_own_scripts_are_named_in_a_warning() {
    let builder = handwritten(
        r#""dependencies":{"ms":"1.0.0"}"#,
        &registry_entry("ms", ""),
    );
    builder
        .write(
            format!("{ROOT}/package.json"),
            br#"{"name":"t","dependencies":{"ms":"1.0.0"},"scripts":{"postinstall":"patch-package","prepare":"husky","test":"node --test"}}"#,
        )
        .unwrap();
    let report = install(&builder, ROOT, &AnyRegistry::new(), &NpmOptions::default()).unwrap();
    assert_eq!(
        report.warnings,
        vec![
            "npm ci would have run package.json postinstall (patch-package), package.json prepare (husky); nothing here runs them"
                .to_string()
        ]
    );
}

#[test]
fn legacy_peer_deps_drops_peer_edges() {
    // What npm writes with `legacy-peer-deps`: `plugin` is optional
    // although `host` peers on it, since npm followed no peer edge. Read
    // without the setting, `host` needs the failing `plugin` without an
    // option and goes with it; with it, `host` stays.
    let packages = [
        registry_entry("host", r#","peerDependencies":{"plugin":"1.0.0"}"#),
        registry_entry("plugin", r#","optional":true,"os":["linux"]"#),
    ]
    .concat();
    let root = r#""dependencies":{"host":"1.0.0"},"optionalDependencies":{"plugin":"1.0.0"}"#;
    let builder = handwritten(root, &packages);
    let report = install(&builder, ROOT, &AnyRegistry::new(), &NpmOptions::default()).unwrap();
    assert_eq!(
        report.skipped_optional,
        vec!["node_modules/host", "node_modules/plugin"]
    );
    let builder = handwritten(root, &packages);
    builder
        .write(format!("{ROOT}/.npmrc"), b"legacy-peer-deps = true\n")
        .unwrap();
    let report = install(&builder, ROOT, &AnyRegistry::new(), &NpmOptions::default()).unwrap();
    assert_eq!(report.skipped_optional, vec!["node_modules/plugin"]);
}

#[test]
fn npm_shrinkwrap_wins_over_package_lock() {
    let builder = handwritten(
        r#""dependencies":{"ms":"1.0.0"}"#,
        &registry_entry("ms", ""),
    );
    builder
        .write(
            format!("{ROOT}/npm-shrinkwrap.json"),
            br#"{"lockfileVersion":3,"packages":{"":{"name":"t","dependencies":{"ms":"1.0.0"}},"node_modules/ms":{"version":"9.9.9","resolved":"https://registry.npmjs.org/ms/-/ms-9.9.9.tgz","integrity":"sha512-AAAA"}}}"#,
        )
        .unwrap();
    let fetcher = AnyRegistry::new();
    let report = install(&builder, ROOT, &fetcher, &NpmOptions::default()).unwrap();
    assert_eq!(report.lockfile, "npm-shrinkwrap.json");
    assert_eq!(
        fetcher.requests(),
        vec!["https://registry.npmjs.org/ms/-/ms-9.9.9.tgz"]
    );
}

#[test]
fn what_cannot_be_installed_says_why() {
    let cases: [(&str, &str, &str); 7] = [
        (
            r#"{"lockfileVersion":1,"dependencies":{}}"#,
            "",
            "lockfileVersion 1 (npm 5 and 6) is not supported",
        ),
        (
            r#"{"lockfileVersion":4,"packages":{}}"#,
            "",
            "written by an npm newer than this runner knows",
        ),
        (r#"{"name":"t"}"#, "", "has no lockfileVersion"),
        (
            r#"{"lockfileVersion":3,"packages":{"":{"name":"t","dependencies":{"g":"1"}},"node_modules/g":{"version":"1.0.0","resolved":"git+ssh://git@github.com/a/g.git#0123456789abcdef0123456789abcdef01234567"}}}"#,
            r#"{"name":"t","dependencies":{"g":"1"}}"#,
            "git dependencies",
        ),
        (
            r#"{"lockfileVersion":3,"packages":{"":{"name":"t","dependencies":{"d":"1"}},"node_modules/d":{"version":"1.0.0","resolved":"file:lib/d"}}}"#,
            r#"{"name":"t","dependencies":{"d":"1"}}"#,
            "installed as a copy (install-links)",
        ),
        (
            r#"{"lockfileVersion":3,"packages":{"":{"name":"t","dependencies":{"r":"1"}},"node_modules/r":{"version":"1.0.0","resolved":"https://example.com/r.tgz"}}}"#,
            r#"{"name":"t","dependencies":{"r":"1"}}"#,
            "has no integrity in the lockfile",
        ),
        ("", "{}", "not found; run npm install"),
    ];
    for (lock, manifest, needle) in cases {
        let mut files = vec![("package.json", manifest)];
        if !lock.is_empty() {
            files.push(("package-lock.json", lock));
        }
        let builder = project(&files);
        let error = install(&builder, ROOT, &AnyRegistry::new(), &NpmOptions::default())
            .unwrap_err()
            .to_string();
        assert!(error.contains(needle), "{needle:?} not in {error:?}");
    }
}

#[test]
fn a_link_outside_node_modules_resolves_from_its_own_directory() {
    // `file:../shared` (a sibling of the project) is a link like a
    // workspace; what it depends on resolves from its own directory up.
    let lock = r#"{"lockfileVersion":3,"packages":{
        "":{"name":"t","dependencies":{"shared":"file:../shared"}},
        "../shared":{"name":"shared","version":"1.0.0","optionalDependencies":{"native":"1.0.0"}},
        "../shared/node_modules/native":{"version":"1.0.0","resolved":"https://registry.npmjs.org/native/-/native-1.0.0.tgz","integrity":"sha512-AAAA","optional":true,"os":["linux"]},
        "node_modules/shared":{"resolved":"../shared","link":true}}}"#;
    let builder = project(&[
        (
            "package.json",
            r#"{"name":"t","dependencies":{"shared":"file:../shared"}}"#,
        ),
        ("package-lock.json", lock),
    ]);
    let report = install(&builder, ROOT, &AnyRegistry::new(), &NpmOptions::default()).unwrap();
    // The link is made, and the skipped optional package is not written
    // outside the project.
    assert_eq!(report.links, 1);
    assert_eq!(
        report.skipped_optional,
        vec!["../shared/node_modules/native"]
    );
    assert_eq!(
        layout(&builder).into_iter().collect::<Vec<_>>(),
        vec!["L node_modules/shared -> ../../shared"]
    );
}

/// Every symlink and package directory under a real `node_modules` tree on
/// disk, as [`layout`] lists an install, `.bin` included.
fn disk_layout(root: &Path) -> BTreeSet<String> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeSet<String>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let relative = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let Ok(meta) = std::fs::symlink_metadata(&path) else {
                continue;
            };
            if meta.file_type().is_symlink() {
                if relative.contains("node_modules/") {
                    let target = std::fs::read_link(&path).unwrap();
                    let kind = if relative.contains("/.bin/") {
                        "B"
                    } else {
                        "L"
                    };
                    out.insert(format!("{kind} {relative} -> {}", target.display()));
                }
            } else if meta.is_dir() {
                walk(root, &path, out);
            } else if let Some(dir) = relative.strip_suffix("/package.json")
                && let Some((_, name)) = dir.rsplit_once("node_modules/")
            {
                let parts = name.split('/').count();
                if parts == 1 || (parts == 2 && name.starts_with('@')) {
                    out.insert(format!("P {dir}"));
                }
            }
        }
    }
    let mut out = BTreeSet::new();
    walk(root, root, &mut out);
    out
}

/// Installs the project at `IWCI_TEST_NPM_PROJECT`, a checkout a real
/// `npm ci --ignore-scripts` has run in, from the registry, and compares
/// the result with the tree npm left there. The platform is the host's
/// (`IWCI_TEST_NPM_PLATFORM`, `os/cpu/libc`, default `linux/x64/glibc`).
#[test]
#[ignore = "network, and a project npm ci has run in"]
fn matches_a_real_npm_ci() {
    let Ok(project) = std::env::var("IWCI_TEST_NPM_PROJECT") else {
        return;
    };
    let project = Path::new(&project);
    let platform =
        std::env::var("IWCI_TEST_NPM_PLATFORM").unwrap_or_else(|_| "linux/x64/glibc".to_string());
    let mut fields = platform.split('/').map(str::to_string);
    let options = NpmOptions {
        platform: Some(Platform {
            os: fields.next().unwrap(),
            cpu: fields.next().unwrap(),
            libc: fields.next(),
        }),
        ..NpmOptions::default()
    };
    // The lockfile, the configuration and every project's package.json,
    // which is all an install reads of the repository here.
    let builder = SnapshotBuilder::new();
    let copy = |relative: &str| {
        if let Ok(bytes) = std::fs::read(project.join(relative)) {
            builder.write(format!("{ROOT}/{relative}"), &bytes).unwrap();
        }
    };
    for name in INPUT_FILES {
        copy(name);
    }
    copy("package.json");
    let lock = parse_lockfile(&std::fs::read_to_string(project.join("package-lock.json")).unwrap())
        .unwrap();
    for (location, entry) in &lock.packages {
        if !location.is_empty() && !location.contains("node_modules") && !entry.link {
            copy(&format!("{location}/package.json"));
        }
        if let Some(path) = entry
            .resolved
            .as_deref()
            .and_then(|r| r.strip_prefix("file:"))
        {
            copy(path);
        }
    }
    let fetcher = crate::fetch::HttpFetcher::new();
    let report = install(&builder, ROOT, &fetcher, &options).unwrap();
    eprintln!(
        "{} packages from {} tarballs, {} links, {} skipped, {} bundled; {:?}",
        report.packages,
        report.tarballs,
        report.links,
        report.skipped_optional.len(),
        report.bundled,
        report.elapsed
    );
    let ours = layout(&builder);
    let theirs = disk_layout(project);
    let missing: Vec<_> = theirs.difference(&ours).collect();
    let extra: Vec<_> = ours.difference(&theirs).collect();
    assert!(
        missing.is_empty() && extra.is_empty(),
        "npm ci has and we do not: {missing:#?}\nwe have and npm ci does not: {extra:#?}"
    );
}

/// In the isolate, a registry's `esbuild` is installed as `esbuild-wasm`
/// of the same version, checked against the integrity the registry
/// publishes for it; on a host, or from anywhere but the registry, it is
/// left alone.
#[test]
fn esbuild_is_installed_as_its_webassembly_build_in_the_isolate() {
    use base64::Engine;
    use sha2::Digest;
    let sri = |bytes: &[u8]| {
        format!(
            "sha512-{}",
            base64::engine::general_purpose::STANDARD.encode(sha2::Sha512::digest(bytes))
        )
    };
    let native = tarball(&[
        ("package.json", r#"{"name":"esbuild","version":"0.25.0"}"#),
        ("lib/main.js", "spawn('@esbuild/linux-x64')"),
    ]);
    let wasm = tarball(&[
        (
            "package.json",
            r#"{"name":"esbuild-wasm","version":"0.25.0","bin":{"esbuild":"bin/esbuild"}}"#,
        ),
        ("lib/main.js", "spawn('node', ['bin/esbuild'])"),
        ("bin/esbuild", "#!/usr/bin/env node\n"),
    ]);
    let lock = |resolved: &str| {
        format!(
            r#"{{"lockfileVersion":3,"packages":{{"":{{"name":"t","devDependencies":{{"esbuild":"0.25.0"}}}},"node_modules/esbuild":{{"version":"0.25.0","resolved":"{resolved}","integrity":"{}","dev":true}}}}}}"#,
            sri(&native)
        )
    };
    let fetcher = MemoryFetcher::new();
    fetcher.insert(
        "https://registry.npmjs.org/esbuild/-/esbuild-0.25.0.tgz",
        native.clone(),
    );
    fetcher.insert(
        "https://registry.npmjs.org/esbuild-wasm/0.25.0",
        format!(
            r#"{{"name":"esbuild-wasm","version":"0.25.0","dist":{{"integrity":"{}"}}}}"#,
            sri(&wasm)
        ),
    );
    fetcher.insert(
        "https://registry.npmjs.org/esbuild-wasm/-/esbuild-wasm-0.25.0.tgz",
        wasm,
    );
    fetcher.insert("https://cdn.example.com/esbuild-0.25.0.tgz", native.clone());
    let manifest = r#"{"name":"t","devDependencies":{"esbuild":"0.25.0"}}"#;

    let registry_lock = lock("https://registry.npmjs.org/esbuild/-/esbuild-0.25.0.tgz");
    let builder = project(&[
        ("package.json", manifest),
        ("package-lock.json", &registry_lock),
    ]);
    let report = install(&builder, ROOT, &fetcher, &NpmOptions::default()).unwrap();
    assert_eq!(
        report.wasm_builds,
        ["esbuild@0.25.0 as esbuild-wasm@0.25.0"]
    );
    assert!(read(&builder, "node_modules/esbuild/lib/main.js").contains("bin/esbuild"));
    // Its command is the WebAssembly build's.
    assert_eq!(report.bins, 1);
    assert!(layout(&builder).contains("B node_modules/.bin/esbuild -> ../esbuild/bin/esbuild"));
    assert!(
        !fetcher
            .requests()
            .iter()
            .any(|url| url.ends_with("/esbuild-0.25.0.tgz"))
    );

    // On a host that can run the native build, it stays.
    let builder = project(&[
        ("package.json", manifest),
        ("package-lock.json", &registry_lock),
    ]);
    let report = install(&builder, ROOT, &fetcher, &darwin()).unwrap();
    assert!(report.wasm_builds.is_empty());
    assert!(read(&builder, "node_modules/esbuild/lib/main.js").contains("linux-x64"));

    // So it does when the lockfile has it from somewhere else.
    let elsewhere = lock("https://cdn.example.com/esbuild-0.25.0.tgz");
    let builder = project(&[
        ("package.json", manifest),
        ("package-lock.json", &elsewhere),
    ]);
    let report = install(&builder, ROOT, &fetcher, &NpmOptions::default()).unwrap();
    assert!(report.wasm_builds.is_empty());
    assert!(read(&builder, "node_modules/esbuild/lib/main.js").contains("linux-x64"));
}

/// Commands go in the `.bin` of the `node_modules` their package is in,
/// nested ones and a workspace's own included, and a missing file is no
/// command.
#[test]
fn nested_and_workspace_packages_get_their_own_bin() {
    let packages = [
        r#","node_modules/top":{"version":"1.0.0","resolved":"https://registry.npmjs.org/top/-/top-1.0.0.tgz","integrity":"sha512-AAAA","dependencies":{"tool":"2.0.0"}}"#,
        r#","node_modules/tool":{"version":"1.0.0","resolved":"https://registry.npmjs.org/tool/-/tool-1.0.0.tgz","integrity":"sha512-AAAA"}"#,
        r#","node_modules/top/node_modules/tool":{"version":"2.0.0","resolved":"https://registry.npmjs.org/tool/-/tool-2.0.0.tgz","integrity":"sha512-AAAA"}"#,
        r#","node_modules/w":{"resolved":"w","link":true}"#,
        r#","w":{"name":"w","version":"1.0.0","dependencies":{"tool":"3.0.0"}}"#,
        r#","w/node_modules/tool":{"version":"3.0.0","resolved":"https://registry.npmjs.org/tool/-/tool-3.0.0.tgz","integrity":"sha512-AAAA"}"#,
    ]
    .concat();
    let builder = handwritten(
        r#""dependencies":{"top":"1.0.0","tool":"1.0.0","w":"1.0.0"}"#,
        &packages,
    );
    builder
        .write(
            format!("{ROOT}/w/package.json"),
            br#"{"name":"w","version":"1.0.0","dependencies":{"tool":"3.0.0"}}"#,
        )
        .unwrap();
    struct Tools(AnyRegistry);
    impl Fetcher for Tools {
        fn fetch(
            &self,
            url: &str,
            integrity: &Integrity,
        ) -> std::result::Result<Arc<[u8]>, FetchError> {
            let Some(version) = url
                .strip_prefix("https://registry.npmjs.org/tool/-/tool-")
                .and_then(|rest| rest.strip_suffix(".tgz"))
            else {
                return self.0.fetch(url, integrity);
            };
            let manifest = format!(
                r#"{{"name":"tool","version":"{version}","bin":{{"tool":"cli.js","gone":"missing.js"}}}}"#
            );
            Ok(tarball(&[
                ("package.json", &manifest),
                ("cli.js", "#!/usr/bin/env node\n"),
            ])
            .into())
        }
    }
    let report = install(
        &builder,
        ROOT,
        &Tools(AnyRegistry::new()),
        &NpmOptions::default(),
    )
    .unwrap();
    let bins: Vec<String> = layout(&builder)
        .into_iter()
        .filter(|line| line.starts_with("B "))
        .collect();
    assert_eq!(
        bins,
        [
            "B node_modules/.bin/tool -> ../tool/cli.js",
            "B node_modules/top/node_modules/.bin/tool -> ../tool/cli.js",
            "B w/node_modules/.bin/tool -> ../tool/cli.js",
        ]
    );
    assert_eq!(report.bins, 3);
}
