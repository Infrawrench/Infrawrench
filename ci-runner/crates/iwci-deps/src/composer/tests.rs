use std::collections::HashMap;
use std::sync::Mutex;

use sha1::Digest;

use super::*;
use crate::archive::zip_of;
use crate::fetch::MemoryFetcher;

/// Git trees from a map, recording what was asked for.
#[derive(Default)]
struct FakeGit {
    trees: HashMap<(String, String), Vec<TreeFile>>,
    asked: Mutex<Vec<String>>,
}

impl GitTrees for FakeGit {
    fn files(&self, url: &str, commit: &str) -> std::result::Result<Vec<TreeFile>, String> {
        self.asked.lock().unwrap().push(format!("{url}@{commit}"));
        self.trees
            .get(&(url.to_string(), commit.to_string()))
            .cloned()
            .ok_or_else(|| "no such commit".to_string())
    }
}

fn file(path: &str, data: &str) -> TreeFile {
    TreeFile {
        path: path.into(),
        data: data.as_bytes().to_vec(),
        executable: false,
    }
}

const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

struct Fixture {
    builder: SnapshotBuilder,
    fetcher: MemoryFetcher,
    git: FakeGit,
    dist: Vec<u8>,
}

fn fixture() -> Fixture {
    let dist = zip_of(&[
        (
            "acme-dist-1a2b/src/Dist.php",
            b"<?php\nnamespace Acme\\Dist;\nclass Dist {}\n",
        ),
        (
            "acme-dist-1a2b/bin/tool",
            b"#!/usr/bin/env php\n<?php\necho 'tool';\n",
        ),
        ("acme-dist-1a2b/composer.json", b"{}"),
    ]);
    let fetcher = MemoryFetcher::new();
    fetcher.insert("https://dist.example/acme-dist.zip", dist.clone());
    let mut git = FakeGit::default();
    git.trees.insert(
        ("https://github.com/acme/git.git".into(), COMMIT.into()),
        vec![
            file(
                ".gitattributes",
                "/tests export-ignore\n*.md export-ignore\n",
            ),
            file("README.md", "# readme"),
            file(
                "src/Git.php",
                "<?php\nnamespace Acme\\Git;\nfinal class Thing {}\ninterface Shape {}\n",
            ),
            file("src/Fixtures/Skipped.php", "<?php\nclass Skipped {}\n"),
            file("tests/GitTest.php", "<?php\nclass GitTest {}\n"),
            file("functions.php", "<?php\nfunction acme_git() {}\n"),
            TreeFile {
                path: "run.sh".into(),
                data: b"#!/bin/sh\necho run\n".to_vec(),
                executable: true,
            },
        ],
    );
    let lock = serde_json::json!({
        "content-hash": "aabbccddeeff00112233445566778899",
        "packages": [
            {
                "name": "acme/dist",
                "version": "v1.2.0",
                "dist": {
                    "type": "zip",
                    "url": "https://dist.example/acme-dist.zip",
                    "reference": "1a2b",
                    "shasum": hex::encode(sha1::Sha1::digest(&dist)),
                },
                "require": { "php": ">=8.1", "acme/meta": "^1" },
                "autoload": { "psr-4": { "Acme\\Dist\\": "src/" } },
                "bin": ["bin/tool"],
                "replace": { "acme/old-dist": "self.version" },
                "type": "library",
            },
            {
                "name": "acme/meta",
                "version": "1.0.0",
                "type": "metapackage",
            },
        ],
        "packages-dev": [
            {
                "name": "acme/git",
                "version": "2.0.0-beta1",
                "source": {
                    "type": "git",
                    "url": "https://github.com/acme/git.git",
                    "reference": COMMIT,
                },
                "dist": {
                    "type": "zip",
                    "url": "https://api.github.com/repos/acme/git/zipball/0123",
                    "reference": COMMIT,
                    "shasum": "",
                },
                "autoload": {
                    "classmap": ["src/"],
                    "files": ["functions.php"],
                    "exclude-from-classmap": ["src/Fixtures/"],
                },
                "bin": ["run.sh", "../escape", "missing"],
            },
        ],
    });
    let root = serde_json::json!({
        "name": "app/x",
        "require": { "acme/dist": "^1.2" },
        "require-dev": { "acme/git": "^2" },
        "autoload": { "psr-4": { "App\\": "src/" } },
        "autoload-dev": { "classmap": ["tests/"], "psr-4": { "App\\": "lib/" } },
    });
    let builder = SnapshotBuilder::new();
    builder
        .write("/app/composer.lock", lock.to_string().as_bytes())
        .unwrap();
    builder
        .write("/app/composer.json", root.to_string().as_bytes())
        .unwrap();
    builder
        .write(
            "/app/src/Greeter.php",
            b"<?php\nnamespace App;\nclass Greeter {}\n",
        )
        .unwrap();
    builder
        .write("/app/tests/Legacy.php", b"<?php\nclass Legacy {}\n")
        .unwrap();
    Fixture {
        builder,
        fetcher,
        git,
        dist,
    }
}

