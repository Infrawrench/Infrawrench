use std::collections::HashMap;
use std::io::Write;
use std::sync::Mutex;

use flate2::Compression;
use flate2::write::GzEncoder;
use sha2::{Digest, Sha256};

use super::*;
use crate::fetch::MemoryFetcher;

const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

fn sha256(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn gzip(bytes: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(bytes).unwrap();
    encoder.finish().unwrap()
}

/// A tar of `files` (path, bytes, mode).
fn tar_of(files: &[(&str, &[u8], u32)]) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    for (name, bytes, mode) in files {
        let mut header = tar::Header::new_gnu();
        header.set_size(bytes.len() as u64);
        header.set_mode(*mode);
        header.set_cksum();
        builder.append_data(&mut header, name, *bytes).unwrap();
    }
    builder.into_inner().unwrap()
}

/// A tar with one raw entry, past the tar crate's own path checks, so it
/// can hold what an attacker would write.
fn raw_tar(name: &str, kind: tar::EntryType, link: Option<&str>) -> Vec<u8> {
    let mut builder = tar::Builder::new(Vec::new());
    let mut header = tar::Header::new_gnu();
    header.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name.as_bytes());
    header.set_entry_type(kind);
    header.set_mode(0o644);
    let body: &[u8] = if kind.is_file() { b"x" } else { b"" };
    header.set_size(body.len() as u64);
    if let Some(link) = link {
        header.as_gnu_mut().unwrap().linkname[..link.len()].copy_from_slice(link.as_bytes());
    }
    header.set_cksum();
    builder.append(&header, body).unwrap();
    builder.into_inner().unwrap()
}

/// A `.gem`: metadata.gz and data.tar.gz (from `data`, a tar) in a tar.
fn gem_of(metadata: &str, data: &[u8]) -> Vec<u8> {
    tar_of(&[
        ("metadata.gz", &gzip(metadata.as_bytes()), 0o444),
        ("data.tar.gz", &gzip(data), 0o444),
        ("checksums.yaml.gz", &gzip(b"--- {}\n"), 0o444),
    ])
}

/// Metadata for a small gem.
fn metadata(name: &str, version: &str, extra: &str) -> String {
    format!(
        "--- !ruby/object:Gem::Specification\n\
         name: {name}\n\
         version: !ruby/object:Gem::Version\n  version: {version}\n\
         platform: ruby\n\
         authors:\n- A\n\
         bindir: exe\n\
         date: 2025-01-01 00:00:00.000000000 Z\n\
         require_paths:\n- lib\n\
         rubygems_version: 3.6.2\n\
         specification_version: 4\n\
         summary: {name}\n\
         {extra}"
    )
}

fn dependency_yaml(name: &str) -> String {
    format!(
        "- !ruby/object:Gem::Dependency\n  name: {name}\n  requirement: !ruby/object:Gem::Requirement\n    requirements:\n    - - \">=\"\n      - !ruby/object:Gem::Version\n        version: '0'\n  type: :runtime\n  prerelease: false\n"
    )
}

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

/// Prebuilt extensions for the gems it names (`<name>-<version>`), for
/// every Ruby.
struct FakePrebuilt(HashMap<String, Vec<TreeFile>>);

impl PrebuiltExtensions for FakePrebuilt {
    fn key(&self) -> String {
        "fake".to_string()
    }

    fn files(
        &self,
        gem: &ExtensionRequest<'_>,
    ) -> std::result::Result<Option<Vec<TreeFile>>, String> {
        assert_eq!(gem.platform, "ruby");
        Ok(self
            .0
            .get(&format!("{}-{}", gem.name, gem.version))
            .cloned())
    }

    fn versions(&self, name: &str, _abi: &RubyAbi) -> std::result::Result<Vec<String>, String> {
        let mut versions: Vec<String> = self
            .0
            .keys()
            .filter_map(|k| k.strip_prefix(&format!("{name}-")).map(str::to_string))
            .collect();
        versions.sort();
        Ok(versions)
    }
}

/// What the fixture installs with: its `native` gem has no build, and the
/// pipeline says the job never loads it.
fn options() -> BundlerOptions {
    BundlerOptions {
        without_extensions: vec!["native".to_string()],
        ..BundlerOptions::default()
    }
}

struct Fixture {
    builder: SnapshotBuilder,
    fetcher: MemoryFetcher,
    git: FakeGit,
    gems: HashMap<&'static str, Vec<u8>>,
}

const ROOT: &str = "/app/vendor/bundle/ruby/4.0.0";

