//! The lisafs server under gVisor's real kernel.
//!
//! These start a sandbox, so they need the pinned gVisor release, a static
//! busybox, root (or a user allowed to create user namespaces), and Linux.
//! They read their inputs from the environment and are ignored by default:
//!
//! - `IWCI_TEST_GVISOR`: the unpacked release (`runsc`, `gvisor-bin/`);
//! - `IWCI_TEST_BUSYBOX`: a statically linked busybox;
//! - `IWCI_TEST_BUN_ROOT` (optional): a directory holding Bun and the C
//!   library it links, laid out as they go in the sandbox
//!   (`usr/local/bin/bun`, `lib64/ld-linux-x86-64.so.2`, ...).
//!
//! `IWCI_REQUIRE_FIXTURES` makes a missing input fail instead of skip.
#![cfg(target_os = "linux")]

use std::os::fd::OwnedFd;
use std::path::{Path, PathBuf};
use std::time::Instant;

use iwci_sandbox::lisafs::{Export, serve, socket_pair};
use iwci_sandbox::net::{Gateway, Network, Outside};
use iwci_sandbox::runsc::{Config, Release, boot};
use iwci_vfs::virtual_fs::FileSystem;
use iwci_vfs::{Change, JobFs, SnapshotBuilder};

fn input(name: &str) -> Option<PathBuf> {
    match std::env::var_os(name) {
        Some(v) => Some(PathBuf::from(v)),
        None if std::env::var_os("IWCI_REQUIRE_FIXTURES").is_some() => {
            panic!("{name} is not set")
        }
        None => {
            eprintln!("skipping: {name} is not set");
            None
        }
    }
}

/// Copies a host directory tree into the snapshot at `at`, keeping modes.
fn copy_tree(b: &SnapshotBuilder, from: &Path, at: &Path) {
    use std::os::unix::fs::PermissionsExt;
    for entry in std::fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        let to = at.join(entry.file_name());
        let meta = std::fs::symlink_metadata(&path).unwrap();
        if meta.is_symlink() {
            b.symlink(&to, std::fs::read_link(&path).unwrap()).unwrap();
        } else if meta.is_dir() {
            b.mkdir_all(&to).unwrap();
            copy_tree(b, &path, &to);
        } else {
            b.write(&to, &std::fs::read(&path).unwrap()).unwrap();
            b.set_mode(&to, meta.permissions().mode() & 0o7777).unwrap();
        }
    }
}

/// A checkout plus busybox at /bin.
fn snapshot(busybox: &Path, extra: impl FnOnce(&SnapshotBuilder)) -> JobFs {
    let b = SnapshotBuilder::new();
    b.write("/bin/busybox", &std::fs::read(busybox).unwrap())
        .unwrap();
    b.set_mode("/bin/busybox", 0o755).unwrap();
    for applet in [
        "sh", "ls", "cat", "find", "stat", "sort", "readlink", "mkdir", "mv", "ln", "chmod", "rm",
        "echo", "wc", "xargs", "sed", "head", "test", "touch", "cp", "dd", "wget", "httpd", "nc",
        "sleep", "kill", "timeout", "nslookup",
    ] {
        b.symlink(format!("/bin/{applet}"), "busybox").unwrap();
    }
    b.write("/work/a.txt", b"hello\n").unwrap();
    b.write("/work/sub/b.txt", b"bee\n").unwrap();
    b.write("/work/run.sh", b"#!/bin/sh\necho ran\n").unwrap();
    b.set_mode("/work/run.sh", 0o755).unwrap();
    b.symlink("/work/link", "a.txt").unwrap();
    b.mkdir_all("/tmp").unwrap();
    b.mkdir_all("/root").unwrap();
    // What the runner gives a sandboxed job: its resolver is the gateway.
    b.write("/etc/resolv.conf", b"nameserver 10.0.2.2\n")
        .unwrap();
    b.write("/etc/hosts", b"127.0.0.1 localhost\n::1 localhost\n")
        .unwrap();
    extra(&b);
    b.freeze().fork()
}

struct Ran {
    status: i32,
    stdout: String,
    stderr: String,
    millis: u128,
}

/// Runs `args` in a sandbox over `job`'s file system, with no network
/// but its loopback.
fn run(release: &Release, job: &JobFs, args: &[&str]) -> Ran {
    run_with(release, job, args, None)
}

