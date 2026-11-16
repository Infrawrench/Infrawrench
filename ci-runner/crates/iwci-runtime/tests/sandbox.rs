//! Jobs that run native Bun, whole, in a gVisor sandbox (`sandbox.rs`,
//! `inside`).
//!
//! These start sandboxes, so they need Linux, root (or a user allowed to
//! create user namespaces), and inputs from the environment; they are
//! ignored by default:
//!
//! - `IWCI_TEST_GVISOR`: the unpacked gVisor release;
//! - `IWCI_TEST_BUN_ROOT`: Bun and the C library it and the runner link, as
//!   they go in the sandbox (`iwci-sandbox/tests/fixtures.sh`);
//! - `IWCI_TEST_NODE_WEBC_DIR`: the `bash-node` environment's build
//!   directory;
//! - `IWCI_TEST_IWCI`: the runner binary that runs inside, built with
//!   `--features node`;
//! - `IWCI_TEST_CGROUP` (optional): a delegated cgroup subtree is there;
//! - `IWCI_TEST_CACHE` (optional): where compiled modules are kept;
//! - `IWCI_TEST_SPAWN_SOCKET` (optional): the sandbox service to start
//!   sandboxes through, as the runner hosts do.
//!
//! `IWCI_REQUIRE_FIXTURES` makes a missing input fail instead of skip.
//! `ci-runner-builtins.yml` runs them in its `bash-node` job, which has
//! all four: `fixtures.sh` for the first two, the environment it builds and
//! the runner it builds with V8. Elsewhere, the environment's build
//! directory is what `builtins/environments/build.sh bash-node` leaves in
//! `dist/environment/bash-node/<version>`.
#![cfg(target_os = "linux")]

use std::path::{Path, PathBuf};
use std::time::Duration;

use iwci_runtime::sandbox::{Content, NativeTool, Placed, SandboxHost};
use iwci_runtime::{Invocation, Limits, Outcome, PathTree, Runtime, WebcPackage};
use iwci_vfs::{JobFs, SnapshotBuilder};
use shared_buffer::OwnedBuffer;

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

struct Fixture {
    runtime: Runtime,
    host: SandboxHost,
    bun: NativeTool,
    packages: Vec<WebcPackage>,
    _dir: TempDir,
}

struct TempDir(PathBuf);

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp_dir(tag: &str) -> TempDir {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let base = std::env::var_os("IWCI_TEST_TMP").map_or_else(std::env::temp_dir, PathBuf::from);
    let dir = base.join(format!(
        "iwci-sbx-{tag}-{}-{}",
        std::process::id(),
        N.fetch_add(1, Ordering::SeqCst)
    ));
    std::fs::create_dir_all(&dir).unwrap();
    TempDir(dir)
}

/// Every file under `root`, placed at its path below it.
fn place_tree(root: &Path, at: &Path, out: &mut Vec<Placed>) {
    use std::os::unix::fs::PermissionsExt;
    for entry in std::fs::read_dir(at).unwrap() {
        let entry = entry.unwrap();
        let path = entry.path();
        let meta = std::fs::symlink_metadata(&path).unwrap();
        let guest = Path::new("/").join(path.strip_prefix(root).unwrap());
        if meta.is_dir() {
            place_tree(root, &path, out);
        } else if meta.is_symlink() {
            out.push(Placed {
                path: guest,
                content: Content::Symlink(std::fs::read_link(&path).unwrap()),
            });
        } else {
            out.push(Placed {
                path: guest,
                content: Content::File {
                    bytes: OwnedBuffer::from_file(&std::fs::File::open(&path).unwrap()).unwrap(),
                    mode: meta.permissions().mode() & 0o7777,
                },
            });
        }
    }
}

fn packages(dir: &Path) -> Vec<WebcPackage> {
    let read = |file: &str| std::fs::read(dir.join(file)).unwrap();
    let build: serde_json::Value = serde_json::from_slice(&read("build.json")).unwrap();
    build["packages"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| {
            let field = |k: &str| p[k].as_str().unwrap();
            WebcPackage::new(field("name"), field("version"), read(field("file")))
        })
        .collect()
}

