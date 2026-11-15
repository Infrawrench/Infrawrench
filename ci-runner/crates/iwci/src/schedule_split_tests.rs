//! A run on two runners: two schedulers against one store.

use super::*;
use std::sync::atomic::AtomicU64;

/// Looks often and gives up soon, so a test takes milliseconds.
const FAST: Timing = Timing {
    poll: Duration::from_millis(10),
    ask_after: Duration::from_millis(20),
    lease: Duration::from_millis(200),
};

/// The same, for a test in which a runner that never says it is alive
/// must not be given up on.
const PATIENT: Timing = Timing {
    lease: Duration::from_secs(30),
    ..FAST
};

/// What the runners of one pipeline share, in memory.
#[derive(Default)]
struct SplitStore {
    claims: Mutex<HashMap<String, String>>,
    done: Mutex<BTreeMap<String, Vec<u8>>>,
    kept: Mutex<HashMap<String, Vec<Entry>>>,
    back: Mutex<Vec<(String, u64)>>,
    asked: AtomicBool,
    ended: AtomicBool,
    primary: AtomicU64,
    helpers: Mutex<HashMap<String, u64>>,
    /// Every claim tried: who, and for which job.
    tried: Mutex<Vec<(String, String)>>,
}

impl SplitStore {
    /// `job` is `runner`'s before anyone starts.
    fn give(&self, job: &str, runner: &str) {
        self.claims
            .lock()
            .unwrap()
            .insert(job.into(), runner.into());
    }

    fn tried_by(&self, runner: &str) -> Vec<String> {
        self.tried
            .lock()
            .unwrap()
            .iter()
            .filter(|(by, _)| by == runner)
            .map(|(_, job)| job.clone())
            .collect()
    }

    fn done_of(&self, job: &str) -> Option<Done> {
        let done = self.done.lock().unwrap();
        done.get(job).map(|b| serde_json::from_slice(b).unwrap())
    }
}

struct MemorySplit {
    store: Arc<SplitStore>,
    runner: &'static str,
    helper: bool,
    timing: Timing,
}

fn primary(store: &Arc<SplitStore>, timing: Timing) -> Arc<dyn Split> {
    Arc::new(MemorySplit {
        store: store.clone(),
        runner: "ci-1",
        helper: false,
        timing,
    })
}

fn helper(store: &Arc<SplitStore>, timing: Timing) -> Arc<dyn Split> {
    Arc::new(MemorySplit {
        store: store.clone(),
        runner: "ci-2",
        helper: true,
        timing,
    })
}

impl Split for MemorySplit {
    fn runner(&self) -> &str {
        self.runner
    }
    fn helper(&self) -> bool {
        self.helper
    }
    fn claim(&self, job: &str) -> Result<Claim, String> {
        self.store
            .tried
            .lock()
            .unwrap()
            .push((self.runner.into(), job.into()));
        let mut claims = self.store.claims.lock().unwrap();
        match claims.get(job) {
            Some(holder) if holder != self.runner => Ok(Claim::Held(holder.clone())),
            _ => {
                claims.insert(job.into(), self.runner.into());
                Ok(Claim::Ours)
            }
        }
    }
    fn release(&self, job: &str) -> Result<(), String> {
        self.store.claims.lock().unwrap().remove(job);
        Ok(())
    }
    fn hand_back(&self, job: &str) -> Result<(), String> {
        self.release(job)?;
        let mut back = self.store.back.lock().unwrap();
        let n = back.len() as u64;
        back.push((job.into(), n));
        Ok(())
    }
    fn finish(&self, job: &str, done: &[u8]) -> Result<(), String> {
        self.store
            .done
            .lock()
            .unwrap()
            .entry(job.into())
            .or_insert_with(|| done.to_vec());
        Ok(())
    }
    fn done(&self, job: &str) -> Result<Option<Vec<u8>>, String> {
        Ok(self.store.done.lock().unwrap().get(job).cloned())
    }
    fn keep(&self, job: &str, entries: &[Entry]) -> Result<(), String> {
        self.store
            .kept
            .lock()
            .unwrap()
            .insert(job.into(), entries.to_vec());
        Ok(())
    }
    fn kept(&self, job: &str, _max_bytes: u64) -> Result<Option<Vec<Entry>>, String> {
        Ok(self.store.kept.lock().unwrap().get(job).cloned())
    }
    fn ask(&self) {
        self.store.asked.store(true, Ordering::SeqCst);
    }
    fn end(&self) {
        self.store.ended.store(true, Ordering::SeqCst);
    }
    fn seen(&self) -> Result<Seen, String> {
        // A runner that looks is alive.
        if self.helper {
            *self
                .store
                .helpers
                .lock()
                .unwrap()
                .entry(self.runner.into())
                .or_default() += 1;
        } else {
            self.store.primary.fetch_add(1, Ordering::SeqCst);
        }
        Ok(Seen {
            done: self.store.done.lock().unwrap().keys().cloned().collect(),
            back: self.store.back.lock().unwrap().clone(),
            ended: self.store.ended.load(Ordering::SeqCst),
            primary: Some(self.store.primary.load(Ordering::SeqCst)),
            helpers: self.store.helpers.lock().unwrap().clone(),
        })
    }
    fn timing(&self) -> Timing {
        self.timing
    }
}

