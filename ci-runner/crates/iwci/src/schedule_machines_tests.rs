//! `platform: linux` jobs in the scheduler, with a
//! fake machine that does what its script names: the job's files and the
//! run's scratch go in, what the job left comes back through
//! `machines::apply`, and everything after reads them as for any job.

use super::*;
use crate::machines::{Collected, MachineRun, Machines, apply};
use iwci_spec::VmOs;

/// What a fake machine was given, by job id.
#[derive(Default)]
struct Seen {
    env: HashMap<String, Vec<(String, String)>>,
    /// The job's `cpus:` as the machine was given it.
    cpus: HashMap<String, Option<u32>>,
    collect: HashMap<String, crate::machines::Collecting>,
    /// The files under `/app/out` and in the scratch when it started.
    started_with: HashMap<String, Vec<String>>,
}

/// Has Linux machines only. The script is a list of words:
/// - `build`: writes `/app/out/app.bin` and `version=1.2` to the output;
/// - `edit`: changes `/app/src/a.ts` and deletes the installed module;
/// - `share`: writes `/tmp/workflow/shared.txt`;
/// - `venv`: makes `/app/.venv`, which ignores itself as Python's does;
/// - `nvm`: installs Node 22 under `/root/.nvm/versions` unless the job
///   started with it, and says which on stdout;
/// - `fail`: exits 2.
pub(super) struct FakeMachines {
    seen: Mutex<Seen>,
    /// The image's caches.
    caches: Vec<crate::env_cache::EnvCacheDecl>,
}

impl FakeMachines {
    pub(super) fn new() -> Self {
        Self {
            seen: Mutex::default(),
            caches: Vec::new(),
        }
    }
}

fn files(fs: &iwci_vfs::JobFs, root: &str) -> Vec<String> {
    let mut out: Vec<String> = fs
        .entries_under(&[root])
        .into_iter()
        .filter_map(|e| match e {
            iwci_vfs::Entry::File { path, .. } => Some(path.display().to_string()),
            _ => None,
        })
        .collect();
    out.sort();
    out
}

impl Machines for FakeMachines {
    fn platforms(&self) -> Vec<VmOs> {
        vec![VmOs::Linux]
    }

    fn overhead(&self, _os: VmOs) -> u64 {
        128 << 20
    }

    fn env_caches(&self, _os: VmOs) -> Vec<crate::env_cache::EnvCacheDecl> {
        self.caches.clone()
    }

    fn run(&self, run: MachineRun<'_>) -> Result<Execution, String> {
        let Action::Script { script } = &run.job.action else {
            return Err("a machine runs a script".into());
        };
        {
            let mut seen = self.seen.lock().unwrap();
            seen.env.insert(run.job.id.clone(), run.env.clone());
            seen.cpus.insert(run.job.id.clone(), run.job.cpus);
            seen.collect.insert(run.job.id.clone(), run.collect.clone());
            let mut start = files(run.fs, "/app/out");
            start.extend(
                files(run.scratch.fs(), "/")
                    .into_iter()
                    .map(|p| format!("scratch:{p}")),
            );
            seen.started_with.insert(run.job.id.clone(), start);
        }
        let output = run
            .env
            .iter()
            .find(|(k, _)| k == "IWCI_OUTPUT")
            .map(|(_, v)| v.clone())
            .unwrap();
        let mut back = Collected::default();
        let mut shared = Collected::default();
        let mut exit_code = 0;
        let mut stdout = format!("ran {script}\n");
        let file = |path: &str, data: &[u8]| {
            (
                iwci_vfs::Entry::File {
                    path: path.into(),
                    data: data.to_vec().into(),
                },
                Some(0o644),
            )
        };
        for word in script.split_whitespace() {
            match word {
                "build" => {
                    back.entries.push(file("/app/out/app.bin", b"binary"));
                    back.entries.push(file(&output, b"version=1.2\n"));
                }
                "edit" => {
                    back.entries.push(file("/app/src/a.ts", b"edited"));
                    back.deleted.push("/app/node_modules/dep/index.js".into());
                }
                "venv" => {
                    back.entries.push(file("/app/.venv/.gitignore", b"*\n"));
                    back.entries.push(file("/app/.venv/bin/python", b"python"));
                }
                "share" => shared
                    .entries
                    .push(file("/shared.txt", b"from the machine")),
                "nvm" => {
                    let node = "/root/.nvm/versions/node/v22/bin/node";
                    if run.fs.read(node).is_ok() {
                        stdout.push_str("node 22 was there\n");
                    } else {
                        back.entries.push(file(node, b"node"));
                        stdout.push_str("installed node 22\n");
                    }
                }
                "fail" => exit_code = 2,
                _ => {}
            }
        }
        // As the real machine does: only what it was asked for comes back.
        let allowed = run.collect.allowed();
        let asked = |path: &std::path::Path| {
            allowed
                .iter()
                .any(|c| crate::machines::is_under(path.to_str().unwrap(), c))
        };
        back.deleted.retain(|p| asked(p));
        back.entries.retain(|(e, _)| match e {
            iwci_vfs::Entry::File { path, .. }
            | iwci_vfs::Entry::Dir { path }
            | iwci_vfs::Entry::Symlink { path, .. } => asked(path),
        });
        apply(run.fs, &back, &allowed)?;
        apply(run.scratch.fs(), &shared, &["/".into()])?;
        run.scratch
            .wrote(shared.entries.iter().map(|(e, _)| entry_path(e)));
        Ok(Execution {
            exit_code,
            stdout,
            ..Default::default()
        })
    }
}