fn fixture() -> Option<Fixture> {
    let gvisor = input("IWCI_TEST_GVISOR")?;
    let bun_root = input("IWCI_TEST_BUN_ROOT")?;
    let webc = input("IWCI_TEST_NODE_WEBC_DIR")?;
    let iwci = input("IWCI_TEST_IWCI")?;
    let dir = temp_dir("rt");
    let mut placed = Vec::new();
    place_tree(&bun_root, &bun_root, &mut placed);
    let (bun_files, system): (Vec<Placed>, Vec<Placed>) = placed
        .into_iter()
        .partition(|p| p.path.starts_with("/usr/local/bin"));
    let mut bun_files = bun_files;
    bun_files.push(Placed {
        path: "/usr/local/bin/bunx".into(),
        content: Content::Symlink("bun".into()),
    });
    let bun = NativeTool {
        files: bun_files,
        commands: vec![
            ("bun".into(), "/usr/local/bin/bun".into()),
            ("bunx".into(), "/usr/local/bin/bun".into()),
        ],
    };
    // `IWCI_TEST_CACHE` keeps compiled modules between runs.
    let cache =
        std::env::var_os("IWCI_TEST_CACHE").map_or_else(|| dir.0.join("cache"), PathBuf::from);
    let runtime = Runtime::new(cache)
        .unwrap()
        .with_internet()
        .with_stall_after(Some(Duration::from_secs(8)));
    let host = SandboxHost::new(
        gvisor,
        &iwci,
        system,
        dir.0.join("sb"),
        std::env::var_os("IWCI_TEST_CGROUP").is_some(),
    )
    .unwrap();
    // Through the sandbox service, as on the runner hosts, when one is
    // given.
    let host = match std::env::var_os("IWCI_TEST_SPAWN_SOCKET") {
        Some(socket) => host.with_service(socket.into()),
        None => host,
    };
    Some(Fixture {
        runtime,
        host,
        bun,
        packages: packages(&webc),
        _dir: dir,
    })
}

fn job(files: &[(&str, &str)]) -> JobFs {
    let b = SnapshotBuilder::new();
    b.mkdir_all("/work").unwrap();
    b.mkdir_all("/root").unwrap();
    for (path, text) in files {
        b.write(path, text.as_bytes()).unwrap();
    }
    b.freeze().fork()
}

fn invocation(job: &JobFs) -> Invocation {
    Invocation {
        args: Vec::new(),
        env: vec![("HOME".into(), "/root".into())],
        cwd: "/work".into(),
        fs: job.as_dyn(),
        limits: Limits {
            timeout: Duration::from_secs(120),
            memory_bytes: 1 << 30,
        },
        log: None,
        scratch: None,
        commands: Vec::new(),
        trees: Vec::new(),
        internet: false,
        modes: job.modes(),
        services: Vec::new(),
        cancel: None,
        memory_watch: None,
    }
}

impl Fixture {
    fn run(&self, inv: Invocation, script: &str) -> Outcome {
        let started = std::time::Instant::now();
        let outcome = self
            .runtime
            .run_script_sandboxed(
                &self.host,
                std::slice::from_ref(&self.bun),
                &self.packages,
                "bash",
                script,
                inv,
                None,
            )
            .unwrap();
        eprintln!(
            "--- exit {} in {} ms, peak {} MiB, oom {}\nstdout:\n{}\nstderr:\n{}",
            outcome.exit_code,
            started.elapsed().as_millis(),
            outcome.peak_memory_bytes >> 20,
            outcome.out_of_memory,
            String::from_utf8_lossy(&outcome.stdout),
            String::from_utf8_lossy(&outcome.stderr)
        );
        outcome
    }
}

