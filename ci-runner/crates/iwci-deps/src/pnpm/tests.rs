//! Installs against synthetic tarballs served by a `MemoryFetcher` (no
//! network), plus checks against this repository's real lockfile and, when
//! it is fresh, the real pnpm install next to it.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use base64::Engine;
use sha2::Digest;

use super::*;
use crate::fetch::MemoryFetcher;

fn sri(bytes: &[u8]) -> String {
    let digest = sha2::Sha512::digest(bytes);
    format!(
        "sha512-{}",
        base64::engine::general_purpose::STANDARD.encode(digest)
    )
}

/// A gzipped tarball with every entry under `package/`, as `npm pack`
/// writes it. A path containing `..` is written into the header raw,
/// because the `tar` crate (rightly) refuses to build one.
fn tgz(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    let mut builder = tar::Builder::new(encoder);
    for (path, data) in entries {
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(0o644);
        header.set_entry_type(tar::EntryType::Regular);
        let full = format!("package/{path}");
        if full.contains("..") {
            let name = &mut header.as_gnu_mut().unwrap().name;
            name[..full.len()].copy_from_slice(full.as_bytes());
            header.set_cksum();
            builder.append(&header, *data).unwrap();
        } else {
            builder.append_data(&mut header, &full, *data).unwrap();
        }
    }
    builder.into_inner().unwrap().finish().unwrap()
}

fn registry(name: &str, version: &str) -> String {
    let basename = name.rsplit('/').next().unwrap();
    format!("https://registry.npmjs.org/{name}/-/{basename}-{version}.tgz")
}

