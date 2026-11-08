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
    order: Mutex<Vec<String>>,
    running: AtomicUsize,
    most_at_once: AtomicUsize,
}

impl Executor<String> for FakeExecutor {
    fn execute(
        &self,
        tool: &String,
        _action: &Action,
        inv: Invocation<'_>,
    ) -> Result<Execution, String> {
        self.order.lock().unwrap().push(inv.job.id.clone());
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
        if tool.contains(":fail@") {
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
        Ok(Execution {
            exit_code,
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
    let ws = FakeWorkspaces {
        builds: AtomicUsize::new(0),
        fail: fail_ws,
    };
    let exec = FakeExecutor {
        seen_env: Mutex::default(),
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
        matches!(status(&report, "w"), Status::Failed { reason } if reason.contains("its own 16 MiB memory limit"))
    );
}