fn text(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

#[test]
#[ignore = "needs gVisor, Bun, the bash-node environment and the runner; see the module docs"]
fn a_script_runs_bun_and_bun_runs_the_environments_commands() {
    let Some(fx) = fixture() else { return };
    let job = job(&[("/work/a.txt", "hello\n")]);
    let script = r#"
        echo "from bash"
        cat a.txt
        bun --version
        bun -e 'console.log("from bun", 6 * 7)'
        bun -e '
          const r = Bun.spawnSync(["bash", "-c", "echo from bash under bun; exit 3"]);
          process.stdout.write(r.stdout);
          console.log("bash exited", r.exitCode);
          const n = Bun.spawnSync(["node", "-e", "console.log(\"from node under bun\")"]);
          process.stdout.write(n.stdout);
          process.stderr.write(n.stderr);
          const l = Bun.spawnSync(["sh", "-c", "ls /work | sort"]);
          process.stdout.write(l.stdout);
        '
        echo piped | bun -e 'process.stdin.on("data", d => process.stdout.write("bun read " + d))'
        bun -e 'process.exit(7)' || echo "bun exited $?"
        echo done
    "#;
    let out = fx.run(invocation(&job), script);
    assert_eq!(out.exit_code, 0, "{}", text(&out.stderr));
    let stdout = text(&out.stdout);
    for line in [
        "from bash",
        "hello",
        "from bun 42",
        "from bash under bun",
        "bash exited 3",
        "from node under bun",
        "a.txt",
        "bun read piped",
        "bun exited 7",
        "done",
    ] {
        assert!(stdout.lines().any(|l| l == line), "{line:?} in {stdout}");
    }
}

#[test]
#[ignore = "needs gVisor, Bun, the bash-node environment and the runner; see the module docs"]
fn a_node_tool_runs_beside_bun() {
    // A Node tool (`abi: node`, such as builtin:vercel) and a native one
    // in the same job: the tool's directory is mounted read only in the
    // sandbox, at the same path as outside, and its command runs from the
    // script and from Bun.
    // The isolate reads files in the sandbox's read-only mounts, the tool's
    // and the runner's own: those reads failed with EIO
    // (`inside::ReadOnlyMounts`).
    let Some(fx) = fixture() else { return };
    let dir = "/usr/local/lib/iwci/tools/greet/1.0.0";
    let tool = SnapshotBuilder::new();
    tool.write(
        "/cli.js",
        b"console.log(\"hello \" + process.argv.slice(2).join(\" \"));\n",
    )
    .unwrap();
    let job = job(&[]);
    let mut inv = invocation(&job);
    inv.trees.push(PathTree {
        name: "greet".into(),
        dir: dir.into(),
        fs: tool.freeze().read_only(),
        scripts: vec![(
            "greet".into(),
            format!("#!/bin/bash\nexec node '{dir}/cli.js' \"$@\"\n").into_bytes(),
        )],
        needs: Some("node".into()),
    });
    let script = format!(
        r#"
        greet from bash
        bun -e 'const r = Bun.spawnSync(["greet", "from bun"]); process.stdout.write(r.stdout); process.stderr.write(r.stderr);'
        bun -e 'console.log(require("fs").readFileSync("{dir}/cli.js", "utf8").includes("hello") ? "bun reads the tool" : "no")'
        if touch {dir}/new 2>/dev/null; then echo writable; else echo read only; fi
        test "$(head -c 1 /.iwci/job/job.json)" = "{{" && echo "bash reads the runner's mount"
        bun -e 'try {{ require("fs").writeFileSync("{dir}/new", "x"); console.log("writable"); }} catch {{ console.log("read only for bun"); }}'
    "#
    );
    let out = fx.run(inv, &script);
    assert_eq!(out.exit_code, 0, "{}", text(&out.stderr));
    let stdout = text(&out.stdout);
    for line in [
        "hello from bash",
        "hello from bun",
        "bun reads the tool",
        "read only",
        "read only for bun",
        "bash reads the runner's mount",
    ] {
        assert!(stdout.lines().any(|l| l == line), "{line:?} in {stdout}");
    }
}

#[test]
#[ignore = "needs gVisor, Bun, the bash-node environment and the runner; see the module docs"]
fn bun_and_the_isolate_share_files_modes_and_the_loopback() {
    let Some(fx) = fixture() else { return };
    let job = job(&[("/work/a.txt", "hello\n")]);
    let script = r#"
        bun -e '
          const fs = require("fs");
          fs.writeFileSync("/work/from-bun.txt", "bun wrote this\n");
          fs.chmodSync("/work/from-bun.txt", 0o750);
        '
        cat /work/from-bun.txt
        stat -c '%a' /work/from-bun.txt
        node -e 'console.log((require("fs").statSync("/work/from-bun.txt").mode & 0o777).toString(8))'
        echo "from bash" > /work/from-bash.txt
        chmod 711 /work/from-bash.txt
        bun -e 'const fs = require("fs"); console.log(fs.readFileSync("/work/from-bash.txt", "utf8").trim(), (fs.statSync("/work/from-bash.txt").mode & 0o777).toString(8))'
        bun -e '
          const server = Bun.serve({ hostname: "127.0.0.1", port: 4567, fetch: () => new Response("from Bun.serve") });
          const node = Bun.spawn(["node", "-e", "fetch(\"http://127.0.0.1:4567/\").then(r => r.text()).then(t => console.log(\"node got\", t))"], { stderr: "inherit" });
          process.stdout.write(await new Response(node.stdout).text());
          await node.exited;
          server.stop(true);
        '
        node -e '
          require("http").createServer((q, s) => s.end("from node")).listen(4568, "127.0.0.1", () => {
            require("child_process").exec("bun -e \"console.log(\\\"bun got\\\", await (await fetch(\\\"http://127.0.0.1:4568/\\\")).text())\"", (e, out, err) => {
              process.stdout.write(out); process.stderr.write(err); process.exit(e ? 1 : 0);
            });
          });
        '
    "#;
    let out = fx.run(invocation(&job), script);
    assert_eq!(out.exit_code, 0, "{}", text(&out.stderr));
    let stdout = text(&out.stdout);
    for line in [
        "bun wrote this",
        "750",
        "from bash 711",
        "node got from Bun.serve",
        "bun got from node",
    ] {
        assert!(stdout.lines().any(|l| l == line), "{line:?} in {stdout}");
    }
    assert_eq!(
        stdout.lines().filter(|l| *l == "750").count(),
        2,
        "stat and node both see bun's mode: {stdout}"
    );
    assert_eq!(job.read("/work/from-bun.txt").unwrap(), b"bun wrote this\n");
    assert_eq!(
        job.modes().get(Path::new("/work/from-bun.txt")),
        Some(0o750)
    );
    assert_eq!(
        job.modes().get(Path::new("/work/from-bash.txt")),
        Some(0o711)
    );
}

#[test]
#[ignore = "needs gVisor, Bun, the bash-node environment and the runner; see the module docs"]
fn a_service_is_reached_from_bun_and_scripts_run_both_ways() {
    let Some(fx) = fixture() else { return };
    let job = job(&[]);
    let mut inv = invocation(&job);
    inv.services.push(iwci_runtime::Service {
        name: "api".into(),
        program: iwci_runtime::ServiceProgram::Script {
            packages: fx.packages.clone(),
            entry: "bash".into(),
            script: r#"node -e 'require("http").createServer((q, s) => s.end("from the service")).listen(3000, "127.0.0.1")'"#.into(),
        },
        env: Vec::new(),
        ready: iwci_runtime::Ready::Port(3000),
        ready_timeout: Duration::from_secs(60),
    });
    let script = r#"
        bun -e 'console.log("bun got", await (await fetch("http://api:3000/")).text())'
        printf '#!/usr/bin/env node\nconsole.log("node from a shebang")\n' > tool.js
        chmod +x tool.js
        printf '#!/usr/bin/env bun\nconsole.log("bun from a shebang", typeof Bun)\n' > btool.js
        chmod +x btool.js
        ./btool.js
        bun -e 'process.stdout.write(Bun.spawnSync(["./tool.js"]).stdout)'
        git init -q repo
        cd repo
        echo x > f
        bun -e 'process.stdout.write(Bun.spawnSync(["git", "status", "--porcelain"]).stdout)'
        bun -e 'const { execSync } = require("child_process"); process.stdout.write(execSync("echo $((6*7)) from execSync"))'
    "#;
    let out = fx.run(inv, script);
    assert_eq!(out.exit_code, 0, "{}", text(&out.stderr));
    let stdout = text(&out.stdout);
    for line in [
        "bun got from the service",
        "bun from a shebang object",
        "node from a shebang",
        "?? f",
        "42 from execSync",
    ] {
        assert!(stdout.lines().any(|l| l == line), "{line:?} in {stdout}");
    }
}

#[test]
#[ignore = "needs gVisor, Bun, the bash-node environment, the runner and a delegated cgroup; see the module docs"]
fn a_sandboxed_job_is_stopped_at_its_timeout_and_its_memory() {
    let Some(fx) = fixture() else { return };
    if std::env::var_os("IWCI_TEST_CGROUP").is_none() {
        return;
    }
    // Compiled first, so the five seconds are the job's alone (a cold
    // cache, as in CI, takes longer than that to start a sandbox).
    let job = self::job(&[]);
    let warm = fx.run(invocation(&job), "true");
    assert_eq!(warm.exit_code, 0, "{}", text(&warm.stderr));
    let mut inv = invocation(&job);
    inv.limits.timeout = Duration::from_secs(5);
    let started = std::time::Instant::now();
    let out = fx.run(inv, "echo started; bun -e 'setInterval(() => {}, 1000)'");
    assert!(out.timed_out, "{out:?}");
    assert_eq!(out.exit_code, iwci_runtime::TIMEOUT_EXIT_CODE);
    assert_eq!(text(&out.stdout), "started\n");
    assert!(
        started.elapsed() < Duration::from_secs(15),
        "{:?}",
        started.elapsed()
    );

    let job = self::job(&[]);
    let mut inv = invocation(&job);
    inv.limits.memory_bytes = 256 << 20;
    let out = fx.run(
        inv,
        "bun -e 'const a = []; for (;;) a.push(Buffer.alloc(1 << 20, 1))'; echo after",
    );
    assert!(out.out_of_memory, "{out:?}");
    assert!(
        text(&out.stderr).contains("ran out of its 256 MiB of memory"),
        "{}",
        text(&out.stderr)
    );
    // The job's share: the whole of its `memory:`, the sandbox's own on top.
    assert!(
        out.peak_memory_bytes <= (256 << 20) + (1 << 20),
        "{}",
        out.peak_memory_bytes
    );
    assert!(
        out.peak_memory_bytes > 200 << 20,
        "{}",
        out.peak_memory_bytes
    );
}

#[test]
#[ignore = "prints what a sandbox costs; needs what the others do"]
fn what_a_sandbox_costs() {
    let Some(fx) = fixture() else { return };
    for script in [
        "true",
        "bun -e 1",
        "node -e 1",
        "bun -e 1; node -e 1",
        "for i in 1 2 3 4 5; do bun -e 1; done",
    ] {
        let job = job(&[]);
        let started = std::time::Instant::now();
        let out = fx.run(invocation(&job), script);
        println!(
            "COST {script:?}: exit {} in {} ms, job peak {} MiB, sandbox {:?}",
            out.exit_code,
            started.elapsed().as_millis(),
            out.peak_memory_bytes >> 20,
            out.sandbox
        );
    }
}

#[test]
#[ignore = "needs gVisor, Bun, the bash-node environment, the runner and a delegated cgroup; see the module docs"]
fn a_sandboxs_own_memory_is_measured_and_capped() {
    let Some(fx) = fixture() else { return };
    if std::env::var_os("IWCI_TEST_CGROUP").is_none() {
        return;
    }
    let job = job(&[]);
    let out = fx.run(invocation(&job), "true");
    let sandbox = out
        .sandbox
        .expect("a sandboxed job says what its sandbox took");
    // If this fails, the runtime grew: measure it and move the constant.
    assert!(
        sandbox.overhead_bytes > 32 << 20
            && sandbox.overhead_bytes < iwci_runtime::sandbox::DEFAULT_OVERHEAD,
        "{sandbox:?}"
    );
    assert_eq!(sandbox.reserved_bytes, fx.host.overhead());
    assert!(
        out.peak_memory_bytes < 128 << 20,
        "a job of `true` holds little: {}",
        out.peak_memory_bytes
    );
    assert!(sandbox.cpu_usec > 0, "{sandbox:?}");
}

#[test]
#[ignore = "needs gVisor, Bun, the bash-node environment, the runner and a delegated cgroup; see the module docs"]
fn a_silent_sandboxed_job_stalls_and_a_cancelled_one_stops() {
    let Some(fx) = fixture() else { return };
    if std::env::var_os("IWCI_TEST_CGROUP").is_none() {
        return;
    }
    // No output and no CPU use for the stall check's 8 s: an idle sandbox
    // is idle (gVisor's kernel's own ticks stay under the threshold).
    let job = job(&[]);
    let started = std::time::Instant::now();
    let out = fx.run(
        invocation(&job),
        "echo waiting; bun -e 'setTimeout(() => {}, 600000)'",
    );
    assert_eq!(out.stalled_after, Some(Duration::from_secs(8)), "{out:?}");
    assert_eq!(out.exit_code, iwci_runtime::TIMEOUT_EXIT_CODE);
    assert!(
        started.elapsed() < Duration::from_secs(60),
        "{:?}",
        started.elapsed()
    );

    // A busy job is not stalled; a cancel stops it.
    let job = self::job(&[]);
    let mut inv = invocation(&job);
    let cancel = iwci_runtime::Cancel::new();
    inv.cancel = Some(cancel.clone());
    let cancelling = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(12));
        cancel.cancel();
    });
    let out = fx.run(inv, "bun -e 'for (;;) {}'");
    cancelling.join().unwrap();
    assert!(out.cancelled, "{out:?}");
    assert!(out.stalled_after.is_none(), "{out:?}");
    assert!(out.sandbox.unwrap().cpu_usec > 8_000_000, "{out:?}");
}