/// Three gems from rubygems.org (one with an executable, one with a
/// native extension, one depending on a gem the lock leaves out), a gem
/// from git and one from a path.
fn fixture() -> Fixture {
    let fetcher = MemoryFetcher::new();
    let mut gems = HashMap::new();
    let tool = gem_of(
        &metadata(
            "tool",
            "1.2.0",
            "executables:\n- tool\nfiles:\n- exe/tool\n- lib/tool.rb\n",
        ),
        &tar_of(&[
            ("lib/tool.rb", b"module Tool; end\n", 0o644),
            ("exe/tool", b"#!/usr/bin/env ruby\nrequire 'tool'\n", 0o755),
        ]),
    );
    let native = gem_of(
        &metadata("native", "0.3.1", "extensions:\n- ext/native/extconf.rb\n"),
        &tar_of(&[
            ("lib/native.rb", b"require 'native/native'\n", 0o644),
            ("ext/native/extconf.rb", b"require 'mkmf'\n", 0o644),
            ("ext/native/native.c", b"void Init_native(void) {}\n", 0o644),
        ]),
    );
    let needy = gem_of(
        &format!(
            "{}dependencies:\n{}",
            metadata("needy", "2.0", ""),
            dependency_yaml("absent")
        ),
        &tar_of(&[("lib/needy.rb", b"require 'absent'\n", 0o644)]),
    );
    for (name, bytes) in [
        ("tool-1.2.0", tool),
        ("native-0.3.1", native),
        ("needy-2.0", needy),
    ] {
        fetcher.insert(
            format!("https://rubygems.org/gems/{name}.gem"),
            bytes.clone(),
        );
        gems.insert(name, bytes);
    }
    let mut git = FakeGit::default();
    git.trees.insert(
        ("https://github.com/acme/fromgit.git".into(), COMMIT.into()),
        vec![
            TreeFile {
                path: "fromgit.gemspec".into(),
                data: b"Gem::Specification.new { |s| s.name = 'fromgit' }\n".to_vec(),
                executable: false,
            },
            TreeFile {
                path: "lib/fromgit.rb".into(),
                data: b"module FromGit; end\n".to_vec(),
                executable: false,
            },
        ],
    );
    let builder = SnapshotBuilder::new();
    builder
        .write("/app/Gemfile", b"source 'https://rubygems.org'\n")
        .unwrap();
    builder
        .write("/app/Gemfile.lock", lock(&gems).as_bytes())
        .unwrap();
    Fixture {
        builder,
        fetcher,
        git,
        gems,
    }
}

fn lock(gems: &HashMap<&str, Vec<u8>>) -> String {
    format!(
        "GIT\n  remote: https://github.com/acme/fromgit.git\n  revision: {COMMIT}\n  branch: main\n  specs:\n    fromgit (0.1.0)\n      tool\n\n\
         PATH\n  remote: .\n  specs:\n    local (0.0.1)\n      tool (~> 1.2)\n\n\
         GEM\n  remote: https://rubygems.org/\n  specs:\n    native (0.3.1)\n    native (0.3.1-x86_64-linux)\n    needy (2.0)\n      absent (>= 0)\n    tool (1.2.0)\n\n\
         PLATFORMS\n  ruby\n  x86_64-linux\n\n\
         DEPENDENCIES\n  fromgit!\n  local!\n  native\n  needy\n  tool (~> 1.2)\n\n\
         CHECKSUMS\n  fromgit (0.1.0)\n  local (0.0.1)\n  native (0.3.1) sha256={}\n  native (0.3.1-x86_64-linux) sha256={}\n  needy (2.0) sha256={}\n  tool (1.2.0) sha256={}\n\n\
         RUBY VERSION\n  ruby 4.0.0p0\n\n\
         BUNDLED WITH\n  4.0.3\n",
        sha256(&gems["native-0.3.1"]),
        "a".repeat(64),
        sha256(&gems["needy-2.0"]),
        sha256(&gems["tool-1.2.0"]),
    )
}

fn run(f: &Fixture) -> Result<BundlerReport> {
    install(
        &f.builder,
        "/app",
        &f.fetcher,
        &f.git,
        &NoPrebuilt,
        &options(),
    )
}

fn read(builder: &SnapshotBuilder, path: &str) -> String {
    String::from_utf8(builder.read(path).unwrap()).unwrap()
}

