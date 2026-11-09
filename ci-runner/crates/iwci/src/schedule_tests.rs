use super::*;
use iwci_spec::Context;
use iwci_vfs::SnapshotBuilder;
use std::sync::atomic::{AtomicUsize, Ordering};

struct FakeWorkspaces {
    builds: AtomicUsize,
    fail: bool,
}

impl Workspaces for FakeWorkspaces {
    fn build(&self, spec: &WorkspaceSpec) -> Result<BuiltWorkspace, String> {
        self.builds.fetch_add(1, Ordering::SeqCst);
        if self.fail {
            return Err("lockfile missing".into());
        }
        let b = SnapshotBuilder::new();
        if let Some(c) = &spec.clone {
            b.write(format!("{}/src/a.ts", c.into), b"a").unwrap();
        }
        Ok(BuiltWorkspace {
            snapshot: b.freeze(),
            env: vec![("FROM_WS".into(), "1".into())],
            warnings: vec![],
            installs: vec![],
        })
    }
}

struct FakeTools;
impl Tools for FakeTools {
    type Tool = String;
    fn resolve(&self, tool: &ToolRef) -> Result<Arc<String>, String> {
        match tool {
            ToolRef::Repo { name, .. } if name == "missing" => Err("no such tool".into()),
            t => Ok(Arc::new(t.to_string())),
        }
    }
}

/// Behaves by tool name: `fail` exits 1, `write` changes a file, `slow`
/// sleeps, `out` writes its args to `$IWCI_OUTPUT` one per line; every
/// tool records the env it saw.
struct FakeExecutor {
    seen_env: Mutex<HashMap<String, Vec<(String, String)>>>,
    seen_tools: Mutex<HashMap<String, Vec<String>>>,
    order: Mutex<Vec<String>>,
    running: AtomicUsize,
    most_at_once: AtomicUsize,
}

impl Executor<String> for FakeExecutor {
    fn execute(
        &self,
        tool: &String,
        path_tools: &[Arc<String>],
        _action: &Action,
        inv: Invocation<'_>,
    ) -> Result<Execution, String> {
        self.order.lock().unwrap().push(inv.job.id.clone());
        self.seen_tools.lock().unwrap().insert(
            inv.job.id.clone(),
            path_tools.iter().map(|t| t.to_string()).collect(),
        );
        let now = self.running.fetch_add(1, Ordering::SeqCst) + 1;
        self.most_at_once.fetch_max(now, Ordering::SeqCst);
        struct Done<'a>(&'a AtomicUsize);
        impl Drop for Done<'_> {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::SeqCst);
            }
        }
        let _done = Done(&self.running);
        self.seen_env
            .lock()
            .unwrap()
            .insert(inv.job.id.clone(), inv.env.clone());
        let mut exit_code = 0;
        // `-fail` makes any tool exit 1 after doing its work.
        if tool.contains(":fail@") || tool.contains("-fail@") {
            exit_code = 1;
        }
        if tool.contains(":write@") {
            inv.fs.write("/app/src/a.ts", b"formatted").unwrap();
        }
        if tool.contains(":slow@") {
            std::thread::sleep(Duration::from_millis(50));
        }
        if tool.contains(":bigwrite@") {
            // One byte more than the job's memory: refused, as a full disk
            // would refuse it, and the program then fails.
            let size = usize::try_from(inv.job.memory_bytes).unwrap() + 1;
            if inv.fs.write("/app/huge.bin", &vec![0u8; size]).is_err() {
                exit_code = 1;
            }
        }
        if tool.contains(":out@") {
            let path = inv
                .env
                .iter()
                .find(|(k, _)| k == "IWCI_OUTPUT")
                .map(|(_, v)| v.clone())
                .unwrap();
            if let Action::Args { args } = _action {
                inv.fs.write(&path, args.join("\n").as_bytes()).unwrap();
            }
        }
        let mut stdout = String::new();
        if tool.contains(":print@") {
            for (k, v) in &inv.env {
                stdout.push_str(&format!("{k}={v}\n"));
            }
        }
        if tool.contains(":art-write") {
            let name: String = inv
                .job
                .id
                .chars()
                .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                .collect();
            inv.fs
                .write(format!("/app/dist/{name}.txt"), inv.job.id.as_bytes())
                .unwrap();
        }
        if tool.contains(":src-write@") {
            inv.fs.write("/app/src/new.ts", b"new").unwrap();
        }
        if tool.contains(":src-list@") {
            let mut names: Vec<String> = inv
                .fs
                .entries_under(&["/app/src"])
                .into_iter()
                .filter_map(|e| match e {
                    iwci_vfs::Entry::File { path, .. } => {
                        Some(path.file_name().unwrap().to_string_lossy().into_owned())
                    }
                    _ => None,
                })
                .collect();
            names.sort();
            stdout.push_str(&names.join(","));
        }
        if tool.contains(":art-big@") {
            inv.fs
                .write("/app/dist/big.bin", &vec![1u8; 20 << 20])
                .unwrap();
        }
        if tool.contains(":art-read@") {
            let mut names: Vec<String> = inv
                .fs
                .entries_under(&["/app/dist"])
                .into_iter()
                .filter_map(|e| match e {
                    iwci_vfs::Entry::File { path, .. } => {
                        Some(path.file_name().unwrap().to_string_lossy().into_owned())
                    }
                    _ => None,
                })
                .collect();
            names.sort();
            stdout.push_str(&names.join(","));
        }
        if tool.contains(":scratch-write@") {
            inv.scratch
                .write("/shared.txt", inv.job.id.as_bytes())
                .unwrap();
        }
        if tool.contains(":scratch-read@") {
            match inv.scratch.read("/shared.txt") {
                Ok(bytes) => stdout.push_str(&String::from_utf8_lossy(&bytes)),
                Err(_) => exit_code = 1,
            }
        }
        Ok(Execution {
            exit_code,
            stdout,
            ..Default::default()
        })
    }
}