/// Runs `IWCI_TEST_SCRIPT` in a sandbox and prints what happened: for
/// looking into one case by hand.
#[test]
#[ignore = "runs IWCI_TEST_SCRIPT; needs what the others do"]
fn a_script_from_the_environment() {
    let Some(fx) = fixture() else { return };
    let Ok(script) = std::env::var("IWCI_TEST_SCRIPT") else {
        return;
    };
    let job = job(&[]);
    let mut inv = invocation(&job);
    inv.limits.timeout = Duration::from_secs(60);
    let out = fx.run(inv, &script);
    println!("SCRIPT exit {} timed out {}", out.exit_code, out.timed_out);
}

// The conformance suite: the same job, run as a WASIX job and in a sandbox
// beside Bun, behaves the same. Each case runs both and compares what a
// job's report and its files say.

/// What a run left that a report or a later job sees.
#[derive(Debug, PartialEq)]
struct Seen {
    exit_code: i32,
    stdout: String,
    stderr: String,
    changes: Vec<String>,
    modes: Vec<(PathBuf, u32)>,
    timed_out: bool,
    stalled: bool,
    cancelled: bool,
    out_of_memory: bool,
}

fn seen(out: &Outcome, job: &JobFs) -> Seen {
    let changes = job
        .changes("/work")
        .into_iter()
        .map(|c| match c {
            iwci_vfs::Change::Added { path, bytes } => {
                format!("+ {} {}", path.display(), bytes.len())
            }
            iwci_vfs::Change::Modified { path, bytes } => {
                format!("~ {} {}", path.display(), bytes.len())
            }
            iwci_vfs::Change::Deleted { path } => format!("- {}", path.display()),
        })
        .collect();
    let mut modes: Vec<(PathBuf, u32)> = job
        .modes()
        .recorded()
        .into_iter()
        .filter(|(p, _)| p.starts_with("/work"))
        .collect();
    modes.sort();
    Seen {
        exit_code: out.exit_code,
        stdout: text(&out.stdout),
        stderr: text(&out.stderr),
        changes,
        modes,
        timed_out: out.timed_out,
        stalled: out.stalled_after.is_some(),
        cancelled: out.cancelled,
        out_of_memory: out.out_of_memory,
    }
}