/// [`FakeExecutor`], whose jobs can each take a moment first, with a
/// tool of its own: `wait` runs until it is stopped.
struct SplitExec {
    inner: FakeExecutor,
    /// How long every job takes before it does anything.
    nap: Duration,
    /// `wait` jobs that have started.
    waiting: Arc<AtomicUsize>,
    /// `cancel-run` holds off until this many `wait` jobs of the other
    /// runner have started.
    until: Option<(Arc<AtomicUsize>, usize)>,
}

impl SplitExec {
    fn new() -> Self {
        Self::napping(Duration::ZERO)
    }

    fn napping(nap: Duration) -> Self {
        Self {
            nap,
            waiting: Arc::default(),
            until: None,
            inner: FakeExecutor {
                seen_env: Mutex::default(),
                seen_tools: Mutex::default(),
                order: Mutex::default(),
                running: AtomicUsize::new(0),
                most_at_once: AtomicUsize::new(0),
            },
        }
    }

    fn ran(&self) -> Vec<String> {
        self.inner.order.lock().unwrap().clone()
    }
}

impl Executor<String> for SplitExec {
    fn execute(
        &self,
        tool: &String,
        path_tools: &[Arc<String>],
        services: &[ServiceRun<'_, String>],
        action: &Action,
        inv: Invocation<'_>,
    ) -> Result<Execution, String> {
        std::thread::sleep(self.nap);
        if tool.contains(":cancel-run@")
            && let Some((waiting, count)) = &self.until
        {
            let until = Instant::now() + Duration::from_secs(5);
            while waiting.load(Ordering::SeqCst) < *count && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
        if tool.contains(":wait@") {
            self.inner.order.lock().unwrap().push(inv.job.id.clone());
            self.waiting.fetch_add(1, Ordering::SeqCst);
            let cancel = inv.cancel.clone().expect("a job that can be stopped");
            let until = Instant::now() + Duration::from_secs(10);
            while !cancel.is_cancelled() && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(2));
            }
            return Ok(Execution {
                exit_code: iwci_runtime::TIMEOUT_EXIT_CODE,
                cancelled: cancel.is_cancelled(),
                ..Default::default()
            });
        }
        self.inner.execute(tool, path_tools, services, action, inv)
    }
}

fn options(split: Option<Arc<dyn Split>>, parallelism: usize) -> Options {
    Options {
        parallelism,
        changed_paths: None,
        base_env: vec![],
        memory: None,
        caches: None,
        logs: None,
        slots: None,
        secrets: BTreeMap::new(),
        skip_task_cache: false,
        durations: None,
        split,
        helping: None,
        downloads: None,
        cancel: Some(iwci_runtime::Cancel::new()),
        access: Default::default(),
    }
}

fn go(plan: &Plan, exec: &SplitExec, options: &Options) -> RunReport {
    let ws = FakeWorkspaces {
        builds: AtomicUsize::new(0),
        installs: AtomicUsize::new(0),
        fail: false,
        source: "a",
    };
    run(
        plan,
        &ws,
        &FakeTools,
        exec,
        &FakeCommitter(Mutex::default()),
        options,
    )
}

/// One side of a run on two runners: its report and the jobs it ran.
struct Side {
    report: RunReport,
    ran: Vec<String>,
}

impl Side {
    fn job(&self, id: &str) -> &JobReport {
        self.report.jobs.iter().find(|j| j.id == id).unwrap()
    }

    fn stdout(&self, id: &str) -> &str {
        &self.job(id).execution.as_ref().unwrap().stdout
    }
}

/// Runs `plan` on a primary and a helper at once, each job taking 20 ms.
fn both(plan: &Plan, first: &Options, second: &Options) -> (Side, Side) {
    let nap = Duration::from_millis(20);
    let (mut a, b) = (SplitExec::napping(nap), SplitExec::napping(nap));
    // A `cancel-run` on the primary waits for the helper's three `wait`
    // jobs, so the cancel finds them running.
    a.until = Some((b.waiting.clone(), 3));
    let (first, second) = std::thread::scope(|scope| {
        let first = scope.spawn(|| go(plan, &a, first));
        let second = scope.spawn(|| go(plan, &b, second));
        (first.join().unwrap(), second.join().unwrap())
    });
    (
        Side {
            report: first,
            ran: a.ran(),
        },
        Side {
            report: second,
            ran: b.ran(),
        },
    )
}

