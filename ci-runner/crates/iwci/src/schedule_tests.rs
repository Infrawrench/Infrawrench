use super::*;
use iwci_spec::Context;
use iwci_vfs::SnapshotBuilder;
use std::sync::atomic::{AtomicUsize, Ordering};

struct FakeWorkspaces {
    builds: AtomicUsize,
    /// Builds that installed dependencies, not just checked out.
    installs: AtomicUsize,
    fail: bool,
    /// What the commit's `src/a.ts` holds.
    source: &'static str,
}

impl Workspaces for FakeWorkspaces {
    fn build(&self, spec: &WorkspaceSpec) -> Result<BuiltWorkspace, String> {
        self.builds.fetch_add(1, Ordering::SeqCst);
        if !spec.deps.is_empty() {
            self.installs.fetch_add(1, Ordering::SeqCst);
        }
        if self.fail {
            return Err("lockfile missing".into());
        }
        let b = SnapshotBuilder::new();
        if let Some(c) = &spec.clone {
            b.write(format!("{}/src/a.ts", c.into), self.source.as_bytes())
                .unwrap();
            b.write(
                format!("{}/node_modules/dep/index.js", c.into),
                b"installed",
            )
            .unwrap();
        }
        Ok(BuiltWorkspace {
            snapshot: b.freeze(),
            env: vec![("FROM_WS".into(), "1".into())],
            warnings: vec![],
            installs: vec![],
            path: vec![],
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
    /// `envcache` tools have one environment cache, of 64 bytes at most.
    fn env_caches(&self, tool: &String) -> Vec<crate::env_cache::EnvCacheDecl> {
        if !tool.contains(":envcache") {
            return Vec::new();
        }
        vec![crate::env_cache::EnvCacheDecl {
            name: "build".into(),
            path: "/root/.cache/build".into(),
            max_bytes: 64,
            environment: "fake@1.0.0".into(),
        }]
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
        services: &[ServiceRun<'_, String>],
        _action: &Action,
        inv: Invocation<'_>,
    ) -> Result<Execution, String> {
        self.order.lock().unwrap().push(inv.job.id.clone());
        // Each service under `<job>/<service>`, in both maps.
        for run in services {
            let key = format!("{}/{}", inv.job.id, run.service.name);
            self.seen_env
                .lock()
                .unwrap()
                .insert(key.clone(), run.env.clone());
            self.seen_tools
                .lock()
                .unwrap()
                .insert(key, vec![run.tool.to_string()]);
        }
        // What the runtime reports for a service that never became ready:
        // the job did not start. It prints the service's environment, as a
        // service's own log lines might.
        if let Some(run) = services.iter().find(|s| s.tool.contains(":unready@")) {
            let env: Vec<String> = run.env.iter().map(|(k, v)| format!("{k}={v}")).collect();
            return Ok(Execution {
                exit_code: 1,
                stderr: format!("[service {}] {}\n", run.service.name, env.join(" ")),
                service_failure: Some(format!(
                    "service `{}` was not ready after 1s: {}",
                    run.service.name,
                    env.join(" ")
                )),
                ..Default::default()
            });
        }
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
        // Cancels its own run, as `POST /v1/runs/{id}/cancel` would while it
        // runs, then waits to be stopped as the runtime would stop it.
        if tool.contains(":cancel-run@") {
            let cancel = inv.cancel.as_ref().expect("a cancellable run");
            cancel.cancel();
            let until = Instant::now() + Duration::from_secs(5);
            while !cancel.is_cancelled() && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(5));
            }
            return Ok(Execution {
                exit_code: iwci_runtime::TIMEOUT_EXIT_CODE,
                cancelled: true,
                ..Default::default()
            });
        }
        // What the runtime reports for a job it stopped as hung.
        if tool.contains(":hang@") || tool.contains(":hang-oom@") {
            return Ok(Execution {
                exit_code: iwci_runtime::TIMEOUT_EXIT_CODE,
                stalled_after: Some(300),
                out_of_memory: tool.contains("-oom@"),
                ..Default::default()
            });
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
        // `dl-write` leaves a text report and a binary blob, both holding
        // the job's `TOKEN`, and a file the checkout already had untouched.
        if tool.contains(":dl-write") {
            let token = inv
                .env
                .iter()
                .find(|(k, _)| k == "TOKEN")
                .map(|(_, v)| v.clone())
                .unwrap_or_default();
            inv.fs
                .write(
                    "/app/out/report.txt",
                    format!("ok\ntoken={token}\n").as_bytes(),
                )
                .unwrap();
            let mut blob = vec![0u8, 159, 146, 150];
            blob.extend_from_slice(token.as_bytes());
            inv.fs.write("/app/out/blob.bin", &blob).unwrap();
            inv.fs.write("/tmp/core.txt", b"core").unwrap();
        }
        // `envcache` prints what its environment cache holds (`name=content`),
        // then writes `$CACHE_FILE` (default `a`) there with
        // `$CACHE_CONTENT` (default `built`).
        if tool.contains(":envcache") {
            let var = |name: &str, default: &str| {
                inv.env
                    .iter()
                    .find(|(k, _)| k == name)
                    .map_or(default.to_string(), |(_, v)| v.clone())
            };
            let mut held: Vec<String> = inv
                .fs
                .entries_under(&["/root/.cache/build"])
                .into_iter()
                .filter_map(|e| match e {
                    iwci_vfs::Entry::File { path, data } => Some(format!(
                        "{}={}",
                        path.file_name().unwrap().to_string_lossy(),
                        String::from_utf8_lossy(&data)
                    )),
                    _ => None,
                })
                .collect();
            held.sort();
            stdout.push_str(&held.join(","));
            inv.fs
                .write(
                    format!("/root/.cache/build/{}", var("CACHE_FILE", "a")),
                    var("CACHE_CONTENT", "built").as_bytes(),
                )
                .unwrap();
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
        installs: AtomicUsize::new(0),
        fail: fail_ws,
        source: "a",
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
        skip_task_cache: false,
        downloads: None,
        cancel: None,
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
fn a_stalled_job_fails_naming_the_stall_and_blocks_its_dependents() {
    let p = plan(
        "name: x\njobs:\n  hang:\n    using: builtin:hang@1\n    timeout: 20m\n  after:\n    using: builtin:ok@1\n    needs: [hang]\n",
    );
    let (report, _, _, _) = run_plan(&p, None, false);
    let Status::Failed { reason } = status(&report, "hang") else {
        panic!("{:?}", status(&report, "hang"));
    };
    assert_eq!(
        reason,
        "stalled: no output and no CPU use for 5 minutes, so it was stopped before its 1200s timeout"
    );
    assert!(matches!(status(&report, "after"), Status::Skipped { .. }));
}

#[test]
fn a_job_that_hangs_after_running_out_of_memory_says_both() {
    let p = plan(
        "name: x\njobs:\n  hang:\n    using: builtin:hang-oom@1\n    memory: 1GiB\n    timeout: 20m\n",
    );
    let (report, _, _, _) = run_plan(&p, None, false);
    let Status::Failed { reason } = status(&report, "hang") else {
        panic!("{:?}", status(&report, "hang"));
    };
    assert_eq!(
        reason,
        "stalled: no output and no CPU use for 5 minutes, so it was stopped before its 1200s timeout, after it ran out of its 1024 MiB of memory"
    );
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

    // The same while another run holds memory: it can never fit, so it is
    // turned away at once rather than waiting for memory to come back.
    let budget = Arc::new(MemoryBudget::new(1 << 30));
    assert!(budget.try_take(1 << 29));
    let (report, exec, _, _) = run_limited(&p, None, false, Some(budget.clone()));
    assert!(ran(&exec).is_empty());
    assert!(
        matches!(status(&report, "big"), Status::Error { message } if message.contains("more than the runner's whole limit"))
    );
    assert_eq!(budget.used(), 1 << 29);
}

/// Runs every `builtin:gate@1` job only once [`Gated::open`] is called.
struct Gated {
    inner: FakeExecutor,
    open: Mutex<bool>,
    opened: Condvar,
}

impl Gated {
    fn new() -> Self {
        Self {
            inner: FakeExecutor {
                seen_env: Mutex::default(),
                seen_tools: Mutex::default(),
                order: Mutex::default(),
                running: AtomicUsize::new(0),
                most_at_once: AtomicUsize::new(0),
            },
            open: Mutex::new(false),
            opened: Condvar::new(),
        }
    }

    fn open(&self) {
        *self.open.lock().unwrap() = true;
        self.opened.notify_all();
    }

    fn ran(&self) -> Vec<String> {
        ran(&self.inner)
    }
}

impl Executor<String> for Gated {
    fn execute(
        &self,
        tool: &String,
        path_tools: &[Arc<String>],
        services: &[ServiceRun<'_, String>],
        action: &Action,
        inv: Invocation<'_>,
    ) -> Result<Execution, String> {
        if tool.contains(":gate@") {
            // Recorded as started before it waits.
            self.inner.order.lock().unwrap().push(inv.job.id.clone());
            let mut open = self.open.lock().unwrap();
            while !*open {
                open = self.opened.wait(open).unwrap();
            }
            drop(open);
            return Ok(Execution::default());
        }
        self.inner.execute(tool, path_tools, services, action, inv)
    }
}

/// One run of `plan` against `budget`, which other runs may share.
fn run_sharing(plan: &Plan, exec: &Gated, budget: &Arc<MemoryBudget>) -> RunReport {
    let ws = FakeWorkspaces {
        builds: AtomicUsize::new(0),
        installs: AtomicUsize::new(0),
        fail: false,
        source: "a",
    };
    let options = Options {
        parallelism: 4,
        changed_paths: None,
        base_env: Vec::new(),
        memory: Some(budget.clone()),
        caches: None,
        logs: None,
        slots: None,
        secrets: BTreeMap::new(),
        skip_task_cache: false,
        downloads: None,
        cancel: None,
    };
    run(
        plan,
        &ws,
        &FakeTools,
        exec,
        &FakeCommitter(Mutex::default()),
        &options,
    )
}

/// Runs `0` when a test fails, so threads it left waiting on a gate or on
/// memory finish and the test reports its failure instead of hanging.
struct OnPanic<F: FnMut()>(F);

impl<F: FnMut()> Drop for OnPanic<F> {
    fn drop(&mut self) {
        if std::thread::panicking() {
            (self.0)();
        }
    }
}

/// Waits up to ten seconds for `done`.
fn eventually(what: &str, done: impl Fn() -> bool) {
    let until = Instant::now() + Duration::from_secs(10);
    while !done() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn a_run_waits_for_memory_another_run_holds() {
    // #975: the first run holds the whole budget; the second has nothing
    // of its own running and jobs that only fit once the first is done.
    let budget = Arc::new(MemoryBudget::new(1 << 30));
    let first = plan("name: first\njobs:\n  hog:\n    using: builtin:gate@1\n    memory: 1GiB\n");
    let second = plan(
        "name: second\njobs:\n  a:\n    using: builtin:ok@1\n    memory: 512MiB\n  b:\n    using: builtin:ok@1\n    memory: 512MiB\n    needs: [a]\n",
    );
    let first_exec = Gated::new();
    let second_exec = Gated::new();
    std::thread::scope(|scope| {
        let _unstick = OnPanic(|| {
            first_exec.open();
            budget.give(1 << 30);
        });
        let first_run = scope.spawn(|| run_sharing(&first, &first_exec, &budget));
        eventually("`hog` to start", || first_exec.ran() == ["hog"]);
        assert_eq!(budget.used(), 1 << 30);
        let second_run = scope.spawn(|| run_sharing(&second, &second_exec, &budget));
        // It waits rather than giving up on its jobs.
        std::thread::sleep(Duration::from_millis(200));
        assert!(!second_run.is_finished(), "the second run gave up");
        assert!(second_exec.ran().is_empty());

        // The first run finishing gives the memory back, which wakes the
        // second, though nothing of its own changed.
        first_exec.open();
        assert!(first_run.join().unwrap().passed());
        let report = second_run.join().unwrap();
        assert!(report.passed(), "{:#?}", report.jobs);
        assert_eq!(report.jobs.len(), 2);
        assert_eq!(status(&report, "a"), &Status::Passed);
        assert_eq!(status(&report, "b"), &Status::Passed);
        assert_eq!(second_exec.ran(), ["a", "b"]);
    });
    assert_eq!(budget.used(), 0, "every reservation is given back");
}

#[test]
fn queued_jobs_count_as_waiting_memory_until_they_start() {
    // #1089: `/v1/capacity`'s `memory_waiting` is what a runner has
    // admitted beyond what it holds, so the proxy can tell a runner whose
    // budget is spoken for from one with room.
    let budget = Arc::new(MemoryBudget::new(1 << 30));
    let first = plan("name: first\njobs:\n  hog:\n    using: builtin:gate@1\n    memory: 1GiB\n");
    let second = plan(
        "name: second\njobs:\n  a:\n    using: builtin:ok@1\n    memory: 512MiB\n  b:\n    using: builtin:ok@1\n    memory: 256MiB\n  c:\n    using: builtin:ok@1\n    memory: 128MiB\n    needs: [a]\n",
    );
    let first_exec = Gated::new();
    let second_exec = Gated::new();
    std::thread::scope(|scope| {
        let _unstick = OnPanic(|| {
            first_exec.open();
            budget.give(1 << 30);
        });
        let first_run = scope.spawn(|| run_sharing(&first, &first_exec, &budget));
        eventually("`hog` to start", || first_exec.ran() == ["hog"]);
        // Started: held, not waiting.
        assert_eq!(budget.waiting(), 0);
        let second_run = scope.spawn(|| run_sharing(&second, &second_exec, &budget));
        // `a` and `b` are ready and wait for memory; `c` is not ready yet,
        // so it asks for nothing until `a` is done.
        eventually("`a` and `b` to wait", || budget.waiting() == 768 << 20);
        first_exec.open();
        assert!(first_run.join().unwrap().passed());
        assert!(second_run.join().unwrap().passed());
    });
    assert_eq!(budget.waiting(), 0, "nothing is left waiting");
    assert_eq!(budget.used(), 0);
}

#[test]
fn a_cancelled_run_leaves_nothing_waiting() {
    let budget = Arc::new(MemoryBudget::new(1 << 30));
    assert!(budget.try_take(1 << 30)); // another run's
    let p = plan(
        "name: x\njobs:\n  a:\n    using: builtin:ok@1\n    memory: 512MiB\n  b:\n    using: builtin:ok@1\n    memory: 512MiB\n",
    );
    let cancel = iwci_runtime::Cancel::new();
    let ws = FakeWorkspaces {
        builds: AtomicUsize::new(0),
        installs: AtomicUsize::new(0),
        fail: false,
        source: "a",
    };
    let exec = Gated::new();
    std::thread::scope(|scope| {
        let _unstick = OnPanic(|| budget.give(1 << 30));
        let run = scope.spawn(|| {
            let options = Options {
                parallelism: 4,
                changed_paths: None,
                base_env: Vec::new(),
                memory: Some(budget.clone()),
                caches: None,
                logs: None,
                slots: None,
                secrets: BTreeMap::new(),
                skip_task_cache: false,
                downloads: None,
                cancel: Some(cancel.clone()),
            };
            run(
                &p,
                &ws,
                &FakeTools,
                &exec,
                &FakeCommitter(Mutex::default()),
                &options,
            )
        });
        eventually("`a` and `b` to wait", || budget.waiting() == 1 << 30);
        cancel.cancel();
        run.join().unwrap();
    });
    assert!(exec.ran().is_empty());
    assert_eq!(budget.waiting(), 0);
    assert_eq!(budget.used(), 1 << 30, "only the other run's is held");
}

#[test]
fn memory_another_run_gives_back_is_taken_while_the_run_is_busy() {
    // Memory given back while the run waits on work of its own (here a
    // small job that fits beside another run's) is used at once, not when
    // that job finishes.
    let budget = Arc::new(MemoryBudget::new((1 << 30) + (16 << 20)));
    assert!(budget.try_take(1 << 30)); // another run's
    let p = plan(
        "name: x\njobs:\n  long:\n    using: builtin:gate@1\n    memory: 16MiB\n  big:\n    using: builtin:ok@1\n    memory: 1GiB\n",
    );
    let exec = Gated::new();
    std::thread::scope(|scope| {
        let _unstick = OnPanic(|| {
            exec.open();
            budget.give(1 << 30);
        });
        let run = scope.spawn(|| run_sharing(&p, &exec, &budget));
        eventually("`long` to start", || exec.ran() == ["long"]);
        budget.give(1 << 30);
        eventually("`big` to run while `long` still runs", || {
            exec.ran() == ["long", "big"]
        });
        exec.open();
        let report = run.join().unwrap();
        assert!(report.passed(), "{:#?}", report.jobs);
    });
    assert_eq!(budget.used(), 0);
}

#[test]
fn a_needs_cycle_is_still_reported_once_nothing_else_can_run() {
    // Validation rules a cycle out, so make one by hand. `c` waits for
    // memory another run holds; the cycle is reported once `c` has run,
    // and not before, since until then something was still queued.
    let mut p = plan(
        "name: x\njobs:\n  c:\n    using: builtin:ok@1\n    memory: 512MiB\n  x:\n    using: builtin:ok@1\n  y:\n    using: builtin:ok@1\n",
    );
    for job in &mut p.jobs {
        match job.key.as_str() {
            "x" => job.needs = vec!["y".into()],
            "y" => job.needs = vec!["x".into()],
            _ => {}
        }
    }
    let budget = Arc::new(MemoryBudget::new(1 << 30));
    assert!(budget.try_take(1 << 30));
    let exec = Gated::new();
    std::thread::scope(|scope| {
        let _unstick = OnPanic(|| {
            exec.open();
            budget.give(1 << 30);
        });
        let run = scope.spawn(|| run_sharing(&p, &exec, &budget));
        std::thread::sleep(Duration::from_millis(200));
        assert!(!run.is_finished(), "`c` was given up on");
        budget.give(1 << 30);
        let report = run.join().unwrap();
        assert_eq!(exec.ran(), ["c"]);
        assert_eq!(report.jobs.len(), 3);
        assert_eq!(status(&report, "c"), &Status::Passed);
        for key in ["x", "y"] {
            assert!(
                matches!(status(&report, key), Status::Error { message } if message.contains("can never be satisfied")),
                "{key}: {:?}",
                status(&report, key)
            );
        }
    });

    // And without a budget, as soon as `c` is done.
    let (report, exec, _, _) = run_plan(&p, None, false);
    assert_eq!(ran(&exec), ["c"]);
    assert_eq!(report.jobs.len(), 3);
    assert!(matches!(status(&report, "x"), Status::Error { .. }));
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

/// Environment caches through the real store adapter: one cache per job
/// and environment version, restored on the next run, saved only after a
/// pass and only when the run changed it.
fn env_cache_store(name: &str) -> (Arc<dyn iwci_store::ObjectStore>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("iwci-env-cache-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    (Arc::new(iwci_store::LocalStore::new(&dir).unwrap()), dir)
}

fn env_caches_for(
    store: &Arc<dyn iwci_store::ObjectStore>,
    branch: &str,
    event: iwci_spec::Event,
) -> Arc<dyn Caches> {
    Arc::new(crate::adapters::caches::StoreCaches::new(
        store.clone(),
        &iwci_store::RepoId::new("github.com-acme").unwrap(),
        &iwci_store::RepoId::new("web").unwrap(),
        branch,
        "main",
        event,
        None,
    ))
}

fn env_cache_run(p: &Plan, caches: &Arc<dyn Caches>) -> (Status, String, Vec<String>) {
    let (report, _, _, _) = run_with(p, None, false, None, Some(caches.clone()));
    let job = &report.jobs[0];
    let stdout = job
        .execution
        .as_ref()
        .map(|e| e.stdout.clone())
        .unwrap_or_default();
    (job.status.clone(), stdout, job.caches.clone())
}

#[test]
fn environment_caches_come_back_on_the_next_run() {
    let (store, dir) = env_cache_store("next");
    let main = env_caches_for(&store, "main", iwci_spec::Event::Push);
    let p = plan("name: x\njobs:\n  g:\n    using: builtin:envcache@1\n    changes: fail\n");

    let (status, held, lines) = env_cache_run(&p, &main);
    assert_eq!(status, Status::Passed, "{lines:?}");
    assert_eq!(held, "");
    assert_eq!(
        lines,
        vec!["env cache `build`: miss", "env cache `build`: saved 1 KiB"]
    );

    // The next run starts with what the first one added, and saves
    // nothing when it leaves it as it was.
    let (status, held, lines) = env_cache_run(&p, &main);
    assert_eq!(status, Status::Passed, "{lines:?}");
    assert_eq!(held, "a=built");
    assert_eq!(
        lines,
        vec![
            "env cache `build`: restored 1 KiB",
            "env cache `build`: unchanged"
        ]
    );

    // A failing run saves nothing, even what it changed.
    let failing = plan(
        "name: x\njobs:\n  g:\n    using: builtin:envcache-fail@1\n    env: { CACHE_CONTENT: broken }\n",
    );
    let (status, held, lines) = env_cache_run(&failing, &main);
    assert!(matches!(status, Status::Failed { .. }), "{status:?}");
    assert_eq!(held, "a=built");
    assert_eq!(lines, vec!["env cache `build`: restored 1 KiB"]);
    let (_, held, _) = env_cache_run(&p, &main);
    assert_eq!(held, "a=built");

    // `env-cache: false`, or the cache's name to `false`, turns it off.
    for off in ["false", "{ build: false }"] {
        let p = plan(&format!(
            "name: x\njobs:\n  g:\n    using: builtin:envcache@1\n    env-cache: {off}\n    env: {{ CACHE_CONTENT: off }}\n"
        ));
        let (status, held, lines) = env_cache_run(&p, &main);
        assert_eq!(status, Status::Passed, "{lines:?}");
        assert_eq!((held.as_str(), lines.len()), ("", 0), "{off}: {lines:?}");
    }
    let (_, held, _) = env_cache_run(&p, &main);
    assert_eq!(held, "a=built");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_pull_request_never_writes_the_default_branchs_environment_cache() {
    let (store, dir) = env_cache_store("pr");
    let main = env_caches_for(&store, "main", iwci_spec::Event::Push);
    let pr = env_caches_for(&store, "main", iwci_spec::Event::PullRequest);
    let p = |content: &str| {
        plan(&format!(
            "name: x\njobs:\n  g:\n    using: builtin:envcache@1\n    env: {{ CACHE_CONTENT: {content} }}\n"
        ))
    };
    env_cache_run(&p("trusted"), &main);

    // The pull request starts from the default branch's cache and saves
    // what it changed into its own scope...
    let (status, held, lines) = env_cache_run(&p("poisoned"), &pr);
    assert_eq!(status, Status::Passed, "{lines:?}");
    assert_eq!(held, "a=trusted");
    assert!(
        lines[1].starts_with("env cache `build`: saved"),
        "{lines:?}"
    );
    let (_, held, _) = env_cache_run(&p("poisoned"), &pr);
    assert_eq!(held, "a=poisoned");

    // ...which the default branch never reads.
    let (_, held, _) = env_cache_run(&p("trusted"), &main);
    assert_eq!(held, "a=trusted");
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn an_environment_cache_past_its_size_keeps_only_what_the_last_run_wrote() {
    let (store, dir) = env_cache_store("size");
    let main = env_caches_for(&store, "main", iwci_spec::Event::Push);
    let p = |file: &str, content: &str| {
        plan(&format!(
            "name: x\njobs:\n  g:\n    using: builtin:envcache@1\n    env: {{ CACHE_FILE: {file}, CACHE_CONTENT: {content} }}\n"
        ))
    };
    let thirty = "x".repeat(30);
    env_cache_run(&p("a", &thirty), &main);
    let (_, held, _) = env_cache_run(&p("b", &thirty), &main);
    assert_eq!(held, format!("a={thirty}"));
    // a and b are 60 bytes together, within its 64.
    let (_, held, lines) = env_cache_run(&p("c", &thirty), &main);
    assert_eq!(held, format!("a={thirty},b={thirty}"));
    // With c it held 90: only c, which that run wrote, was kept.
    assert!(
        lines[1].contains("only what this run wrote was kept"),
        "{lines:?}"
    );
    let (_, held, _) = env_cache_run(&p("c", &thirty), &main);
    assert_eq!(held, format!("c={thirty}"));
    // One run that writes more than the whole cache may hold saves nothing.
    let big = "y".repeat(70);
    let (_, _, lines) = env_cache_run(&p("d", &big), &main);
    assert!(lines[1].contains("not saved"), "{lines:?}");
    let _ = std::fs::remove_dir_all(dir);
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
        installs: AtomicUsize::new(0),
        fail: false,
        source: "a",
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
        skip_task_cache: false,
        downloads: None,
        cancel: None,
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
            _services: &[ServiceRun<'_, String>],
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
        "name: x\njobs:\n  a:\n    using: builtin:ok@1\n  b:\n    using: builtin:ok@1\n    needs: [a]\n    if: false\n",
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
        skip_task_cache: false,
        downloads: None,
        cancel: None,
    };
    let ws = FakeWorkspaces {
        builds: AtomicUsize::new(0),
        installs: AtomicUsize::new(0),
        fail: false,
        source: "a",
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
    assert_eq!(
        lines[0],
        r#"{"event":"pipeline-started","pipeline":"x","jobs":[{"key":"a","name":"a","needs":[],"ids":["a"]},{"key":"b","name":"b","needs":["a"],"ids":["b"]}]}"#,
        "the graph comes first, before any job"
    );
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

#[test]
fn an_artifact_path_can_name_a_single_file() {
    // `gen` writes src/new.ts; only that file is listed, and only it travels.
    let p = plan(
        "name: x\njobs:\n  gen:\n    using: builtin:src-write@1\n    artifacts: [src/new.ts]\n  use:\n    using: builtin:src-list@1\n    needs: [gen]\n",
    );
    let (report, _, _, _) = run_plan(&p, None, false);
    assert!(report.passed(), "{:#?}", report.jobs);
    assert!(notes_of(&report, "gen").contains(&"artifacts: kept 1 file(s), 1 KiB".to_string()));
    assert_eq!(stdout_of(&report, "use"), "a.ts,new.ts");
}

/// A run with caches and the commit's `src/a.ts` holding `source`.
fn run_cached(
    plan: &Plan,
    caches: &Arc<MemoryCaches>,
    source: &'static str,
) -> (RunReport, Vec<String>) {
    let (report, ran, _) = run_cached_installs(plan, caches, source);
    (report, ran)
}

/// [`run_cached`], plus how many workspace builds installed dependencies.
fn run_cached_installs(
    plan: &Plan,
    caches: &Arc<MemoryCaches>,
    source: &'static str,
) -> (RunReport, Vec<String>, usize) {
    run_cached_with(plan, caches, source, false)
}

/// [`run_cached_installs`], skipping the task cache's lookups when asked.
fn run_cached_with(
    plan: &Plan,
    caches: &Arc<MemoryCaches>,
    source: &'static str,
    skip_task_cache: bool,
) -> (RunReport, Vec<String>, usize) {
    let ws = FakeWorkspaces {
        builds: AtomicUsize::new(0),
        installs: AtomicUsize::new(0),
        fail: false,
        source,
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
        base_env: Vec::new(),
        memory: None,
        caches: Some(caches.clone()),
        logs: None,
        slots: None,
        secrets: BTreeMap::new(),
        skip_task_cache,
        downloads: None,
        cancel: None,
    };
    let report = run(
        plan,
        &ws,
        &FakeTools,
        &exec,
        &FakeCommitter(Mutex::default()),
        &options,
    );
    let ran = ran(&exec);
    (report, ran, ws.installs.load(Ordering::SeqCst))
}

fn cached(report: &RunReport, id: &str) -> bool {
    report.jobs.iter().find(|j| j.id == id).unwrap().cached
}

#[test]
fn the_task_cache_skips_jobs_whose_inputs_have_not_changed() {
    let p = plan(
        "name: x\njobs:\n  lib:\n    using: builtin:art-write@1\n    artifacts: [dist]\n    task-cache: { inputs: [src/**] }\n  check:\n    using: builtin:art-read@1\n    needs: [lib]\n    task-cache: { inputs: [docs/**] }\n  other:\n    using: builtin:print@1\n",
    );
    let store = Arc::new(MemoryCaches::default());
    let (first, ran) = run_cached(&p, &store, "a");
    assert!(first.passed(), "{:#?}", first.jobs);
    assert_eq!(ran.len(), 3);
    assert!(!cached(&first, "lib") && !cached(&first, "check"));
    assert_eq!(stdout_of(&first, "check"), "lib.txt");
    assert_eq!(
        store.saved.lock().unwrap().len(),
        2,
        "one entry per task-cached job"
    );

    // Nothing changed: neither cached job runs, and `check` still gets
    // `lib`'s artifacts and shows the log of the run it stands for.
    let (second, ran) = run_cached(&p, &store, "a");
    assert!(second.passed(), "{:#?}", second.jobs);
    assert_eq!(ran, ["other"], "only the job without a task cache ran");
    assert!(cached(&second, "lib") && cached(&second, "check"));
    assert_eq!(stdout_of(&second, "check"), "lib.txt");
    let lib = second.jobs.iter().find(|j| j.id == "lib").unwrap();
    assert_eq!(
        lib.memory_mib, 0,
        "a job that did not run is not billed memory"
    );
    assert!(
        lib.caches.iter().any(|l| l.ends_with(": hit")),
        "{:?}",
        lib.caches
    );
    assert!(
        notes_of(&second, "lib")
            .iter()
            .any(|n| n.contains("from the task cache")),
        "{:?}",
        notes_of(&second, "lib")
    );

    // An input changes: `lib` runs again; its artifacts are the same bytes,
    // so `check`, which reads only them (and `docs/`), still does not.
    let (third, ran) = run_cached(&p, &store, "changed");
    assert!(third.passed(), "{:#?}", third.jobs);
    assert!(
        ran.contains(&"lib".to_string()) && !ran.contains(&"check".to_string()),
        "{ran:?}"
    );
}

#[test]
fn a_run_that_skips_the_task_cache_runs_every_job_and_still_saves() {
    let p = plan(
        "name: x\njobs:\n  lib:\n    using: builtin:art-write@1\n    artifacts: [dist]\n    task-cache: { inputs: [src/**] }\n  check:\n    using: builtin:art-read@1\n    needs: [lib]\n    task-cache: { inputs: [docs/**] }\n",
    );
    let store = Arc::new(MemoryCaches::default());
    let (first, _) = run_cached(&p, &store, "a");
    assert!(first.passed(), "{:#?}", first.jobs);
    assert_eq!(store.saved.lock().unwrap().len(), 2);

    // Nothing changed, but this run does not read the task cache: both
    // jobs run, and say why.
    let (fresh, ran, _) = run_cached_with(&p, &store, "a", true);
    assert!(fresh.passed(), "{:#?}", fresh.jobs);
    assert_eq!(ran, ["lib", "check"]);
    assert!(!cached(&fresh, "lib") && !cached(&fresh, "check"));
    let lib = fresh.jobs.iter().find(|j| j.id == "lib").unwrap();
    assert!(
        lib.caches
            .iter()
            .any(|l| l.ends_with("not read, this run skips the task cache")),
        "{:?}",
        lib.caches
    );
    // Its passes are saved again under the same keys.
    let saved = store.saved.lock().unwrap().clone();
    assert_eq!(saved.len(), 4, "{saved:?}");
    assert_eq!(
        saved[0..2].iter().collect::<HashSet<_>>(),
        saved[2..4].iter().collect::<HashSet<_>>()
    );

    // The next run that reads the task cache is cached again.
    let (after, ran) = run_cached(&p, &store, "a");
    assert!(after.passed(), "{:#?}", after.jobs);
    assert!(ran.is_empty(), "{ran:?}");
    assert!(cached(&after, "lib") && cached(&after, "check"));
}

#[test]
fn a_changed_artifact_reaches_the_jobs_downstream() {
    // `lib` writes its job id: a matrix entry renamed upstream changes
    // what `check` is handed, and so its key.
    let first = plan(
        "name: x\njobs:\n  lib:\n    using: builtin:art-write@1\n    matrix: [a]\n    artifacts: [dist]\n  check:\n    using: builtin:art-read@1\n    needs: [lib]\n    task-cache: true\n",
    );
    let second = plan(
        "name: x\njobs:\n  lib:\n    using: builtin:art-write@1\n    matrix: [b]\n    artifacts: [dist]\n  check:\n    using: builtin:art-read@1\n    needs: [lib]\n    task-cache: true\n",
    );
    let store = Arc::new(MemoryCaches::default());
    run_cached(&first, &store, "a");
    let (again, _) = run_cached(&first, &store, "a");
    assert!(cached(&again, "check"));
    let (changed, ran) = run_cached(&second, &store, "a");
    assert!(!cached(&changed, "check") && ran.contains(&"check".to_string()));
    assert_eq!(stdout_of(&changed, "check"), "lib_b_.txt");
}

#[test]
fn the_task_cache_keys_on_the_job_and_ignores_node_modules() {
    let store = Arc::new(MemoryCaches::default());
    let a = plan(
        "name: x\njobs:\n  t:\n    using: builtin:print@1\n    args: [one]\n    task-cache: true\n",
    );
    let b = plan(
        "name: x\njobs:\n  t:\n    using: builtin:print@1\n    args: [two]\n    task-cache: true\n",
    );
    run_cached(&a, &store, "a");
    let (again, _) = run_cached(&a, &store, "a");
    assert!(cached(&again, "t"));
    let (other, _) = run_cached(&b, &store, "a");
    assert!(
        !cached(&other, "t"),
        "different arguments are a different task"
    );
    let keys = store.saved.lock().unwrap().clone();
    assert!(keys.iter().all(|k| k.starts_with("task/t/")), "{keys:?}");
}

#[test]
fn failures_are_not_cached() {
    let store = Arc::new(MemoryCaches::default());
    let p = plan("name: x\njobs:\n  t:\n    using: builtin:fail@1\n    task-cache: true\n");
    run_cached(&p, &store, "a");
    let (again, ran) = run_cached(&p, &store, "a");
    assert_eq!(ran, ["t"]);
    assert!(!again.passed());
    assert!(store.saved.lock().unwrap().is_empty());
}

#[test]
fn a_run_whose_jobs_all_hit_installs_nothing() {
    let p = plan(
        "name: x\nworkspace:\n  deps: [pnpm]\njobs:\n  a:\n    using: builtin:print@1\n    task-cache: true\n  b:\n    using: builtin:print@1\n    needs: [a]\n    task-cache: true\n",
    );
    let store = Arc::new(MemoryCaches::default());
    let (_, _, installs) = run_cached_installs(&p, &store, "a");
    assert_eq!(installs, 1, "the first run installs once for both jobs");
    let (report, ran, installs) = run_cached_installs(&p, &store, "a");
    assert!(report.passed() && ran.is_empty(), "{ran:?}");
    assert_eq!(
        installs, 0,
        "every job hit, so the workspace was never built"
    );
    assert!(report.installs.is_empty());
}

#[test]
fn reports_say_what_each_job_needed() {
    let p = plan(
        "name: x\njobs:\n  a:\n    using: builtin:ok@1\n  b:\n    using: builtin:fail@1\n    needs: [a]\n  c:\n    using: builtin:ok@1\n    needs: [b]\n",
    );
    let (report, _, _, _) = run_plan(&p, None, false);
    let needs = |id: &str| {
        report
            .jobs
            .iter()
            .find(|j| j.id == id)
            .unwrap()
            .needs
            .clone()
    };
    assert!(needs("a").is_empty());
    assert_eq!(needs("b"), ["a"]);
    assert_eq!(
        needs("c"),
        ["b"],
        "a job skipped for a failure upstream says so too"
    );
}

/// [`MemoryCaches`] behind a store that takes a while to answer: counts
/// the lookups in flight at once and records every key asked for.
#[derive(Default)]
struct SlowCaches {
    inner: MemoryCaches,
    asked: Mutex<Vec<String>>,
    in_flight: AtomicUsize,
    most_at_once: AtomicUsize,
    /// A key containing this takes longer still.
    slowest: Mutex<Option<&'static str>>,
}

impl Caches for SlowCaches {
    fn restore(
        &self,
        key: &str,
        restore_keys: &[String],
        max: u64,
    ) -> Result<Option<Restored>, String> {
        self.asked.lock().unwrap().push(key.into());
        let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
        self.most_at_once.fetch_max(now, Ordering::SeqCst);
        let slowest = *self.slowest.lock().unwrap();
        let extra = if slowest.is_some_and(|s| key.contains(s)) {
            150
        } else {
            0
        };
        std::thread::sleep(Duration::from_millis(50 + extra));
        self.in_flight.fetch_sub(1, Ordering::SeqCst);
        self.inner.restore(key, restore_keys, max)
    }
    fn save(
        &self,
        key: &str,
        restore_keys: &[String],
        entries: &[iwci_vfs::Entry],
    ) -> Result<(), String> {
        self.inner.save(key, restore_keys, entries)
    }
}

/// A run against a slow store, with the runner's limits as given. Returns
/// the report, the jobs that ran and the most that ran at once.
fn run_looked_up(
    plan: &Plan,
    caches: &Arc<SlowCaches>,
    parallelism: usize,
    slots: Option<Arc<Slots>>,
    memory: Option<Arc<MemoryBudget>>,
) -> (RunReport, Vec<String>, usize) {
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
        parallelism,
        changed_paths: None,
        base_env: Vec::new(),
        memory,
        caches: Some(caches.clone()),
        logs: None,
        slots,
        secrets: BTreeMap::new(),
        skip_task_cache: false,
        downloads: None,
        cancel: None,
    };
    let report = run(
        plan,
        &ws,
        &FakeTools,
        &exec,
        &FakeCommitter(Mutex::default()),
        &options,
    );
    let ran = ran(&exec);
    (report, ran, exec.most_at_once.load(Ordering::SeqCst))
}

const SIXTEEN: &str = "name: x\njobs:\n  t:\n    using: builtin:slow@1\n    matrix: [a, b, c, d, e, f, g, h, i, j, k, l, m, n, o, p]\n    task-cache: true\n";

#[test]
fn task_cache_lookups_overlap_beyond_the_jobs_that_may_run() {
    let p = plan(SIXTEEN);
    let store = Arc::new(SlowCaches::default());
    // Cold: sixteen misses looked up together, then run two at a time.
    let (first, ran, most_running) = run_looked_up(&p, &store, 2, None, None);
    assert!(first.passed(), "{:#?}", first.jobs);
    assert_eq!(ran.len(), 16);
    assert!(most_running <= 2, "{most_running} jobs ran at once");
    let looked_up = store.most_at_once.load(Ordering::SeqCst);
    assert!(
        looked_up > 2,
        "only {looked_up} lookups were in flight at once with parallelism 2"
    );
    assert!(looked_up <= LOOKUPS);

    // Warm: sixteen hits, as many at once, and nothing runs.
    store.most_at_once.store(0, Ordering::SeqCst);
    let (second, ran, _) = run_looked_up(&p, &store, 2, None, None);
    assert!(second.passed() && ran.is_empty(), "{ran:?}");
    assert!(second.jobs.iter().all(|j| j.cached));
    assert!(store.most_at_once.load(Ordering::SeqCst) > 2);
    // Matrix order, however the lookups finished.
    let ids: Vec<&str> = second.jobs.iter().map(|j| j.id.as_str()).collect();
    let mut sorted = ids.clone();
    sorted.sort();
    assert_eq!(ids, sorted);
}

#[test]
fn a_hit_takes_no_slot_and_no_memory() {
    let p = plan(
        "name: x\njobs:\n  lib:\n    using: builtin:art-write@1\n    matrix: [a, b, c]\n    artifacts: [dist]\n    memory: 1GiB\n    task-cache: true\n  check:\n    using: builtin:art-read@1\n    needs: [lib]\n    memory: 1GiB\n    task-cache: true\n",
    );
    let store = Arc::new(SlowCaches::default());
    let (first, ran, _) = run_looked_up(&p, &store, 4, None, None);
    assert!(first.passed(), "{:#?}", first.jobs);
    assert_eq!(ran.len(), 4);

    // Every slot of the runner is taken by other runs, and so is all of
    // its memory: a job that had to run would wait for ever. Hits do not.
    let slots = Arc::new(Slots::new(1));
    let _held = slots.acquire();
    let budget = Arc::new(MemoryBudget::new(1 << 30));
    assert!(budget.try_take(1 << 30));
    let (second, ran, _) = run_looked_up(&p, &store, 4, Some(slots.clone()), Some(budget.clone()));
    assert!(second.passed(), "{:#?}", second.jobs);
    assert!(ran.is_empty(), "{ran:?}");
    assert_eq!(second.jobs.len(), 4);
    assert!(second.jobs.iter().all(|j| j.cached && j.memory_mib == 0));
    assert_eq!(stdout_of(&second, "check"), stdout_of(&first, "check"));
    assert_eq!(slots.free(), 0, "the held slot is the only one in use");
    assert_eq!(budget.used(), 1 << 30, "nothing was taken or given back");
}

#[test]
fn a_miss_is_looked_up_once_runs_once_and_saves_under_the_key_it_looked_up() {
    // One worker, and `after` waits on a job whose lookup is in flight
    // with nothing queued and nothing running: that is not a stuck run.
    let p = plan(
        "name: x\njobs:\n  t:\n    using: builtin:print@1\n    task-cache: true\n  after:\n    using: builtin:ok@1\n    needs: [t]\n",
    );
    let store = Arc::new(SlowCaches::default());
    let (first, ran, _) = run_looked_up(&p, &store, 1, None, None);
    assert!(first.passed(), "{:#?}", first.jobs);
    assert_eq!(ran, ["t", "after"]);
    let asked = store.asked.lock().unwrap().clone();
    let saved = store.inner.saved.lock().unwrap().clone();
    assert_eq!(asked.len(), 1, "looked up once: {asked:?}");
    assert_eq!(saved, asked, "saved under the key that missed");
    let t = first.jobs.iter().find(|j| j.id == "t").unwrap();
    assert_eq!(t.caches.len(), 2, "{:?}", t.caches);
    assert!(t.caches[0].ends_with(": miss"), "{:?}", t.caches);
    assert!(t.caches[1].contains(": saved "), "{:?}", t.caches);
    assert!(!t.cached);

    // An entry that cannot be used: the same, with the line saying why.
    store
        .inner
        .entries
        .lock()
        .unwrap()
        .insert(asked[0].clone(), Vec::new());
    let (second, ran, _) = run_looked_up(&p, &store, 1, None, None);
    assert!(second.passed(), "{:#?}", second.jobs);
    assert_eq!(ran, ["t", "after"]);
    assert_eq!(
        *store.asked.lock().unwrap(),
        [asked[0].clone(), asked[0].clone()],
        "one more lookup, of the same key"
    );
    assert_eq!(
        *store.inner.saved.lock().unwrap(),
        [asked[0].clone(), asked[0].clone()]
    );
    let t = second.jobs.iter().find(|j| j.id == "t").unwrap();
    assert!(
        t.caches[0].contains("could not use the entry") && t.caches[1].contains(": saved "),
        "{:?}",
        t.caches
    );

    // And now it hits.
    let (third, ran, _) = run_looked_up(&p, &store, 1, None, None);
    assert_eq!(ran, ["after"]);
    assert!(cached(&third, "t"));
}

#[test]
fn a_downstream_key_reads_the_artifacts_its_upstream_replayed() {
    let p = plan(
        "name: x\njobs:\n  lib:\n    using: builtin:art-write@1\n    artifacts: [dist]\n    task-cache: true\n  check:\n    using: builtin:art-read@1\n    needs: [lib]\n    task-cache: true\n",
    );
    let store = Arc::new(SlowCaches::default());
    run_looked_up(&p, &store, 4, None, None);
    let keys = store.inner.saved.lock().unwrap().clone();
    let (lib_key, check_key) = (keys[0].clone(), keys[1].clone());
    assert!(lib_key.starts_with("task/lib/") && check_key.starts_with("task/check/"));

    // `lib` is replayed, and `check` asks for the key it saved under when
    // `lib` really ran: the replayed artifacts are in it, byte for byte.
    store.asked.lock().unwrap().clear();
    let (second, ran, _) = run_looked_up(&p, &store, 4, None, None);
    assert!(ran.is_empty(), "{ran:?}");
    assert!(cached(&second, "lib") && cached(&second, "check"));
    assert_eq!(
        *store.asked.lock().unwrap(),
        [lib_key.clone(), check_key.clone()]
    );

    // The entry `lib` replays now holds other bytes: `check` is handed
    // them, so it asks for another key, misses and runs.
    for entry in store
        .inner
        .entries
        .lock()
        .unwrap()
        .get_mut(&lib_key)
        .unwrap()
    {
        if let Entry::File { path, data } = entry
            && path.starts_with("/app/dist")
        {
            *data = b"rebuilt differently".to_vec().into();
        }
    }
    store.asked.lock().unwrap().clear();
    let (third, ran, _) = run_looked_up(&p, &store, 4, None, None);
    assert!(third.passed(), "{:#?}", third.jobs);
    assert_eq!(ran, ["check"]);
    let asked = store.asked.lock().unwrap().clone();
    assert_eq!(asked[0], lib_key);
    assert!(asked[1].starts_with("task/check/") && asked[1] != check_key);
}

#[test]
fn the_order_lookups_answer_in_does_not_reach_a_downstream_key() {
    let p = plan(
        "name: x\njobs:\n  lib:\n    using: builtin:art-write@1\n    matrix: [a, b, c]\n    artifacts: [dist]\n    task-cache: true\n  check:\n    using: builtin:art-read@1\n    needs: [lib]\n    task-cache: true\n",
    );
    let store = Arc::new(SlowCaches::default());
    let (first, _, _) = run_looked_up(&p, &store, 4, None, None);
    assert!(first.passed(), "{:#?}", first.jobs);
    let check_key = store.inner.saved.lock().unwrap()[3].clone();
    assert!(check_key.starts_with("task/check/"), "{check_key}");
    let lib_ids: Vec<String> = first.jobs[..3].iter().map(|j| j.id.clone()).collect();
    for last in [0, 2] {
        // The entry of `last` answers after the other two.
        let slow: &'static str = Box::leak(format!("task/{}/", lib_ids[last]).into_boxed_str());
        *store.slowest.lock().unwrap() = Some(slow);
        store.asked.lock().unwrap().clear();
        let (again, ran, _) = run_looked_up(&p, &store, 4, None, None);
        assert!(ran.is_empty(), "{ran:?}");
        assert!(cached(&again, "check"));
        assert_eq!(store.asked.lock().unwrap().last(), Some(&check_key));
    }
}

#[test]
fn a_checkout_that_fails_errors_every_task_cached_job_without_a_lookup() {
    let p = plan(SIXTEEN);
    let store = Arc::new(SlowCaches::default());
    let (report, exec, _, _) = run_with(&p, None, true, None, Some(store.clone()));
    assert_eq!(report.jobs.len(), 16);
    for job in &report.jobs {
        assert!(
            matches!(&job.status, Status::Error { message } if message == "workspace did not build: lockfile missing"),
            "{:?}",
            job.status
        );
    }
    assert!(ran(&exec).is_empty());
    assert!(store.asked.lock().unwrap().is_empty());
}

#[test]
fn services_get_their_own_env_and_secrets_and_a_failed_one_fails_the_job_masked() {
    let p = plan(
        r#"name: x
jobs:
  a:
    using: builtin:ok@1
    env: { JOB_ONLY: "1" }
    services:
      db:
        using: env:postgres@18
        run: pglite
        env:
          PASSWORD: ${{ secrets.DB_PASSWORD }}
          GONE: ${{ secrets.NOPE }}
  b:
    using: builtin:ok@1
    services:
      db:
        using: builtin:unready@1
        env: { PASSWORD: "${{ secrets.DB_PASSWORD }}" }
"#,
    );
    let secrets = BTreeMap::from([("DB_PASSWORD".to_string(), "s3cret-pass".to_string())]);
    let (report, exec, _, _) = run_full(&p, None, false, None, None, secrets);

    let seen = exec.seen_env.lock().unwrap();
    let env = &seen["a/db"];
    let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    assert_eq!(get("PASSWORD"), Some("s3cret-pass"));
    assert_eq!(get("GONE"), Some(""));
    // The runner's variables, but nothing of the job's.
    assert_eq!(get("IWCI"), Some("1"));
    assert_eq!(get("IWCI_JOB"), Some("a"));
    assert_eq!(get("JOB_ONLY"), None);
    assert_eq!(get("IWCI_OUTPUT"), None);
    assert_eq!(
        exec.seen_tools.lock().unwrap()["a/db"],
        vec!["env:postgres@18".to_string()]
    );
    let a = report.jobs.iter().find(|j| j.id == "a").unwrap();
    assert_eq!(a.status, Status::Passed);
    assert!(
        a.notes
            .iter()
            .any(|n| n.contains("service `db`") && n.contains("`GONE`")),
        "{:?}",
        a.notes
    );

    // A service that is never ready fails the job, naming it, and the
    // secret in its environment is masked in the reason and the log.
    match status(&report, "b") {
        Status::Failed { reason } => {
            assert!(reason.starts_with("service `db` was not ready"), "{reason}");
            assert!(reason.contains("PASSWORD=***"), "{reason}");
        }
        other => panic!("{other:?}"),
    }
    let b = report.jobs.iter().find(|j| j.id == "b").unwrap();
    let execution = b.execution.as_ref().unwrap();
    assert!(execution.stderr.contains("[service db] "), "{execution:?}");
    assert!(
        !serde_json::to_string(&report)
            .unwrap()
            .contains("s3cret-pass"),
        "a secret reached the report: {}",
        serde_json::to_string(&report).unwrap()
    );
}

#[test]
fn a_service_is_part_of_a_task_cache_key() {
    let job = |services: &str| {
        plan(&format!(
            "name: x\njobs:\n  a:\n    using: builtin:ok@1\n    task-cache: true\n{services}"
        ))
    };
    let key = |p: &Plan| {
        let ws = &p.workspaces[0];
        let snapshot = SnapshotBuilder::new();
        snapshot
            .write(
                format!("{}/src/a.ts", ws.clone.as_ref().unwrap().into),
                b"a",
            )
            .unwrap();
        task_cache_key(p.job("a").unwrap(), p, &snapshot.freeze(), &[]).unwrap()
    };
    let none = job("");
    let with = job("    services: { db: { using: env:postgres@18, run: pglite } }\n");
    let other = job("    services: { db: { using: env:postgres@18, run: 'pglite -x' } }\n");
    assert_ne!(key(&none), key(&with));
    assert_ne!(key(&with), key(&other));
    // A job without services keeps the key it had before they existed.
    assert_eq!(key(&none), key(&job("    services: false\n")));
}

/// Keeps what a run's jobs upload, as the store adapter would.
#[derive(Default)]
struct FakeDownloads {
    uploads: Mutex<Vec<(String, PendingDownload, u64)>>,
}

impl Downloads for FakeDownloads {
    fn upload(
        &self,
        job: &str,
        files: Vec<PendingDownload>,
        retention_secs: u64,
    ) -> (Vec<DownloadedFile>, Vec<String>) {
        let mut kept = Vec::new();
        for file in files {
            kept.push(DownloadedFile {
                path: file.path.clone(),
                size: file.data.len() as u64,
                sha256: String::new(),
                content_type: String::new(),
                expires_at: retention_secs,
                key: format!("artifacts/o/r/run/{}", kept.len()),
                masked: file.masked,
            });
            self.uploads
                .lock()
                .unwrap()
                .push((job.to_string(), file, retention_secs));
        }
        (kept, vec!["one more thing".into()])
    }
}

fn run_downloads(
    yaml: &str,
    secrets: BTreeMap<String, String>,
    store: Option<Arc<FakeDownloads>>,
) -> RunReport {
    let p = plan(yaml);
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
        parallelism: 2,
        changed_paths: None,
        base_env: Vec::new(),
        memory: None,
        caches: None,
        logs: None,
        slots: None,
        secrets,
        skip_task_cache: false,
        downloads: store.map(|s| s as Arc<dyn Downloads>),
        cancel: None,
    };
    run(
        &p,
        &ws,
        &FakeTools,
        &exec,
        &FakeCommitter(Mutex::default()),
        &options,
    )
}

#[test]
fn downloads_are_masked_text_and_unmasked_binaries() {
    let store = Arc::new(FakeDownloads::default());
    let secret = "hunter2-download-value";
    let report = run_downloads(
        "name: x\njobs:\n  a:\n    using: builtin:dl-write@1\n    env: { TOKEN: \"${{ secrets.TOKEN }}\" }\n    downloads: { paths: [out, /tmp/core.txt, src], retention: 2d }\n",
        BTreeMap::from([("TOKEN".to_string(), secret.to_string())]),
        Some(store.clone()),
    );
    let job = &report.jobs[0];
    assert_eq!(job.status, Status::Passed, "{job:?}");
    let uploads = store.uploads.lock().unwrap();
    // Only what the job wrote: not the checkout's own `src/a.ts`.
    let mut paths: Vec<&str> = uploads.iter().map(|(_, f, _)| f.path.as_str()).collect();
    paths.sort_unstable();
    assert_eq!(paths, ["/tmp/core.txt", "out/blob.bin", "out/report.txt"]);
    assert!(uploads.iter().all(|(j, _, r)| j == "a" && *r == 2 * 86_400));
    let file = |p: &str| &uploads.iter().find(|(_, f, _)| f.path == p).unwrap().1;
    // The text file never reaches the store with the secret in it.
    let text = file("out/report.txt");
    assert!(text.masked);
    assert_eq!(text.data, b"ok\ntoken=***\n");
    assert!(
        !uploads
            .iter()
            .any(|(_, f, _)| f.masked && String::from_utf8_lossy(&f.data).contains(secret))
    );
    // A binary file is uploaded as it is, which the docs say plainly.
    let blob = file("out/blob.bin");
    assert!(!blob.masked);
    assert!(blob.data.ends_with(secret.as_bytes()));
    // The report lists them and never holds the secret.
    assert_eq!(job.downloads.len(), 3);
    assert!(!serde_json::to_string(&report).unwrap().contains(secret));
    assert!(
        job.notes
            .iter()
            .any(|n| n.starts_with("downloads: kept 3 of 3 file(s)")),
        "{:?}",
        job.notes
    );
    assert!(job.notes.iter().any(|n| n == "downloads: one more thing"));
}

#[test]
fn downloads_follow_when_and_say_when_nothing_keeps_them() {
    // A failure keeps nothing by default...
    let store = Arc::new(FakeDownloads::default());
    let report = run_downloads(
        "name: x\njobs:\n  a:\n    using: builtin:dl-write-fail@1\n    downloads: [out]\n",
        BTreeMap::new(),
        Some(store.clone()),
    );
    assert!(matches!(report.jobs[0].status, Status::Failed { .. }));
    assert!(store.uploads.lock().unwrap().is_empty());
    assert!(report.jobs[0].downloads.is_empty());
    // ...unless `when:` says so, and then a pass keeps nothing.
    let report = run_downloads(
        "name: x\njobs:\n  a:\n    using: builtin:dl-write-fail@1\n    downloads: { paths: [out], when: failure }\n  b:\n    using: builtin:dl-write@1\n    downloads: { paths: [out], when: failure }\n  c:\n    using: builtin:dl-write@1\n    downloads: { paths: [out], when: always }\n",
        BTreeMap::new(),
        Some(store.clone()),
    );
    let jobs: std::collections::BTreeSet<String> = store
        .uploads
        .lock()
        .unwrap()
        .iter()
        .map(|(j, _, _)| j.clone())
        .collect();
    assert_eq!(jobs.into_iter().collect::<Vec<_>>(), ["a", "c"]);
    assert!(
        report
            .jobs
            .iter()
            .find(|j| j.id == "b")
            .unwrap()
            .downloads
            .is_empty()
    );
    // A path the job wrote nothing under, and a runner with no store.
    let report = run_downloads(
        "name: x\njobs:\n  a:\n    using: builtin:ok@1\n    downloads: [out]\n  b:\n    using: builtin:dl-write@1\n    downloads: [out]\n",
        BTreeMap::new(),
        None,
    );
    let notes = |id: &str| {
        report
            .jobs
            .iter()
            .find(|j| j.id == id)
            .unwrap()
            .notes
            .clone()
    };
    assert!(notes("a").contains(&"downloads: nothing under its `downloads:` paths".to_string()));
    assert!(notes("b").contains(&"downloads: this runner keeps no downloads".to_string()));
}

#[test]
fn a_cancelled_run_stops_what_runs_and_starts_nothing_more() {
    // One job at a time, and the queue is a stack: `a` runs first, `b` is
    // queued behind it when it cancels the run.
    let plan = iwci_spec::parse(
        "name: x\njobs:\n  b: { using: builtin:ok@1, args: [] }\n  a: { using: builtin:cancel-run@1, args: [] }\n  c: { using: builtin:ok@1, args: [], needs: [a] }\n  d: { using: builtin:ok@1, args: [], needs: [a], if: 'always()' }\n",
        &Context::default(),
    )
    .unwrap();
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
    let events = Arc::new(Mutex::new(Vec::<LogEvent>::new()));
    let sink = events.clone();
    let memory = Arc::new(MemoryBudget::new(8 << 30));
    let options = Options {
        parallelism: 1,
        changed_paths: None,
        base_env: vec![],
        memory: Some(memory.clone()),
        caches: None,
        logs: Some(Arc::new(move |e| sink.lock().unwrap().push(e))),
        slots: None,
        secrets: BTreeMap::new(),
        skip_task_cache: false,
        downloads: None,
        cancel: Some(iwci_runtime::Cancel::new()),
    };
    let report = run(
        &plan,
        &ws,
        &FakeTools,
        &exec,
        &FakeCommitter(Mutex::default()),
        &options,
    );
    assert_eq!(*exec.order.lock().unwrap(), vec!["a".to_string()]);
    assert!(!report.passed());
    let cancelled = Status::Cancelled {
        reason: CANCELLED_REASON.into(),
    };
    for id in ["a", "b", "c", "d"] {
        assert_eq!(status(&report, id), &cancelled, "{id}");
    }
    let job = |id: &str| report.jobs.iter().find(|j| j.id == id).unwrap();
    assert!(job("a").execution.as_ref().unwrap().cancelled);
    assert!(job("b").execution.is_none(), "never started");
    assert!(job("c").execution.is_none() && job("d").execution.is_none());
    assert_eq!(memory.used(), 0, "every reservation is given back");
    let finished: Vec<String> = events
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            LogEvent::JobFinished { job, status, .. } => Some(format!("{job}={status}")),
            _ => None,
        })
        .collect();
    assert_eq!(finished.len(), 4, "{finished:?}");
    assert!(
        finished.iter().all(|f| f.ends_with("=cancelled")),
        "{finished:?}"
    );
    let json = serde_json::to_value(job("b")).unwrap();
    assert_eq!(json["status"], "cancelled");
    assert_eq!(json["reason"], CANCELLED_REASON);
}

#[test]
fn a_run_cancelled_before_it_starts_runs_nothing() {
    let plan = iwci_spec::parse(
        "name: x\njobs:\n  a: { using: builtin:ok@1, args: [] }\n  b: { using: builtin:ok@1, args: [], needs: [a] }\n",
        &Context::default(),
    )
    .unwrap();
    let exec = FakeExecutor {
        seen_env: Mutex::default(),
        seen_tools: Mutex::default(),
        order: Mutex::default(),
        running: AtomicUsize::new(0),
        most_at_once: AtomicUsize::new(0),
    };
    let cancel = iwci_runtime::Cancel::new();
    cancel.cancel();
    let options = Options {
        parallelism: 2,
        changed_paths: None,
        base_env: vec![],
        memory: None,
        caches: None,
        logs: None,
        slots: None,
        secrets: BTreeMap::new(),
        skip_task_cache: false,
        downloads: None,
        cancel: Some(cancel),
    };
    let ws = FakeWorkspaces {
        builds: AtomicUsize::new(0),
        installs: AtomicUsize::new(0),
        fail: false,
        source: "a",
    };
    let report = run(
        &plan,
        &ws,
        &FakeTools,
        &exec,
        &FakeCommitter(Mutex::default()),
        &options,
    );
    assert!(exec.order.lock().unwrap().is_empty());
    assert_eq!(ws.builds.load(Ordering::SeqCst), 0);
    assert!(
        report
            .jobs
            .iter()
            .all(|j| matches!(j.status, Status::Cancelled { .. }))
    );
}
