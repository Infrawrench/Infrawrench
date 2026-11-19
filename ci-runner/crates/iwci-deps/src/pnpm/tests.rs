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

/// A lockfile pnpm 11 or later wrote with a boot document first (a project
/// that pins pnpm) installs what the same lockfile without one does.
#[test]
fn a_boot_document_changes_nothing_installed() {
    let plain = fixture(|_| {});
    let plain_report = install(
        &plain.builder,
        "/app",
        &plain.fetcher,
        &PnpmOptions::default(),
    )
    .unwrap();

    let Fixture { builder, fetcher } = fixture(|_| {});
    let lockfile = read(&builder, "/app/pnpm-lock.yaml");
    builder
        .write(
            "/app/pnpm-lock.yaml",
            format!("{}{lockfile}", super::lockfile::BOOT_DOCUMENT).as_bytes(),
        )
        .unwrap();
    let report = install(&builder, "/app", &fetcher, &PnpmOptions::default()).unwrap();
    assert_eq!(report.importers, plain_report.importers);
    assert_eq!(report.packages, plain_report.packages);
    assert_eq!(report.skipped_optional, plain_report.skipped_optional);
    assert_eq!(report.hoisted, plain_report.hoisted);
    assert_eq!(report.links, plain_report.links);
    assert_eq!(fetcher.requests().len(), plain.fetcher.requests().len());
    assert!(!fetcher.requests().iter().any(|url| url.contains("pnpm")));
    assert!(!builder.is_dir("/app/node_modules/pnpm"));
    assert!(read(&builder, "/app/node_modules/react-dom/index.js").contains("react-dom@18.0.0"));
}

/// A workspace whose project depends on `rollup@4.52.0` (with its native
/// build for Linux as an optional dependency, as Rollup publishes it) and
/// `rollup@3.29.5` under an alias; the registry also has
/// `@rollup/wasm-node@4.52.0` when `with_wasm`.
fn rollup_workspace(with_wasm: bool) -> Fixture {
    let fetcher = MemoryFetcher::new();
    let native = publish(
        &fetcher,
        "rollup",
        "4.52.0",
        &[(
            "dist/native.js",
            b"require('@rollup/rollup-linux-x64-gnu');\n",
        )],
    );
    let linux = publish(&fetcher, "@rollup/rollup-linux-x64-gnu", "4.52.0", &[]);
    let old = publish(&fetcher, "rollup", "3.29.5", &[]);
    if with_wasm {
        let wasm = tgz(&[
            (
                "package.json",
                br#"{"name":"@rollup/wasm-node","version":"4.52.0"}"#,
            ),
            (
                "dist/native.js",
                b"require('./wasm-node/bindings_wasm.js');\n",
            ),
            ("dist/wasm-node/bindings_wasm_bg.wasm", b"\0asm"),
        ]);
        fetcher.insert(
            "https://registry.npmjs.org/@rollup%2fwasm-node/4.52.0",
            format!(
                r#"{{"name":"@rollup/wasm-node","version":"4.52.0","dist":{{"integrity":"{}","tarball":"https://registry.npmjs.org/@rollup/wasm-node/-/wasm-node-4.52.0.tgz"}}}}"#,
                sri(&wasm)
            ),
        );
        fetcher.insert(registry("@rollup/wasm-node", "4.52.0"), wasm);
    }
    let lockfile = format!(
        r#"lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      rollup:
        specifier: ^4.52.0
        version: 4.52.0
      rollup3:
        specifier: npm:rollup@3.29.5
        version: rollup@3.29.5

packages:

  '@rollup/rollup-linux-x64-gnu@4.52.0':
    resolution: {{integrity: {linux}}}
    cpu: [x64]
    os: [linux]
    libc: [glibc]

  rollup@3.29.5:
    resolution: {{integrity: {old}}}

  rollup@4.52.0:
    resolution: {{integrity: {native}}}
    hasBin: true

snapshots:

  '@rollup/rollup-linux-x64-gnu@4.52.0':
    optional: true

  rollup@3.29.5: {{}}

  rollup@4.52.0:
    optionalDependencies:
      '@rollup/rollup-linux-x64-gnu': 4.52.0
"#
    );
    let builder = SnapshotBuilder::new();
    builder
        .write("/app/pnpm-lock.yaml", lockfile.as_bytes())
        .unwrap();
    Fixture { builder, fetcher }
}