#[test]
fn each_job_runs_once_and_what_it_kept_reaches_the_other_runner() {
    // `lib` keeps its artifacts in the task cache, `raw` has none, so its
    // few bytes go through the split; `check` needs both. Every job takes
    // 20 ms, the primary runs one at a time and the helper four.
    let p = plan(
        "name: x\nsplit: true\njobs:\n  lib:\n    using: builtin:art-write@1\n    matrix: [a, b, c, d, e, f, g, h]\n    artifacts: [dist]\n    task-cache: true\n  raw:\n    using: builtin:art-write@1\n    artifacts: [dist]\n  check:\n    using: builtin:art-read@1\n    matrix: [a, b, c, d, e, f]\n    needs: [lib, raw]\n",
    );
    let store = Arc::new(SplitStore::default());
    let caches: Arc<MemoryCaches> = Arc::new(MemoryCaches::default());
    let mut first = options(Some(primary(&store, PATIENT)), 1);
    first.caches = Some(caches.clone());
    let mut second = options(Some(helper(&store, PATIENT)), 4);
    second.caches = Some(caches.clone());
    let (one, two) = both(&p, &first, &second);

    assert!(one.report.passed(), "{:#?}", one.report.jobs);
    assert!(two.report.passed(), "{:#?}", two.report.jobs);
    assert_eq!(one.report.jobs.len(), 15);
    let mut ran: Vec<String> = one.ran.iter().chain(&two.ran).cloned().collect();
    ran.sort();
    let mut all: Vec<String> = one.report.jobs.iter().map(|j| j.id.clone()).collect();
    all.sort();
    assert_eq!(ran, all, "every job ran, and none twice");
    assert!(!one.ran.is_empty() && !two.ran.is_empty(), "both took part");

    // Whichever runner ran a `check`, it started with all nine files.
    let files = "lib_a_.txt,lib_b_.txt,lib_c_.txt,lib_d_.txt,lib_e_.txt,lib_f_.txt,lib_g_.txt,lib_h_.txt,raw.txt";
    for id in [
        "check[a]", "check[b]", "check[c]", "check[d]", "check[e]", "check[f]",
    ] {
        assert_eq!(one.stdout(id), files, "{id}");
        assert_eq!(two.stdout(id), files, "{id}");
    }
    // The report of a job the other runner ran says so, and reserves
    // nothing here.
    for (here, there, name) in [(&one, &two, "ci-2"), (&two, &one, "ci-1")] {
        for id in &there.ran {
            let job = here.job(id);
            assert_eq!(job.remote.as_deref(), Some(name), "{id}");
            assert_eq!(job.memory_mib, 0, "{id}");
            assert!(job.notes.contains(&format!("split: ran on `{name}`")));
        }
        for id in &here.ran {
            assert_eq!(here.job(id).remote, None, "{id}");
        }
    }
    // `raw` crossed through the split, `lib` through the task cache.
    assert_eq!(store.done_of("raw").unwrap().kept, Kept::Split);
    assert!(matches!(
        store.done_of("lib[a]").unwrap().kept,
        Kept::TaskCache { .. }
    ));
    assert_eq!(store.kept.lock().unwrap().len(), 1);
}

#[test]
fn a_job_that_failed_on_the_helper_blocks_what_needs_it_on_both() {
    let p = plan(
        "name: x\nsplit: true\njobs:\n  bad:\n    using: builtin:fail@1\n  after:\n    using: builtin:ok@1\n    needs: [bad]\n  free:\n    using: builtin:ok@1\n",
    );
    let store = Arc::new(SplitStore::default());
    store.give("bad", "ci-2");
    let (one, two) = both(
        &p,
        &options(Some(primary(&store, PATIENT)), 2),
        &options(Some(helper(&store, PATIENT)), 2),
    );
    for side in [&one, &two] {
        assert!(
            matches!(&side.job("bad").status, Status::Failed { reason } if reason == "exited with 1")
        );
        assert!(
            matches!(&side.job("after").status, Status::Skipped { reason } if reason.contains("`bad` did not pass"))
        );
        assert_eq!(side.job("free").status, Status::Passed);
        assert!(!side.report.passed());
    }
    assert_eq!(one.job("bad").remote.as_deref(), Some("ci-2"));
    assert!(!one.ran.contains(&"bad".to_string()));
    assert!(two.ran.contains(&"bad".to_string()));
    assert!(!one.ran.contains(&"after".to_string()) && !two.ran.contains(&"after".to_string()));
}

#[test]
fn the_primary_takes_over_the_job_of_a_helper_that_stopped_answering() {
    let p = plan(
        "name: x\nsplit: true\njobs:\n  a:\n    using: builtin:art-write@1\n    artifacts: [dist]\n  b:\n    using: builtin:art-read@1\n    needs: [a]\n",
    );
    let store = Arc::new(SplitStore::default());
    // A helper claimed `a` and was never heard of again.
    store.give("a", "ghost");
    let exec = SplitExec::new();
    let report = go(&p, &exec, &options(Some(primary(&store, FAST)), 2));
    assert!(report.passed(), "{:#?}", report.jobs);
    assert_eq!(exec.ran(), vec!["a".to_string(), "b".to_string()]);
    let a = report.jobs.iter().find(|j| j.id == "a").unwrap();
    assert_eq!(a.remote, None);
    assert!(
        a.caches
            .iter()
            .any(|l| l == "split: `ghost` stopped answering; running it here"),
        "{:?}",
        a.caches
    );
    let b = report.jobs.iter().find(|j| j.id == "b").unwrap();
    assert_eq!(b.execution.as_ref().unwrap().stdout, "a.txt");
}