impl Fixture {
    /// `script` as a WASIX job and in a sandbox, each over a fresh job made
    /// by `job`, with `inv` adjusting each invocation.
    fn both(
        &self,
        job: impl Fn() -> JobFs,
        inv: impl Fn(Invocation) -> Invocation,
        script: &str,
    ) -> (Seen, Seen) {
        let plain = job();
        let out = self
            .runtime
            .run_script(&self.packages, "bash", script, inv(invocation(&plain)))
            .unwrap();
        eprintln!(
            "--- WASIX: exit {}\nstdout:\n{}\nstderr:\n{}",
            out.exit_code,
            text(&out.stdout),
            text(&out.stderr)
        );
        let wasix = seen(&out, &plain);
        let boxed = job();
        let out = self.run(inv(invocation(&boxed)), script);
        (wasix, seen(&out, &boxed))
    }
}

fn checkout() -> JobFs {
    let b = SnapshotBuilder::new();
    b.mkdir_all("/root").unwrap();
    b.write("/work/README.md", b"# fixture\n").unwrap();
    b.write("/work/src/main.ts", b"console.log(1)\n").unwrap();
    b.write("/work/bin/run.sh", b"#!/bin/sh\necho ran\n")
        .unwrap();
    b.set_mode("/work/bin/run.sh", 0o755).unwrap();
    b.symlink("/work/link", "README.md").unwrap();
    b.write("/work/old.txt", b"old\n").unwrap();
    b.freeze().fork()
}