struct FakeCommitter(Mutex<Vec<(String, usize, String)>>);
impl Committer for FakeCommitter {
    fn commit(&self, root: &str, changes: &[Change], message: &str) -> Result<String, String> {
        self.0
            .lock()
            .unwrap()
            .push((root.into(), changes.len(), message.into()));
        Ok("c0ffee".into())
    }
}

fn plan(yaml: &str) -> Plan {
    iwci_spec::parse(yaml, &Context::default()).unwrap()
}

fn ran(exec: &FakeExecutor) -> Vec<String> {
    exec.order.lock().unwrap().clone()
}

fn run_plan(
    plan: &Plan,
    changed: Option<Vec<String>>,
    fail_ws: bool,
) -> (RunReport, FakeExecutor, FakeCommitter, usize) {
    run_limited(plan, changed, fail_ws, None)
}

fn run_limited(
    plan: &Plan,
    changed: Option<Vec<String>>,
    fail_ws: bool,
    memory: Option<Arc<MemoryBudget>>,
) -> (RunReport, FakeExecutor, FakeCommitter, usize) {
    run_with(plan, changed, fail_ws, memory, None)
}

fn run_with(
    plan: &Plan,
    changed: Option<Vec<String>>,
    fail_ws: bool,
    memory: Option<Arc<MemoryBudget>>,
    caches: Option<Arc<dyn Caches>>,
) -> (RunReport, FakeExecutor, FakeCommitter, usize) {
    run_full(plan, changed, fail_ws, memory, caches, BTreeMap::new())
}

fn run_full(
    plan: &Plan,
    changed: Option<Vec<String>>,
    fail_ws: bool,
    memory: Option<Arc<MemoryBudget>>,
    caches: Option<Arc<dyn Caches>>,
    secrets: BTreeMap<String, String>,
) -> (RunReport, FakeExecutor, FakeCommitter, usize) {
    let ws = FakeWorkspaces {
        builds: AtomicUsize::new(0),
        fail: fail_ws,
    };
    let exec = FakeExecutor {
        seen_env: Mutex::default(),
        seen_tools: Mutex::default(),
        order: Mutex::default(),
        running: AtomicUsize::new(0),
        most_at_once: AtomicUsize::new(0),
    };
    let commits = FakeCommitter(Mutex::default());
    let options = Options {
        parallelism: 4,
        changed_paths: changed,
        base_env: vec![
            ("IWCI".into(), "1".into()),
            ("FROM_WS".into(), "base".into()),
        ],
        memory,
        caches,
        logs: None,
        slots: None,
        secrets,
    };
    let report = run(plan, &ws, &FakeTools, &exec, &commits, &options);
    let builds = ws.builds.load(Ordering::SeqCst);
    (report, exec, commits, builds)
}

fn status<'a>(report: &'a RunReport, id: &str) -> &'a Status {
    &report.jobs.iter().find(|j| j.id == id).unwrap().status
}