#[test]
fn the_primary_runs_again_a_job_whose_artifacts_it_cannot_get() {
    let p = plan(
        "name: x\nsplit: true\njobs:\n  a:\n    using: builtin:art-write@1\n    artifacts: [dist]\n    task-cache: true\n  b:\n    using: builtin:art-read@1\n    needs: [a]\n",
    );
    let store = Arc::new(SplitStore::default());
    // A helper ran `a` and says its artifacts are in a task cache entry
    // that is no longer there.
    store.give("a", "ci-2");
    let done = Done {
        runner: "ci-2".into(),
        result: Status::Passed,
        blocks: false,
        execution: Some(Execution::default()),
        changes: Vec::new(),
        commit: None,
        outputs: BTreeMap::new(),
        caches: Vec::new(),
        downloads: Vec::new(),
        notes: Vec::new(),
        duration_ms: 5,
        peak_memory_mib: 0,
        queued_ms: 0,
        kept: Kept::TaskCache {
            key: "task/a/0123456789abcdef".into(),
        },
    };
    store
        .done
        .lock()
        .unwrap()
        .insert("a".into(), serde_json::to_vec(&done).unwrap());
    let exec = SplitExec::new();
    let mut opts = options(Some(primary(&store, PATIENT)), 2);
    opts.caches = Some(Arc::new(MemoryCaches::default()));
    let report = go(&p, &exec, &opts);
    assert!(report.passed(), "{:#?}", report.jobs);
    assert_eq!(exec.ran(), vec!["a".to_string(), "b".to_string()]);
    let a = report.jobs.iter().find(|j| j.id == "a").unwrap();
    assert!(
        a.caches
            .iter()
            .any(|l| l.contains("it saved is gone; running it here")),
        "{:?}",
        a.caches
    );
}

#[test]
fn the_primary_runs_a_job_whose_record_it_cannot_read() {
    let p = plan("name: x\nsplit: true\njobs:\n  a:\n    using: builtin:ok@1\n");
    let store = Arc::new(SplitStore::default());
    store.give("a", "ci-2");
    store
        .done
        .lock()
        .unwrap()
        .insert("a".into(), b"{ not a record".to_vec());
    let exec = SplitExec::new();
    let report = go(&p, &exec, &options(Some(primary(&store, PATIENT)), 2));
    assert!(report.passed(), "{:#?}", report.jobs);
    assert_eq!(exec.ran(), vec!["a".to_string()]);
    assert!(
        report.jobs[0]
            .caches
            .iter()
            .any(|l| l == "split: its record could not be read; running it here"),
        "{:?}",
        report.jobs[0].caches
    );
}

#[test]
fn cancelling_the_primary_stops_the_helper() {
    let p = plan(
        "name: x\nsplit: true\njobs:\n  stop:\n    using: builtin:cancel-run@1\n  w:\n    using: builtin:wait@1\n    matrix: [a, b, c]\n",
    );
    let store = Arc::new(SplitStore::default());
    // The primary runs `stop`, which cancels its run; the helper is in
    // the middle of the rest by then.
    store.give("stop", "ci-1");
    for id in ["w[a]", "w[b]", "w[c]"] {
        store.give(id, "ci-2");
    }
    let started = Instant::now();
    let (one, two) = both(
        &p,
        &options(Some(primary(&store, PATIENT)), 1),
        &options(Some(helper(&store, PATIENT)), 4),
    );
    assert!(
        started.elapsed() < Duration::from_secs(8),
        "the helper's jobs were stopped, not left to run out"
    );
    assert!(store.ended.load(Ordering::SeqCst));
    for side in [&one, &two] {
        for job in &side.report.jobs {
            assert!(
                matches!(job.status, Status::Cancelled { .. }),
                "{}: {:?}",
                job.id,
                job.status
            );
        }
    }
    assert_eq!(two.ran.len(), 3);
    // A stopped job is handed back, never reported as the job's result.
    let done = store.done.lock().unwrap();
    assert!(
        !done.keys().any(|id| id.starts_with("w[")),
        "{:?}",
        done.keys()
    );
}