fn fixture_file(name: &str) -> String {
    std::fs::read_to_string(format!(
        "{}/src/bundler/fixtures/{name}",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

#[test]
fn lockfile_sections_are_read() {
    let gems = fixture().gems;
    let parsed = lockfile::parse(&lock(&gems)).unwrap();
    assert_eq!(parsed.platforms, ["ruby", "x86_64-linux"]);
    assert_eq!(parsed.ruby_version.as_deref(), Some("4.0.0p0"));
    assert_eq!(parsed.bundled_with.as_deref(), Some("4.0.3"));
    assert!(parsed.has_checksums);
    assert_eq!(
        parsed.checksums.get("tool (1.2.0)"),
        Some(&Some(sha256(&gems["tool-1.2.0"])))
    );
    assert_eq!(parsed.checksums.get("local (0.0.1)"), Some(&None));
    assert_eq!(parsed.sources.len(), 3);
    assert_eq!(
        parsed.sources[0].kind,
        lockfile::SourceKind::Git {
            remote: "https://github.com/acme/fromgit.git".into(),
            revision: COMMIT.into(),
            reference: Some("branch: main".into()),
            submodules: false,
        }
    );
    assert_eq!(parsed.sources[0].specs[0].dependencies, ["tool"]);
    assert_eq!(
        parsed.sources[1].kind,
        lockfile::SourceKind::Path { remote: ".".into() }
    );
    let gem = &parsed.sources[2];
    assert_eq!(
        gem.kind,
        lockfile::SourceKind::Gem {
            remotes: vec!["https://rubygems.org/".into()]
        }
    );
    let names: Vec<String> = gem.specs.iter().map(LockedSpec::full_name).collect();
    assert_eq!(
        names,
        [
            "native-0.3.1",
            "native-0.3.1-x86_64-linux",
            "needy-2.0",
            "tool-1.2.0",
        ]
    );
    assert_eq!(gem.specs[2].dependencies, ["absent"]);

    // The real Rails 8.1 lock's shape: CRLF endings are read the same.
    let crlf = lock(&gems).replace('\n', "\r\n");
    assert_eq!(lockfile::parse(&crlf).unwrap().sources.len(), 3);
    assert!(lockfile::parse("GEM\n  remote: x\n  specs:\n    bad (1.0\n").is_err());
    assert!(lockfile::parse("PLUGIN SOURCE\n  remote: x\n").is_err());
}

#[test]
fn installs_the_bundle_as_bundler_lays_it_out() {
    let f = fixture();
    let report = run(&f).unwrap();
    let b = &f.builder;
    assert_eq!(report.ruby, "4.0");
    let installed: Vec<(&str, Verified)> = report
        .installed
        .iter()
        .map(|g| (g.name.as_str(), g.verified))
        .collect();
    assert_eq!(
        installed,
        [
            ("fromgit", Verified::GitCommit),
            ("local", Verified::Path),
            ("native", Verified::Sha256),
            ("needy", Verified::Sha256),
            ("tool", Verified::Sha256),
        ]
    );

    // Gem files, with their modes.
    assert_eq!(
        read(b, &format!("{ROOT}/gems/tool-1.2.0/lib/tool.rb")),
        "module Tool; end\n"
    );

    // Specifications, written as RubyGems writes them.
    let spec = read(b, &format!("{ROOT}/specifications/tool-1.2.0.gemspec"));
    assert!(spec.starts_with("# -*- encoding: utf-8 -*-\n# stub: tool 1.2.0 ruby lib\n"));
    assert!(spec.contains("  s.executables = [\"tool\".freeze]\n"));
    assert!(spec.contains("  s.installed_by_version = \"4.0.20\".freeze\n"));

    // A wrapper for the executable.
    let stub = read(b, &format!("{ROOT}/bin/tool"));
    assert!(stub.starts_with("#!/usr/bin/env ruby\n"));
    assert!(stub.contains("Gem.activate_and_load_bin_path('tool', 'tool', version)"));

    // A native extension with no build that `without-extensions` names:
    // installed, marked built, reported.
    assert!(b.is_file(format!("{ROOT}/gems/native-0.3.1/ext/native/native.c")));
    assert!(b.is_file(format!(
        "{ROOT}/extensions/wasm32-wasi/4.0.0-static/native-0.3.1/gem.build_complete"
    )));
    assert_eq!(report.missing_extensions, ["native-0.3.1"]);
    assert!(
        report.warnings.iter().any(|w| w.contains(
            "native-0.3.1 is installed without its native extension (ext/native/extconf.rb)"
        ) && w.contains("LoadError")),
        "{:?}",
        report.warnings
    );

    // The git source, where Bundler checks it out.
    assert_eq!(
        read(
            b,
            &format!("{ROOT}/bundler/gems/fromgit-0123456789ab/lib/fromgit.rb")
        ),
        "module FromGit; end\n"
    );
    assert_eq!(
        *f.git.asked.lock().unwrap(),
        [format!("https://github.com/acme/fromgit.git@{COMMIT}")]
    );

    // Only the `ruby` builds were fetched, and a dependency the lock lacks
    // is a warning.
    let mut requests = f.fetcher.requests();
    requests.sort();
    assert_eq!(
        requests,
        [
            "https://rubygems.org/gems/native-0.3.1.gem",
            "https://rubygems.org/gems/needy-2.0.gem",
            "https://rubygems.org/gems/tool-1.2.0.gem",
        ]
    );
    assert!(
        report
            .warnings
            .iter()
            .any(|w| w.contains("needy depends on absent")),
        "{:?}",
        report.warnings
    );
    assert!(!b.is_file("/app/.bundle/config"));

    // The executable and its wrapper are executable.
    let Fixture { builder, .. } = f;
    let snapshot = builder.freeze();
    for path in [
        format!("{ROOT}/gems/tool-1.2.0/exe/tool"),
        format!("{ROOT}/bin/tool"),
    ] {
        assert_eq!(snapshot.mode(&path).unwrap_or(0) & 0o111, 0o111, "{path}");
    }
    assert_eq!(
        snapshot.mode(format!("{ROOT}/gems/tool-1.2.0/lib/tool.rb")),
        None
    );
}

#[test]
fn a_prebuilt_extension_goes_in_the_extension_directory() {
    let f = fixture();
    let prebuilt = FakePrebuilt(HashMap::from([(
        "native-0.3.1".to_string(),
        vec![TreeFile {
            path: "native/native.so".into(),
            data: b"\0asm".to_vec(),
            executable: false,
        }],
    )]));
    let report = install(
        &f.builder,
        "/app",
        &f.fetcher,
        &f.git,
        &prebuilt,
        &BundlerOptions::default(),
    )
    .unwrap();
    let dir = format!("{ROOT}/extensions/wasm32-wasi/4.0.0-static/native-0.3.1");
    assert_eq!(
        f.builder.read(format!("{dir}/native/native.so")).unwrap(),
        b"\0asm"
    );
    assert!(f.builder.is_file(format!("{dir}/gem.build_complete")));
    assert!(report.missing_extensions.is_empty());
    assert!(
        report.warnings.iter().all(|w| !w.contains("native")),
        "{:?}",
        report.warnings
    );
}

#[test]
fn a_gem_with_no_build_fails_naming_the_versions_there_are() {
    let f = fixture();
    let so = || {
        vec![TreeFile {
            path: "native/native.so".into(),
            data: b"\0asm".to_vec(),
            executable: false,
        }]
    };
    let prebuilt = FakePrebuilt(HashMap::from([
        ("native-0.3.2".to_string(), so()),
        ("native-0.2.0".to_string(), so()),
        ("other-1.0".to_string(), so()),
    ]));
    let err = install(
        &f.builder,
        "/app",
        &f.fetcher,
        &f.git,
        &prebuilt,
        &BundlerOptions::default(),
    )
    .unwrap_err()
    .to_string();
    assert!(
        err.starts_with("native-0.3.1: has a native extension (ext/native/extconf.rb)"),
        "{err}"
    );
    assert!(
        err.contains("there are builds for Ruby 4.0 of native 0.2.0, 0.3.2; lock one of those"),
        "{err}"
    );
    assert!(err.contains("`without-extensions`"), "{err}");

    // With none at all, it says so.
    let err = install(
        &f.builder,
        "/app",
        &f.fetcher,
        &f.git,
        &NoPrebuilt,
        &BundlerOptions::default(),
    )
    .unwrap_err()
    .to_string();
    assert!(
        err.contains("there is no build of any version of native for Ruby 4.0"),
        "{err}"
    );
}

#[test]
fn without_extensions_names_that_do_not_apply_are_warnings() {
    let f = fixture();
    let prebuilt = FakePrebuilt(HashMap::from([(
        "native-0.3.1".to_string(),
        vec![TreeFile {
            path: "native/native.so".into(),
            data: b"\0asm".to_vec(),
            executable: false,
        }],
    )]));
    let report = install(
        &f.builder,
        "/app",
        &f.fetcher,
        &f.git,
        &prebuilt,
        &BundlerOptions {
            without_extensions: vec!["native".into(), "tool".into(), "absent".into()],
            ..BundlerOptions::default()
        },
    )
    .unwrap();
    // The build there is wins.
    assert!(report.missing_extensions.is_empty());
    let warned = |what: &str| report.warnings.iter().any(|w| w.contains(what));
    assert!(
        warned("names native, and there is a build of native-0.3.1"),
        "{:?}",
        report.warnings
    );
    assert!(
        warned("names tool, which has no native extension"),
        "{:?}",
        report.warnings
    );
    assert!(
        warned("names absent, which the lock does not install"),
        "{:?}",
        report.warnings
    );
}

#[test]
fn a_gem_that_does_not_match_its_checksum_is_refused() {
    let f = fixture();
    f.fetcher.insert(
        "https://rubygems.org/gems/tool-1.2.0.gem",
        f.gems["native-0.3.1"].clone(),
    );
    let err = run(&f).unwrap_err();
    assert!(
        matches!(
            err,
            BundlerError::Fetch(FetchError::IntegrityMismatch { .. })
        ),
        "{err}"
    );
    assert!(
        !f.builder
            .is_file(format!("{ROOT}/gems/tool-1.2.0/lib/tool.rb"))
    );
}

#[test]
fn a_lock_without_checksums_says_how_to_add_them() {
    let f = fixture();
    let text = read(&f.builder, "/app/Gemfile.lock");
    let without_tool = text.replace(
        &format!("  tool (1.2.0) sha256={}\n", sha256(&f.gems["tool-1.2.0"])),
        "",
    );
    f.builder
        .write("/app/Gemfile.lock", without_tool.as_bytes())
        .unwrap();
    let err = run(&f).unwrap_err().to_string();
    assert!(err.contains("no sha256 for tool (1.2.0)"), "{err}");
    assert!(err.contains("bundle lock --add-checksums"), "{err}");

    let start = text.find("CHECKSUMS").unwrap();
    let end = text.find("RUBY VERSION").unwrap();
    let no_section = format!("{}{}", &text[..start], &text[end..]);
    f.builder
        .write("/app/Gemfile.lock", no_section.as_bytes())
        .unwrap();
    let err = run(&f).unwrap_err().to_string();
    assert!(err.contains("there is no CHECKSUMS section"), "{err}");
    assert!(f.fetcher.requests().is_empty());
}

#[test]
fn a_lock_without_the_ruby_platform_says_how_to_add_it() {
    let f = fixture();
    let text = read(&f.builder, "/app/Gemfile.lock").replace("PLATFORMS\n  ruby\n", "PLATFORMS\n");
    f.builder
        .write("/app/Gemfile.lock", text.as_bytes())
        .unwrap();
    let err = run(&f).unwrap_err().to_string();
    assert!(
        err.contains("PLATFORMS lists x86_64-linux, not `ruby`"),
        "{err}"
    );
    assert!(err.contains("bundle lock --add-platform ruby"), "{err}");
}

#[test]
fn a_gem_with_no_ruby_build_says_how_to_relock() {
    let f = fixture();
    let text = read(&f.builder, "/app/Gemfile.lock").replace("    native (0.3.1)\n", "");
    f.builder
        .write("/app/Gemfile.lock", text.as_bytes())
        .unwrap();
    let err = run(&f).unwrap_err().to_string();
    assert!(
        err.contains("no `ruby` build of native (x86_64-linux)"),
        "{err}"
    );
    assert!(err.contains("bundle lock --remove-platform ruby"), "{err}");
    assert!(f.fetcher.requests().is_empty());
}

/// The lock `rails new` writes (Rails 8.1.4.1, Bundler 4.0.3) once
/// `bundle lock --add-platform ruby` has added the `ruby` builds: every gem
/// is planned from its `ruby` build with its checksum, and nothing is
/// missing. Before that, it is refused with the command to run.
#[test]
fn a_rails_lock_plans_its_ruby_builds() {
    let text = fixture_file("rails-8.1.lock");
    let lock = lockfile::parse(&text).unwrap();
    let abi = ruby_abi("4.0").unwrap();
    let plan = plan(&lock, abi).unwrap();
    assert_eq!(plan.gems.len(), 123);
    assert!(plan.warnings.is_empty(), "{:?}", plan.warnings);
    for name in [
        "nokogiri",
        "sqlite3",
        "ffi",
        "prism",
        "mini_portile2",
        "rails",
    ] {
        let job = plan.gems.iter().find(|g| g.spec.name == name).unwrap();
        assert_eq!(job.spec.platform, "ruby", "{name}");
        assert_eq!(job.sha256.len(), 64, "{name}");
    }

    let without_ruby = text.replace("  ruby\n  x86_64-linux\n", "  x86_64-linux\n");
    let err = plan_of(&without_ruby).unwrap_err();
    assert!(err.contains("bundle lock --add-platform ruby"), "{err}");
    let without_nokogiri = text.replace("    nokogiri (1.19.7)\n", "    nokogiri-gone (1.19.7)\n");
    let err = plan_of(&without_nokogiri).unwrap_err();
    assert!(err.contains("no `ruby` build of nokogiri ("), "{err}");
}

fn plan_of(text: &str) -> std::result::Result<Plan, String> {
    plan(&lockfile::parse(text).unwrap(), ruby_abi("4.0").unwrap())
}

#[test]
fn metadata_must_name_the_gem_the_lock_names() {
    let f = fixture();
    let impostor = gem_of(
        &metadata("other", "1.2.0", ""),
        &tar_of(&[("lib/other.rb", b"", 0o644)]),
    );
    f.fetcher
        .insert("https://rubygems.org/gems/tool-1.2.0.gem", impostor.clone());
    let text = read(&f.builder, "/app/Gemfile.lock")
        .replace(&sha256(&f.gems["tool-1.2.0"]), &sha256(&impostor));
    f.builder
        .write("/app/Gemfile.lock", text.as_bytes())
        .unwrap();
    let err = run(&f).unwrap_err().to_string();
    assert!(err.contains("says it is other-1.2.0"), "{err}");
}

/// Swaps tool's gem for one whose data.tar.gz is `data`, keeping the lock
/// in step, and returns the install's error.
fn install_with_data(data: &[u8], options: &BundlerOptions) -> String {
    let f = fixture();
    let gem = gem_of(&metadata("tool", "1.2.0", ""), data);
    f.fetcher
        .insert("https://rubygems.org/gems/tool-1.2.0.gem", gem.clone());
    let text = read(&f.builder, "/app/Gemfile.lock")
        .replace(&sha256(&f.gems["tool-1.2.0"]), &sha256(&gem));
    f.builder
        .write("/app/Gemfile.lock", text.as_bytes())
        .unwrap();
    let mut options = options.clone();
    options.without_extensions.push("native".to_string());
    install(
        &f.builder,
        "/app",
        &f.fetcher,
        &f.git,
        &NoPrebuilt,
        &options,
    )
    .unwrap_err()
    .to_string()
}

#[test]
fn archives_cannot_write_outside_the_gem() {
    let defaults = BundlerOptions::default();
    for (name, kind, link) in [
        ("../evil.rb", tar::EntryType::Regular, None),
        ("lib/../../evil.rb", tar::EntryType::Regular, None),
        ("/etc/passwd", tar::EntryType::Regular, None),
        ("lib/link", tar::EntryType::Symlink, Some("../../outside")),
        ("lib/abs", tar::EntryType::Symlink, Some("/etc/passwd")),
    ] {
        let err = install_with_data(&raw_tar(name, kind, link), &defaults);
        assert!(err.contains("data.tar.gz"), "{name}: {err}");
    }

    // Nothing is written through a link.
    let through = {
        let mut t = raw_tar("dir", tar::EntryType::Symlink, Some("lib"));
        t.truncate(t.len() - 1024);
        t.extend(raw_tar("dir/x.rb", tar::EntryType::Regular, None));
        t
    };
    let err = install_with_data(&through, &defaults);
    assert!(err.contains("inside or over a symbolic link"), "{err}");

    let many = tar_of(&[("a", b"1", 0o644), ("b", b"2", 0o644), ("c", b"3", 0o644)]);
    let small = BundlerOptions {
        max_files_per_gem: 2,
        ..BundlerOptions::default()
    };
    assert!(install_with_data(&many, &small).contains("more than 2 entries"));
    let tiny = BundlerOptions {
        max_unpacked_bytes: 2,
        ..BundlerOptions::default()
    };
    assert!(install_with_data(&many, &tiny).contains("over 2 bytes unpacked"));
}

#[test]
fn a_symlink_inside_the_gem_is_kept() {
    let f = fixture();
    let mut data = tar_of(&[("lib/tool.rb", b"module Tool; end\n", 0o644)]);
    data.truncate(data.len() - 1024);
    data.extend(raw_tar(
        "lib/alias.rb",
        tar::EntryType::Symlink,
        Some("tool.rb"),
    ));
    let gem = gem_of(&metadata("tool", "1.2.0", ""), &data);
    f.fetcher
        .insert("https://rubygems.org/gems/tool-1.2.0.gem", gem.clone());
    let text = read(&f.builder, "/app/Gemfile.lock")
        .replace(&sha256(&f.gems["tool-1.2.0"]), &sha256(&gem));
    f.builder
        .write("/app/Gemfile.lock", text.as_bytes())
        .unwrap();
    run(&f).unwrap();
    assert_eq!(
        read(&f.builder, &format!("{ROOT}/gems/tool-1.2.0/lib/alias.rb")),
        "module Tool; end\n"
    );
}

#[test]
fn git_sources_must_be_https_commits_without_submodules() {
    for (from, to, expect) in [
        (
            "https://github.com/acme/fromgit.git",
            "git@github.com:acme/fromgit.git",
            "is not https",
        ),
        (
            &format!("revision: {COMMIT}"),
            "revision: main",
            "is not a commit id",
        ),
        (
            "branch: main\n",
            "branch: main\n  submodules: true\n",
            "submodules: true",
        ),
    ] {
        let f = fixture();
        let text = read(&f.builder, "/app/Gemfile.lock").replacen(from, to, 1);
        f.builder
            .write("/app/Gemfile.lock", text.as_bytes())
            .unwrap();
        let err = run(&f).unwrap_err().to_string();
        assert!(err.contains(expect), "{expect}: {err}");
    }
    assert_eq!(git_base_name("https://github.com/rails/rails.git"), "rails");
    assert_eq!(git_base_name("https://example.com/x/y/"), "y");
    assert_eq!(git_base_name("git@github.com:acme/thing.git"), "thing");
    assert_eq!(git_base_name("https://example.com/repo"), "repo");
}

#[test]
fn the_ruby_comes_from_the_pipeline_the_lock_or_ruby_version() {
    let mut w = Vec::new();
    let newest = RUBY_ABIS.last().unwrap();
    assert_eq!(choose_abi(None, None, None, &mut w).unwrap(), newest);
    assert_eq!(
        choose_abi(None, Some("3.4.1p0"), Some("4.0.0"), &mut w)
            .unwrap()
            .version,
        "3.4"
    );
    assert_eq!(
        choose_abi(None, None, Some("ruby-3.4.7\n"), &mut w)
            .unwrap()
            .version,
        "3.4"
    );
    assert_eq!(
        choose_abi(Some("3.4"), None, Some("4.0"), &mut w)
            .unwrap()
            .version,
        "3.4"
    );
    let err = choose_abi(Some("4.0"), Some("3.4.2"), None, &mut w).unwrap_err();
    assert!(
        err.contains("disagrees with the lock's RUBY VERSION (3.4.2)"),
        "{err}"
    );
    let err = choose_abi(None, Some("3.3.6p108"), None, &mut w).unwrap_err();
    assert!(
        err.contains("Ruby 3.3.6p108") && err.contains("3.4, 4.0"),
        "{err}"
    );
    let err = choose_abi(Some("2.7"), None, None, &mut w).unwrap_err();
    assert!(err.contains("`ruby:`"), "{err}");
    assert!(w.is_empty());
    assert_eq!(
        choose_abi(None, None, Some("truffleruby-24.1"), &mut w).unwrap(),
        newest
    );
    assert_eq!(w.len(), 1);
}

#[test]
fn ruby_3_4_lays_out_under_its_own_directory() {
    let f = fixture();
    let text = read(&f.builder, "/app/Gemfile.lock").replace("ruby 4.0.0p0", "ruby 3.4.7p58");
    f.builder
        .write("/app/Gemfile.lock", text.as_bytes())
        .unwrap();
    let report = run(&f).unwrap();
    assert_eq!(report.ruby, "3.4");
    let root = "/app/vendor/bundle/ruby/3.4.0";
    assert!(
        f.builder
            .is_file(format!("{root}/gems/tool-1.2.0/lib/tool.rb"))
    );
    assert!(f.builder.is_file(format!(
        "{root}/extensions/wasm32-wasi/3.4.0-static/native-0.3.1/gem.build_complete"
    )));
    let stub = read(&f.builder, &format!("{root}/bin/tool"));
    assert!(stub.contains("load Gem.activate_bin_path('tool', 'tool', version)"));
    assert!(
        read(
            &f.builder,
            &format!("{root}/specifications/tool-1.2.0.gemspec")
        )
        .contains("s.installed_by_version = \"3.6.9\".freeze")
    );
}

#[test]
fn a_local_bundle_config_that_moves_the_path_is_a_warning() {
    let f = fixture();
    f.builder
        .write("/app/.bundle/config", b"---\nBUNDLE_PATH: \"gems\"\n")
        .unwrap();
    let report = run(&f).unwrap();
    assert!(
        report
            .warnings
            .iter()
            .any(|w| w.contains("BUNDLE_PATH to \"gems\"")),
        "{:?}",
        report.warnings
    );
}

#[test]
fn path_sources_name_their_gemspecs() {
    let gems = fixture().gems;
    let text = lock(&gems).replace("PATH\n  remote: .\n", "PATH\n  remote: engines/billing\n");
    assert_eq!(
        path_gemspecs(Some(text.as_bytes())),
        ["engines/billing/local.gemspec"]
    );
    assert_eq!(
        path_gemspecs(Some(lock(&gems).as_bytes())),
        ["local.gemspec"]
    );
    let outside = lock(&gems).replace("PATH\n  remote: .\n", "PATH\n  remote: ../shared\n");
    assert!(path_gemspecs(Some(outside.as_bytes())).is_empty());
    assert!(path_gemspecs(None).is_empty());
}

#[test]
fn no_lockfile_is_an_error() {
    let builder = SnapshotBuilder::new();
    builder.write("/app/Gemfile", b"").unwrap();
    let err = install(
        &builder,
        "/app",
        &MemoryFetcher::new(),
        &NoGit,
        &NoPrebuilt,
        &BundlerOptions::default(),
    )
    .unwrap_err();
    assert!(matches!(err, BundlerError::NoLockfile(_)), "{err}");
}

/// Each fixture's metadata (a gem's `metadata.gz`, unpacked; `edge` and
/// `old` are written by hand to reach the corners), rendered, is what
/// RubyGems 4.0.3 writes for it. The `.gemspec` files came from:
///
/// ```sh
/// ruby -e 'ARGV.each { |m| s = Gem::Specification.from_yaml(File.read(m));
///   s.installed_by_version = Gem.rubygems_version;
///   File.binwrite(m.sub(/\.metadata\z/, ".gemspec"), s.to_ruby_for_cache) }' *.metadata
/// ```
#[test]
fn gemspecs_match_what_rubygems_writes() {
    for name in [
        "bcrypt-3.1.20",
        "ed25519-1.4.0",
        "edge-0.1.0",
        "minitest-5.27.0",
        "old-1.0",
        "rake-13.4.2",
        "rspec-core-3.13.7",
        "rspec-expectations-3.13.6",
    ] {
        let yaml = fixture_file(&format!("{name}.metadata"));
        let spec = gemspec::Gemspec::from_yaml(&yaml).unwrap();
        let ours = String::from_utf8(spec.to_ruby_for_cache("4.0.3")).unwrap();
        let theirs = fixture_file(&format!("{name}.gemspec"));
        assert_eq!(ours, theirs, "{name}");
    }
}

/// The `.binstub` fixtures are `Gem::Installer#app_script_text` of
/// RubyGems 4.0.3 (the host's; `rspec-4.0.binstub` is byte for byte what
/// `bundle install` wrote) and 3.6.9 (the `wasm32-wasi` Ruby 3.4 build's),
/// evaluated with the `#!/usr/bin/env ruby` shebang Bundler asks for.
#[test]
fn binstubs_match_what_rubygems_writes() {
    for abi in RUBY_ABIS {
        for (gem, exe, file) in [
            ("rspec-core", "rspec", "rspec"),
            ("bundler", "bundle", "bundle"),
        ] {
            assert_eq!(
                binstub(abi, gem, exe),
                fixture_file(&format!("{file}-{}.binstub", abi.version)),
                "{gem} for {}",
                abi.version
            );
        }
    }
}

#[test]
fn metadata_with_classes_rubygems_refuses_is_refused() {
    let yaml = "--- !ruby/object:Gem::Specification\nname: x\nversion: !ruby/object:Gem::Version\n  version: 1\nauthors: !ruby/object:Kernel\n  x: 1\n";
    let err = gemspec::Gemspec::from_yaml(yaml).unwrap_err();
    assert!(err.contains("!ruby/object:Kernel"), "{err}");
    assert!(gemspec::Gemspec::from_yaml("--- {}\n").is_err());
}

#[test]
fn strings_dump_as_ruby_dumps_them() {
    use gemspec::dump;
    assert_eq!(dump(b"plain"), "\"plain\"");
    assert_eq!(dump("é😀".as_bytes()), "\"\\u00E9\\u{1F600}\"");
    assert_eq!(dump(b"#{a} #$b #@c #d"), "\"\\#{a} \\#$b \\#@c #d\"");
    assert_eq!(dump(b"\x7f\x01\x1b"), "\"\\x7F\\x01\\e\"");
    assert_eq!(dump(b"\xff"), "\"\\xFF\"");
}

/// Every `GIT` source's tree, read from one local directory, so a lock
/// with a git source can be checked against Bundler without a repository.
struct DirTree(String);

impl GitTrees for DirTree {
    fn files(&self, _url: &str, _commit: &str) -> std::result::Result<Vec<TreeFile>, String> {
        fn walk(root: &Path, dir: &Path, out: &mut Vec<TreeFile>) {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    walk(root, &path, out);
                } else {
                    out.push(TreeFile {
                        path: path
                            .strip_prefix(root)
                            .unwrap()
                            .to_string_lossy()
                            .into_owned(),
                        data: std::fs::read(&path).unwrap(),
                        executable: false,
                    });
                }
            }
        }
        let mut out = Vec::new();
        walk(Path::new(&self.0), Path::new(&self.0), &mut out);
        Ok(out)
    }
}

/// An empty build for every gem with an extension, which leaves the
/// directory with only `gem.build_complete`.
struct AllWithout;

impl PrebuiltExtensions for AllWithout {
    fn key(&self) -> String {
        String::new()
    }

    fn files(
        &self,
        _gem: &ExtensionRequest<'_>,
    ) -> std::result::Result<Option<Vec<TreeFile>>, String> {
        Ok(Some(Vec::new()))
    }

    fn versions(&self, _name: &str, _abi: &RubyAbi) -> std::result::Result<Vec<String>, String> {
        Ok(Vec::new())
    }
}

/// Installs `IWCI_TEST_BUNDLER_DIR`'s Gemfile.lock from rubygems.org into
/// that directory's `vendor/bundle`, for checking with the host's
/// Bundler:
///
/// ```sh
/// IWCI_TEST_BUNDLER_DIR=/path/to/app cargo test -p iwci-deps \
///   bundler::tests::installs_a_real_lock -- --ignored
/// cd /path/to/app && BUNDLE_PATH=vendor/bundle BUNDLE_FROZEN=true bundle exec rspec
/// ```
///
/// Gems with native extensions are installed without them (the host's
/// Bundler would compile them; this checks the layout, not the builds).
/// `IWCI_TEST_BUNDLER_RUBY` names the ABI to install for (the host's
/// `ruby -v`); its platform and extension directory are the host's own
/// (`IWCI_TEST_BUNDLER_PLATFORM`, `IWCI_TEST_BUNDLER_EXT_API`) so the
/// host's Ruby reads the result. `IWCI_TEST_BUNDLER_TREE` names a
/// directory that stands in for every `GIT` source's tree, and
/// `IWCI_TEST_BUNDLER_CACHE` keeps the downloads (by SHA-256) to compare
/// with RubyGems afterwards.
#[test]
#[ignore = "network: installs IWCI_TEST_BUNDLER_DIR's lock from rubygems.org"]
fn installs_a_real_lock() {
    let Ok(dir) = std::env::var("IWCI_TEST_BUNDLER_DIR") else {
        eprintln!("IWCI_TEST_BUNDLER_DIR is not set");
        return;
    };
    let dir = std::path::PathBuf::from(dir);
    let builder = SnapshotBuilder::new();
    for name in ["Gemfile", "Gemfile.lock", ".ruby-version"] {
        if let Ok(bytes) = std::fs::read(dir.join(name)) {
            builder.write(format!("/app/{name}"), &bytes).unwrap();
        }
    }
    let mut fetcher = crate::fetch::HttpFetcher::new();
    if let Ok(cache) = std::env::var("IWCI_TEST_BUNDLER_CACHE") {
        fetcher = fetcher.with_cache_dir(cache);
    }
    let tree = std::env::var("IWCI_TEST_BUNDLER_TREE").ok().map(DirTree);
    let trees: &dyn GitTrees = match &tree {
        Some(tree) => tree,
        None => &NoGit,
    };
    let report = install(
        &builder,
        "/app",
        &fetcher,
        trees,
        &AllWithout,
        &BundlerOptions {
            ruby: std::env::var("IWCI_TEST_BUNDLER_RUBY").ok(),
            ..BundlerOptions::default()
        },
    )
    .unwrap();
    for gem in &report.installed {
        eprintln!("{} {} ({:?})", gem.name, gem.version, gem.verified);
    }
    eprintln!("warnings {:?}", report.warnings);
    let abi = ruby_abi(&report.ruby).unwrap();
    let platform = std::env::var("IWCI_TEST_BUNDLER_PLATFORM").ok();
    let ext_api = std::env::var("IWCI_TEST_BUNDLER_EXT_API").ok();
    let snapshot = builder.freeze();
    let out = dir.join("vendor/bundle");
    let _ = std::fs::remove_dir_all(&out);
    for path in snapshot.list_files("/app/vendor/bundle") {
        let mut relative = path
            .strip_prefix("/app/vendor/bundle")
            .unwrap()
            .to_string_lossy()
            .into_owned();
        if let (Some(p), Some(e)) = (&platform, &ext_api) {
            relative = relative.replace(
                &format!(
                    "/extensions/{}/{}/",
                    abi.platform, abi.extension_api_version
                ),
                &format!("/extensions/{p}/{e}/"),
            );
        }
        let target = out.join(relative);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, snapshot.read(&path).unwrap()).unwrap();
        if snapshot.mode(&path).is_some_and(|m| m & 0o111 != 0) {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    assert!(!report.installed.is_empty());
}

#[test]
fn a_rails_lock_runs_its_tests_in_one_worker() {
    let f = fixture();
    let plain = env_for(&f.builder, "/app");
    assert!(
        plain.iter().all(|(k, _)| k != "PARALLEL_WORKERS"),
        "{plain:?}"
    );
    assert!(plain.contains(&("BUNDLE_FROZEN".to_string(), "true".to_string())));
    f.builder
        .write(
            "/app/Gemfile.lock",
            fixture_file("rails-8.1.lock").as_bytes(),
        )
        .unwrap();
    let rails = env_for(&f.builder, "/app");
    assert!(rails.contains(&("PARALLEL_WORKERS".to_string(), "1".to_string())));
    // No lock: just the bundle's.
    assert_eq!(env_for(&f.builder, "/elsewhere"), env());
}