#[test]
fn needs_order_jobs_and_failures_skip_the_chain_below() {
    let p = plan(
        "name: x\njobs:\n  a:\n    using: builtin:slow@1\n  b:\n    using: builtin:fail@1\n    needs: [a]\n  c:\n    using: builtin:ok@1\n    needs: [b]\n  d:\n    using: builtin:ok@1\n    needs: [a]\n",
    );
    let (report, exec, _, _) = run_plan(&p, None, false);
    assert_eq!(status(&report, "a"), &Status::Passed);
    assert!(matches!(status(&report, "b"), Status::Failed { reason } if reason == "exited with 1"));
    assert!(
        matches!(status(&report, "c"), Status::Skipped { reason } if reason.contains("`b` did not pass"))
    );
    assert_eq!(status(&report, "d"), &Status::Passed);
    assert!(!report.passed());
    let order = exec.order.lock().unwrap().clone();
    assert!(order.iter().position(|j| j == "a") < order.iter().position(|j| j == "b"));
    assert!(!order.contains(&"c".to_string()));
}

#[test]
fn paths_filters_skip_jobs_without_building_their_workspace_or_blocking_dependents() {
    let p = plan(
        "name: x\njobs:\n  docs:\n    using: builtin:ok@1\n    deps: [pnpm]\n    paths: [\"docs/**\"]\n  after:\n    using: builtin:ok@1\n    needs: [docs]\n",
    );
    let (report, _, _, builds) = run_plan(&p, Some(vec!["app/x.ts".into()]), false);
    assert!(matches!(status(&report, "docs"), Status::Skipped { .. }));
    assert_eq!(status(&report, "after"), &Status::Passed);
    assert_eq!(builds, 1, "only the workspace `after` uses was built");
    assert!(report.passed());
}

#[test]
fn each_workspace_builds_once_for_any_number_of_jobs() {
    let p = plan("name: x\njobs:\n  t:\n    using: builtin:ok@1\n    matrix: [a, b, c, d, e]\n");
    let (report, _, _, builds) = run_plan(&p, None, false);
    assert_eq!(builds, 1);
    assert_eq!(report.jobs.len(), 5);
    assert!(report.passed());
}

#[test]
fn change_policies() {
    let p = plan(
        "name: x\njobs:\n  ignore:\n    using: builtin:write@1\n  fail:\n    using: builtin:write@1\n    changes: fail\n  commit:\n    using: builtin:write@1\n    changes: { commit: \"style: format\" }\n  clean:\n    using: builtin:ok@1\n    changes: fail\n",
    );
    let (report, _, commits, _) = run_plan(&p, None, false);
    assert_eq!(status(&report, "ignore"), &Status::Passed);
    assert!(
        matches!(status(&report, "fail"), Status::Failed { reason } if reason.contains("changed 1 file"))
    );
    assert_eq!(status(&report, "commit"), &Status::Passed);
    assert_eq!(status(&report, "clean"), &Status::Passed);
    let commit = report.jobs.iter().find(|j| j.id == "commit").unwrap();
    assert_eq!(commit.commit.as_deref(), Some("c0ffee"));
    assert_eq!(commit.changes[0].path, "/app/src/a.ts");
    assert_eq!(
        commits.0.lock().unwrap().clone(),
        vec![("/app".to_string(), 1, "style: format".to_string())]
    );
}

#[test]
fn env_layers_job_over_workspace_over_runner() {
    let p = plan("name: x\njobs:\n  t:\n    using: builtin:ok@1\n    env: { FROM_JOB: yes }\n");
    let (_, exec, _, _) = run_plan(&p, None, false);
    let env = exec.seen_env.lock().unwrap()["t"].clone();
    let get = |k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| v.clone());
    assert_eq!(get("IWCI").as_deref(), Some("1"));
    assert_eq!(
        get("FROM_WS").as_deref(),
        Some("1"),
        "workspace env overrides the runner's"
    );
    assert_eq!(get("FROM_JOB").as_deref(), Some("yes"));
    assert_eq!(get("IWCI_JOB").as_deref(), Some("t"));
}

#[test]
fn workspace_and_tool_errors_are_reported_per_job() {
    let p = plan("name: x\njobs:\n  a:\n    using: builtin:ok@1\n");
    let (report, _, _, _) = run_plan(&p, None, true);
    assert!(
        matches!(status(&report, "a"), Status::Error { message } if message.contains("lockfile missing"))
    );

    let p = plan(
        "name: x\njobs:\n  a:\n    using: repo:missing@1\n  b:\n    using: builtin:ok@1\n    needs: [a]\n",
    );
    let (report, _, _, _) = run_plan(&p, None, false);
    assert!(
        matches!(status(&report, "a"), Status::Error { message } if message.contains("no such tool"))
    );
    assert!(matches!(status(&report, "b"), Status::Skipped { .. }));
}