fn text(builder: &SnapshotBuilder, path: &str) -> String {
    String::from_utf8(builder.read(path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}

#[test]
fn installs_a_lock_as_composer_lays_it_out() {
    let f = fixture();
    let report = install(
        &f.builder,
        "/app",
        &f.fetcher,
        &f.git,
        &ComposerOptions::default(),
    )
    .unwrap();
    let verified: Vec<(&str, Verified)> = report
        .installed
        .iter()
        .map(|p| (p.name.as_str(), p.verified))
        .collect();
    assert_eq!(
        verified,
        [
            ("acme/dist", Verified::DistSha1),
            ("acme/git", Verified::GitCommit),
            ("acme/meta", Verified::Nothing)
        ]
    );
    assert_eq!(f.git.asked.lock().unwrap().len(), 1);
    // The dist's top directory is moved up; the git tree loses what
    // export-ignore marks.
    let b = &f.builder;
    assert!(b.is_file("/app/vendor/acme/dist/src/Dist.php"));
    assert!(b.is_file("/app/vendor/acme/git/src/Git.php"));
    assert!(!b.is_file("/app/vendor/acme/git/tests/GitTest.php"));
    assert!(!b.is_file("/app/vendor/acme/git/README.md"));
    assert!(b.is_file("/app/vendor/acme/git/.gitattributes"));
    assert!(!b.is_dir("/app/vendor/acme/meta"));

    // vendor/bin: a PHP proxy for a PHP script, a shell one otherwise.
    let tool = text(b, "/app/vendor/bin/tool");
    assert!(tool.starts_with("#!/usr/bin/env php\n<?php\n"), "{tool}");
    assert!(
        tool.contains("$GLOBALS['_composer_autoload_path'] = __DIR__ . '/..'.'/autoload.php';"),
        "{tool}"
    );
    assert!(
        tool.ends_with("return include __DIR__ . '/..'.'/acme/dist/bin/tool';\n"),
        "{tool}"
    );
    assert!(tool.contains("final class BinProxyWrapper"), "{tool}");
    let run = text(b, "/app/vendor/bin/run.sh");
    assert!(run.starts_with("#!/usr/bin/env sh\n"), "{run}");
    assert!(run.contains("cd '../acme/git' && pwd"), "{run}");
    assert!(run.contains("exec \"${dir}/\"'run.sh' \"$@\""), "{run}");
    assert!(!b.is_file("/app/vendor/bin/escape"));
    assert_eq!(report.warnings.len(), 2, "{:?}", report.warnings);

    // What Composer reads back.
    let installed: Value =
        serde_json::from_str(&text(b, "/app/vendor/composer/installed.json")).unwrap();
    assert_eq!(installed["dev"], true);
    assert_eq!(
        installed["dev-package-names"],
        serde_json::json!(["acme/git"])
    );
    let packages = installed["packages"].as_array().unwrap();
    assert_eq!(packages[0]["name"], "acme/dist");
    assert_eq!(packages[0]["install-path"], "../acme/dist");
    assert_eq!(packages[0]["installation-source"], "dist");
    assert_eq!(packages[1]["installation-source"], "dist");
    assert_eq!(packages[2]["install-path"], Value::Null);
    let php = text(b, "/app/vendor/composer/installed.php");
    assert!(
        php.starts_with("<?php return array(\n    'root' => array(\n        'name' => 'app/x',"),
        "{php}"
    );
    assert!(
        php.contains("'install_path' => __DIR__ . '/../../',"),
        "{php}"
    );
    assert!(php.contains("        'acme/dist' => array(\n            'pretty_version' => 'v1.2.0',\n            'version' => '1.2.0.0',\n            'reference' => '1a2b',"), "{php}");
    assert!(php.contains("'version' => '2.0.0.0-beta1',"), "{php}");
    assert!(
        php.contains("'install_path' => __DIR__ . '/../acme/git',"),
        "{php}"
    );
    assert!(
        php.contains("'acme/meta' => array(") && php.contains("'install_path' => NULL,"),
        "{php}"
    );
    assert!(php.contains("'acme/old-dist' => array(\n            'dev_requirement' => false,\n            'replaced' => array(\n                0 => 'v1.2.0',"), "{php}");
    assert!(b.is_file("/app/vendor/composer/ClassLoader.php"));
    assert!(b.is_file("/app/vendor/composer/InstalledVersions.php"));

    let snapshot = f.builder;
    let autoload = dump_autoload(&snapshot, "/app").unwrap();
    assert!(autoload.warnings.is_empty(), "{:?}", autoload.warnings);
    let psr4 = text(&snapshot, "/app/vendor/composer/autoload_psr4.php");
    assert!(
        psr4.contains("$vendorDir = dirname(__DIR__);\n$baseDir = dirname($vendorDir);\n"),
        "{psr4}"
    );
    assert!(
        psr4.contains("    'App\\\\' => array($baseDir . '/src', $baseDir . '/lib'),\n"),
        "{psr4}"
    );
    assert!(
        psr4.contains("    'Acme\\\\Dist\\\\' => array($vendorDir . '/acme/dist/src'),\n"),
        "{psr4}"
    );
    // krsort: `App\` before `Acme\Dist\`.
    assert!(
        psr4.find("'App").unwrap() < psr4.find("'Acme").unwrap(),
        "{psr4}"
    );
    let classmap = text(&snapshot, "/app/vendor/composer/autoload_classmap.php");
    assert!(
        classmap.contains("    'Acme\\\\Git\\\\Thing' => $vendorDir . '/acme/git/src/Git.php',\n"),
        "{classmap}"
    );
    assert!(
        classmap.contains("    'Acme\\\\Git\\\\Shape' => $vendorDir . '/acme/git/src/Git.php',\n"),
        "{classmap}"
    );
    assert!(
        classmap.contains("    'Legacy' => $baseDir . '/tests/Legacy.php',\n"),
        "{classmap}"
    );
    assert!(classmap.contains("    'Composer\\\\InstalledVersions' => $vendorDir . '/composer/InstalledVersions.php',\n"), "{classmap}");
    assert!(!classmap.contains("Skipped"), "{classmap}");
    assert_eq!(autoload.classes, 4);
    let files = text(&snapshot, "/app/vendor/composer/autoload_files.php");
    let id = hex::encode(md5::Md5::digest(b"acme/git:functions.php"));
    assert!(
        files.contains(&format!(
            "    '{id}' => $vendorDir . '/acme/git/functions.php',\n"
        )),
        "{files}"
    );
    let entry = text(&snapshot, "/app/vendor/autoload.php");
    assert!(
        entry.contains("require_once __DIR__ . '/composer/autoload_real.php';"),
        "{entry}"
    );
    assert!(
        entry.contains(
            "return ComposerAutoloaderInitaabbccddeeff00112233445566778899::getLoader();"
        ),
        "{entry}"
    );
    let real = text(&snapshot, "/app/vendor/composer/autoload_real.php");
    assert!(
        real.contains("$filesToLoad = require __DIR__ . '/autoload_files.php';"),
        "{real}"
    );

    let frozen = snapshot.freeze();
    assert_eq!(frozen.mode("/app/vendor/bin/tool"), Some(0o755));
    assert_eq!(frozen.mode("/app/vendor/acme/dist/bin/tool"), Some(0o755));
    assert_eq!(frozen.mode("/app/vendor/acme/git/run.sh"), Some(0o755));
}

#[test]
fn a_tampered_dist_is_refused() {
    let f = fixture();
    let mut tampered = f.dist.clone();
    let at = tampered.len() / 2;
    tampered[at] ^= 1;
    f.fetcher
        .insert("https://dist.example/acme-dist.zip", tampered);
    let err = install(
        &f.builder,
        "/app",
        &f.fetcher,
        &f.git,
        &ComposerOptions::default(),
    )
    .unwrap_err();
    assert!(
        matches!(
            err,
            ComposerError::Fetch(FetchError::IntegrityMismatch { .. })
        ),
        "{err}"
    );
    assert!(!f.builder.is_file("/app/vendor/composer/installed.json"));
}

#[test]
fn a_commit_that_cannot_be_fetched_fails() {
    let f = fixture();
    let err = install(
        &f.builder,
        "/app",
        &f.fetcher,
        &NoGit,
        &ComposerOptions::default(),
    )
    .unwrap_err()
    .to_string();
    assert!(
        err.starts_with("acme/git: https://github.com/acme/git.git at 0123"),
        "{err}"
    );
}

#[test]
fn refuses_what_it_cannot_verify() {
    let lock_with = |package: Value| {
        let builder = SnapshotBuilder::new();
        let lock = serde_json::json!({ "packages": [package] });
        builder
            .write("/app/composer.lock", lock.to_string().as_bytes())
            .unwrap();
        install(
            &builder,
            "/app",
            &MemoryFetcher::new(),
            &NoGit,
            &ComposerOptions::default(),
        )
        .unwrap_err()
        .to_string()
    };
    let unpinned = lock_with(serde_json::json!({
        "name": "a/b", "version": "1.0.0",
        "dist": { "type": "zip", "url": "https://x.example/b.zip", "shasum": "" },
    }));
    assert!(
        unpinned.contains("nothing to check it against"),
        "{unpinned}"
    );
    let branch = lock_with(serde_json::json!({
        "name": "a/b", "version": "dev-main",
        "source": { "type": "git", "url": "https://x.example/b.git", "reference": "main" },
    }));
    assert!(branch.contains("nothing to check it against"), "{branch}");
    let insecure = lock_with(serde_json::json!({
        "name": "a/b", "version": "1.0.0",
        "source": { "type": "git", "url": "git@github.com:a/b.git", "reference": COMMIT },
    }));
    assert!(insecure.contains("not an https git URL"), "{insecure}");
    let escape = lock_with(serde_json::json!({
        "name": "a/b", "version": "1.0.0",
        "dist": { "type": "path", "url": "../../etc" },
    }));
    assert!(escape.contains("not inside the repository"), "{escape}");
    let name = lock_with(serde_json::json!({ "name": "../../x", "version": "1" }));
    assert!(name.contains("is not a package name"), "{name}");
    let none = SnapshotBuilder::new();
    let missing = install(
        &none,
        "/app",
        &MemoryFetcher::new(),
        &NoGit,
        &ComposerOptions::default(),
    )
    .unwrap_err();
    assert!(matches!(missing, ComposerError::NoLockfile(_)), "{missing}");
}

#[test]
fn a_path_package_is_linked() {
    let builder = SnapshotBuilder::new();
    let lock = serde_json::json!({ "packages": [{
        "name": "local/lib", "version": "dev-main",
        "dist": { "type": "path", "url": "packages/lib", "reference": "x" },
        "autoload": { "psr-4": { "Local\\": "src/" } },
    }]});
    builder
        .write("/app/composer.lock", lock.to_string().as_bytes())
        .unwrap();
    builder
        .write(
            "/app/packages/lib/src/A.php",
            b"<?php namespace Local; class A {}",
        )
        .unwrap();
    let report = install(
        &builder,
        "/app",
        &MemoryFetcher::new(),
        &NoGit,
        &ComposerOptions::default(),
    )
    .unwrap();
    assert_eq!(report.installed[0].verified, Verified::Path);
    let link = builder.entries().into_iter().find_map(|e| match e {
        iwci_vfs::Entry::Symlink { path, target } if path == Path::new("/app/vendor/local/lib") => {
            Some(target)
        }
        _ => None,
    });
    assert_eq!(link, Some(PathBuf::from("../../packages/lib")));
    dump_autoload(&builder, "/app").unwrap();
    let psr4 = text(&builder, "/app/vendor/composer/autoload_psr4.php");
    assert!(
        psr4.contains("'Local\\\\' => array($vendorDir . '/local/lib/src')"),
        "{psr4}"
    );
}