fn run_machines(plan: &Plan, machines: Option<Arc<dyn Machines>>) -> (RunReport, FakeExecutor) {
    run_machines_with(plan, machines, None)
}

fn run_machines_with(
    plan: &Plan,
    machines: Option<Arc<dyn Machines>>,
    slots: Option<Arc<Slots>>,
) -> (RunReport, FakeExecutor) {
    run_machines_full(plan, machines, slots, None)
}

fn run_machines_full(
    plan: &Plan,
    machines: Option<Arc<dyn Machines>>,
    slots: Option<Arc<Slots>>,
    caches: Option<Arc<dyn Caches>>,
) -> (RunReport, FakeExecutor) {
    let ws = FakeWorkspaces {
        builds: AtomicUsize::new(0),
        installs: AtomicUsize::new(0),
        fail: false,
        source: "a",
    };
    let exec = FakeExecutor {
        seen_env: Mutex::default(),
        seen_tools: Mutex::default(),
        order: Mutex::default(),
        running: AtomicUsize::new(0),
        most_at_once: AtomicUsize::new(0),
    };
    let options = Options {
        parallelism: 4,
        changed_paths: None,
        base_env: vec![("IWCI".into(), "1".into())],
        memory: None,
        caches,
        logs: None,
        slots,
        secrets: BTreeMap::from([("TOKEN".into(), "s3cr3t-value".into())]),
        skip_task_cache: false,
        durations: None,
        split: None,
        helping: None,
        inflight: None,
        machines,
        spill: None,
        downloads: None,
        cancel: None,
        access: Default::default(),
    };
    let report = run(
        plan,
        &ws,
        &FakeTools,
        &exec,
        &FakeCommitter(Mutex::default()),
        &options,
    );
    (report, exec)
}

fn job<'a>(report: &'a RunReport, id: &str) -> &'a JobReport {
    report.jobs.iter().find(|j| j.id == id).unwrap()
}

#[test]
fn a_machine_job_hands_on_artifacts_outputs_and_scratch() {
    let p = plan(
        "name: t
jobs:
  build:
    platform: linux
    run: build share
    outputs: [version]
    artifacts: [out]
    env:
      TOKEN: ${{ secrets.TOKEN }}
  check:
    platform: linux
    needs: [build]
    run: nothing
    env:
      VERSION: ${{ needs.build.outputs.version }}
  wasm:
    using: builtin:src-list@1
    needs: [build]
",
    );
    let machines = Arc::new(FakeMachines::new());
    let (report, exec) = run_machines(&p, Some(machines.clone()));
    for id in ["build", "check", "wasm"] {
        assert_eq!(job(&report, id).status, Status::Passed, "{id}");
    }
    let build = job(&report, "build");
    assert_eq!(build.tool, "vm:linux/ubuntu-24.04");
    assert_eq!(
        build.outputs.get("version").map(String::as_str),
        Some("1.2")
    );
    assert_eq!(
        build.execution.as_ref().unwrap().stdout,
        "ran build share\n"
    );

    let seen = machines.seen.lock().unwrap();
    // The job's variables, its secret filled in, as any job gets them.
    let env = &seen.env["build"];
    assert!(env.contains(&("TOKEN".into(), "s3cr3t-value".into())));
    assert!(env.contains(&("IWCI_OUTPUT".into(), OUTPUT_PATH.into())));
    assert!(env.contains(&("IWCI_SCRATCH".into(), "/tmp/workflow".into())));
    assert_eq!(seen.collect["build"].paths, ["/app/out", OUTPUT_PATH]);
    assert_eq!(seen.collect["build"].repository, None);
    // The next machine starts with the artifact and the scratch file, and
    // reads the output like any job.
    assert_eq!(
        seen.started_with["check"],
        ["/app/out/app.bin", "scratch:/shared.txt"]
    );
    assert!(seen.env["check"].contains(&("VERSION".into(), "1.2".into())));
    assert!(
        job(&report, "check")
            .notes
            .iter()
            .any(|n| n == "artifacts: 1 file(s) from `build`")
    );
    // A job in an isolate gets them too.
    assert!(
        job(&report, "wasm")
            .notes
            .iter()
            .any(|n| n == "artifacts: 1 file(s) from `build`")
    );
    assert_eq!(ran(&exec), ["wasm"]);
}