/// Runs `args` in a sandbox, with `network` its way out if there is one.
fn run_with(release: &Release, job: &JobFs, args: &[&str], network: Option<Network>) -> Ran {
    let (gateway, link) = match network {
        Some(n) => {
            let (g, l) = Gateway::start(n).unwrap();
            (Some(g), Some(l))
        }
        None => (None, None),
    };
    let (ours, theirs) = socket_pair().unwrap();
    let serving = serve(
        Export {
            fs: job.as_dyn(),
            modes: job.modes(),
            root: "/".into(),
            read_only: false,
        },
        ours,
    )
    .unwrap();
    let dir = tempdir();
    let out = std::fs::File::create(dir.join("stdout")).unwrap();
    let err = std::fs::File::create(dir.join("stderr")).unwrap();
    let stdin: OwnedFd = std::fs::File::open("/dev/null").unwrap().into();
    let log: OwnedFd = std::fs::File::create(dir.join("sentry.log"))
        .unwrap()
        .into();
    let config = Config {
        id: format!("iwci-test-{}", std::process::id()),
        state_dir: dir.join("state"),
        args: args.iter().map(|a| a.to_string()).collect(),
        env: vec![
            "PATH=/usr/local/bin:/usr/bin:/bin".into(),
            "HOME=/root".into(),
        ],
        cwd: "/work".into(),
        platform: "systrap".into(),
        cpus: 2,
        memory_bytes: 2 << 30,
        extra_flags: std::env::var("IWCI_TEST_SENTRY_FLAGS")
            .map(|f| f.split_whitespace().map(str::to_string).collect())
            .unwrap_or_default(),
    };
    let started = Instant::now();
    let mut sandbox = boot(
        release,
        &config,
        theirs,
        [stdin, out.into(), err.into()],
        log,
        link,
    )
    .unwrap();
    if let Err(e) = sandbox.start() {
        let log = std::fs::read_to_string(dir.join("sentry.log")).unwrap_or_default();
        let tail: Vec<&str> = log.lines().rev().take(60).collect();
        let tail: Vec<&str> = tail.into_iter().rev().collect();
        panic!("starting the sandbox: {e}\n{}", tail.join("\n"));
    }
    let status = sandbox.wait().unwrap();
    let millis = started.elapsed().as_millis();
    drop(sandbox);
    drop(gateway);
    serving.wait();
    let ran = Ran {
        status,
        stdout: std::fs::read_to_string(dir.join("stdout")).unwrap(),
        stderr: std::fs::read_to_string(dir.join("stderr")).unwrap(),
        millis,
    };
    if ran.status != 0 {
        let log = std::fs::read_to_string(dir.join("sentry.log")).unwrap_or_default();
        eprintln!("sentry log:\n{log}");
    }
    let _ = std::fs::remove_dir_all(&dir);
    ran
}