#[test]
#[ignore = "needs gVisor, Bun, the bash-node environment and the runner; see the module docs"]
fn conformance_files_listings_writes_and_modes() {
    let Some(fx) = fixture() else { return };
    let script = r#"
        find /work | sort | while read -r p; do stat -c '%n %F %a %s' "$p"; done
        cat README.md src/main.ts link
        ./bin/run.sh
        sha256sum README.md src/main.ts
        echo new > new.txt
        mkdir -p made/deep && echo deep > made/deep/f
        chmod 600 new.txt
        chmod +x made/deep/f
        mv old.txt moved.txt
        ln -s moved.txt l2
        rm src/main.ts
        node -e 'const fs = require("fs"); fs.writeFileSync("/work/from-node.txt", "node\n"); fs.chmodSync("/work/from-node.txt", 0o640); console.log((fs.statSync("/work/bin/run.sh").mode & 0o777).toString(8))'
        stat -c '%a' new.txt made/deep/f from-node.txt
        find /work -type l | sort
        readlink l2
        find /work -newer /work/README.md | sort
    "#;
    let (wasix, boxed) = fx.both(checkout, |i| i, script);
    assert_eq!(wasix, boxed);
}

#[test]
#[ignore = "needs gVisor, Bun, the bash-node environment and the runner; see the module docs"]
fn conformance_the_runs_scratch_directory_and_lent_files() {
    let Some(fx) = fixture() else { return };
    let scratch = SnapshotBuilder::new().freeze().fork();
    let lent = || {
        let job = checkout();
        // As the scheduler lends a key: its file, its mode, its directory's.
        job.write("/root/.ssh/id_test", b"KEY\n").unwrap();
        job.modes().set(Path::new("/root/.ssh/id_test"), 0o600);
        job.modes().set(Path::new("/root/.ssh"), 0o700);
        job
    };
    let with_scratch = |mut i: Invocation| {
        i.scratch = Some(scratch.as_dyn());
        i
    };
    let script = r#"
        stat -c '%a' /root/.ssh /root/.ssh/id_test
        cat /root/.ssh/id_test
        n=$(ls /tmp/workflow | wc -l)
        echo "step $n" > /tmp/workflow/step-$n
        ls /tmp/workflow | sort | tr '\n' ' '
    "#;
    let (first, second) = fx.both(lent, with_scratch, script);
    assert_eq!(first.stdout, "700\n600\nKEY\nstep-0 ");
    assert_eq!(
        second.stdout, "700\n600\nKEY\nstep-0 step-1 ",
        "the sandbox saw what the WASIX job left in /tmp/workflow, and added to it"
    );
    assert_eq!(scratch.read("/step-1").unwrap(), b"step 1\n");
    // And Bun sees the lent file's mode.
    let job = lent();
    let out = fx.run(
        invocation(&job),
        "bun -e 'console.log((require(\"fs\").statSync(\"/root/.ssh/id_test\").mode & 0o777).toString(8))'",
    );
    assert_eq!(text(&out.stdout), "600\n");
}