#[test]
fn changes_a_machine_makes_are_the_jobs_changes() {
    let p = plan(
        "name: t
jobs:
  fmt:
    platform: linux
    run: edit
    changes: fail
",
    );
    let machines = Arc::new(FakeMachines::new());
    let (report, _) = run_machines(&p, Some(machines.clone()));
    let fmt = job(&report, "fmt");
    assert!(
        matches!(&fmt.status, Status::Failed { reason } if reason.starts_with("changed 2 file(s)")),
        "{:?}",
        fmt.status
    );
    let changed: Vec<(&str, &str)> = fmt
        .changes
        .iter()
        .map(|c| (c.path.as_str(), c.kind))
        .collect();
    assert_eq!(
        changed,
        [
            ("/app/node_modules/dep/index.js", "deleted"),
            ("/app/src/a.ts", "modified")
        ]
    );
    let seen = machines.seen.lock().unwrap();
    assert_eq!(seen.collect["fmt"].paths, [OUTPUT_PATH]);
    assert_eq!(seen.collect["fmt"].repository.as_deref(), Some("/app"));
}

#[test]
fn what_git_ignores_is_not_a_change() {
    let p = plan(
        "name: t
jobs:
  fmt:
    platform: linux
    run: venv edit
    changes: fail
  clean:
    platform: linux
    run: venv
    changes: fail
",
    );
    let machines = Arc::new(FakeMachines::new());
    let (report, _) = run_machines(&p, Some(machines));
    let changed: Vec<&str> = job(&report, "fmt")
        .changes
        .iter()
        .map(|c| c.path.as_str())
        .collect();
    assert_eq!(changed, ["/app/node_modules/dep/index.js", "/app/src/a.ts"]);
    assert_eq!(job(&report, "clean").status, Status::Passed);
}

#[test]
fn a_failing_script_fails_the_job_and_hands_on_nothing() {
    let p = plan(
        "name: t
jobs:
  build:
    platform: linux
    run: build fail
    artifacts: [out]
  after:
    platform: linux
    needs: [build]
    run: nothing
",
    );
    let (report, _) = run_machines(&p, Some(Arc::new(FakeMachines::new())));
    assert!(
        matches!(&job(&report, "build").status, Status::Failed { reason } if reason == "exited with 2")
    );
    assert!(matches!(
        job(&report, "after").status,
        Status::Skipped { .. }
    ));
}

#[test]
fn a_runner_without_the_machines_says_so() {
    let p = plan(
        "name: t
jobs:
  linux:
    platform: linux
    run: share
  wasm:
    using: builtin:ok@1
",
    );
    let (report, _) = run_machines(&p, None);
    assert!(matches!(
        &job(&report, "linux").status,
        Status::Error { message } if message.contains("no Linux virtual machines (`platform: linux`)")
    ));
    assert_eq!(job(&report, "wasm").status, Status::Passed);
}

#[test]
fn a_machine_gets_the_vcpus_its_job_holds() {
    let p = plan(
        "name: t
jobs:
  wide:
    platform: linux
    cpus: 8
    run: share
  narrow:
    platform: linux
    run: share
",
    );
    let machines = Arc::new(FakeMachines::new());
    // A runner with 2 vCPUs gives a job asking for 8 all of its own.
    let (report, _) = run_machines_with(
        &p,
        Some(machines.clone()),
        Some(Arc::new(Slots::for_cpus(2, 4))),
    );
    assert_eq!(job(&report, "wide").status, Status::Passed);
    let seen = machines.seen.lock().unwrap();
    assert_eq!(seen.cpus["wide"], Some(2));
    assert!(seen.env["wide"].contains(&("IWCI_CPUS".into(), "2".into())));
    // Without `cpus:` the machine gets the runner's `--machine-cpus`.
    assert_eq!(seen.cpus["narrow"], None);
}

