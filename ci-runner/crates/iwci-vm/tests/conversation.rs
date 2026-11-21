//! The runner's side of the conversation ([`iwci_vm::agent`]) against the
//! real agent (`iwci_guest::serve`), over pipes, with a manifest tree in a
//! temporary directory standing in for the machine's disk. Everything but
//! QEMU: the job's files go in with their modes, a real shell runs the
//! script, and what it left comes back to be written into a job's files.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::time::Duration;

use iwci_vfs::{Entry, SnapshotBuilder};
use iwci_vm::agent::{Agent, Ran, Tick, Watch};
use iwci_vm::archive;
use iwci_vm_proto::{Collect, Exec, Network, PROTOCOL, Setup, Shell};

struct Temp(PathBuf);

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp() -> Temp {
    let dir = std::env::temp_dir().join(format!(
        "iwci-vm-conversation-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    Temp(dir.canonicalize().unwrap())
}

/// An agent serving a manifest tree under `root`, in a thread.
fn agent(root: &Path) -> (Agent, std::thread::JoinHandle<()>) {
    let (to_guest_r, to_guest_w) = std::io::pipe().unwrap();
    let (to_host_r, to_host_w) = std::io::pipe().unwrap();
    let root = root.to_path_buf();
    let guest = std::thread::spawn(move || {
        let mut tree = iwci_guest::Manifest::new(iwci_guest::Root::Dir(root));
        let _ = iwci_guest::serve(to_guest_r, to_host_w, &iwci_guest::Local, &mut tree);
    });
    (Agent::start(to_host_r, to_guest_w).unwrap(), guest)
}

const STEP: Duration = Duration::from_secs(30);

#[test]
fn a_job_goes_in_runs_and_comes_back() {
    let disk = temp();
    let (mut agent, guest) = agent(&disk.0);
    let hello = agent.hello(STEP).unwrap();
    assert_eq!(hello.protocol, PROTOCOL);
    assert!(hello.modes);
    agent
        .setup(
            Setup {
                protocol: PROTOCOL,
                time_ms: 0,
                hostname: "iwci".into(),
                network: Some(Network::standard()),
            },
            STEP,
        )
        .unwrap();

    // The job's files: a checkout with a script, as a workspace snapshot
    // forked for the job, and a file in the run's scratch.
    let ws = SnapshotBuilder::new();
    ws.write("/app/build.sh", b"#!/bin/sh\necho built > out/app.bin\n")
        .unwrap();
    ws.set_mode("/app/build.sh", 0o755).unwrap();
    ws.write("/app/old.txt", b"old").unwrap();
    ws.write("/app/keep.txt", b"keep").unwrap();
    let fs = ws.freeze().fork();
    fs.write("/iwci/output", b"").unwrap();
    let scratch = SnapshotBuilder::new().freeze().fork();
    scratch.write("/from-before.txt", b"earlier job").unwrap();
    let done = agent
        .put(
            &[
                ("/", &archive::whole(&fs)),
                ("/tmp/workflow", &archive::whole(&scratch)),
            ],
            STEP,
        )
        .unwrap();
    assert!(done.entries >= 5, "{done:?}");

    let mut out = Vec::new();
    let ran = agent
        .exec(
            Exec {
                shell: Shell::Sh,
                // `$ROOT` stands for `/`: the manifest tree is a directory
                // here, where a machine's root would be its own.
                script: r#"
cd "$ROOT/app"
mkdir -p out
./build.sh
rm old.txt
echo "version=1.2" > "$ROOT/iwci/output"
echo shared > "$ROOT/tmp/workflow/shared.txt"
echo "secret is $TOKEN"
echo oops >&2
"#
                .into(),
                env: vec![
                    ("ROOT".into(), disk.0.display().to_string()),
                    ("TOKEN".into(), "abc".into()),
                ],
                cwd: "/".into(),
            },
            Duration::from_millis(100),
            &mut |tick| {
                if let Tick::Output(err, data) = tick {
                    out.push((err, String::from_utf8_lossy(data).into_owned()));
                }
                Watch::Continue
            },
        )
        .unwrap();
    let Ran::Exited(exited) = ran else {
        panic!("stopped")
    };
    assert_eq!(exited.code, 0);
    let stdout: String = out.iter().filter(|o| !o.0).map(|o| o.1.as_str()).collect();
    let stderr: String = out.iter().filter(|o| o.0).map(|o| o.1.as_str()).collect();
    assert_eq!(stdout, "secret is abc\n");
    assert_eq!(stderr, "oops\n");

    let (collected, entries, done) = agent
        .collect(
            Collect {
                paths: vec!["/app".into(), "/iwci/output".into(), "/tmp/workflow".into()],
                repository: None,
                max_bytes: 1 << 20,
            },
            STEP,
        )
        .unwrap();
    assert!(!done.truncated);
    assert_eq!(collected.deleted, ["/app/old.txt"]);
    let mut files: Vec<(String, Option<u32>)> = entries
        .iter()
        .filter_map(|(e, m)| match e {
            Entry::File { path, .. } => Some((path.display().to_string(), m.map(|m| m & 0o777))),
            _ => None,
        })
        .collect();
    files.sort();
    // What the script wrote and nothing it did not touch: not `keep.txt`,
    // not the script, not the scratch file it was handed.
    assert_eq!(
        files,
        [
            ("/app/out/app.bin".to_string(), Some(0o644)),
            ("/iwci/output".to_string(), Some(0o644)),
            ("/tmp/workflow/shared.txt".to_string(), Some(0o644)),
        ]
    );
    let output = entries
        .iter()
        .find_map(|(e, _)| match e {
            Entry::File { path, data } if path == Path::new("/iwci/output") => Some(data.to_vec()),
            _ => None,
        })
        .unwrap();
    assert_eq!(output, b"version=1.2\n");

    agent.shutdown();
    drop(agent);
    guest.join().unwrap();
}

#[test]
fn a_failing_script_reports_its_exit_and_stops_when_asked() {
    let disk = temp();
    let (mut agent, guest) = agent(&disk.0);
    agent.hello(STEP).unwrap();
    agent
        .setup(
            Setup {
                protocol: PROTOCOL,
                time_ms: 0,
                hostname: "iwci".into(),
                network: None,
            },
            STEP,
        )
        .unwrap();
    agent.put(&[("/", &[])], STEP).unwrap();
    let ran = agent
        .exec(
            Exec {
                shell: Shell::Bash,
                script: "false\necho never".into(),
                env: vec![],
                cwd: "/".into(),
            },
            Duration::from_millis(100),
            &mut |_| Watch::Continue,
        )
        .unwrap();
    let Ran::Exited(exited) = ran else {
        panic!("stopped")
    };
    assert_eq!(exited.code, 1);

    // A watcher that says stop ends the wait at once, as a timeout does.
    let mut ticks = 0;
    let ran = agent
        .exec(
            Exec {
                shell: Shell::Sh,
                script: "sleep 30".into(),
                env: vec![],
                cwd: "/".into(),
            },
            Duration::from_millis(20),
            &mut |_| {
                ticks += 1;
                if ticks > 3 {
                    Watch::Stop
                } else {
                    Watch::Continue
                }
            },
        )
        .unwrap();
    assert!(matches!(ran, Ran::Stopped));
    // The runner stops the machine then; here, the agent's script is left
    // to end on its own.
    drop(agent);
    drop(guest);
}