#[test]
#[ignore = "needs gVisor, Bun, the bash-node environment and the runner; see the module docs"]
fn conformance_the_network_refuses_the_same_addresses() {
    let Some(fx) = fixture() else { return };
    // Something of the host's listening on its loopback, which no job may
    // reach.
    let host = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = host.local_addr().unwrap().port();
    let script = format!(
        r#"
        node -e '
          const net = require("net");
          const targets = [["127.0.0.1", {port}], ["10.1.2.3", 80], ["172.16.0.1", 80], ["192.168.1.1", 80],
                           ["100.64.0.1", 80], ["169.254.169.254", 80], ["fd00::1", 80], ["::ffff:10.0.0.1", 80]];
          let left = targets.length;
          for (const [host, port] of targets) {{
            const s = net.connect({{ host, port }});
            s.setTimeout(5000, () => {{ console.log(host, "timed out"); s.destroy(); if (!--left) process.exit(0); }});
            s.on("connect", () => {{ console.log(host, "connected"); s.destroy(); if (!--left) process.exit(0); }});
            s.on("error", e => {{ console.log(host, "refused", e.code); if (!--left) process.exit(0); }});
          }}
        ' | sort
        node -e 'require("dns").lookup("localhost", (e, a) => console.log("localhost", e ? e.code : a))'
    "#
    );
    for internet in [true, false] {
        let (wasix, boxed) = fx.both(
            checkout,
            |mut i| {
                i.internet = internet;
                i
            },
            &script,
        );
        assert_eq!(wasix, boxed, "internet: {internet}");
        assert!(!wasix.stdout.contains("connected"), "{}", wasix.stdout);
    }
    // Bun's own connections are held to the same addresses by the gateway.
    let job = checkout();
    let mut inv = invocation(&job);
    inv.internet = true;
    let out = fx.run(
        inv,
        &format!(
            r#"bun -e '
              for (const url of ["http://127.0.0.1:{port}/", "http://10.1.2.3/", "http://169.254.169.254/", "http://[fd00::1]/"]) {{
                try {{ await fetch(url, {{ signal: AbortSignal.timeout(5000) }}); console.log(url, "reached"); }}
                catch (e) {{ console.log(url, "refused"); }}
              }}'"#
        ),
    );
    assert!(
        !text(&out.stdout).contains("reached"),
        "{}",
        text(&out.stdout)
    );
    assert_eq!(text(&out.stdout).matches("refused").count(), 4);
    drop(host);
}