fn tempdir() -> PathBuf {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let base = std::env::var_os("IWCI_TEST_TMP").map_or_else(std::env::temp_dir, PathBuf::from);
    let dir = base.join(format!(
        "iwci-sb-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// `path type mode size` for everything under `root`, as the job's own
/// file system and modes describe it: what a WASIX job's `stat` reports.
fn view_of(job: &JobFs, root: &str) -> Vec<String> {
    let fs = job.as_dyn();
    let modes = job.modes();
    let mut out = Vec::new();
    let mut todo = vec![PathBuf::from(root)];
    while let Some(path) = todo.pop() {
        let meta = fs.symlink_metadata(&path).unwrap();
        let ft = meta.file_type();
        let (kind, perm, size) = if ft.is_symlink() {
            let target = fs.readlink(&path).unwrap();
            ("symbolic link", 0o777, target.as_os_str().len() as u64)
        } else if ft.is_dir() {
            for e in fs.read_dir(&path).unwrap().flatten() {
                todo.push(e.path);
            }
            ("directory", modes.get(&path).unwrap_or(0o755), meta.len)
        } else {
            ("regular file", modes.get(&path).unwrap_or(0o644), meta.len)
        };
        out.push(format!("{} {kind} {perm:o} {size}", path.display()));
    }
    out.sort();
    out
}

fn lines(s: &str) -> Vec<String> {
    let mut v: Vec<String> = s.lines().map(str::to_string).collect();
    v.sort();
    v
}

#[test]
#[ignore = "needs gVisor and a static busybox; see the module docs"]
fn a_sandboxed_shell_sees_and_changes_the_jobs_files() {
    let (Some(gvisor), Some(busybox)) = (input("IWCI_TEST_GVISOR"), input("IWCI_TEST_BUSYBOX"))
    else {
        return;
    };
    let release = Release { dir: gvisor };
    let job = snapshot(&busybox, |_| {});
    let expected_view = view_of(&job, "/work");

    let script = r#"
        set -e
        find /work | while read p; do stat -c '%n %F %a %s' "$p"; done > /tmp/view
        cat a.txt
        readlink link
        ./run.sh
        echo written > new.txt
        mkdir -p made/deep && echo deep > made/deep/f
        mv a.txt renamed.txt
        ln -s renamed.txt l2
        chmod 600 new.txt
        chmod +x made/deep/f
        rm sub/b.txt
        cat renamed.txt l2 >/dev/null
        dd if=/dev/zero of=sparse bs=1 count=1 seek=99999 2>/dev/null
        stat -c '%s' sparse
        mv made moved
        cat moved/deep/f
        rm -r moved/deep && mkdir moved/deep && ls moved/deep | wc -l
    "#;
    let ran = run(&release, &job, &["/bin/sh", "-c", script]);
    assert_eq!(ran.status, 0, "stderr: {}", ran.stderr);
    assert_eq!(ran.stdout, "hello\na.txt\nran\n100000\ndeep\n0\n");
    eprintln!("ran in {} ms", ran.millis);

    // The sandbox's view of the checkout was the job's.
    let view = job.read("/tmp/view").unwrap();
    assert_eq!(lines(&String::from_utf8(view).unwrap()), expected_view);

    // And its writes are the job's changes.
    let changes: Vec<String> = job
        .changes("/")
        .into_iter()
        .map(|c| match c {
            Change::Added { path, bytes } => format!("+ {} {}", path.display(), bytes.len()),
            Change::Modified { path, bytes } => format!("~ {} {}", path.display(), bytes.len()),
            Change::Deleted { path } => format!("- {}", path.display()),
        })
        .collect();
    let view_bytes: usize = expected_view.iter().map(|l| l.len() + 1).sum();
    assert_eq!(
        changes,
        [
            format!("+ /tmp/view {view_bytes}").as_str(),
            "- /work/a.txt",
            "+ /work/new.txt 8",
            "+ /work/renamed.txt 6",
            "+ /work/sparse 100000",
            "- /work/sub/b.txt",
        ]
    );
    let fs = job.as_dyn();
    assert_eq!(
        fs.readlink(Path::new("/work/l2")).unwrap(),
        PathBuf::from("renamed.txt")
    );
    assert!(fs.metadata(Path::new("/work/moved/deep")).unwrap().is_dir());
    assert_eq!(job.modes().get(Path::new("/work/new.txt")), Some(0o600));
}

#[test]
#[ignore = "needs gVisor and a static busybox; see the module docs"]
fn many_files_are_listed_and_read_quickly() {
    let (Some(gvisor), Some(busybox)) = (input("IWCI_TEST_GVISOR"), input("IWCI_TEST_BUSYBOX"))
    else {
        return;
    };
    let release = Release { dir: gvisor };
    const DIRS: usize = 100;
    const FILES: usize = 100;
    let job = snapshot(&busybox, |b| {
        for d in 0..DIRS {
            for f in 0..FILES {
                b.write(
                    format!("/work/big/d{d}/f{f}.js"),
                    format!("module.exports = {f};\n").as_bytes(),
                )
                .unwrap();
            }
        }
    });
    let empty = run(&release, &job, &["/bin/sh", "-c", "true"]);
    assert_eq!(empty.status, 0, "{}", empty.stderr);
    let listed = run(
        &release,
        &job,
        &["/bin/sh", "-c", "find /work/big -type f | wc -l"],
    );
    assert_eq!(listed.stdout.trim(), (DIRS * FILES).to_string());
    let read = run(
        &release,
        &job,
        &[
            "/bin/sh",
            "-c",
            "find /work/big -type f | xargs cat | wc -c",
        ],
    );
    assert_eq!(read.status, 0, "{}", read.stderr);
    eprintln!(
        "start and stop: {} ms; listing {} files: {} ms; reading them: {} ms",
        empty.millis,
        DIRS * FILES,
        listed.millis.saturating_sub(empty.millis),
        read.millis.saturating_sub(empty.millis),
    );
}

#[test]
#[ignore = "needs gVisor, a static busybox and Bun; see the module docs"]
fn bun_maps_writes_and_renames_through_the_server() {
    let (Some(gvisor), Some(busybox), Some(bun)) = (
        input("IWCI_TEST_GVISOR"),
        input("IWCI_TEST_BUSYBOX"),
        input("IWCI_TEST_BUN_ROOT"),
    ) else {
        return;
    };
    let release = Release { dir: gvisor };
    let job = snapshot(&busybox, |b| copy_tree(b, &bun, Path::new("/")));
    let script = r#"
        const fs = require("fs");
        fs.writeFileSync("/work/m.bin", Buffer.alloc(8192));
        const m = Bun.mmap("/work/m.bin", { shared: true });
        m[0] = 65; m[4096] = 66;
        const { Database } = require("bun:sqlite");
        const db = new Database("/work/db.sqlite");
        db.run("create table t (x)");
        db.run("insert into t values (42)");
        console.log(db.query("select x from t").get().x);
        db.close();
        fs.renameSync("/work/a.txt", "/work/b.txt");
        fs.chmodSync("/work/b.txt", 0o700);
        console.log((fs.statSync("/work/b.txt").mode & 0o777).toString(8));
        fs.symlinkSync("b.txt", "/work/sl");
        console.log(fs.readlinkSync("/work/sl"), fs.readFileSync("/work/sl", "utf8").trim());
        console.log(fs.readdirSync("/work").sort().join(","));
        const out = Bun.spawnSync(["/bin/sh", "-c", "echo from sh; ls /work | wc -l"]);
        process.stdout.write(out.stdout);
    "#;
    let ran = run(&release, &job, &["/usr/local/bin/bun", "-e", script]);
    assert_eq!(ran.status, 0, "stderr: {}", ran.stderr);
    assert_eq!(
        ran.stdout,
        "42\n700\nb.txt hello\nb.txt,db.sqlite,link,m.bin,run.sh,sl,sub\nfrom sh\n7\n"
    );
    let mapped = job.read("/work/m.bin").unwrap();
    assert_eq!(
        (mapped.len(), mapped[0], mapped[4096]),
        (8192, 65, 66),
        "a shared mapping writes back"
    );
    assert!(
        job.read("/work/db.sqlite")
            .unwrap()
            .starts_with(b"SQLite format 3")
    );
    assert_eq!(job.modes().get(Path::new("/work/b.txt")), Some(0o700));
    eprintln!("bun ran in {} ms", ran.millis);
}

/// The test's internet: one "public" address, served by a local HTTP
/// server, and names. Everything else is refused, as the runner's policy
/// refuses private and internal addresses.
struct FakeInternet {
    upstream: std::net::SocketAddr,
}

const PUBLIC: std::net::IpAddr = std::net::IpAddr::V4(std::net::Ipv4Addr::new(203, 0, 113, 7));

impl Outside for FakeInternet {
    fn allows(&self, ip: std::net::IpAddr) -> bool {
        ip == PUBLIC
    }
    fn connect(&self, to: std::net::SocketAddr) -> std::io::Result<std::net::TcpStream> {
        if to.port() != 8080 {
            return Err(std::io::ErrorKind::ConnectionRefused.into());
        }
        std::net::TcpStream::connect(self.upstream)
    }
    fn resolve(&self, name: &str) -> std::io::Result<Vec<std::net::IpAddr>> {
        match name {
            "upstream.test" => Ok(vec![PUBLIC]),
            "inside.test" => Ok(vec!["10.1.2.3".parse().unwrap()]),
            _ => Err(std::io::ErrorKind::NotFound.into()),
        }
    }
}

/// A tiny HTTP server answering every request with `body`.
fn http_upstream(body: &'static str) -> std::net::SocketAddr {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            std::thread::spawn(move || {
                let mut req = Vec::new();
                let mut buf = [0u8; 4096];
                while !req.windows(4).any(|w| w == b"\r\n\r\n") {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => return,
                        Ok(n) => req.extend_from_slice(&buf[..n]),
                    }
                }
                let _ = write!(
                    stream,
                    "HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
            });
        }
    });
    addr
}