#[test]
fn a_helper_whose_primary_is_gone_ends() {
    // Only the primary may run `s`, and there is none.
    let p = plan(
        "name: x\nsplit: true\njobs:\n  s:\n    using: builtin:print@1\n    env:\n      TOKEN: ${{ secrets.TOKEN }}\n",
    );
    let store = Arc::new(SplitStore::default());
    let exec = SplitExec::new();
    let report = go(&p, &exec, &options(Some(helper(&store, FAST)), 2));
    assert!(exec.ran().is_empty());
    assert!(matches!(report.jobs[0].status, Status::Cancelled { .. }));
    assert!(store.tried.lock().unwrap().is_empty());
}

/// One runner's limits, shared by its own run and the run it helps.
struct Host {
    slots: Arc<Slots>,
    memory: Arc<MemoryBudget>,
    helping: Arc<Helping>,
}

impl Host {
    fn new(slots: usize, memory: u64) -> Self {
        Self {
            slots: Arc::new(Slots::new(slots)),
            memory: Arc::new(MemoryBudget::new(memory)),
            helping: Arc::new(Helping::default()),
        }
    }

    fn options(&self, split: Option<Arc<dyn Split>>) -> Options {
        let mut options = options(split, 4);
        options.slots = Some(self.slots.clone());
        options.memory = Some(self.memory.clone());
        options.helping = Some(self.helping.clone());
        options
    }
}

fn wait_for(what: &str, ready: impl Fn() -> bool) {
    let until = Instant::now() + Duration::from_secs(5);
    while !ready() {
        assert!(Instant::now() < until, "waited 5 s for {what}");
        std::thread::sleep(Duration::from_millis(2));
    }
}

/// A helper is in the middle of a long job that holds what `host` has
/// least of; then one of the runner's own runs arrives with `own`. Returns
/// how long the own run took.
fn own_run_against_a_helper_job(host: &Host, own: &Plan) -> Duration {
    let helped = plan(
        "name: helped\nsplit: true\njobs:\n  long:\n    using: builtin:wait@1\n    memory: 2GiB\n",
    );
    let store = Arc::new(SplitStore::default());
    let helping = host.options(Some(helper(&store, PATIENT)));
    let (helper_exec, own_exec) = (SplitExec::new(), SplitExec::new());
    let took = std::thread::scope(|scope| {
        let helper_run = scope.spawn(|| go(&helped, &helper_exec, &helping));
        wait_for("the helper's job to start", || {
            helper_exec.waiting.load(Ordering::SeqCst) == 1
        });
        assert_eq!(host.helping.running(), 1);
        assert_eq!(host.helping.bytes(), 2 << 30);

        let started = Instant::now();
        let report = go(own, &own_exec, &host.options(None));
        let took = started.elapsed();
        assert!(report.passed(), "{:#?}", report.jobs);

        // The helper gave its job back rather than report it, and waits
        // for the primary's word on it.
        wait_for("the job to be handed back", || {
            store.back.lock().unwrap().len() == 1
        });
        assert_eq!(store.back.lock().unwrap()[0].0, "long");
        assert!(store.done.lock().unwrap().is_empty());
        assert!(store.claims.lock().unwrap().is_empty());
        assert_eq!(host.helping.running(), 0);
        // The run it helped ends: so does the helper.
        store.ended.store(true, Ordering::SeqCst);
        let report = helper_run.join().unwrap();
        assert!(matches!(report.jobs[0].status, Status::Cancelled { .. }));
        took
    });
    assert_eq!(host.memory.used(), 0);
    assert_eq!(host.slots.in_use(), 0);
    took
}

#[test]
fn a_helper_job_gives_its_slot_to_the_runners_own_run() {
    // One slot, and the helper's job has it.
    let host = Host::new(1, 8 << 30);
    let own = plan("name: own\njobs:\n  quick:\n    using: builtin:ok@1\n");
    let took = own_run_against_a_helper_job(&host, &own);
    assert!(
        took < Duration::from_secs(3),
        "the own run waited {took:?} for a helper's job"
    );
}

#[test]
fn a_helper_job_gives_its_memory_to_the_runners_own_run() {
    // Slots to spare, but the helper's job holds 2 of the 3 GiB the own
    // run's job needs 2 of.
    let host = Host::new(4, 3 << 30);
    let own = plan("name: own\njobs:\n  quick:\n    using: builtin:ok@1\n    memory: 2GiB\n");
    let took = own_run_against_a_helper_job(&host, &own);
    assert!(
        took < Duration::from_secs(3),
        "the own run waited {took:?} for a helper's job"
    );
}