#[test]
#[ignore = "needs gVisor, Bun, the bash-node environment, the runner and a delegated cgroup; see the module docs"]
fn conformance_memory_time_stall_and_cancel_end_a_job_the_same_way() {
    let Some(fx) = fixture() else { return };
    if std::env::var_os("IWCI_TEST_CGROUP").is_none() {
        return;
    }
    let oom = "node -e 'const a = []; for (;;) a.push(Buffer.alloc(1 << 20, 1))'";
    let (wasix, boxed) = fx.both(
        checkout,
        |mut i| {
            i.limits.memory_bytes = 512 << 20;
            i
        },
        oom,
    );
    assert!(
        wasix.out_of_memory && boxed.out_of_memory,
        "{wasix:?}\n{boxed:?}"
    );
    assert_ne!(wasix.exit_code, 0);
    assert_ne!(boxed.exit_code, 0);
    for s in [&wasix, &boxed] {
        assert!(s.stderr.contains("iwci:"), "a note says why: {s:?}");
    }

    let (wasix, boxed) = fx.both(
        checkout,
        |mut i| {
            i.limits.timeout = Duration::from_secs(5);
            i
        },
        "echo started; while :; do :; done",
    );
    assert_eq!(wasix, boxed);
    assert!(wasix.timed_out);

    let (wasix, boxed) = fx.both(checkout, |i| i, "echo started; sleep 600");
    assert_eq!(wasix, boxed);
    assert!(wasix.stalled);

    let (wasix, boxed) = fx.both(
        checkout,
        |mut i| {
            let cancel = iwci_runtime::Cancel::new();
            let later = cancel.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(3));
                later.cancel();
            });
            i.cancel = Some(cancel);
            i
        },
        "echo started; while :; do :; done",
    );
    assert_eq!(wasix, boxed);
    assert!(wasix.cancelled);
}