/// Serves `name@version` with a `package.json` and an `index.js` that
/// names it, plus `extra` files. Returns the tarball's integrity.
fn publish(fetcher: &MemoryFetcher, name: &str, version: &str, extra: &[(&str, &[u8])]) -> String {
    let manifest = format!(r#"{{"name":"{name}","version":"{version}"}}"#);
    let index = format!("module.exports = '{name}@{version}';\n");
    let mut entries: Vec<(&str, &[u8])> = vec![
        ("package.json", manifest.as_bytes()),
        ("index.js", index.as_bytes()),
    ];
    entries.extend_from_slice(extra);
    let bytes = tgz(&entries);
    let integrity = sri(&bytes);
    fetcher.insert(registry(name, version), bytes);
    integrity
}

const LEFT_PAD_PATCH: &[u8] = b"diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -1 +1,2 @@
 module.exports = 'left-pad@1.3.0';
+module.exports.patched = true;
";

struct Fixture {
    builder: SnapshotBuilder,
    fetcher: MemoryFetcher,
}

/// A two-project workspace exercising every lockfile feature the
/// installer supports. `tamper` may replace the served tarballs.
fn fixture(tamper: impl FnOnce(&MemoryFetcher)) -> Fixture {
    let fetcher = MemoryFetcher::new();
    let mut integrity = BTreeMap::new();
    for (name, version) in [
        ("@scope/util", "1.0.0"),
        ("@tsc-rs/typescript", "0.8.0"),
        ("fsevents", "2.3.3"),
        ("left-pad", "1.3.0"),
        ("loose-envify", "1.4.0"),
        ("ms", "2.1.3"),
        ("react", "18.0.0"),
        ("react-dom", "18.0.0"),
        ("string-width", "4.2.3"),
    ] {
        let extra: &[(&str, &[u8])] = if name == "@tsc-rs/typescript" {
            &[("lib/lib.d.ts", b"interface Array<T> {}\n")]
        } else {
            &[]
        };
        integrity.insert(name, publish(&fetcher, name, version, extra));
    }
    tamper(&fetcher);
    let hash = patch_file_hash(LEFT_PAD_PATCH);
    let i = |name: &str| integrity[name].clone();
    let lockfile = format!(
        r#"lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

patchedDependencies:
  left-pad@1.3.0: {hash}

importers:

  .:
    dependencies:
      '@scope/util':
        specifier: ^1.0.0
        version: 1.0.0
      left-pad:
        specifier: 1.3.0
        version: 1.3.0(patch_hash={hash})
      lib:
        specifier: workspace:*
        version: link:packages/lib
      react:
        specifier: ^18.0.0
        version: 18.0.0
      react-dom:
        specifier: ^18.0.0
        version: 18.0.0(react@18.0.0)
      typescript:
        specifier: npm:@tsc-rs/typescript@0.8.0
        version: '@tsc-rs/typescript@0.8.0'
    optionalDependencies:
      fsevents:
        specifier: ^2.3.0
        version: 2.3.3

  packages/lib:
    dependencies:
      '@scope/util':
        specifier: ^1.0.0
        version: 1.0.0
    devDependencies:
      cjs-width:
        specifier: npm:string-width@4.2.3
        version: string-width@4.2.3

packages:

  '@scope/util@1.0.0':
    resolution: {{integrity: {scope_util}}}

  '@tsc-rs/typescript@0.8.0':
    resolution: {{integrity: {tsc}}}
    hasBin: true

  fsevents@2.3.3:
    resolution: {{integrity: {fsevents}}}
    engines: {{node: ^8.16.0 || ^10.6.0 || >=11.0.0}}
    os: [darwin]

  left-pad@1.3.0:
    resolution: {{integrity: {left_pad}}}

  loose-envify@1.4.0:
    resolution: {{integrity: {loose_envify}}}
    hasBin: true

  ms@2.1.3:
    resolution: {{integrity: {ms}}}

  react-dom@18.0.0:
    resolution: {{integrity: {react_dom}}}
    peerDependencies:
      react: ^18.0.0

  react@18.0.0:
    resolution: {{integrity: {react}}}

  string-width@4.2.3:
    resolution: {{integrity: {string_width}}}

snapshots:

  '@scope/util@1.0.0':
    dependencies:
      ms: 2.1.3

  '@tsc-rs/typescript@0.8.0': {{}}

  fsevents@2.3.3:
    optional: true

  left-pad@1.3.0(patch_hash={hash}): {{}}

  loose-envify@1.4.0: {{}}

  ms@2.1.3: {{}}

  react-dom@18.0.0(react@18.0.0):
    dependencies:
      loose-envify: 1.4.0
      react: 18.0.0

  react@18.0.0:
    dependencies:
      loose-envify: 1.4.0

  string-width@4.2.3: {{}}
"#,
        scope_util = i("@scope/util"),
        tsc = i("@tsc-rs/typescript"),
        fsevents = i("fsevents"),
        left_pad = i("left-pad"),
        loose_envify = i("loose-envify"),
        ms = i("ms"),
        react_dom = i("react-dom"),
        react = i("react"),
        string_width = i("string-width"),
    );
    let builder = SnapshotBuilder::new();
    builder
        .write("/app/pnpm-lock.yaml", lockfile.as_bytes())
        .unwrap();
    builder
        .write(
            "/app/pnpm-workspace.yaml",
            b"packages:\n  - packages/*\npatchedDependencies:\n  left-pad@1.3.0: patches/left-pad@1.3.0.patch\n",
        )
        .unwrap();
    builder
        .write("/app/patches/left-pad@1.3.0.patch", LEFT_PAD_PATCH)
        .unwrap();
    builder
        .write("/app/package.json", br#"{"name":"root","private":true}"#)
        .unwrap();
    builder
        .write("/app/packages/lib/package.json", br#"{"name":"lib"}"#)
        .unwrap();
    builder
        .write("/app/packages/lib/src/index.ts", b"export {};\n")
        .unwrap();
    Fixture { builder, fetcher }
}

fn read(builder: &SnapshotBuilder, path: &str) -> String {
    String::from_utf8(builder.read(path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}

#[test]
fn installs_the_isolated_layout() {
    let Fixture { builder, fetcher } = fixture(|_| {});
    let report = install(&builder, "/app", &fetcher, &PnpmOptions::default()).unwrap();

    // A scoped package, through the importer's symlink.
    assert!(read(&builder, "/app/node_modules/@scope/util/index.js").contains("@scope/util@1.0.0"));
    // Its own dependency, linked beside it in the virtual store.
    assert!(
        read(
            &builder,
            "/app/node_modules/.pnpm/@scope+util@1.0.0/node_modules/ms/index.js"
        )
        .contains("ms@2.1.3")
    );
    // A peer-suffixed snapshot gets its own directory, with the peer and
    // its other dependencies linked next to it.
    let react_dom = "/app/node_modules/.pnpm/react-dom@18.0.0_react@18.0.0/node_modules";
    assert!(
        read(&builder, &format!("{react_dom}/react-dom/index.js")).contains("react-dom@18.0.0")
    );
    assert!(read(&builder, &format!("{react_dom}/react/index.js")).contains("react@18.0.0"));
    assert!(
        read(&builder, &format!("{react_dom}/loose-envify/index.js"))
            .contains("loose-envify@1.4.0")
    );
    assert!(read(&builder, "/app/node_modules/react-dom/index.js").contains("react-dom@18.0.0"));
    let link = builder
        .fs()
        .readlink(Path::new("/app/node_modules/react-dom"))
        .unwrap();
    assert_eq!(
        link,
        PathBuf::from(".pnpm/react-dom@18.0.0_react@18.0.0/node_modules/react-dom")
    );
    // The npm alias: `typescript` is tsc-rs.
    assert!(
        read(&builder, "/app/node_modules/typescript/package.json").contains("@tsc-rs/typescript")
    );
    assert!(
        read(&builder, "/app/node_modules/typescript/lib/lib.d.ts").contains("interface Array")
    );
    // The workspace link, and the linked project's own dependencies,
    // including an aliased dev dependency.
    assert!(read(&builder, "/app/node_modules/lib/package.json").contains(r#""name":"lib""#));
    assert_eq!(
        read(&builder, "/app/node_modules/lib/src/index.ts"),
        "export {};\n"
    );
    assert!(
        read(
            &builder,
            "/app/packages/lib/node_modules/@scope/util/index.js"
        )
        .contains("@scope/util")
    );
    assert!(
        read(
            &builder,
            "/app/packages/lib/node_modules/cjs-width/index.js"
        )
        .contains("string-width@4.2.3")
    );
    // The patch.
    assert!(read(&builder, "/app/node_modules/left-pad/index.js").contains("patched = true"));
    assert!(builder.is_dir(format!(
        "/app/node_modules/.pnpm/left-pad@1.3.0_patch_hash={}/node_modules/left-pad",
        patch_file_hash(LEFT_PAD_PATCH)
    )));
    // The optional darwin-only package is neither fetched nor linked.
    assert!(!builder.is_dir("/app/node_modules/fsevents"));
    assert!(
        !fetcher
            .requests()
            .iter()
            .any(|url| url.contains("fsevents"))
    );
    // Private hoisting: transitive and other projects' dependencies and
    // the workspace project itself, but never the root's own names.
    let hoisted = "/app/node_modules/.pnpm/node_modules";
    assert!(read(&builder, &format!("{hoisted}/loose-envify/index.js")).contains("loose-envify"));
    assert!(read(&builder, &format!("{hoisted}/ms/index.js")).contains("ms@2.1.3"));
    assert!(read(&builder, &format!("{hoisted}/cjs-width/index.js")).contains("string-width"));
    assert!(read(&builder, &format!("{hoisted}/lib/package.json")).contains(r#""name":"lib""#));
    assert!(!builder.is_dir(format!("{hoisted}/react")));

    assert_eq!(
        report.importers,
        vec![".".to_string(), "packages/lib".to_string()]
    );
    assert_eq!(report.packages, 8);
    assert_eq!(report.tarballs, 8);
    assert_eq!(report.skipped_optional, vec!["fsevents@2.3.3".to_string()]);
    assert_eq!(report.patched.len(), 1);
    assert_eq!(report.hoisted, 4);
    assert!(report.files >= 17 && report.bytes > 0 && report.tarball_bytes > 0);
    // Every tarball once, whatever links to it.
    let mut requests = fetcher.requests();
    requests.sort();
    requests.dedup();
    assert_eq!(requests.len(), fetcher.requests().len());
}

/// Installed files are read-only nodes over shared buffers; a job's fork
/// must still read them, overwrite them in its own layer, and report the
/// change, while the snapshot keeps the original.
#[test]
fn installed_files_behave_like_any_other_in_a_job() {
    let Fixture { builder, fetcher } = fixture(|_| {});
    install(&builder, "/app", &fetcher, &PnpmOptions::default()).unwrap();
    let path = "/app/node_modules/.pnpm/ms@2.1.3/node_modules/ms/index.js";
    let original = builder.read(path).unwrap();
    let snapshot = builder.freeze();
    let job = snapshot.fork();
    assert_eq!(
        job.read("/app/node_modules/@scope/util/package.json")
            .unwrap(),
        snapshot
            .read("/app/node_modules/@scope/util/package.json")
            .unwrap()
    );
    // Longer than the original: whether a shorter overwrite truncates is
    // the overlay's business, not the installer's.
    let changed = b"module.exports = 'changed by the job, and longer than before';\n".to_vec();
    assert!(changed.len() > original.len());
    job.write(path, &changed).unwrap();
    assert_eq!(job.read(path).unwrap(), changed);
    assert_eq!(snapshot.read(path).unwrap(), original);
    let changes = job.changes("/app/node_modules/.pnpm/ms@2.1.3");
    assert_eq!(
        changes,
        vec![iwci_vfs::Change::Modified {
            path: path.into(),
            bytes: changed
        }]
    );
    job.remove_file(path).unwrap();
    assert!(job.read(path).is_err());
    assert!(snapshot.read(path).is_ok());
}

#[test]
fn a_host_platform_installs_its_optional_packages() {
    let Fixture { builder, fetcher } = fixture(|_| {});
    let options = PnpmOptions {
        platform: Some(Platform {
            os: "darwin".into(),
            cpu: "arm64".into(),
            libc: None,
        }),
        ..PnpmOptions::default()
    };
    let report = install(&builder, "/app", &fetcher, &options).unwrap();
    assert!(report.skipped_optional.is_empty());
    assert!(read(&builder, "/app/node_modules/fsevents/index.js").contains("fsevents"));
}

#[test]
fn only_importers_installs_just_their_closure() {
    let Fixture { builder, fetcher } = fixture(|_| {});
    let options = PnpmOptions {
        only_importers: Some(vec!["./packages/lib/".into()]),
        ..PnpmOptions::default()
    };
    let report = install(&builder, "/app", &fetcher, &options).unwrap();
    assert_eq!(report.importers, vec!["packages/lib".to_string()]);
    assert_eq!(report.packages, 3);
    assert!(
        read(
            &builder,
            "/app/packages/lib/node_modules/@scope/util/index.js"
        )
        .contains("@scope/util")
    );
    assert!(!builder.is_dir("/app/node_modules/react"));
    assert!(!fetcher.requests().iter().any(|url| url.contains("react")));
    // Without dev dependencies the alias goes too.
    let Fixture { builder, fetcher } = fixture(|_| {});
    let options = PnpmOptions {
        only_importers: Some(vec!["packages/lib".into()]),
        include_dev: false,
        ..PnpmOptions::default()
    };
    let report = install(&builder, "/app", &fetcher, &options).unwrap();
    assert_eq!(report.packages, 2);
    assert!(!builder.is_dir("/app/packages/lib/node_modules/cjs-width"));
    let unknown = PnpmOptions {
        only_importers: Some(vec!["nope".into()]),
        ..PnpmOptions::default()
    };
    assert!(install(&builder, "/app", &fetcher, &unknown).is_err());
}

#[test]
fn a_tarball_entry_that_climbs_out_is_refused() {
    let Fixture { builder, fetcher } = fixture(|_| {});
    // The lockfile was written for the honest tarball, so swap in one
    // with a matching integrity: the integrity check is not what stops it.
    let evil = tgz(&[("package.json", b"{}"), ("../../evil.js", b"x")]);
    let lockfile = read(&builder, "/app/pnpm-lock.yaml");
    let honest = fetcher_integrity(&lockfile, "ms@2.1.3");
    let lockfile = lockfile.replace(&honest, &sri(&evil));
    builder
        .write("/app/pnpm-lock.yaml", lockfile.as_bytes())
        .unwrap();
    fetcher.insert(registry("ms", "2.1.3"), evil);
    let error = install(&builder, "/app", &fetcher, &PnpmOptions::default()).unwrap_err();
    assert!(
        matches!(&error, PnpmError::Tarball { dep_path, .. } if dep_path == "ms@2.1.3"),
        "{error}"
    );
    assert!(!builder.is_file("/app/node_modules/evil.js"));
    assert!(!builder.is_file("/app/node_modules/.pnpm/evil.js"));
}

/// The integrity the fixture's lockfile pins for `key`.
fn fetcher_integrity(lockfile: &str, key: &str) -> String {
    let start = lockfile.find(&format!("\n  {key}:\n")).unwrap();
    let rest = &lockfile[start..];
    let at = rest.find("integrity: ").unwrap() + "integrity: ".len();
    let end = rest[at..].find('}').unwrap();
    rest[at..at + end].to_string()
}

#[test]
fn an_integrity_mismatch_fails_the_install() {
    let Fixture { builder, fetcher } = fixture(|fetcher| {
        fetcher.insert(
            registry("react", "18.0.0"),
            tgz(&[("index.js", b"tampered")]),
        );
    });
    let error = install(&builder, "/app", &fetcher, &PnpmOptions::default()).unwrap_err();
    assert!(
        matches!(
            &error,
            PnpmError::Fetch { dep_path, source: FetchError::IntegrityMismatch { .. } } if dep_path == "react@18.0.0"
        ),
        "{error}"
    );
}

#[test]
fn a_changed_patch_file_is_reported_as_stale() {
    let Fixture { builder, fetcher } = fixture(|_| {});
    let mut changed = LEFT_PAD_PATCH.to_vec();
    changed.extend_from_slice(b"+// more\n");
    builder
        .write("/app/patches/left-pad@1.3.0.patch", &changed)
        .unwrap();
    let error = install(&builder, "/app", &fetcher, &PnpmOptions::default()).unwrap_err();
    assert!(
        error
            .to_string()
            .contains("has changed since pnpm-lock.yaml was written"),
        "{error}"
    );
}

#[test]
fn a_patch_that_does_not_apply_fails_loudly() {
    let Fixture { builder, fetcher } = fixture(|_| {});
    let lockfile = read(&builder, "/app/pnpm-lock.yaml");
    let old_hash = patch_file_hash(LEFT_PAD_PATCH);
    let bad = b"--- a/index.js\n+++ b/index.js\n@@ -1 +1 @@\n-something else\n+x\n";
    let new_hash = patch_file_hash(bad);
    builder
        .write(
            "/app/pnpm-lock.yaml",
            lockfile.replace(&old_hash, &new_hash).as_bytes(),
        )
        .unwrap();
    builder
        .write("/app/patches/left-pad@1.3.0.patch", bad)
        .unwrap();
    let error = install(&builder, "/app", &fetcher, &PnpmOptions::default()).unwrap_err();
    assert!(
        matches!(&error, PnpmError::Patch { dep_path, .. } if dep_path == "left-pad@1.3.0"),
        "{error}"
    );
}

#[test]
fn platform_checks_follow_pnpm() {
    let package = |os: &[&str], cpu: &[&str], libc: &[&str]| Package {
        name: "x".into(),
        version: "1.0.0".into(),
        resolution: Resolution::Other(String::new()),
        os: os.iter().map(|s| s.to_string()).collect(),
        cpu: cpu.iter().map(|s| s.to_string()).collect(),
        libc: libc.iter().map(|s| s.to_string()).collect(),
        has_bin: false,
    };
    let linux = Platform {
        os: "linux".into(),
        cpu: "x64".into(),
        libc: Some("glibc".into()),
    };
    assert!(platform_accepts(
        Some(&linux),
        &package(&["linux"], &["x64"], &["glibc"])
    ));
    assert!(!platform_accepts(
        Some(&linux),
        &package(&["linux"], &["x64"], &["musl"])
    ));
    assert!(!platform_accepts(
        Some(&linux),
        &package(&["!linux"], &[], &[])
    ));
    assert!(platform_accepts(
        Some(&linux),
        &package(&["!win32"], &[], &[])
    ));
    // The isolate is cpu wasm32 with no operating system or libc: the
    // WebAssembly builds of native packages install, native ones do not.
    assert!(platform_accepts(None, &package(&[], &["wasm32"], &[])));
    assert!(platform_accepts(
        None,
        &named_cpu("@rolldown/binding-wasm32-wasi", &["wasm32"])
    ));
    assert!(!platform_accepts(None, &package(&[], &["x64"], &[])));
    assert!(!platform_accepts(
        None,
        &package(&["linux"], &["wasm32"], &[])
    ));
    assert!(!platform_accepts(
        None,
        &named_cpu("@rolldown/binding-linux-x64-gnu", &[])
    ));
    assert!(!platform_accepts(None, &package(&["linux"], &[], &[])));
    assert!(platform_accepts(None, &package(&["!win32"], &[], &[])));
    assert!(platform_accepts(None, &package(&[], &[], &[])));
    // Fields a registry dropped are read back from the name.
    fn named_cpu(name: &str, cpu: &[&str]) -> Package {
        Package {
            name: name.into(),
            version: "1.0.0".into(),
            resolution: Resolution::Other(String::new()),
            os: Vec::new(),
            cpu: cpu.iter().map(|s| s.to_string()).collect(),
            libc: Vec::new(),
            has_bin: false,
        }
    }
    let named = |name: &str, os: &[&str]| Package {
        name: name.into(),
        ..package(os, &[], &[])
    };
    let mac = Platform {
        os: "darwin".into(),
        cpu: "arm64".into(),
        libc: None,
    };
    assert!(!platform_accepts(
        Some(&mac),
        &named("@nx/nx-win32-arm64-msvc", &[])
    ));
    assert!(platform_accepts(
        Some(&mac),
        &named("@nx/nx-darwin-arm64", &[])
    ));
    assert!(!platform_accepts(
        Some(&mac),
        &named("tool-darwin-x64", &["darwin"])
    ));
    assert!(platform_accepts(
        Some(&mac),
        &named("@electron/windows-sign", &[])
    ));
}

#[test]
fn settings_come_from_npmrc_and_the_workspace_file() {
    let builder = SnapshotBuilder::new();
    builder
        .write(
            "/w/.npmrc",
            b"shamefully-hoist=true\nhoist-pattern[]=*types*\n",
        )
        .unwrap();
    let settings = WorkspaceSettings::read(&builder, Path::new("/w")).unwrap();
    assert_eq!(settings.public_hoist_pattern, vec!["*".to_string()]);
    assert_eq!(settings.hoist_pattern, vec!["*types*".to_string()]);
    builder
        .write(
            "/w/pnpm-workspace.yaml",
            b"hoist: false\nnodeLinker: isolated\n",
        )
        .unwrap();
    assert!(
        WorkspaceSettings::read(&builder, Path::new("/w"))
            .unwrap()
            .hoist_pattern
            .is_empty()
    );
    builder
        .write("/w/pnpm-workspace.yaml", b"nodeLinker: hoisted\n")
        .unwrap();
    assert!(WorkspaceSettings::read(&builder, Path::new("/w")).is_err());
}

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

/// The monorepo this runner lives in, which pins a couple of thousand
/// packages with catalogs, patches, npm aliases, peer suffixes, links and
/// platform packages.
fn repository_lockfile() -> Option<(String, Lockfile)> {
    let text = std::fs::read_to_string(repository().join("pnpm-lock.yaml")).ok()?;
    let lockfile = parse_lockfile(&text).unwrap();
    Some((text, lockfile))
}

#[test]
fn parses_the_repository_lockfile() {
    let Some((text, lockfile)) = repository_lockfile() else {
        eprintln!("skipped: no pnpm-lock.yaml beside the runner");
        return;
    };
    // Importers counted from the text, independently of the parser.
    let importers = text
        .lines()
        .skip_while(|line| *line != "importers:")
        .skip(1)
        .take_while(|line| line.is_empty() || line.starts_with(' '))
        .filter(|line| line.starts_with("  ") && !line.starts_with("   ") && line.ends_with(':'))
        .count();
    assert!(importers > 1);
    assert_eq!(lockfile.importers.len(), importers);
    assert!(lockfile.importers.contains_key("."));

    for (dep_path, snapshot) in &lockfile.snapshots {
        assert!(
            lockfile.package(dep_path).is_some(),
            "{dep_path} has no package entry"
        );
        let dir = dep_path_to_filename(dep_path, DEFAULT_VIRTUAL_STORE_DIR_MAX_LENGTH);
        assert!(
            !dir.is_empty() && !dir.contains('/') && dir != "." && dir != ".." && dir.len() <= 120,
            "{dep_path} gives directory {dir}"
        );
        for (alias, reference) in snapshot_deps(snapshot) {
            if let DepRef::Snapshot(child) = DepRef::parse(alias, reference) {
                assert!(
                    lockfile.snapshots.contains_key(&child),
                    "{dep_path} -> {child}"
                );
            }
        }
    }
    for (id, importer) in &lockfile.importers {
        for (alias, reference) in importer_deps(importer, true) {
            match DepRef::parse(alias, reference) {
                DepRef::Snapshot(child) => {
                    assert!(lockfile.snapshots.contains_key(&child), "{id}: {child}")
                }
                DepRef::Link(path) => assert!(link_target_id(id, &path).is_some(), "{id}: {path}"),
            }
        }
    }
    for package in lockfile.packages.values() {
        assert!(
            matches!(package.resolution, Resolution::Registry { .. }),
            "{package:?}"
        );
    }
    // The aliased TypeScript and both patches are there.
    assert!(
        lockfile
            .patched_dependencies
            .contains_key("@tsc-rs/typescript@0.8.0")
    );
    assert!(
        lockfile
            .snapshots
            .keys()
            .any(|key| key.starts_with("@tsc-rs/typescript@") && patch_hash(key).is_some())
    );

    // The isolate installs every project but no platform binaries.
    let settings = WorkspaceSettings::default();
    let plan = Plan::build(&lockfile, &settings, &PnpmOptions::default()).unwrap();
    assert_eq!(plan.importers.len(), importers);
    assert!(!plan.skipped.is_empty());
    for dep_path in &plan.skipped {
        let package = lockfile.package(dep_path).unwrap();
        assert!(!package.os.is_empty() || !package.cpu.is_empty() || !package.libc.is_empty());
    }
    // A single project closes over far less.
    let web = PnpmOptions {
        only_importers: Some(vec!["app/packages/analytics".into()]),
        ..PnpmOptions::default()
    };
    if lockfile.importers.contains_key("app/packages/analytics") {
        let small = Plan::build(&lockfile, &settings, &web).unwrap();
        assert!(small.installed.len() < plan.installed.len() / 2);
    }
}

/// The node platform names for the host this test runs on.
fn host_platform() -> Option<Platform> {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => return None, // libc detection is not worth porting for a test
        other => other,
    };
    let cpu = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    };
    Some(Platform {
        os: os.into(),
        cpu: cpu.into(),
        libc: None,
    })
}

/// When the repository's own `node_modules` was installed by pnpm from
/// exactly this lockfile (pnpm keeps a copy at `.pnpm/lock.yaml`), the
/// plan for the same host must match it: the same directories, the same
/// skipped packages, the same hoisting.
#[test]
fn matches_the_repository_pnpm_install() {
    let Some((text, lockfile)) = repository_lockfile() else {
        return;
    };
    let modules = repository().join("node_modules");
    let fresh = std::fs::read_to_string(modules.join(".pnpm/lock.yaml"))
        .is_ok_and(|installed| installed == text);
    let Some(platform) = host_platform().filter(|_| fresh) else {
        eprintln!("skipped: no pnpm install of this exact lockfile on a comparable host");
        return;
    };
    let manifest: serde_yaml_ng::Value =
        serde_yaml_ng::from_slice(&std::fs::read(modules.join(".modules.yaml")).unwrap()).unwrap();
    let options = PnpmOptions {
        platform: Some(platform),
        ..PnpmOptions::default()
    };
    let settings = WorkspaceSettings::default();
    let plan = Plan::build(&lockfile, &settings, &options).unwrap();

    let skipped: BTreeSet<String> = manifest["skipped"]
        .as_sequence()
        .unwrap()
        .iter()
        .map(|value| value.as_str().unwrap().to_string())
        .collect();
    // pnpm does not always prune directories an older install made, so
    // only those of snapshots this install did not skip are compared.
    let known: BTreeSet<String> = lockfile
        .snapshots
        .keys()
        .filter(|dep_path| !skipped.contains(*dep_path))
        .map(|dep_path| dep_path_to_filename(dep_path, DEFAULT_VIRTUAL_STORE_DIR_MAX_LENGTH))
        .collect();
    let on_disk: BTreeSet<String> = std::fs::read_dir(modules.join(".pnpm"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| known.contains(name))
        .collect();
    let planned: BTreeSet<String> = plan
        .installed
        .values()
        .map(|entry| entry.dir.clone())
        .collect();
    // pnpm 11.20 also treated an optional package whose name has a lone
    // operating system token (`@electron/windows-sign`) as platform
    // specific; current pnpm, which this follows, does not
    // (pnpm/pnpm#11702). What only those packages pull in may differ.
    let lone_os_token = |name: &str| {
        let name = name.rsplit('/').next().unwrap_or(name).to_lowercase();
        name.split(['-', '_', '.']).any(|token| {
            matches!(
                token,
                "win32" | "windows" | "linux" | "darwin" | "macos" | "osx"
            )
        })
    };
    let mut divergent: BTreeSet<&str> = BTreeSet::new();
    let mut queue: Vec<&str> = plan
        .installed
        .iter()
        .filter(|(_, entry)| {
            entry.snapshot.optional
                && entry.package.os.is_empty()
                && entry.package.cpu.is_empty()
                && lone_os_token(&entry.package.name)
        })
        .map(|(dep_path, _)| *dep_path)
        .collect();
    while let Some(dep_path) = queue.pop() {
        if !divergent.insert(dep_path) {
            continue;
        }
        for (alias, reference) in snapshot_deps(plan.installed[dep_path].snapshot) {
            if let DepRef::Snapshot(child) = DepRef::parse(alias, reference)
                && let Some((key, entry)) = plan.installed.get_key_value(child.as_str())
                && entry.snapshot.optional
            {
                queue.push(key);
            }
        }
    }
    let divergent_dirs: BTreeSet<String> = divergent
        .iter()
        .map(|dep_path| plan.installed[dep_path].dir.clone())
        .collect();
    let planned: BTreeSet<String> = planned.difference(&divergent_dirs).cloned().collect();
    assert_eq!(
        on_disk.difference(&planned).collect::<Vec<_>>(),
        Vec::<&String>::new(),
        "directories pnpm made that the plan does not"
    );
    assert_eq!(
        planned.difference(&on_disk).collect::<Vec<_>>(),
        Vec::<&String>::new(),
        "directories the plan makes that pnpm did not"
    );

    // pnpm also lists optional packages reached only through skipped ones;
    // the plan just never reaches them.
    for dep_path in &plan.skipped {
        assert!(
            skipped.contains(*dep_path),
            "{dep_path} skipped by the plan, not by pnpm"
        );
    }
    for dep_path in &skipped {
        assert!(
            !plan.installed.contains_key(dep_path.as_str())
                || divergent.contains(dep_path.as_str()),
            "{dep_path} skipped by pnpm, installed by the plan"
        );
    }

    let mut project_names = BTreeMap::new();
    for id in lockfile.importers.keys() {
        let path = repository().join(id).join("package.json");
        if let Ok(bytes) = std::fs::read(path)
            && let Ok(manifest) = serde_json::from_slice::<serde_json::Value>(&bytes)
            && let Some(name) = manifest["name"].as_str()
        {
            project_names.insert(id.clone(), name.to_string());
        }
    }
    let hoisted = plan.hoist(&lockfile, &settings, &options, &project_names);
    // Hoisting is compared with the links pnpm left, which is an
    // approximation in both directions: pnpm keeps an existing
    // `.pnpm/node_modules` link while the copy it points at is still
    // installed (so a link can predate the current lockfile), and pnpm
    // walks projects in its workspace discovery order (topological), which
    // decides between different versions of one name that several projects
    // depend on directly. The plan walks them in lockfile order. Everything
    // else follows pnpm, so nearly every link must agree.
    let private = modules.join(".pnpm/node_modules");
    let (mut agree, mut total) = (0usize, 0usize);
    let mut differ = Vec::new();
    for hoisted in &hoisted {
        assert_eq!(hoisted.kind, hoist::HoistKind::Private);
        let target = match &hoisted.target {
            hoist::HoistTarget::Snapshot(dep_path) => {
                if divergent.contains(dep_path.as_str()) {
                    continue;
                }
                let entry = &plan.installed[dep_path.as_str()];
                modules
                    .join(".pnpm")
                    .join(&entry.dir)
                    .join("node_modules")
                    .join(&entry.package.name)
            }
            hoist::HoistTarget::Project(id) => repository().join(id),
        };
        total += 1;
        let link = private.join(&hoisted.alias);
        if std::fs::canonicalize(&link).ok() == std::fs::canonicalize(&target).ok() {
            agree += 1;
        } else {
            differ.push(hoisted.alias.clone());
        }
    }
    eprintln!("hoisting: {agree} of {total} links agree with pnpm; differ: {differ:?}");
    assert!(total > 1000);
    assert!(
        agree * 100 >= total * 97,
        "only {agree} of {total} hoisted links agree: {differ:?}"
    );
}

/// A real install of a tiny lockfile from the public registry.
#[test]
#[ignore = "network"]
fn installs_from_the_npm_registry() {
    let lockfile = "lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      is-number:
        specifier: 7.0.0
        version: 7.0.0

packages:

  is-number@7.0.0:
    resolution: {integrity: sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==}
    engines: {node: '>=0.12.0'}

snapshots:

  is-number@7.0.0: {}
";
    let builder = SnapshotBuilder::new();
    builder
        .write("/app/pnpm-lock.yaml", lockfile.as_bytes())
        .unwrap();
    let fetcher = crate::fetch::HttpFetcher::new();
    let report = install(&builder, "/app", &fetcher, &PnpmOptions::default()).unwrap();
    assert_eq!(report.packages, 1);
    assert!(read(&builder, "/app/node_modules/is-number/package.json").contains("\"is-number\""));
}

/// Throughput at monorepo scale: 2,000 packages of 40 files each, served
/// from memory, so the time is unpacking, writing and linking.
#[test]
#[ignore = "benchmark"]
fn installs_a_monorepo_sized_lockfile() {
    let fetcher = MemoryFetcher::new();
    let mut packages = String::new();
    let mut snapshots = String::new();
    let mut importer = String::new();
    let count = 2000;
    let body = vec![b'x'; 2048];
    for n in 0..count {
        let name = format!("pkg-{n}");
        let files: Vec<(String, &[u8])> = (0..40)
            .map(|f| (format!("lib/sub{}/file{f}.d.ts", f % 4), body.as_slice()))
            .collect();
        let entries: Vec<(&str, &[u8])> = files.iter().map(|(p, b)| (p.as_str(), *b)).collect();
        let integrity = publish(&fetcher, &name, "1.0.0", &entries);
        packages.push_str(&format!(
            "  {name}@1.0.0:\n    resolution: {{integrity: {integrity}}}\n\n"
        ));
        let deps: Vec<String> = (1..4)
            .map(|d| (n + d * 7) % count)
            .filter(|&d| d != n)
            .map(|d| format!("      pkg-{d}: 1.0.0\n"))
            .collect();
        snapshots.push_str(&format!(
            "  {name}@1.0.0:\n    dependencies:\n{}\n",
            deps.concat()
        ));
        if n % 10 == 0 {
            importer.push_str(&format!(
                "      {name}:\n        specifier: 1.0.0\n        version: 1.0.0\n"
            ));
        }
    }
    let lockfile = format!(
        "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n{importer}\npackages:\n\n{packages}snapshots:\n\n{snapshots}"
    );
    let builder = SnapshotBuilder::new();
    builder
        .write("/app/pnpm-lock.yaml", lockfile.as_bytes())
        .unwrap();
    let parallelism = std::env::var("IWCI_BENCH_THREADS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(16);
    let options = PnpmOptions {
        parallelism,
        ..PnpmOptions::default()
    };
    let report = install(&builder, "/app", &fetcher, &options).unwrap();
    eprintln!(
        "{} packages, {} files, {} MiB, {} links in {:?}",
        report.packages,
        report.files,
        report.bytes >> 20,
        report.links,
        report.elapsed
    );
    assert_eq!(report.packages, count);
}
