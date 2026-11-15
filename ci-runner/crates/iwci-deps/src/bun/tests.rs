//! Installs against the lockfiles a real Bun wrote (`fixtures/`, made by
//! `fixtures/generate.sh`), compared with the `node_modules` that Bun laid
//! out for them. Nothing here reaches the network: the registry is a
//! `MemoryFetcher` over the tarballs committed beside the lockfiles.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Mutex;

use iwci_vfs::Entry;

use super::*;
use crate::fetch::MemoryFetcher;

const ROOT: &str = "/app";

macro_rules! fixture {
    ($path:literal) => {
        include_str!(concat!("fixtures/", $path))
    };
}

const TARBALLS: [(&str, &[u8]); 4] = [
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
        "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz",
        include_bytes!("fixtures/tarballs/ms-2.1.3.tgz"),
    ),
];

/// The real tarballs, checked against the lockfile like any download.
fn registry() -> MemoryFetcher {
    let fetcher = MemoryFetcher::new();
    for (url, bytes) in TARBALLS {
        fetcher.insert(url, bytes);
    }
    fetcher
}

/// A registry that has every package: the real tarballs where there is
/// one (still verified), and a stand-in for the rest, which is not. For
/// the layout tests whose packages are too big to commit.
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
}

impl Fetcher for AnyRegistry {
    fn fetch(
        &self,
        url: &str,
        integrity: &Integrity,
    ) -> std::result::Result<Arc<[u8]>, FetchError> {
        self.requests.lock().unwrap().push(url.to_string());
        if TARBALLS.iter().any(|(known, _)| *known == url) {
            return self.real.fetch(url, integrity);
        }
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        for (path, data) in [
            ("package/package.json", format!("{{\"from\":\"{url}\"}}")),
            ("package/index.js", "module.exports = 1;\n".to_string()),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            builder
                .append_data(&mut header, path, data.as_bytes())
                .unwrap();
        }
        Ok(builder.into_inner().unwrap().finish().unwrap().into())
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

fn single() -> SnapshotBuilder {
    project(&[
        ("package.json", fixture!("single/package.json")),
        ("bun.lock", fixture!("single/bun.lock")),
    ])
}

fn workspace() -> SnapshotBuilder {
    project(&[
        ("package.json", fixture!("workspace/package.json")),
        ("bun.lock", fixture!("workspace/bun.lock")),
        (
            "packages/a/package.json",
            fixture!("workspace/packages/a/package.json"),
        ),
        (
            "packages/b/package.json",
            fixture!("workspace/packages/b/package.json"),
        ),
    ])
}

fn peers() -> SnapshotBuilder {
    project(&[
        ("package.json", fixture!("peers/package.json")),
        ("bun.lock", fixture!("peers/bun.lock")),
        (
            "packages/a/package.json",
            fixture!("peers/packages/a/package.json"),
        ),
        (
            "packages/b/package.json",
            fixture!("peers/packages/b/package.json"),
        ),
    ])
}

fn features(lock: &str) -> SnapshotBuilder {
    project(&[
        ("package.json", fixture!("features/package.json")),
        ("bun.lock", lock),
        (
            "packages/lib/package.json",
            fixture!("features/packages/lib/package.json"),
        ),
        (
            "vendor/linked/package.json",
            fixture!("features/vendor/linked/package.json"),
        ),
        (
            "patches/is-odd@3.0.1.patch",
            fixture!("features/patches/is-odd@3.0.1.patch"),
        ),
    ])
}

/// What `fixtures/generate.sh` records of a real install: every symlink
/// (`L`) and every package directory (`P`), relative to the project.
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
            Entry::Symlink { path, target } => {
                out.insert(format!("L {} -> {}", relative(&path), target.display()));
            }
            Entry::File { path, .. } if path.ends_with("package.json") => {
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

fn read(builder: &SnapshotBuilder, path: &str) -> String {
    String::from_utf8(builder.read(format!("{ROOT}/{path}")).unwrap()).unwrap()
}

/// The Mac the fixtures' layouts were recorded on.
fn darwin() -> BunOptions {
    BunOptions {
        platform: Some(Platform {
            os: "darwin".to_string(),
            cpu: "arm64".to_string(),
            libc: None,
        }),
        ..BunOptions::default()
    }
}

#[test]
fn a_single_package_gets_buns_hoisted_tree() {
    let builder = single();
    let fetcher = registry();
    let report = install(&builder, ROOT, &fetcher, &BunOptions::default()).unwrap();
    assert_eq!(
        layout(&builder),
        recorded(fixture!("single/layout-hoisted.txt"))
    );
    assert_eq!(report.linker, Linker::Hoisted);
    assert_eq!((report.packages, report.tarballs, report.links), (4, 4, 0));
    // The nested copy is the other version, as its key says.
    assert!(read(&builder, "node_modules/is-number/package.json").contains("\"7.0.0\""));
    assert!(
        read(
            &builder,
            "node_modules/is-odd/node_modules/is-number/package.json"
        )
        .contains("\"6.0.0\"")
    );
    assert!(read(&builder, "node_modules/ms/index.js").contains("module.exports"));
    assert_eq!(fetcher.requests().len(), 4);
}

#[test]
fn a_workspace_gets_buns_isolated_store() {
    let builder = workspace();
    let report = install(&builder, ROOT, &registry(), &BunOptions::default()).unwrap();
    assert_eq!(report.linker, Linker::Isolated);
    assert_eq!(
        layout(&builder),
        recorded(fixture!("workspace/layout-isolated.txt"))
    );
    assert_eq!(
        (report.packages, report.tarballs, report.hoisted),
        (4, 4, 3)
    );
    // What `packages/a` imports resolves through its link, and what that
    // package imports through the link beside it.
    assert!(read(&builder, "packages/a/node_modules/is-odd/package.json").contains("\"3.0.1\""));
    assert!(
        read(
            &builder,
            "node_modules/.bun/is-odd@3.0.1/node_modules/is-number/package.json"
        )
        .contains("\"6.0.0\"")
    );
}

#[test]
fn bunfig_selects_the_hoisted_linker_for_a_workspace() {
    let builder = workspace();
    builder
        .write(
            format!("{ROOT}/bunfig.toml"),
            b"[install]\nlinker = \"hoisted\"\n",
        )
        .unwrap();
    let report = install(&builder, ROOT, &registry(), &BunOptions::default()).unwrap();
    assert_eq!(report.linker, Linker::Hoisted);
    assert_eq!(
        layout(&builder),
        recorded(fixture!("workspace/layout-hoisted.txt"))
    );
}

#[test]
fn a_lockfile_from_before_the_isolated_default_stays_hoisted() {
    let builder = workspace();
    let lock = fixture!("workspace/bun.lock").replace("\"configVersion\": 1,", "");
    builder
        .write(format!("{ROOT}/bun.lock"), lock.as_bytes())
        .unwrap();
    let report = install(&builder, ROOT, &registry(), &BunOptions::default()).unwrap();
    assert_eq!(report.linker, Linker::Hoisted);
}

#[test]
fn peers_get_a_directory_per_set_named_as_bun_names_it() {
    let builder = peers();
    install(&builder, ROOT, &AnyRegistry::new(), &BunOptions::default()).unwrap();
    assert_eq!(
        layout(&builder),
        recorded(fixture!("peers/layout-isolated.txt"))
    );
}

#[test]
fn every_kind_of_dependency_lands_where_bun_puts_it() {
    let builder = features(fixture!("features/bun.lock"));
    let fetcher = AnyRegistry::new();
    let report = install(&builder, ROOT, &fetcher, &darwin()).unwrap();
    assert_eq!(
        layout(&builder),
        recorded(fixture!("features/layout-isolated.txt"))
    );
    // The patch `bun patch` wrote is applied to the real tarball.
    assert_eq!(report.patched, ["is-odd@3.0.1"]);
    assert!(
        read(
            &builder,
            "node_modules/.bun/is-odd@3.0.1/node_modules/is-odd/index.js"
        )
        .ends_with("module.exports.patched = true;\n")
    );
    // A GitHub dependency is the archive whose hash the lockfile holds,
    // and a tarball dependency its own URL.
    let requests = fetcher.requests.lock().unwrap().clone();
    assert!(
        requests.contains(
            &"https://codeload.github.com/lukeed/kleur/legacy.tar.gz/6c7ac76".to_string()
        )
    );
    assert!(requests.contains(&"https://registry.npmjs.org/ms/-/ms-2.1.2.tgz".to_string()));
    // 24 of esbuild's 25 platform packages are for other machines.
    assert_eq!(report.skipped_optional.len(), 24);
    assert_eq!(report.warnings.len(), 1);
    assert!(report.warnings[0].starts_with("esbuild@0.25.0 is in trustedDependencies"));
}

#[test]
fn the_isolate_skips_every_native_optional_dependency() {
    let builder = features(fixture!("features/bun.lock"));
    let report = install(&builder, ROOT, &AnyRegistry::new(), &BunOptions::default()).unwrap();
    assert_eq!(report.skipped_optional.len(), 26);
    assert!(
        report
            .skipped_optional
            .contains(&"fsevents@2.3.3".to_string())
    );
    assert!(
        report
            .skipped_optional
            .contains(&"@esbuild/linux-loong64@0.25.0".to_string())
    );
    assert!(!builder.is_dir(format!("{ROOT}/node_modules/.bun/fsevents@2.3.3")));
    assert!(builder.is_dir(format!("{ROOT}/node_modules/.bun/esbuild@0.25.0")));
}

#[test]
fn a_wasm_build_bun_has_no_cpu_name_for_is_installed() {
    let lock = r#"{
  "lockfileVersion": 1,
  "configVersion": 1,
  "workspaces": {
    "": { "name": "w", "optionalDependencies": { "@rolldown/binding-wasm32-wasi": "1.0.0", "@rolldown/binding-linux-x64-gnu": "1.0.0" } },
  },
  "packages": {
    "@rolldown/binding-linux-x64-gnu": ["@rolldown/binding-linux-x64-gnu@1.0.0", "", { "os": "linux", "cpu": "x64", "libc": "glibc" }, "sha512-AA=="],
    "@rolldown/binding-wasm32-wasi": ["@rolldown/binding-wasm32-wasi@1.0.0", "", { "cpu": "none" }, "sha512-AA=="],
  }
}"#;
    let builder = project(&[("bun.lock", lock)]);
    let report = install(&builder, ROOT, &AnyRegistry::new(), &BunOptions::default()).unwrap();
    assert_eq!(
        report.skipped_optional,
        ["@rolldown/binding-linux-x64-gnu@1.0.0"]
    );
    assert!(builder.is_file(format!(
        "{ROOT}/node_modules/@rolldown/binding-wasm32-wasi/package.json"
    )));
}

#[test]
fn hoisting_follows_bunfig() {
    let builder = workspace();
    builder
        .write(
            format!("{ROOT}/bunfig.toml"),
            b"[install]\nhoist = false\npublicHoistPattern = [\"is-o*\"]\n",
        )
        .unwrap();
    let report = install(&builder, ROOT, &registry(), &BunOptions::default()).unwrap();
    let layout = layout(&builder);
    assert!(
        !layout
            .iter()
            .any(|line| line.contains(".bun/node_modules/"))
    );
    assert!(layout.contains("L node_modules/is-odd -> .bun/is-odd@3.0.1/node_modules/is-odd"));
    assert_eq!(report.hoisted, 1);
}

#[test]
fn a_tampered_tarball_fails_the_install() {
    let builder = single();
    let fetcher = registry();
    let mut bytes = TARBALLS[2].1.to_vec();
    let last = bytes.len() - 1;
    bytes[last] ^= 1;
    fetcher.insert(TARBALLS[2].0, bytes);
    let error = install(&builder, ROOT, &fetcher, &BunOptions::default()).unwrap_err();
    assert!(
        matches!(&error, BunError::Fetch { package, source: FetchError::IntegrityMismatch { .. } } if package == "is-odd@3.0.1"),
        "{error}"
    );
}

#[test]
fn a_tampered_integrity_fails_the_install() {
    let builder = single();
    let lock = fixture!("single/bun.lock").replace("sha512-6FlzubTL", "sha512-7FlzubTL");
    assert_ne!(lock, fixture!("single/bun.lock"));
    builder
        .write(format!("{ROOT}/bun.lock"), lock.as_bytes())
        .unwrap();
    let error = install(&builder, ROOT, &registry(), &BunOptions::default()).unwrap_err();
    assert!(
        matches!(&error, BunError::Fetch { package, source: FetchError::IntegrityMismatch { .. } } if package == "ms@2.1.3"),
        "{error}"
    );
}

/// `lock` without the entry of `packages` whose key is `key`.
fn without_entry(lock: &str, key: &str) -> String {
    let start = format!("    \"{key}\": [");
    let kept: Vec<&str> = lock
        .lines()
        .filter(|line| !line.starts_with(&start))
        .collect();
    assert_eq!(kept.len() + 1, lock.lines().count(), "{key} is one line");
    kept.join("\n")
}

#[test]
fn a_dependency_the_lockfile_has_no_entry_for_fails_the_install() {
    // A project's own dependency.
    let builder = single();
    let lock = without_entry(fixture!("single/bun.lock"), "ms");
    builder
        .write(format!("{ROOT}/bun.lock"), lock.as_bytes())
        .unwrap();
    let error = install(&builder, ROOT, &registry(), &BunOptions::default()).unwrap_err();
    assert_eq!(
        error.to_string(),
        "/app/bun.lock: the root depends on ms, which has no entry under packages; run bun install and commit bun.lock"
    );

    // A package's, in both layouts.
    for build in [single, workspace] {
        let builder = build();
        let lock = read(&builder, "bun.lock");
        let lock = without_entry(&without_entry(&lock, "is-number"), "is-odd/is-number");
        let lock = lock.replace("\"is-number\": \"7.0.0\",", "");
        builder
            .write(format!("{ROOT}/bun.lock"), lock.as_bytes())
            .unwrap();
        let error = install(&builder, ROOT, &registry(), &BunOptions::default()).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("is-odd@3.0.1 depends on is-number, which has no entry under packages"),
            "{error}"
        );
        assert!(!builder.is_dir(format!("{ROOT}/node_modules")));
    }
}

#[test]
fn a_binary_lockfile_alone_is_refused_with_the_way_out() {
    let builder = project(&[("package.json", fixture!("single/package.json"))]);
    builder
        .write(
            format!("{ROOT}/bun.lockb"),
            b"#!/usr/bin/env bun\nbun-lockfile-format-v0\n",
        )
        .unwrap();
    let error = install(&builder, ROOT, &registry(), &BunOptions::default()).unwrap_err();
    let message = error.to_string();
    assert!(
        message.starts_with("/app/bun.lock: not found, and bun.lockb is"),
        "{message}"
    );
    assert!(message.contains("bun install --save-text-lockfile --frozen-lockfile --lockfile-only"));

    let builder = project(&[("package.json", fixture!("single/package.json"))]);
    let error = install(&builder, ROOT, &registry(), &BunOptions::default()).unwrap_err();
    assert_eq!(error.to_string(), "/app/bun.lock: not found");
}

#[test]
fn what_cannot_be_verified_is_refused() {
    let refused = |lock: String| -> String {
        let builder = features(&lock);
        install(&builder, ROOT, &AnyRegistry::new(), &darwin())
            .unwrap_err()
            .to_string()
    };
    let lock = fixture!("features/bun.lock");

    // A git repository that is not on GitHub.
    let git = lock.replace(
        "[\"kleur@github:lukeed/kleur#6c7ac76\", {}, \"lukeed-kleur-6c7ac76\", ",
        "[\"kleur@git+https://example.com/kleur.git#6c7ac76\", {}, \"6c7ac76\", ",
    );
    assert_ne!(git, lock);
    assert!(
        refused(git).starts_with(
            "kleur@git+https://example.com/kleur.git#6c7ac76: git dependencies (git+https://example.com/kleur.git#6c7ac76) are not supported"
        )
    );

    // A directory copied in.
    let folder = lock.replace(
        "[\"linked@link:./vendor/linked\", {}]",
        "[\"linked@file:vendor/linked\", {}]",
    );
    assert_ne!(folder, lock);
    assert!(refused(folder).starts_with(
        "linked@file:vendor/linked: directory dependencies (file:vendor/linked) are not supported"
    ));

    // A GitHub archive, a tarball and a registry package with no hash.
    let entry = |key: &str| -> &str {
        let start = format!("    \"{key}\": [");
        lock.lines().find(|line| line.starts_with(&start)).unwrap()
    };
    for key in ["kleur", "ms", "react"] {
        let line = entry(key);
        let hash = line.rfind(", \"sha512-").unwrap();
        let bare = if key == "react" {
            format!("{}, \"\"],", &line[..hash])
        } else {
            format!("{}],", &line[..hash])
        };
        let message = refused(lock.replace(line, &bare));
        assert!(
            message.contains("bun.lock has no integrity for it, so it cannot be verified"),
            "{key}: {message}"
        );
    }
}

#[test]
fn a_newer_lockfile_version_is_refused() {
    let builder = single();
    let lock =
        fixture!("single/bun.lock").replace("\"lockfileVersion\": 2", "\"lockfileVersion\": 4");
    builder
        .write(format!("{ROOT}/bun.lock"), lock.as_bytes())
        .unwrap();
    let error = install(&builder, ROOT, &registry(), &BunOptions::default()).unwrap_err();
    assert_eq!(
        error.to_string(),
        "/app/bun.lock: lockfileVersion 4 is newer than this runner reads (up to 3)"
    );
}

#[test]
fn a_registry_from_bunfig_serves_what_the_lockfile_leaves_to_it() {
    let builder = single();
    builder
        .write(
            format!("{ROOT}/bunfig.toml"),
            b"[install]\nregistry = { url = \"https://npm.example.com/\" }\n",
        )
        .unwrap();
    let fetcher = MemoryFetcher::new();
    for (url, bytes) in TARBALLS {
        fetcher.insert(
            url.replace("https://registry.npmjs.org", "https://npm.example.com"),
            bytes,
        );
    }
    install(&builder, ROOT, &fetcher, &BunOptions::default()).unwrap();
    assert!(builder.is_file(format!("{ROOT}/node_modules/ms/package.json")));
}

#[test]
fn an_install_in_a_layer_records_what_it_read() {
    let base = workspace();
    let layer = base.layer();
    install(&layer, ROOT, &registry(), &BunOptions::default()).unwrap();
    let reads: Vec<String> = layer
        .reads()
        .iter()
        .map(|input| input.path().display().to_string())
        .collect();
    // The lockfile, and the settings file that is not there: adding one
    // must not reuse this install.
    assert!(reads.contains(&"/app/bun.lock".to_string()), "{reads:?}");
    assert!(reads.contains(&"/app/bunfig.toml".to_string()), "{reads:?}");
    assert!(layer.is_dir(format!("{ROOT}/node_modules/.bun")));
    assert!(!base.is_dir(format!("{ROOT}/node_modules")));
}

#[test]
fn a_long_dependency_chain_does_not_run_out_of_stack() {
    // 5,000 packages, each depending on the next and on a shared peer.
    const LENGTH: usize = 5_000;
    let mut packages = String::new();
    for index in 0..LENGTH {
        let next = if index + 1 < LENGTH {
            format!("\"dependencies\": {{ \"p{}\": \"1.0.0\" }}, ", index + 1)
        } else {
            String::new()
        };
        packages.push_str(&format!(
            "    \"p{index}\": [\"p{index}@1.0.0\", \"\", {{ {next}\"peerDependencies\": {{ \"peer\": \"*\" }} }}, \"sha512-AA==\"],\n"
        ));
    }
    let lock = format!(
        r#"{{
  "lockfileVersion": 2,
  "configVersion": 1,
  "workspaces": {{
    "": {{ "name": "w", "dependencies": {{ "p0": "1.0.0", "peer": "1.0.0" }} }},
    "packages/a": {{ "name": "a" }},
  }},
  "packages": {{
    "a": ["a@workspace:packages/a"],
    "peer": ["peer@1.0.0", "", {{}}, "sha512-AA=="],
{packages}  }}
}}"#
    );
    let builder = project(&[("bun.lock", &lock)]);
    let options = BunOptions {
        parallelism: 4,
        ..BunOptions::default()
    };
    let report = std::thread::Builder::new()
        .stack_size(256 << 10)
        .spawn(move || install(&builder, ROOT, &AnyRegistry::new(), &options).unwrap())
        .unwrap()
        .join()
        .unwrap();
    assert_eq!(report.linker, Linker::Isolated);
    assert_eq!(report.packages, LENGTH + 1);
}