#[test]
fn a_helper_starts_nothing_while_the_runners_own_run_waits_for_memory() {
    // The own run's first job holds 2 of 3 GiB and its second waits for
    // 2: a slot and 1 GiB are free, and a helper's 512 MiB job would fit.
    let host = Host::new(4, 3 << 30);
    let own = plan(
        "name: own\njobs:\n  holds:\n    using: builtin:wait@1\n    memory: 2GiB\n  queued:\n    using: builtin:ok@1\n    memory: 2GiB\n",
    );
    let helped = plan(
        "name: helped\nsplit: true\njobs:\n  small:\n    using: builtin:ok@1\n    memory: 512MiB\n",
    );
    let store = Arc::new(SplitStore::default());
    let own_options = host.options(None);
    let helping = host.options(Some(helper(&store, PATIENT)));
    let (own_exec, helper_exec) = (SplitExec::new(), SplitExec::new());
    std::thread::scope(|scope| {
        let own_run = scope.spawn(|| go(&own, &own_exec, &own_options));
        wait_for("the own run's first job", || {
            own_exec.waiting.load(Ordering::SeqCst) == 1 && host.memory.waiting() == 2 << 30
        });
        let helper_run = scope.spawn(|| go(&helped, &helper_exec, &helping));
        // Many times the helper's recheck: it has looked, and left it.
        std::thread::sleep(Duration::from_millis(600));
        assert!(helper_exec.ran().is_empty());
        assert!(store.tried.lock().unwrap().is_empty());
        assert_eq!(host.memory.used(), 2 << 30);
        // What a helper has queued is not this runner's backlog.
        assert_eq!(host.memory.waiting(), 2 << 30);

        // Once the own run is through, the helper takes its job.
        own_options.cancel.as_ref().unwrap().cancel();
        own_run.join().unwrap();
        let report = helper_run.join().unwrap();
        assert!(report.passed(), "{:#?}", report.jobs);
        assert_eq!(helper_exec.ran(), vec!["small".to_string()]);
    });
}

#[test]
fn helper_jobs_give_way_newest_first_and_only_as_far_as_needed() {
    let helping = Arc::new(Helping::default());
    let jobs: Vec<_> = [1u64 << 30, 2 << 30, 4 << 30]
        .iter()
        .map(|bytes| helping.start(*bytes, None))
        .collect();
    let stopped = |jobs: &[super::super::split::Helped]| -> Vec<bool> {
        jobs.iter().map(|j| j.cancel.is_cancelled()).collect()
    };
    assert_eq!(helping.running(), 3);
    assert_eq!(helping.bytes(), 7 << 30);
    assert!(!helping.wanted());

    // 3 GiB short: the newest job's 4 GiB cover it.
    helping.want_memory(3 << 30);
    assert_eq!(stopped(&jobs), [false, false, true]);
    // Asked again before that came back: it is already on its way.
    helping.want_memory(3 << 30);
    assert_eq!(stopped(&jobs), [false, false, true]);
    // 5 GiB short takes the next newest too.
    helping.want_memory(5 << 30);
    assert_eq!(stopped(&jobs), [false, true, true]);

    // Two workers waiting for a slot are covered by the two giving way; a
    // third takes the last job.
    let (a, b) = (helping.want_slot(), helping.want_slot());
    assert_eq!(stopped(&jobs), [false, true, true]);
    assert!(helping.wanted());
    let c = helping.want_slot();
    assert_eq!(stopped(&jobs), [true, true, true]);
    drop((a, b, c));
    assert!(!helping.wanted());

    // The run's own cancel stops a helper's job too.
    let run = iwci_runtime::Cancel::new();
    let job = helping.start(1 << 20, Some(&run));
    run.cancel();
    assert!(job.cancel.is_cancelled());
    drop(jobs);
    drop(job);
    assert_eq!(helping.running(), 0);
}

#[test]
fn artifacts_over_the_cap_stay_and_so_do_the_jobs_that_need_them() {
    // `big` keeps 20 MiB and `small` a few bytes, neither in the task
    // cache; the pipeline sends up to 1 MiB.
    let p = plan(
        "name: x\nsplit: { artifacts: 1MiB }\njobs:\n  big:\n    using: builtin:art-big@1\n    artifacts: [dist]\n  small:\n    using: builtin:art-write@1\n    artifacts: [dist]\n  after-big:\n    using: builtin:art-read@1\n    needs: [big]\n  after-small:\n    using: builtin:art-read@1\n    needs: [small]\n",
    );
    let store = Arc::new(SplitStore::default());
    store.give("big", "ci-1");
    store.give("small", "ci-1");
    store.give("after-small", "ci-2");
    let (one, two) = both(
        &p,
        &options(Some(primary(&store, PATIENT)), 1),
        &options(Some(helper(&store, PATIENT)), 4),
    );
    assert!(one.report.passed(), "{:#?}", one.report.jobs);
    assert!(two.report.passed(), "{:#?}", two.report.jobs);

    // Only `small`'s artifacts were sent, and the helper's job got them.
    assert_eq!(
        store.kept.lock().unwrap().keys().collect::<Vec<_>>(),
        vec!["small"]
    );
    assert_eq!(store.done_of("small").unwrap().kept, Kept::Split);
    assert_eq!(store.done_of("big").unwrap().kept, Kept::Local);
    assert_eq!(two.ran, vec!["after-small".to_string()]);
    assert_eq!(two.stdout("after-small"), "small.txt");
    assert_eq!(one.stdout("after-small"), "small.txt");

    // `after-big` needs what stayed on the primary: the helper never
    // tried for it, though it had nothing else to do.
    assert!(!store.tried_by("ci-2").contains(&"after-big".to_string()));
    assert_eq!(one.stdout("after-big"), "big.bin");
    assert!(
        one.job("big").notes.iter().any(|n| n
            == "split: its artifacts stay on `ci-1` (20480 KiB is over the pipeline's `split: artifacts` of 1024 KiB), so the jobs that need them run there"),
        "{:?}",
        one.job("big").notes
    );
    assert_eq!(two.job("after-big").remote.as_deref(), Some("ci-1"));
}