#[test]
fn a_machine_reserves_its_overhead_with_its_memory() {
    let p = plan(
        "name: t
jobs:
  big:
    platform: linux
    memory: 1GiB
    run: build
",
    );
    let budget = Arc::new(MemoryBudget::new(1 << 30));
    let ws = FakeWorkspaces {
        builds: AtomicUsize::new(0),
        installs: AtomicUsize::new(0),
        fail: false,
        source: "a",
    };
    let exec = FakeExecutor {
        seen_env: Mutex::default(),
        seen_tools: Mutex::default(),
        order: Mutex::default(),
        running: AtomicUsize::new(0),
        most_at_once: AtomicUsize::new(0),
    };
    let options = Options {
        parallelism: 4,
        changed_paths: None,
        base_env: vec![],
        memory: Some(budget),
        caches: None,
        logs: None,
        slots: None,
        secrets: BTreeMap::new(),
        skip_task_cache: false,
        durations: None,
        split: None,
        helping: None,
        inflight: None,
        machines: Some(Arc::new(FakeMachines::new())),
        spill: None,
        downloads: None,
        cancel: None,
        access: Default::default(),
    };
    let report = run(
        &p,
        &ws,
        &FakeTools,
        &exec,
        &FakeCommitter(Mutex::default()),
        &options,
    );
    // 1 GiB and the machine's 128 MiB do not fit a 1 GiB runner.
    assert!(matches!(
        &job(&report, "big").status,
        Status::Error { message } if message.contains("asks for 1152 MiB")
    ));
}

#[test]
fn a_machine_images_caches_come_back_on_the_next_run() {
    let dir = std::env::temp_dir().join(format!("iwci-machine-env-cache-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let store: Arc<dyn iwci_store::ObjectStore> =
        Arc::new(iwci_store::LocalStore::new(&dir).unwrap());
    let caches: Arc<dyn Caches> = Arc::new(crate::adapters::caches::StoreCaches::new(
        store,
        &iwci_store::RepoId::new("github.com-acme").unwrap(),
        &iwci_store::RepoId::new("web").unwrap(),
        "main",
        "main",
        iwci_spec::Event::Push,
        None,
    ));
    let mut fake = FakeMachines::new();
    fake.caches = vec![crate::env_cache::EnvCacheDecl {
        name: "nvm".into(),
        path: "/root/.nvm/versions".into(),
        max_bytes: 1 << 30,
        environment: "machine:ubuntu-24.04".into(),
    }];
    let machines = Arc::new(fake);
    let p = plan("name: t\njobs:\n  a:\n    platform: linux\n    run: nvm\n");
    let go = |p: &Plan| {
        let (report, _) = run_machines_full(p, Some(machines.clone()), None, Some(caches.clone()));
        let a = job(&report, "a").clone();
        (a.status, a.execution.unwrap().stdout, a.caches)
    };

    let (status, stdout, lines) = go(&p);
    assert_eq!(status, Status::Passed, "{lines:?}");
    assert_eq!(stdout, "ran nvm\ninstalled node 22\n");
    assert_eq!(
        lines,
        vec!["env cache `nvm`: miss", "env cache `nvm`: saved 1 KiB"]
    );
    // The machine is asked for the cache's directory back.
    let collect = machines.seen.lock().unwrap().collect["a"].clone();
    assert!(
        collect.paths.contains(&"/root/.nvm/versions".to_string()),
        "{collect:?}"
    );

    // The next run starts with it, and leaves it as it was.
    let (status, stdout, lines) = go(&p);
    assert_eq!(status, Status::Passed, "{lines:?}");
    assert_eq!(stdout, "ran nvm\nnode 22 was there\n");
    assert_eq!(
        lines,
        vec![
            "env cache `nvm`: restored 1 KiB",
            "env cache `nvm`: unchanged"
        ]
    );

    // `env-cache: false` turns it off for a machine job too.
    let off =
        plan("name: t\njobs:\n  a:\n    platform: linux\n    run: nvm\n    env-cache: false\n");
    let (status, stdout, lines) = go(&off);
    assert_eq!(status, Status::Passed);
    assert_eq!(
        (stdout.as_str(), lines.len()),
        ("ran nvm\ninstalled node 22\n", 0)
    );
    let _ = std::fs::remove_dir_all(dir);
}