#[test]
fn a_job_sets_the_matrix_of_another() {
    let p = plan(
        r#"
name: x
jobs:
  detect:
    using: builtin:out@1
    outputs: [packages, run-docs]
    args: ['packages=["web","mobile"]', "run-docs=false"]
  check:
    needs: [detect]
    matrix: ${{ needs.detect.outputs.packages }}
    using: builtin:ok@1
    args: ["${{ matrix }}"]
  docs:
    needs: [detect]
    if: needs.detect.outputs.run-docs == 'true'
    using: builtin:ok@1
  after-docs:
    needs: [docs]
    using: builtin:ok@1
"#,
    );
    let (report, exec, _, _) = run_plan(&p, None, false);
    let ids: Vec<&str> = report.jobs.iter().map(|j| j.id.as_str()).collect();
    assert_eq!(
        ids,
        [
            "detect",
            "check[web]",
            "check[mobile]",
            "docs",
            "after-docs"
        ]
    );
    let detect = report.jobs.iter().find(|j| j.id == "detect").unwrap();
    assert_eq!(detect.outputs["packages"], r#"["web","mobile"]"#);
    assert_eq!(status(&report, "check[mobile]"), &Status::Passed);
    assert!(
        matches!(status(&report, "docs"), Status::Skipped { reason } if reason.contains("`if:` is false"))
    );
    assert_eq!(
        status(&report, "after-docs"),
        &Status::Passed,
        "a false `if:` does not block dependents"
    );
    assert!(report.passed());
    assert!(!ran(&exec).contains(&"docs".to_string()));
}

#[test]
fn an_empty_dynamic_matrix_runs_nothing_and_blocks_nothing() {
    let p = plan(
        "name: x\njobs:\n  d:\n    using: builtin:out@1\n    outputs: [list]\n    args: ['list=[]']\n  m:\n    needs: [d]\n    matrix: ${{ needs.d.outputs.list }}\n    using: builtin:ok@1\n  z:\n    needs: [m]\n    using: builtin:ok@1\n",
    );
    let (report, _, _, _) = run_plan(&p, None, false);
    assert!(
        matches!(status(&report, "m"), Status::Skipped { reason } if reason.contains("matrix is empty"))
    );
    assert_eq!(status(&report, "z"), &Status::Passed);
}

#[test]
fn a_bad_matrix_output_is_an_error_for_that_job() {
    let p = plan(
        "name: x\njobs:\n  d:\n    using: builtin:out@1\n    outputs: [list]\n    args: ['list=web']\n  m:\n    needs: [d]\n    matrix: ${{ needs.d.outputs.list }}\n    using: builtin:ok@1\n",
    );
    let (report, _, _, _) = run_plan(&p, None, false);
    assert!(
        matches!(status(&report, "m"), Status::Error { message } if message.contains("JSON list"))
    );
}

#[test]
fn status_functions_run_cleanup_after_a_failure() {
    let p = plan(
        "name: x\njobs:\n  a:\n    using: builtin:fail@1\n  cleanup:\n    needs: [a]\n    if: always()\n    using: builtin:ok@1\n  on-fail:\n    needs: [a]\n    if: failure() && needs.a.result == 'failure'\n    using: builtin:ok@1\n  normal:\n    needs: [a]\n    if: needs.a.result == 'failure'\n    using: builtin:ok@1\n",
    );
    let (report, _, _, _) = run_plan(&p, None, false);
    assert_eq!(status(&report, "cleanup"), &Status::Passed);
    assert_eq!(status(&report, "on-fail"), &Status::Passed);
    assert!(
        matches!(status(&report, "normal"), Status::Skipped { reason } if reason.contains("did not pass")),
        "without a status function an `if:` still needs success()"
    );
}

#[test]
fn undeclared_or_malformed_outputs_fail_the_job() {
    let p =
        plan("name: x\njobs:\n  d:\n    using: builtin:out@1\n    outputs: [a]\n    args: [b=1]\n");
    let (report, _, _, _) = run_plan(&p, None, false);
    assert!(
        matches!(status(&report, "d"), Status::Failed { reason } if reason.contains("`b` is not in the job's `outputs:`"))
    );
}

#[test]
fn outputs_parse_like_github_actions() {
    let declared = vec!["a".to_string(), "body".to_string()];
    let parsed =
        parse_outputs(b"a=1=2\nbody<<EOF\nline one\nline two\nEOF\n\n", &declared).unwrap();
    assert_eq!(parsed["a"], "1=2");
    assert_eq!(parsed["body"], "line one\nline two");
    assert!(
        parse_outputs(b"body<<EOF\nnever closed\n", &declared)
            .unwrap_err()
            .contains("never closed")
    );
    assert!(
        parse_outputs(b"just text\n", &declared)
            .unwrap_err()
            .contains("neither")
    );
    assert!(
        parse_outputs(&vec![b'a'; MAX_OUTPUT_BYTES + 1], &declared)
            .unwrap_err()
            .contains("limit")
    );
}

#[test]
fn skipped_jobs_never_build_their_workspace() {
    let p = plan(
        "name: x\njobs:\n  a:\n    using: builtin:ok@1\n    clone: false\n    if: false\n  b:\n    using: builtin:ok@1\n    deps: [pnpm]\n    if: \"commit.branch == 'nope'\"\n",
    );
    let (report, _, _, builds) = run_plan(&p, None, false);
    assert!(report.passed());
    assert_eq!(builds, 0);
}

#[test]
fn jobs_that_do_not_fit_the_runners_memory_together_run_one_after_another() {
    let p = plan(
        "name: x\njobs:\n  t:\n    using: builtin:slow@1\n    matrix: [a, b, c]\n    memory: 1GiB\n",
    );
    let budget = Arc::new(MemoryBudget::new(3 << 29)); // 1.5 GiB
    let (report, exec, _, _) = run_limited(&p, None, false, Some(budget.clone()));
    assert!(report.passed());
    assert_eq!(exec.most_at_once.load(Ordering::SeqCst), 1);
    assert_eq!(budget.used(), 0, "every reservation is given back");

    // With room for all three, they run together.
    let budget = Arc::new(MemoryBudget::new(4 << 30));
    let (_, exec, _, _) = run_limited(&p, None, false, Some(budget));
    assert!(exec.most_at_once.load(Ordering::SeqCst) > 1);
}

#[test]
fn a_job_bigger_than_the_whole_budget_is_an_error_not_a_hang() {
    let p = plan(
        "name: x\njobs:\n  big:\n    using: builtin:ok@1\n    memory: 4GiB\n  after:\n    needs: [big]\n    using: builtin:ok@1\n    memory: 64MiB\n",
    );
    let (report, _, _, _) =
        run_limited(&p, None, false, Some(Arc::new(MemoryBudget::new(1 << 30))));
    assert!(
        matches!(status(&report, "big"), Status::Error { message } if message.contains("4096 MiB") && message.contains("1024 MiB"))
    );
    assert!(matches!(status(&report, "after"), Status::Skipped { .. }));
}

#[test]
fn a_job_cannot_write_past_its_memory_and_its_bytes_are_given_back() {
    let p = plan("name: x\njobs:\n  w:\n    using: builtin:bigwrite@1\n    memory: 16MiB\n");
    let budget = Arc::new(MemoryBudget::new(1 << 30));
    let (report, _, _, _) = run_limited(&p, None, false, Some(budget.clone()));
    assert!(
        matches!(status(&report, "w"), Status::Failed { reason } if reason.contains("write was refused")),
        "{:?}",
        status(&report, "w")
    );
    assert_eq!(budget.used(), 0);

    // Without a runner budget the job's own limit still holds.
    let (report, _, _, _) = run_plan(&p, None, false);
    assert!(
        matches!(status(&report, "w"), Status::Failed { reason } if reason.contains("its 16 MiB memory limit"))
    );
}

/// Caches in memory: key to entries, plus what was saved, in order.
#[derive(Default)]
struct MemoryCaches {
    entries: Mutex<HashMap<String, Vec<iwci_vfs::Entry>>>,
    saved: Mutex<Vec<String>>,
}

impl Caches for MemoryCaches {
    fn restore(
        &self,
        key: &str,
        restore_keys: &[String],
        _max: u64,
    ) -> Result<Option<Restored>, String> {
        let entries = self.entries.lock().unwrap();
        if let Some(e) = entries.get(key) {
            return Ok(Some(Restored {
                key: key.into(),
                exact: true,
                entries: e.clone(),
            }));
        }
        for prefix in restore_keys {
            if let Some((k, e)) = entries.iter().find(|(k, _)| k.starts_with(prefix.as_str())) {
                return Ok(Some(Restored {
                    key: k.clone(),
                    exact: false,
                    entries: e.clone(),
                }));
            }
        }
        Ok(None)
    }
    fn save(
        &self,
        key: &str,
        _restore_keys: &[String],
        entries: &[iwci_vfs::Entry],
    ) -> Result<(), String> {
        self.entries
            .lock()
            .unwrap()
            .insert(key.into(), entries.to_vec());
        self.saved.lock().unwrap().push(key.into());
        Ok(())
    }
}

#[test]
fn caches_restore_before_a_job_and_save_after_it_passes() {
    // `write` writes /app/src/a.ts; caching /app/src means the restored
    // and rewritten file is the cache's, not a change to the repository.
    let p = plan(
        "name: x\njobs:\n  w:\n    using: builtin:write@1\n    changes: fail\n    cache: { key: \"k-${{ hashFiles('src/**') }}\", restore-keys: [k-], paths: [src] }\n",
    );
    let store: Arc<MemoryCaches> = Arc::new(MemoryCaches::default());
    let (report, _, _, _) = run_with(&p, None, false, None, Some(store.clone()));
    let job = report.jobs.iter().find(|j| j.id == "w").unwrap();
    assert_eq!(job.status, Status::Passed, "{:?}", job.caches);
    assert!(
        job.caches.iter().any(|l| l.contains("miss"))
            && job.caches.iter().any(|l| l.contains("saved")),
        "{:?}",
        job.caches
    );
    let saved = store.saved.lock().unwrap().clone();
    assert_eq!(saved.len(), 1);
    assert!(
        saved[0].starts_with("k-") && saved[0].len() == 2 + 32,
        "the hash is filled in: {saved:?}"
    );

    // The second run is an exact hit: restored, not saved again.
    let (report, _, _, _) = run_with(&p, None, false, None, Some(store.clone()));
    let job = report.jobs.iter().find(|j| j.id == "w").unwrap();
    assert_eq!(job.status, Status::Passed);
    assert!(
        job.caches.iter().any(|l| l.ends_with("restored")),
        "{:?}",
        job.caches
    );
    assert_eq!(store.saved.lock().unwrap().len(), 1);

    // A failing job saves nothing.
    let failing = plan(
        "name: x\njobs:\n  f:\n    using: builtin:fail@1\n    cache: { key: other, paths: [src] }\n",
    );
    run_with(&failing, None, false, None, Some(store.clone()));
    assert_eq!(store.saved.lock().unwrap().len(), 1);
}

#[test]
fn runs_share_the_runners_slots() {
    let slots = Arc::new(Slots::new(2));
    let p = plan("name: x\njobs:\n  t:\n    using: builtin:slow@1\n    matrix: [a, b, c, d]\n");
    let exec = FakeExecutor {
        seen_env: Mutex::default(),
        seen_tools: Mutex::default(),
        order: Mutex::default(),
        running: AtomicUsize::new(0),
        most_at_once: AtomicUsize::new(0),
    };
    let ws = FakeWorkspaces {
        builds: AtomicUsize::new(0),
        fail: false,
    };
    let commits = FakeCommitter(Mutex::default());
    let options = Options {
        parallelism: 8,
        changed_paths: None,
        base_env: vec![],
        memory: None,
        caches: None,
        logs: None,
        slots: Some(slots.clone()),
        secrets: BTreeMap::new(),
    };
    // Two runs at once, each wanting four jobs in parallel: together they
    // never exceed the two slots.
    std::thread::scope(|scope| {
        scope.spawn(|| run(&p, &ws, &FakeTools, &exec, &commits, &options));
        scope.spawn(|| run(&p, &ws, &FakeTools, &exec, &commits, &options));
    });
    assert_eq!(exec.most_at_once.load(Ordering::SeqCst), 2);
    assert_eq!(slots.in_use(), 0);
    let held = slots.try_acquire().unwrap();
    let _second = slots.try_acquire().unwrap();
    assert!(slots.try_acquire().is_none(), "full is full");
    drop(held);
    assert_eq!(slots.free(), 1);
}

#[test]
fn logs_stream_lines_and_job_events_in_order() {
    struct Printing;
    impl Executor<String> for Printing {
        fn execute(
            &self,
            _tool: &String,
            _path_tools: &[Arc<String>],
            _action: &Action,
            inv: Invocation<'_>,
        ) -> Result<Execution, String> {
            let log = inv.log.expect("a log sink when logs are followed");
            log(false, b"hel");
            log(false, b"lo\nwor");
            log(true, b"oops\n");
            log(false, b"ld");
            Ok(Execution::default())
        }
    }
    let p = plan(
        "name: x\njobs:\n  a:\n    using: builtin:ok@1\n  b:\n    using: builtin:ok@1\n    if: false\n",
    );
    let events: Arc<Mutex<Vec<LogEvent>>> = Arc::default();
    let sink = events.clone();
    let options = Options {
        parallelism: 1,
        changed_paths: None,
        base_env: vec![],
        memory: None,
        caches: None,
        logs: Some(Arc::new(move |e| sink.lock().unwrap().push(e))),
        slots: None,
        secrets: BTreeMap::new(),
    };
    let ws = FakeWorkspaces {
        builds: AtomicUsize::new(0),
        fail: false,
    };
    run(
        &p,
        &ws,
        &FakeTools,
        &Printing,
        &FakeCommitter(Mutex::default()),
        &options,
    );
    let lines: Vec<String> = events
        .lock()
        .unwrap()
        .iter()
        .map(|e| serde_json::to_string(e).unwrap())
        .collect();
    let text = lines.join("\n");
    let expected = [
        r#"{"event":"job-started","job":"a","name":"a"}"#,
        r#"{"event":"output","job":"a","stream":"stdout","line":"hello"}"#,
        r#"{"event":"output","job":"a","stream":"stderr","line":"oops"}"#,
        r#"{"event":"output","job":"a","stream":"stdout","line":"world"}"#,
    ];
    for want in expected {
        assert!(text.contains(want), "missing {want} in\n{text}");
    }
    assert!(
        text.contains(r#""event":"job-finished","job":"a","status":"passed""#),
        "{text}"
    );
    assert!(
        text.contains(r#""event":"job-finished","job":"b","status":"skipped""#),
        "a skipped job is reported too: {text}"
    );
}

#[test]
fn secrets_are_filled_late_and_masked_everywhere_output_goes() {
    let p = plan(
        "name: x\njobs:\n  a:\n    using: builtin:print@1\n    env:\n      TOKEN: ${{ secrets.TOKEN }}\n      AUTH: \"Bearer ${{ secrets.TOKEN }}\"\n      MISSING: ${{ secrets.NOPE }}\n",
    );
    // Nothing secret is in the plan.
    assert!(!serde_json::to_string(&p).unwrap().contains("hunter2-value"));
    let secrets = BTreeMap::from([("TOKEN".to_string(), "hunter2-value".to_string())]);
    let (report, exec, _, _) = run_full(&p, None, false, None, None, secrets);
    let env = exec.seen_env.lock().unwrap()["a"].clone();
    let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    assert_eq!(get("TOKEN").as_deref(), Some("hunter2-value"));
    assert_eq!(get("AUTH").as_deref(), Some("Bearer hunter2-value"));
    assert_eq!(get("MISSING").as_deref(), Some(""));
    let job = &report.jobs[0];
    let stdout = &job.execution.as_ref().unwrap().stdout;
    assert!(
        stdout.contains("TOKEN=***") && stdout.contains("AUTH=Bearer ***"),
        "{stdout}"
    );
    assert!(
        !serde_json::to_string(&report)
            .unwrap()
            .contains("hunter2-value")
    );
    assert_eq!(job.notes.len(), 1, "{:?}", job.notes);
    assert!(job.notes[0].contains("`NOPE`"));
}

#[test]
fn masking_covers_lines_of_multiline_secrets_and_skips_tiny_ones() {
    let mask = Masker::new(&[
        "line-one\nline-two".to_string(),
        "ab".to_string(),
        "abc-and-more".to_string(),
    ]);
    assert_eq!(mask.mask("x line-two y"), "x *** y");
    assert_eq!(mask.mask("ab abc-and-more"), "ab ***");
    assert_eq!(mask.mask("line-one\nline-two"), "***");
}

#[test]
fn every_job_of_a_run_shares_one_scratch() {
    let p = plan(
        "name: x\njobs:\n  w:\n    using: builtin:scratch-write@1\n  r:\n    using: builtin:scratch-read@1\n    needs: [w]\n",
    );
    let (report, exec, _, _) = run_plan(&p, None, false);
    assert!(matches!(status(&report, "r"), Status::Passed), "{report:?}");
    assert_eq!(report.jobs[1].execution.as_ref().unwrap().stdout, "w");
    let env = exec.seen_env.lock().unwrap()["r"].clone();
    assert!(env.contains(&("IWCI_SCRATCH".to_string(), "/tmp/workflow".to_string())));
    // A second run starts with an empty scratch.
    let p = plan("name: x\njobs:\n  r:\n    using: builtin:scratch-read@1\n");
    let (report, _, _, _) = run_plan(&p, None, false);
    assert!(matches!(status(&report, "r"), Status::Failed { .. }));
}

#[test]
fn tools_are_resolved_and_handed_to_the_executor() {
    let p = plan(
        "name: x\njobs:\n  a:\n    using: env:bash@5\n    tools: [builtin:gofmt@1, repo:lint@2]\n    run: gofmt\n  b:\n    using: env:bash@5\n    tools: [repo:missing@1]\n    run: x\n",
    );
    let (report, exec, _, _) = run_plan(&p, None, false);
    assert_eq!(
        exec.seen_tools.lock().unwrap()["a"],
        vec!["builtin:gofmt@1".to_string(), "repo:lint@2".to_string()]
    );
    assert!(
        matches!(status(&report, "b"), Status::Error { message } if message.contains("repo:missing@1"))
    );
}

fn stdout_of(report: &RunReport, id: &str) -> String {
    report
        .jobs
        .iter()
        .find(|j| j.id == id)
        .and_then(|j| j.execution.as_ref())
        .map(|e| e.stdout.clone())
        .unwrap_or_default()
}

fn notes_of(report: &RunReport, id: &str) -> Vec<String> {
    report
        .jobs
        .iter()
        .find(|j| j.id == id)
        .unwrap()
        .notes
        .clone()
}

#[test]
fn artifacts_reach_every_job_that_needs_them_and_are_not_its_changes() {
    let p = plan(
        "name: x\njobs:\n  lib:\n    matrix: [a, b]\n    using: builtin:art-write@1\n    artifacts: [dist]\n  mid:\n    using: builtin:art-write@1\n    needs: [lib]\n    artifacts: [dist]\n  check:\n    using: builtin:art-read@1\n    needs: [mid]\n    changes: fail\n  alone:\n    using: builtin:art-read@1\n",
    );
    let (report, _, _, _) = run_plan(&p, None, false);
    assert!(report.passed(), "{:#?}", report.jobs);
    // Through `mid`, `check` also gets `lib`'s files, both matrix entries'.
    assert_eq!(stdout_of(&report, "check"), "lib_a_.txt,lib_b_.txt,mid.txt");
    // And `mid` keeps only what it wrote, not what it was handed.
    assert!(notes_of(&report, "mid").contains(&"artifacts: kept 1 file(s), 1 KiB".to_string()));
    assert!(notes_of(&report, "check").contains(&"artifacts: 2 file(s) from `lib`".to_string()));
    // A job that needs nothing sees nothing.
    assert_eq!(stdout_of(&report, "alone"), "");
}

#[test]
fn a_failed_job_hands_on_nothing() {
    let p = plan(
        "name: x\njobs:\n  build:\n    using: builtin:art-write-fail@1\n    artifacts: [dist]\n  report:\n    using: builtin:art-read@1\n    needs: [build]\n    if: always()\n",
    );
    let (report, _, _, _) = run_plan(&p, None, false);
    assert!(matches!(status(&report, "build"), Status::Failed { .. }));
    assert_eq!(status(&report, "report"), &Status::Passed);
    assert_eq!(stdout_of(&report, "report"), "");
}

#[test]
fn artifacts_are_held_to_the_runs_scratch_limit() {
    let p = plan(
        "name: x\nscratch: 16MiB\njobs:\n  build:\n    using: builtin:art-big@1\n    artifacts: [dist]\n",
    );
    let (report, _, _, _) = run_plan(&p, None, false);
    assert!(
        matches!(status(&report, "build"), Status::Failed { reason } if reason.contains("past its `scratch:` limit of 16 MiB")),
        "{:?}",
        status(&report, "build")
    );
}

#[test]
fn a_job_keeps_only_the_files_it_wrote() {
    // `src/a.ts` is in the checkout under the artifact path; only the file
    // the job wrote there is handed on.
    let p = plan(
        "name: x\njobs:\n  gen:\n    using: builtin:src-write@1\n    artifacts: [src]\n  use:\n    using: builtin:src-list@1\n    needs: [gen]\n",
    );
    let (report, _, _, _) = run_plan(&p, None, false);
    assert!(report.passed(), "{:#?}", report.jobs);
    assert!(notes_of(&report, "gen").contains(&"artifacts: kept 1 file(s), 1 KiB".to_string()));
    assert!(notes_of(&report, "use").contains(&"artifacts: 1 file(s) from `gen`".to_string()));
    assert_eq!(stdout_of(&report, "use"), "a.ts,new.ts");
}