#[test]
fn a_helper_only_tries_for_jobs_that_may_run_anywhere() {
    let p = plan(
        "name: x\nsplit: true\njobs:\n  secret:\n    using: builtin:print@1\n    env:\n      TOKEN: ${{ secrets.TOKEN }}\n  commit:\n    using: builtin:write@1\n    changes: { commit: \"style: format\" }\n  keeps:\n    using: builtin:dl-write@1\n    downloads: [out]\n  plain:\n    using: builtin:print@1\n    matrix: [a, b, c, d]\n",
    );
    let store = Arc::new(SplitStore::default());
    let (one, two) = both(
        &p,
        &options(Some(primary(&store, PATIENT)), 1),
        &options(Some(helper(&store, PATIENT)), 4),
    );
    assert!(one.report.passed(), "{:#?}", one.report.jobs);
    assert!(two.report.passed(), "{:#?}", two.report.jobs);
    for id in ["secret", "commit", "keeps"] {
        assert!(one.ran.contains(&id.to_string()), "{id}");
        assert!(!store.tried_by("ci-2").contains(&id.to_string()), "{id}");
        assert_eq!(two.job(id).remote.as_deref(), Some("ci-1"), "{id}");
    }
    assert!(two.ran.iter().all(|id| id.starts_with("plain[")));
    assert!(!two.ran.is_empty());
}

#[test]
fn a_pipeline_without_split_never_claims() {
    let p = plan(
        "name: x\njobs:\n  a:\n    using: builtin:art-write@1\n    artifacts: [dist]\n  b:\n    using: builtin:art-read@1\n    needs: [a]\n",
    );
    let store = Arc::new(SplitStore::default());
    // The run is shared, but the pipeline does not ask to be: each
    // scheduler runs all of it by itself, as if the other were not there.
    let (one, two) = both(
        &p,
        &options(Some(primary(&store, FAST)), 2),
        &options(Some(helper(&store, FAST)), 2),
    );
    for side in [&one, &two] {
        assert!(side.report.passed());
        assert_eq!(side.ran, vec!["a".to_string(), "b".to_string()]);
        assert!(side.report.jobs.iter().all(|j| j.remote.is_none()));
    }
    assert!(store.tried.lock().unwrap().is_empty());
    assert!(store.done.lock().unwrap().is_empty());
    assert!(store.kept.lock().unwrap().is_empty());
    assert!(!store.asked.load(Ordering::SeqCst) && !store.ended.load(Ordering::SeqCst));
    assert_eq!(store.primary.load(Ordering::SeqCst), 0, "nobody looked");
}

#[test]
fn the_primary_asks_for_help_only_when_jobs_wait() {
    // One job at a time and four of them: the others wait.
    let busy = plan(
        "name: x\nsplit: true\njobs:\n  j:\n    using: builtin:ok@1\n    matrix: [a, b, c, d]\n",
    );
    let store = Arc::new(SplitStore::default());
    let report = go(
        &busy,
        &SplitExec::napping(Duration::from_millis(40)),
        &options(Some(primary(&store, FAST)), 1),
    );
    assert!(report.passed());
    assert!(store.asked.load(Ordering::SeqCst));
    assert!(
        store.ended.load(Ordering::SeqCst),
        "and says when it is done"
    );

    // Room for all of them at once: nothing waits, nobody is asked.
    let store = Arc::new(SplitStore::default());
    let report = go(
        &busy,
        &SplitExec::new(),
        &options(Some(primary(&store, FAST)), 8),
    );
    assert!(report.passed());
    assert!(!store.asked.load(Ordering::SeqCst));
}

const SECRET: &str = "hunter2-9f3b77c1";

