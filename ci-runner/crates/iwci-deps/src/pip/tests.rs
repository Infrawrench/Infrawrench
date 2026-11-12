use super::*;
use crate::archive::zip_of;
use crate::fetch::MemoryFetcher;

const SITE: &str = "/root/.local/lib/python3.13/site-packages";

fn sha(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn wheel(dist: &str, version: &str, extra: &[(&str, &[u8])], requires: &[&str]) -> Vec<u8> {
    let info = format!("{dist}-{version}.dist-info");
    let mut metadata = format!("Metadata-Version: 2.1\nName: {dist}\nVersion: {version}\n");
    for r in requires {
        metadata.push_str(&format!("Requires-Dist: {r}\n"));
    }
    let wheel_meta =
        "Wheel-Version: 1.0\nGenerator: test\nRoot-Is-Purelib: true\nTag: py3-none-any\n";
    let mut files: Vec<(String, Vec<u8>)> = vec![
        (
            format!("{dist}/__init__.py"),
            format!("VERSION = {version:?}\n").into_bytes(),
        ),
        (format!("{info}/METADATA"), metadata.into_bytes()),
        (format!("{info}/WHEEL"), wheel_meta.as_bytes().to_vec()),
        (format!("{info}/RECORD"), b"stale,,\n".to_vec()),
    ];
    for (name, data) in extra {
        files.push((name.to_string(), data.to_vec()));
    }
    let refs: Vec<(&str, &[u8])> = files
        .iter()
        .map(|(n, d)| (n.as_str(), d.as_slice()))
        .collect();
    zip_of(&refs)
}

fn page(links: &[(&str, &[u8])]) -> String {
    let mut html = String::from("<!DOCTYPE html><html><body>\n");
    for (href, bytes) in links {
        html.push_str(&format!(
            "<a href=\"{href}#sha256={}\" data-requires-python=\"&gt;=3.8\">{href}</a><br/>\n",
            sha(bytes)
        ));
    }
    html + "</body></html>\n"
}

fn repo(files: &[(&str, &str)]) -> SnapshotBuilder {
    let builder = SnapshotBuilder::new();
    for (path, text) in files {
        builder
            .write(format!("/app/{path}"), text.as_bytes())
            .unwrap();
    }
    builder
}

fn text(builder: &SnapshotBuilder, path: &str) -> String {
    String::from_utf8(builder.read(path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}

/// A pure package on PyPI, and one with compiled code: a manylinux wheel
/// and an sdist on PyPI, and a WASIX build on Wasmer's index.
struct Fixture {
    fetcher: MemoryFetcher,
    pure: Vec<u8>,
    linux: Vec<u8>,
    wasix: Vec<u8>,
    sdist: Vec<u8>,
}

fn fixture() -> Fixture {
    let fetcher = MemoryFetcher::new();
    let entry_points: &[u8] =
        b"[console_scripts]\npure-tool = purepkg.cli:main\n[other]\nx = y:z\n";
    let pure = wheel(
        "purepkg",
        "1.0",
        &[
            ("purepkg/cli.py", b"def main():\n    return 0\n"),
            ("purepkg-1.0.dist-info/entry_points.txt", entry_points),
            (
                "purepkg-1.0.data/scripts/pure-script",
                b"#!python\nprint('hi')\n",
            ),
            ("purepkg-1.0.data/purelib/extra_mod.py", b"X = 1\n"),
            ("pure.pth", b"import purepkg\n"),
        ],
        &[
            "natpkg>=2",
            "colorama ; sys_platform == 'win32'",
            "socks ; extra == 'socks'",
        ],
    );
    let linux = wheel("natpkg", "2.0", &[("natpkg/_core.so", b"ELF")], &[]);
    let wasix = wheel(
        "natpkg",
        "2.0+wasix.1",
        &[("natpkg/_core.so", b"\0asm")],
        &[],
    );
    let sdist = b"not really a tarball".to_vec();
    fetcher.insert(
        "https://pypi.org/simple/purepkg/",
        page(&[(
            "https://files.example/p/purepkg-1.0-py3-none-any.whl",
            &pure,
        )]),
    );
    fetcher.insert(
        "https://files.example/p/purepkg-1.0-py3-none-any.whl",
        pure.clone(),
    );
    fetcher.insert(
        "https://pypi.org/simple/natpkg/",
        page(&[
            (
                "../../files/natpkg-2.0-cp313-cp313-manylinux_2_17_x86_64.whl",
                &linux,
            ),
            ("../../files/natpkg-2.0.tar.gz", &sdist),
        ]),
    );
    fetcher.insert(
        "https://pypi.org/files/natpkg-2.0-cp313-cp313-manylinux_2_17_x86_64.whl",
        linux.clone(),
    );
    fetcher.insert("https://pypi.org/files/natpkg-2.0.tar.gz", sdist.clone());
    fetcher.insert(
        "https://python-registry.wasix.org/simple/natpkg/",
        page(&[("natpkg-2.0%2Bwasix.1-cp313-cp313-wasix_wasm32.whl", &wasix)]),
    );
    fetcher.insert(
        "https://python-registry.wasix.org/simple/natpkg/natpkg-2.0%2Bwasix.1-cp313-cp313-wasix_wasm32.whl",
        wasix.clone(),
    );
    Fixture {
        fetcher,
        pure,
        linux,
        wasix,
        sdist,
    }
}

fn requirements(f: &Fixture) -> String {
    format!(
        "# compiled with pip-compile --generate-hashes\n\
         --extra-index-url https://python-registry.wasix.org/simple/\n\
         \n\
         natpkg==2.0 \\\n    --hash=sha256:{} \\\n    --hash=sha256:{} \\\n    --hash=sha256:{}\n    \
         # via purepkg\n\
         purepkg[socks]==1.0 ; python_version >= \"3.8\" \\\n    --hash=sha256:{}\n\
         winonly==1.0 ; sys_platform == \"win32\" \\\n    --hash=sha256:{}\n",
        sha(&f.linux),
        sha(&f.sdist),
        sha(&f.wasix),
        sha(&f.pure),
        "0".repeat(64),
    )
}

#[test]
fn installs_a_hashed_requirements_file_for_wasix() {
    let f = fixture();
    let builder = repo(&[("requirements.txt", &requirements(&f))]);
    let report = install(&builder, "/app", &f.fetcher, &PipOptions::default()).unwrap();

    assert_eq!(report.lockfile, "/app/requirements.txt");
    let wheels: Vec<&str> = report.installed.iter().map(|d| d.wheel.as_str()).collect();
    assert_eq!(
        wheels,
        [
            "natpkg-2.0+wasix.1-cp313-cp313-wasix_wasm32.whl",
            "purepkg-1.0-py3-none-any.whl"
        ]
    );
    assert_eq!(report.skipped, ["requirements.txt:11"]);
    // The WASIX build, not the Linux one; nothing for Windows was fetched.
    assert_eq!(
        builder.read(format!("{SITE}/natpkg/_core.so")).unwrap(),
        b"\0asm"
    );
    assert!(!f.fetcher.requests().iter().any(|u| u.contains("winonly")));
    assert!(!f.fetcher.requests().iter().any(|u| u.ends_with(".tar.gz")));

    // Schemes, console scripts, INSTALLER and a RECORD of where it all went.
    assert_eq!(text(&builder, &format!("{SITE}/extra_mod.py")), "X = 1\n");
    assert_eq!(
        text(&builder, &format!("{SITE}/pure.pth")),
        "import purepkg\n"
    );
    assert_eq!(
        text(&builder, "/root/.local/bin/pure-script"),
        "#!/usr/bin/env python3\nprint('hi')\n"
    );
    let tool = text(&builder, "/root/.local/bin/pure-tool");
    assert!(tool.starts_with("#!/usr/bin/env python3\n"), "{tool}");
    assert!(tool.contains("from purepkg.cli import main\n"), "{tool}");
    assert!(tool.contains("sys.exit(main())"), "{tool}");
    assert!(builder.read("/root/.local/bin/x").is_err());
    assert_eq!(
        text(&builder, &format!("{SITE}/purepkg-1.0.dist-info/INSTALLER")),
        "iwci\n"
    );
    let record = text(&builder, &format!("{SITE}/purepkg-1.0.dist-info/RECORD"));
    assert!(
        record.contains("../../../bin/pure-tool,sha256="),
        "{record}"
    );
    assert!(record.contains("purepkg/__init__.py,sha256="), "{record}");
    assert!(
        record.ends_with("purepkg-1.0.dist-info/RECORD,,\n"),
        "{record}"
    );
    assert!(!record.contains("stale"), "{record}");

    // purepkg needs natpkg (installed) and, with its socks extra, socks.
    assert_eq!(
        report.warnings,
        ["pip: purepkg needs socks, which requirements.txt does not install"]
    );
    assert_eq!(
        env(&PipOptions::default()),
        [("PYTHONUSERBASE".into(), "/root/.local".into())]
    );
    assert_eq!(path(&PipOptions::default()), ["/root/.local/bin"]);
}

#[test]
fn a_tampered_download_is_refused() {
    let f = fixture();
    // The index still lists the locked hash, but serves other bytes.
    let mut tampered = f.pure.clone();
    let last = tampered.len() - 30;
    tampered[last] ^= 1;
    f.fetcher.insert(
        "https://files.example/p/purepkg-1.0-py3-none-any.whl",
        tampered,
    );
    let builder = repo(&[("requirements.txt", &requirements(&f))]);
    let err = install(&builder, "/app", &f.fetcher, &PipOptions::default()).unwrap_err();
    assert!(
        matches!(err, PipError::Fetch(FetchError::IntegrityMismatch { .. })),
        "{err}"
    );
    assert!(builder.read(format!("{SITE}/purepkg/__init__.py")).is_err());
}

#[test]
fn a_file_the_lock_does_not_hash_is_never_a_candidate() {
    let f = fixture();
    // The index offers a wheel whose hash the lock does not list.
    let other = wheel("purepkg", "1.0", &[("purepkg/evil.py", b"x")], &[]);
    f.fetcher.insert(
        "https://pypi.org/simple/purepkg/",
        page(&[(
            "https://files.example/p/purepkg-1.0-py3-none-any.whl",
            &other,
        )]),
    );
    let builder = repo(&[("requirements.txt", &requirements(&f))]);
    let err = install(&builder, "/app", &f.fetcher, &PipOptions::default()).unwrap_err();
    assert!(err.to_string().contains("none of the files on"), "{err}");
}

#[test]
fn refuses_what_a_job_cannot_use() {
    let f = fixture();
    let only = |hashes: &[&[u8]]| {
        let lines: Vec<String> = hashes
            .iter()
            .map(|h| format!("--hash=sha256:{}", sha(h)))
            .collect();
        format!("natpkg==2.0 {}\n", lines.join(" "))
    };
    let run = |text: String| {
        let builder = repo(&[("requirements.txt", &text)]);
        install(&builder, "/app", &f.fetcher, &PipOptions::default())
            .unwrap_err()
            .to_string()
    };
    let linux_only = run(only(&[&f.linux]));
    assert!(
        linux_only.contains("other interpreters or platforms"),
        "{linux_only}"
    );
    assert!(
        linux_only.contains("python-registry.wasix.org"),
        "{linux_only}"
    );
    let sdist_only = run(only(&[&f.sdist]));
    assert!(
        sdist_only.contains("only a source distribution"),
        "{sdist_only}"
    );
    let unpinned = run(format!("natpkg>=2.0 --hash=sha256:{}\n", sha(&f.wasix)));
    assert!(unpinned.contains("not pinned"), "{unpinned}");
    let unhashed = run("natpkg==2.0\n".to_string());
    assert!(unhashed.contains("--generate-hashes"), "{unhashed}");
    let include = run("-r other.txt\n".to_string());
    assert!(include.contains("line 1: -r is not supported"), "{include}");
    let md5 = run("natpkg==2.0 --hash=md5:abc\n".to_string());
    assert!(md5.contains("only sha256"), "{md5}");
    let builder = repo(&[]);
    let missing = install(&builder, "/app", &f.fetcher, &PipOptions::default()).unwrap_err();
    assert!(matches!(missing, PipError::NoLockfile(_)), "{missing}");
}

#[test]
fn installs_a_pylock() {
    let f = fixture();
    let local = wheel("vendored", "0.1", &[], &[]);
    let lock = format!(
        r#"lock-version = "1.0"
created-by = "pip"
default-groups = ["dev"]

[[packages]]
name = "natpkg"
version = "2.0+wasix.1"
[[packages.wheels]]
url = "https://python-registry.wasix.org/simple/natpkg/natpkg-2.0%2Bwasix.1-cp313-cp313-wasix_wasm32.whl"
hashes = {{ sha256 = "{wasix}" }}
[[packages.wheels]]
name = "natpkg-2.0-cp313-cp313-manylinux_2_17_x86_64.whl"
url = "https://pypi.org/files/natpkg-2.0-cp313-cp313-manylinux_2_17_x86_64.whl"
hashes = {{ sha256 = "{linux}" }}

[[packages]]
name = "vendored"
marker = "'dev' in dependency_groups"
[[packages.wheels]]
path = "wheels/vendored-0.1-py3-none-any.whl"
hashes = {{ sha256 = "{local}" }}

[[packages]]
name = "docs-only"
marker = "'docs' in dependency_groups"
[[packages.wheels]]
url = "https://files.example/docs_only-1-py3-none-any.whl"
hashes = {{ sha256 = "{zero}" }}
"#,
        wasix = sha(&f.wasix),
        linux = sha(&f.linux),
        local = sha(&local),
        zero = "0".repeat(64),
    );
    let builder = repo(&[("pylock.toml", &lock)]);
    builder
        .write("/app/wheels/vendored-0.1-py3-none-any.whl", &local)
        .unwrap();
    let report = install(&builder, "/app", &f.fetcher, &PipOptions::default()).unwrap();
    let names: Vec<&str> = report.installed.iter().map(|d| d.name.as_str()).collect();
    assert_eq!(names, ["natpkg", "vendored"]);
    assert_eq!(report.skipped, ["pylock.toml: docs-only"]);
    assert_eq!(
        builder.read(format!("{SITE}/natpkg/_core.so")).unwrap(),
        b"\0asm"
    );
    assert!(builder.is_file(format!("{SITE}/vendored/__init__.py")));
    // No index is asked when the lock names its files.
    assert!(!f.fetcher.requests().iter().any(|u| u.ends_with('/')));

    // A wheel in the repository is checked like a download.
    builder
        .write("/app/wheels/vendored-0.1-py3-none-any.whl", b"changed")
        .unwrap();
    let fresh = repo(&[("pylock.toml", &lock)]);
    fresh
        .write("/app/wheels/vendored-0.1-py3-none-any.whl", b"changed")
        .unwrap();
    let err = install(&fresh, "/app", &f.fetcher, &PipOptions::default()).unwrap_err();
    assert!(
        matches!(err, PipError::Fetch(FetchError::IntegrityMismatch { .. })),
        "{err}"
    );
}

#[test]
fn file_option_and_a_custom_index() {
    let f = fixture();
    let page_text = page(&[(
        "https://mirror.example/f/purepkg-1.0-py3-none-any.whl",
        &f.pure,
    )]);
    f.fetcher
        .insert("https://mirror.example/simple/purepkg/", page_text);
    f.fetcher.insert(
        "https://mirror.example/f/purepkg-1.0-py3-none-any.whl",
        f.pure.clone(),
    );
    let text = format!(
        "--index-url=https://mirror.example/simple\npurepkg==1.0 --hash=sha256:{}\n",
        sha(&f.pure)
    );
    let builder = repo(&[("requirements/ci.txt", &text)]);
    let options = PipOptions {
        file: Some("requirements/ci.txt".into()),
        ..PipOptions::default()
    };
    let report = install(&builder, "/app", &f.fetcher, &options).unwrap();
    assert_eq!(report.installed.len(), 1);
    assert_eq!(
        f.fetcher.requests()[0],
        "https://mirror.example/simple/purepkg/"
    );
    let escape = PipOptions {
        file: Some("../etc/x".into()),
        ..PipOptions::default()
    };
    assert!(install(&builder, "/app", &f.fetcher, &escape).is_err());
}

#[test]
fn tags_follow_packaging() {
    let tags = Target::default().tags();
    let t = |a: &str, b: &str, c: &str| (a.to_string(), b.to_string(), c.to_string());
    assert_eq!(tags[0], t("cp313", "cp313", "wasix_wasm32"));
    assert_eq!(tags[1], t("cp313", "abi3", "wasix_wasm32"));
    let pos = |tag| tags.iter().position(|x| *x == tag).unwrap();
    assert!(pos(t("cp312", "abi3", "wasix_wasm32")) < pos(t("py3", "none", "wasix_wasm32")));
    assert!(pos(t("py3", "none", "wasix_wasm32")) < pos(t("cp313", "none", "any")));
    assert!(pos(t("cp313", "none", "any")) < pos(t("py3", "none", "any")));
    assert!(tags.contains(&t("py30", "none", "any")));
    assert!(!tags.iter().any(|(_, _, p)| p.starts_with("manylinux")));
}

#[test]
fn index_pages_and_names() {
    let html = r#"<a href="a-1.0-py3-none-any.whl#sha256=AB">a</a>
        <A HREF='../x/b-1.0.tar.gz#sha256=cd' data-yanked="">b</A>
        <a data-x="1" href=https://h.example/c%2Bd.whl?x=1#sha256=ef>c</a>
        <abbr>no</abbr><a href="q?x=1&amp;y=2">q</a>"#;
    assert_eq!(
        anchors(html),
        [
            "a-1.0-py3-none-any.whl#sha256=AB",
            "../x/b-1.0.tar.gz#sha256=cd",
            "https://h.example/c%2Bd.whl?x=1#sha256=ef",
            "q?x=1&y=2"
        ]
    );
    let page_url = "https://pypi.org/simple/numpy/";
    assert_eq!(
        resolve_url(page_url, "a.whl"),
        "https://pypi.org/simple/numpy/a.whl"
    );
    assert_eq!(
        resolve_url(page_url, "../../f/a.whl"),
        "https://pypi.org/f/a.whl"
    );
    assert_eq!(
        resolve_url(page_url, "/f/a.whl"),
        "https://pypi.org/f/a.whl"
    );
    assert_eq!(
        resolve_url(page_url, "//cdn.example/a.whl"),
        "https://cdn.example/a.whl"
    );
    assert_eq!(
        url_file_name("https://h/numpy-2.5.1%2Bwasix.3-cp313-cp313-wasix_wasm32.whl?x#y")
            .as_deref(),
        Some("numpy-2.5.1+wasix.3-cp313-cp313-wasix_wasm32.whl")
    );
    assert_eq!(url_file_name("https://h/a%2Fb.whl"), None);
    assert_eq!(normalise_name("Foo_Bar.baz--Q"), "foo-bar-baz-q");
    let w = parse_wheel_name("pkg-1.0-1-py2.py3-none-any.whl").unwrap();
    assert_eq!(w.version, "1.0");
    assert_eq!(w.tags.len(), 2);
    assert!(parse_wheel_name("pkg-1.0.tar.gz").is_none());
}

#[test]
fn requirement_lines() {
    let lines = logical_lines("a==1 \\\n  --hash=sha256:x # c\n# whole line\nb==2#not-a-comment\n");
    assert_eq!(lines[0], (1, "a==1    --hash=sha256:x".to_string()));
    assert_eq!(lines[2], (4, "b==2#not-a-comment".to_string()));
    let h = "a".repeat(64);
    let (locked, marker) = parse_requirement(
        "Requests[socks, security] == 2.32.3 ; python_version >= '3.8'",
        vec![h.clone()],
        "f:1".into(),
    )
    .unwrap();
    assert_eq!(locked.name, "Requests");
    assert_eq!(locked.extras, ["socks", "security"]);
    assert_eq!(locked.version.as_deref(), Some("2.32.3"));
    assert_eq!(marker.as_deref(), Some("python_version >= '3.8'"));
    let (direct, _) = parse_requirement(
        "pkg @ https://h.example/pkg-1-py3-none-any.whl",
        vec![h],
        "f:2".into(),
    )
    .unwrap();
    assert_eq!(direct.files.unwrap()[0].filename, "pkg-1-py3-none-any.whl");
}

/// A real lock against the real indexes: `IWCI_TEST_PIP_LOCK` names a
/// requirements file or pylock.toml on disk.
#[test]
#[ignore = "network: installs the lock IWCI_TEST_PIP_LOCK names"]
fn installs_a_real_lock() {
    let Ok(path) = std::env::var("IWCI_TEST_PIP_LOCK") else {
        eprintln!("IWCI_TEST_PIP_LOCK is not set");
        return;
    };
    let text = std::fs::read(&path).unwrap();
    let name = Path::new(&path)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    let builder = SnapshotBuilder::new();
    builder.write(format!("/app/{name}"), &text).unwrap();
    let options = PipOptions {
        file: Some(name),
        ..PipOptions::default()
    };
    let fetcher = crate::fetch::HttpFetcher::new();
    let report = install(&builder, "/app", &fetcher, &options).unwrap();
    for dist in &report.installed {
        eprintln!("{} {} ({})", dist.name, dist.version, dist.wheel);
    }
    eprintln!(
        "skipped {:?}, warnings {:?}",
        report.skipped, report.warnings
    );
    assert!(!report.installed.is_empty());
}