#[test]
fn rollup_is_installed_as_its_webassembly_build() {
    let Fixture { builder, fetcher } = rollup_workspace(true);
    let report = install(&builder, "/app", &fetcher, &PnpmOptions::default()).unwrap();
    assert_eq!(
        report.wasm_builds,
        ["rollup@4.52.0 as @rollup/wasm-node@4.52.0"]
    );
    // In Rollup's own directory, so `rollup` resolves to it.
    let dir = "/app/node_modules/.pnpm/rollup@4.52.0/node_modules/rollup";
    assert!(read(&builder, &format!("{dir}/dist/native.js")).contains("bindings_wasm"));
    assert!(builder.is_file(format!("{dir}/dist/wasm-node/bindings_wasm_bg.wasm")));
    assert!(read(&builder, "/app/node_modules/rollup/package.json").contains("wasm-node"));
    // Rollup 3 has no native binary to replace.
    assert!(read(&builder, "/app/node_modules/rollup3/index.js").contains("rollup@3.29.5"));
    assert_eq!(
        report.skipped_optional,
        ["@rollup/rollup-linux-x64-gnu@4.52.0"]
    );
    // The native tarball is never fetched.
    assert!(!fetcher.requests().contains(&registry("rollup", "4.52.0")));
}

#[test]
fn rollup_stays_native_where_it_can_run_or_has_no_build() {
    // A host platform runs the native build.
    let Fixture { builder, fetcher } = rollup_workspace(true);
    let host = PnpmOptions {
        platform: Some(Platform {
            os: "linux".into(),
            cpu: "x64".into(),
            libc: Some("glibc".into()),
        }),
        ..PnpmOptions::default()
    };
    let report = install(&builder, "/app", &fetcher, &host).unwrap();
    assert!(report.wasm_builds.is_empty());
    assert!(read(&builder, "/app/node_modules/rollup/dist/native.js").contains("linux-x64-gnu"));
    assert!(
        !fetcher
            .requests()
            .iter()
            .any(|url| url.contains("wasm-node"))
    );

    // An empty table replaces nothing.
    let Fixture { builder, fetcher } = rollup_workspace(true);
    let none = PnpmOptions {
        wasm_builds: &[],
        ..PnpmOptions::default()
    };
    let report = install(&builder, "/app", &fetcher, &none).unwrap();
    assert!(report.wasm_builds.is_empty());
    assert!(read(&builder, "/app/node_modules/rollup/dist/native.js").contains("linux-x64-gnu"));

    // A registry without the build leaves the native package.
    let Fixture { builder, fetcher } = rollup_workspace(false);
    let report = install(&builder, "/app", &fetcher, &PnpmOptions::default()).unwrap();
    assert!(report.wasm_builds.is_empty());
    assert!(read(&builder, "/app/node_modules/rollup/dist/native.js").contains("linux-x64-gnu"));
}

/// Serves a package with `manifest` as its `package.json`, plus `files`.
fn publish_manifest(
    fetcher: &MemoryFetcher,
    name: &str,
    version: &str,
    manifest: &str,
    files: &[(&str, &[u8])],
) -> String {
    let mut entries: Vec<(&str, &[u8])> = vec![("package.json", manifest.as_bytes())];
    entries.extend_from_slice(files);
    let bytes = tgz(&entries);
    let integrity = sri(&bytes);
    fetcher.insert(registry(name, version), bytes);
    integrity
}