#[test]
fn a_secret_is_in_nothing_the_runners_share() {
    // `reads` is given the secret and prints it; `says` prints the same
    // text from a plain `env:` value; `files` keeps a text file and a
    // binary one that both hold it; `clean` keeps a file that does not.
    let p = plan(&format!(
        "name: x\nsplit: true\njobs:\n  reads:\n    using: builtin:print@1\n    env:\n      TOKEN: ${{{{ secrets.TOKEN }}}}\n  says:\n    using: builtin:print@1\n    env:\n      COPY: {SECRET}\n  files:\n    using: builtin:dl-write@1\n    env:\n      TOKEN: {SECRET}\n    artifacts: [out]\n  clean:\n    using: builtin:art-write@1\n    artifacts: [dist]\n  after:\n    using: builtin:art-read@1\n    needs: [clean, files]\n    matrix: [a, b, c]\n",
    ));
    let dir = std::env::temp_dir().join(format!("iwci-split-secret-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let objects: Arc<dyn iwci_store::ObjectStore> =
        Arc::new(iwci_store::LocalStore::new(&dir).unwrap());
    let id = |text: &str| iwci_store::RepoId::new(text).unwrap();
    let side = |runner: &str, helper: bool, parallelism: usize| {
        let run = crate::adapters::split::SplitRun::with_timing(
            objects.clone(),
            &id("acme"),
            &id("app"),
            &id("run1"),
            runner,
            helper,
            PATIENT,
        );
        let mut options = options(Some(run.pipeline("test.yml")), parallelism);
        options.secrets = BTreeMap::from([("TOKEN".to_string(), SECRET.to_string())]);
        (run, options)
    };
    let (first_run, first) = side("ci-1", false, 1);
    let (second_run, second) = side("ci-2", true, 4);
    let (one, two) = both(&p, &first, &second);
    assert!(one.report.passed(), "{:#?}", one.report.jobs);
    assert!(two.report.passed(), "{:#?}", two.report.jobs);
    assert!(!two.ran.is_empty(), "the helper took part");
    // The jobs did see it, and their reports here do not show it.
    assert!(one.stdout("reads").contains("TOKEN=***"));
    assert!(one.stdout("says").contains("COPY=***"));

    // Every object under `splits/`, whatever it is.
    fn files(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                files(&path, out);
            } else {
                out.push(path);
            }
        }
    }
    let mut shared = Vec::new();
    files(&dir.join("splits"), &mut shared);
    let holds = |path: &std::path::Path| {
        let bytes = std::fs::read(path).unwrap();
        bytes.windows(SECRET.len()).any(|w| w == SECRET.as_bytes())
    };
    let leaked: Vec<_> = shared.iter().filter(|p| holds(p)).collect();
    assert!(leaked.is_empty(), "{leaked:?}");
    let count = |part: &str| {
        shared
            .iter()
            .filter(|p| p.to_string_lossy().contains(part))
            .count()
    };
    // Not for want of anything written: a record for each of the seven
    // jobs, a claim for each, and the one set of artifacts that may go.
    assert_eq!(count("/state/done/"), 7, "{shared:?}");
    assert_eq!(count("/claims/"), 7);
    assert_eq!(count("/artifacts/"), 1);

    // The files that hold it stayed where they were written, so a job
    // that needs them ran on a runner that had written them.
    assert!(
        one.job("files")
            .notes
            .iter()
            .any(|n| n.contains("a file among them holds a secret's value")),
        "{:?}",
        one.job("files").notes
    );
    for id in ["after[a]", "after[b]", "after[c]"] {
        let ran_with_files = |side: &Side| {
            side.ran.contains(&id.to_string()) && side.ran.contains(&"files".to_string())
        };
        assert!(ran_with_files(&one) || ran_with_files(&two), "{id}");
        assert_eq!(one.stdout(id), "clean.txt");
    }
    drop((first_run, second_run));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_record_of_a_job_reads_back_as_it_was_written() {
    let done = Done {
        runner: "ci-2".into(),
        result: Status::Failed {
            reason: "exited with 2".into(),
        },
        blocks: true,
        execution: Some(Execution {
            exit_code: 2,
            stdout: "out".into(),
            stderr: "err".into(),
            timed_out: true,
            stalled_after: Some(300),
            out_of_memory: true,
            peak_memory_bytes: 9,
            service_failure: Some("db".into()),
            cancelled: false,
        }),
        changes: vec![("src/a.ts".into(), "modified".into())],
        commit: None,
        outputs: BTreeMap::from([("k".to_string(), "v".to_string())]),
        caches: vec!["cache `k`: miss".into()],
        downloads: Vec::new(),
        notes: vec!["a note".into()],
        duration_ms: 1234,
        peak_memory_mib: 77,
        queued_ms: 5,
        kept: Kept::TaskCache {
            key: "task/a/abc".into(),
        },
    };
    let text = serde_json::to_string(&done).unwrap();
    let back: Done = serde_json::from_str(&text).unwrap();
    assert_eq!(back.result, done.result);
    assert_eq!(back.kept, done.kept);
    let (a, b) = (back.execution.unwrap(), done.execution.unwrap());
    assert_eq!(
        (
            a.exit_code,
            a.stdout,
            a.stderr,
            a.timed_out,
            a.stalled_after
        ),
        (
            b.exit_code,
            b.stdout,
            b.stderr,
            b.timed_out,
            b.stalled_after
        )
    );
    assert_eq!(a.service_failure, b.service_failure);
    assert!(a.out_of_memory && !a.cancelled);
    assert_eq!(back.outputs, done.outputs);
    assert_eq!((back.duration_ms, back.peak_memory_mib), (1234, 77));
}