fn fake_internet() -> Network {
    Network {
        outside: std::sync::Arc::new(FakeInternet {
            upstream: http_upstream("hello from upstream\n"),
        }),
        services: vec!["postgres".into()],
    }
}

#[test]
#[ignore = "needs gVisor and a static busybox; see the module docs"]
fn a_sandbox_reaches_allowed_addresses_and_shares_its_loopback() {
    let (Some(gvisor), Some(busybox)) = (input("IWCI_TEST_GVISOR"), input("IWCI_TEST_BUSYBOX"))
    else {
        return;
    };
    let release = Release { dir: gvisor };
    let job = snapshot(&busybox, |b| {
        b.write("/work/www/index.html", b"hello from the job\n")
            .unwrap();
    });
    let script = r#"
        wget -q -O- http://203.0.113.7:8080/
        wget -q -O- http://upstream.test:8080/
        wget -q -T 5 -O- http://10.1.2.3:8080/ 2>/dev/null && echo "internal address reached"
        wget -q -T 5 -O- http://inside.test:8080/ 2>/dev/null && echo "internal name reached"
        wget -q -T 5 -O- http://203.0.113.7:9999/ 2>/dev/null && echo "closed port reached"
        httpd -p 127.0.0.1:8081 -h /work/www
        sleep 1
        wget -q -O- http://127.0.0.1:8081/index.html
        wget -q -O- http://localhost:8081/index.html
        echo done
    "#;
    let ran = run_with(
        &release,
        &job,
        &["/bin/sh", "-c", script],
        Some(fake_internet()),
    );
    assert_eq!(ran.status, 0, "stderr: {}", ran.stderr);
    assert_eq!(
        ran.stdout,
        "hello from upstream\nhello from upstream\nhello from the job\nhello from the job\ndone\n"
    );
    eprintln!("network round trip in {} ms", ran.millis);
}