/// The SRI of the tar inside a `.tgz`.
fn tar_sri(tgz: &[u8]) -> String {
    let mut tar = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(tgz), &mut tar).unwrap();
    sri(&tar)
}

#[test]
fn a_registry_revision_is_fetched_from_its_route_and_pins_its_tar() {
    let fetcher = MemoryFetcher::new();
    let original = tgz(&[
        ("package.json", br#"{"name":"ejs","version":"2.7.4"}"#),
        ("index.js", b"original"),
    ]);
    let replaced = tgz(&[
        ("package.json", br#"{"name":"ejs","version":"2.7.4"}"#),
        ("index.js", b"patched"),
    ]);
    fetcher.insert(registry("ejs", "2.7.4"), original);
    fetcher.insert("https://registry.npmjs.org/ejs@2.7.4+r2", replaced.clone());
    let scoped = tgz(&[("package.json", br#"{"name":"@a/b","version":"1.0.0"}"#)]);
    fetcher.insert("https://registry.npmjs.org/@a/b@1.0.0+r0", scoped.clone());
    let lockfile = format!(
        r#"lockfileVersion: '9.0'

importers:

  .:
    dependencies:
      '@a/b':
        specifier: 1.0.0
        version: 1.0.0
      ejs:
        specifier: 2.7.4
        version: 2.7.4

packages:

  '@a/b@1.0.0':
    resolution:
      integrity: {scoped}
      revision: 0

  ejs@2.7.4:
    resolution:
      integrity: {replaced}
      revision: 2

snapshots:

  '@a/b@1.0.0': {{}}

  ejs@2.7.4: {{}}
"#,
        scoped = tar_sri(&scoped),
        replaced = tar_sri(&replaced),
    );
    let builder = SnapshotBuilder::new();
    builder
        .write("/app/pnpm-lock.yaml", lockfile.as_bytes())
        .unwrap();
    install(&builder, "/app", &fetcher, &PnpmOptions::default()).unwrap();
    assert_eq!(read(&builder, "/app/node_modules/ejs/index.js"), "patched");
    assert!(read(&builder, "/app/node_modules/@a/b/package.json").contains("1.0.0"));
    assert!(!fetcher.requests().contains(&registry("ejs", "2.7.4")));

    // The tar's hash, not the download's: a lockfile that names the
    // `.tgz`'s hash for a revision is refused.
    let wrong = lockfile.replace(&tar_sri(&replaced), &sri(&replaced));
    builder
        .write("/app/pnpm-lock.yaml", wrong.as_bytes())
        .unwrap();
    let error = install(&builder, "/app", &fetcher, &PnpmOptions::default()).unwrap_err();
    assert!(error.to_string().contains("ejs"), "{error}");
}

#[test]
fn integrity_target_tar_pins_every_tarball_by_its_tar() {
    let fetcher = MemoryFetcher::new();
    let ms = tgz(&[("package.json", br#"{"name":"ms","version":"2.1.3"}"#)]);
    fetcher.insert(registry("ms", "2.1.3"), ms.clone());
    // A tar registry serves the tar itself, which is hashed as it is.
    let mut plain = Vec::new();
    std::io::Read::read_to_end(&mut flate2::read::GzDecoder::new(&ms[..]), &mut plain).unwrap();
    let local = tgz(&[("package.json", br#"{"name":"local","version":"1.0.0"}"#)]);
    let lockfile = |ms_integrity: &str| {
        format!(
            r#"lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
  integrityTarget: tar

importers:

  .:
    dependencies:
      local:
        specifier: file:vendor/local-1.0.0.tgz
        version: file:vendor/local-1.0.0.tgz
      ms:
        specifier: 2.1.3
        version: 2.1.3

packages:

  local@file:vendor/local-1.0.0.tgz:
    resolution: {{integrity: {local}, tarball: file:vendor/local-1.0.0.tgz}}
    version: 1.0.0

  ms@2.1.3:
    resolution: {{integrity: {ms_integrity}}}

snapshots:

  local@file:vendor/local-1.0.0.tgz: {{}}

  ms@2.1.3: {{}}
"#,
            local = tar_sri(&local),
        )
    };
    let builder = SnapshotBuilder::new();
    builder
        .write("/app/vendor/local-1.0.0.tgz", &local)
        .unwrap();
    builder
        .write("/app/pnpm-lock.yaml", lockfile(&tar_sri(&ms)).as_bytes())
        .unwrap();
    install(&builder, "/app", &fetcher, &PnpmOptions::default()).unwrap();
    assert!(read(&builder, "/app/node_modules/ms/package.json").contains("2.1.3"));
    assert!(read(&builder, "/app/node_modules/local/package.json").contains("local"));

    // The same lockfile against a registry that serves the tar.
    let tar_registry = MemoryFetcher::new();
    tar_registry.insert(registry("ms", "2.1.3"), plain);
    let builder = SnapshotBuilder::new();
    builder
        .write("/app/vendor/local-1.0.0.tgz", &local)
        .unwrap();
    builder
        .write("/app/pnpm-lock.yaml", lockfile(&tar_sri(&ms)).as_bytes())
        .unwrap();
    install(&builder, "/app", &tar_registry, &PnpmOptions::default()).unwrap();
    assert!(read(&builder, "/app/node_modules/ms/package.json").contains("2.1.3"));

    // The `.tgz`'s own hash is not the tar's.
    let builder = SnapshotBuilder::new();
    builder
        .write("/app/vendor/local-1.0.0.tgz", &local)
        .unwrap();
    builder
        .write("/app/pnpm-lock.yaml", lockfile(&sri(&ms)).as_bytes())
        .unwrap();
    assert!(install(&builder, "/app", &fetcher, &PnpmOptions::default()).is_err());
}

#[test]
fn a_directory_dependency_is_copied_as_pnpm_packs_it() {
    let fetcher = MemoryFetcher::new();
    let ms = publish(&fetcher, "ms", "2.1.3", &[]);
    // An injected workspace package (`dependenciesMeta.injected`), with a
    // peer, as pnpm locks one.
    let lockfile = format!(
        r#"lockfileVersion: '9.0'

importers:

  examples/app:
    dependencies:
      '@shared/ui':
        specifier: workspace:*
        version: file:tooling/ui(ms@2.1.3)
      ms:
        specifier: 2.1.3
        version: 2.1.3
    dependenciesMeta:
      '@shared/ui':
        injected: true

  tooling/plain: {{}}

  tooling/ui:
    devDependencies:
      ms:
        specifier: 2.1.3
        version: 2.1.3

packages:

  '@shared/plain@file:tooling/plain':
    resolution: {{directory: tooling/plain, type: directory}}

  '@shared/ui@file:tooling/ui':
    resolution: {{directory: tooling/ui, type: directory}}
    peerDependencies:
      ms: ^2.0.0

  ms@2.1.3:
    resolution: {{integrity: {ms}}}

snapshots:

  '@shared/ui@file:tooling/ui(ms@2.1.3)':
    dependencies:
      '@shared/plain': file:tooling/plain
      ms: 2.1.3

  '@shared/plain@file:tooling/plain': {{}}

  ms@2.1.3: {{}}
"#
    );
    let checkout = SnapshotBuilder::new();
    for (path, text) in [
        ("/app/pnpm-lock.yaml", lockfile.as_str()),
        ("/app/examples/app/package.json", r#"{"name":"app"}"#),
        (
            "/app/tooling/ui/package.json",
            r#"{"name":"@shared/ui","files":["src","!src/**/*.test.ts","dist/*.js"],"main":"entry.js"}"#,
        ),
        ("/app/tooling/ui/entry.js", "main"),
        ("/app/tooling/ui/README.md", "readme"),
        ("/app/tooling/ui/src/button.tsx", "button"),
        ("/app/tooling/ui/src/button.test.ts", "test"),
        ("/app/tooling/ui/dist/a.js", "a"),
        ("/app/tooling/ui/dist/a.js.map", "map"),
        ("/app/tooling/ui/notes.txt", "left out"),
        (
            "/app/tooling/ui/node_modules/ms/index.js",
            "the project's own",
        ),
        (
            "/app/tooling/plain/package.json",
            r#"{"name":"@shared/plain"}"#,
        ),
        ("/app/tooling/plain/any/file.txt", "kept"),
    ] {
        checkout.write(path, text.as_bytes()).unwrap();
    }
    // Through a layer, as a cached install runs.
    let layer = checkout.layer();
    install(&layer, "/app", &fetcher, &PnpmOptions::default()).unwrap();
    let ui = "/app/node_modules/.pnpm/@shared+ui@file+tooling+ui_ms@2.1.3/node_modules/@shared/ui";
    for (file, kept) in [
        ("package.json", true),
        ("entry.js", true),
        ("README.md", true),
        ("src/button.tsx", true),
        ("src/button.test.ts", false),
        ("dist/a.js", true),
        ("dist/a.js.map", false),
        ("notes.txt", false),
        ("node_modules/ms/index.js", false),
    ] {
        assert_eq!(layer.is_file(format!("{ui}/{file}")), kept, "{file}");
    }
    // Without `files`, everything but `node_modules`.
    assert_eq!(
        read(
            &layer,
            "/app/node_modules/.pnpm/@shared+plain@file+tooling+plain/node_modules/@shared/plain/any/file.txt"
        ),
        "kept"
    );
    // Its dependencies and its peer resolve beside the copy.
    assert!(
        read(
            &layer,
            "/app/node_modules/.pnpm/@shared+ui@file+tooling+ui_ms@2.1.3/node_modules/ms/index.js"
        )
        .contains("ms@2.1.3")
    );
    assert!(
        read(
            &layer,
            "/app/examples/app/node_modules/@shared/ui/src/button.tsx"
        )
        .contains("button")
    );
    // A file added to the directory is a change to the install's inputs.
    let reads = layer.reads();
    assert!(reads.iter().all(|input| input.holds(checkout.fs())));
    checkout
        .write("/app/tooling/ui/src/new.tsx", b"new")
        .unwrap();
    assert!(!reads.iter().all(|input| input.holds(checkout.fs())));
}

#[test]
fn commands_are_linked_into_node_modules_bin() {
    let fetcher = MemoryFetcher::new();
    let eslint = publish_manifest(
        &fetcher,
        "eslint",
        "9.0.0",
        r#"{"name":"eslint","version":"9.0.0","bin":{"eslint":"./bin/eslint.js"}}"#,
        &[("bin/eslint.js", b"#!/usr/bin/env node\n")],
    );
    let which = publish_manifest(
        &fetcher,
        "which",
        "2.0.2",
        r#"{"name":"which","version":"2.0.2","bin":{"node-which":"bin/node-which"}}"#,
        &[("bin/node-which", b"#!/usr/bin/env node\n")],
    );
    let tool = publish_manifest(
        &fetcher,
        "@scope/tool",
        "1.0.0",
        r#"{"name":"@scope/tool","version":"1.0.0","bin":"cli.js"}"#,
        &[("cli.js", b"#!/usr/bin/env node\n")],
    );
    let lockfile = format!(
        r#"lockfileVersion: '9.0'

importers:

  .:
    devDependencies:
      '@scope/tool':
        specifier: 1.0.0
        version: 1.0.0

  packages/app:
    devDependencies:
      eslint:
        specifier: ^9.0.0
        version: 9.0.0
      lib:
        specifier: workspace:*
        version: link:../lib

  packages/lib: {{}}

packages:

  '@scope/tool@1.0.0':
    resolution: {{integrity: {tool}}}
    hasBin: true

  eslint@9.0.0:
    resolution: {{integrity: {eslint}}}
    hasBin: true

  which@2.0.2:
    resolution: {{integrity: {which}}}
    hasBin: true

snapshots:

  '@scope/tool@1.0.0': {{}}

  eslint@9.0.0:
    dependencies:
      which: 2.0.2

  which@2.0.2: {{}}
"#
    );
    let builder = SnapshotBuilder::new();
    for (path, text) in [
        ("/app/pnpm-lock.yaml", lockfile.as_str()),
        ("/app/package.json", r#"{"name":"root"}"#),
        ("/app/packages/app/package.json", r#"{"name":"app"}"#),
        (
            "/app/packages/lib/package.json",
            r#"{"name":"lib","bin":{"lib-cli":"src/cli.js"}}"#,
        ),
    ] {
        builder.write(path, text.as_bytes()).unwrap();
    }
    let report = install(&builder, "/app", &fetcher, &PnpmOptions::default()).unwrap();
    let link = |path: &str| {
        builder
            .fs()
            .readlink(Path::new(path))
            .unwrap_or_else(|e| panic!("{path}: {e}"))
    };
    // A project's own dependencies, a scoped package's string `bin` by
    // its unscoped name, and a workspace project's command.
    assert_eq!(
        link("/app/node_modules/.bin/tool"),
        PathBuf::from("../.pnpm/@scope+tool@1.0.0/node_modules/@scope/tool/cli.js")
    );
    assert_eq!(
        link("/app/packages/app/node_modules/.bin/eslint"),
        PathBuf::from(
            "../../../../node_modules/.pnpm/eslint@9.0.0/node_modules/eslint/bin/eslint.js"
        )
    );
    assert_eq!(
        link("/app/packages/app/node_modules/.bin/lib-cli"),
        PathBuf::from("../../../lib/src/cli.js")
    );
    // Following the link reads the file.
    assert_eq!(
        read(&builder, "/app/packages/app/node_modules/.bin/eslint"),
        "#!/usr/bin/env node\n"
    );
    // A package's own `.bin` has its dependencies' commands.
    assert_eq!(
        link(
            "/app/node_modules/.pnpm/eslint@9.0.0/node_modules/eslint/node_modules/.bin/node-which"
        ),
        PathBuf::from("../../../../../which@2.0.2/node_modules/which/bin/node-which")
    );
    // A transitive dependency is not on a project's `PATH`.
    assert!(
        builder
            .fs()
            .readlink(Path::new("/app/packages/app/node_modules/.bin/node-which"))
            .is_err()
    );
    assert_eq!(report.bins, 4);
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

/// A native platform adds its packages to what the isolate takes, and
/// leaves those alone: without it the native one is skipped.
#[test]
fn a_native_platform_installs_its_optional_packages_beside_the_isolates() {
    let Fixture { builder, fetcher } = fixture(|_| {});
    let isolate = install(&builder, "/app", &fetcher, &PnpmOptions::default()).unwrap();
    assert!(!isolate.skipped_optional.is_empty());
    let Fixture { builder, fetcher } = fixture(|_| {});
    let options = PnpmOptions {
        native: Some(Platform {
            os: "darwin".into(),
            cpu: "arm64".into(),
            libc: None,
        }),
        ..PnpmOptions::default()
    };
    let report = install(&builder, "/app", &fetcher, &options).unwrap();
    assert!(report.skipped_optional.is_empty());
    assert_eq!(
        report.packages,
        isolate.packages + isolate.skipped_optional.len()
    );
    assert!(read(&builder, "/app/node_modules/fsevents/index.js").contains("fsevents"));
    // The runner's own is Linux with glibc, where the sandbox runs.
    if let Some(native) = super::native_platform() {
        assert_eq!(
            (native.os.as_str(), native.libc.as_deref()),
            ("linux", Some("glibc"))
        );
    }
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