#[test]
#[ignore = "needs gVisor and a static busybox; see the module docs"]
fn without_a_network_only_the_loopback_is_there() {
    let (Some(gvisor), Some(busybox)) = (input("IWCI_TEST_GVISOR"), input("IWCI_TEST_BUSYBOX"))
    else {
        return;
    };
    let release = Release { dir: gvisor };
    let job = snapshot(&busybox, |b| {
        b.write("/work/www/index.html", b"still here\n").unwrap();
    });
    let script = r#"
        wget -q -T 5 -O- http://203.0.113.7:8080/ 2>/dev/null && echo "reached outside"
        httpd -p 127.0.0.1:8081 -h /work/www
        sleep 1
        wget -q -O- http://127.0.0.1:8081/index.html
    "#;
    let ran = run(&release, &job, &["/bin/sh", "-c", script]);
    assert_eq!(ran.status, 0, "stderr: {}", ran.stderr);
    assert_eq!(ran.stdout, "still here\n");
}

#[test]
#[ignore = "needs gVisor, a static busybox and Bun; see the module docs"]
fn bun_serves_on_the_loopback_and_fetches_through_the_gateway() {
    let (Some(gvisor), Some(busybox), Some(bun)) = (
        input("IWCI_TEST_GVISOR"),
        input("IWCI_TEST_BUSYBOX"),
        input("IWCI_TEST_BUN_ROOT"),
    ) else {
        return;
    };
    let release = Release { dir: gvisor };
    let job = snapshot(&busybox, |b| copy_tree(b, &bun, Path::new("/")));
    let script = r#"
        const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("from Bun.serve\n") });
        const url = `http://127.0.0.1:${server.port}/`;
        // Another process of the job reaches it.
        const wget = Bun.spawn(["wget", "-q", "-O-", url]);
        process.stdout.write(await new Response(wget.stdout).text());
        process.stdout.write(await (await fetch("http://upstream.test:8080/")).text());
        try {
            await fetch("http://10.1.2.3:8080/", { signal: AbortSignal.timeout(5000) });
            console.log("internal address reached");
        } catch {
            console.log("refused");
        }
        server.stop(true);
    "#;
    let ran = run_with(
        &release,
        &job,
        &["/usr/local/bin/bun", "-e", script],
        Some(fake_internet()),
    );
    assert_eq!(ran.status, 0, "stderr: {}", ran.stderr);
    assert_eq!(ran.stdout, "from Bun.serve\nhello from upstream\nrefused\n");
}
