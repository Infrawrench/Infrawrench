//! Two runs computing the same task cache keys at once: two schedulers
//! against one store, the second waiting for what the first computes.

use super::*;
use crate::adapters::inflight::StoreInFlight;
use iwci_store::{ObjectStore, RepoId};

/// Looks often, so a test takes milliseconds. The lease is long enough
/// that a busy CI host, whose signs of life can stall for some hundreds
/// of milliseconds, does not lose a holder that is alive.
const FAST: InFlightTiming = InFlightTiming {
    poll: Duration::from_millis(10),
    lease: Duration::from_secs(2),
    margin: Duration::from_millis(50),
    recheck: Duration::from_millis(50),
};

pub(super) fn store(name: &str) -> (Arc<dyn ObjectStore>, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("iwci-inflight-run-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    (Arc::new(iwci_store::LocalStore::new(&dir).unwrap()), dir)
}

/// The markers of a run, counting how often another run's turned up. A
/// `blind` one does not see markers at lookups, only when a job starts.
pub(super) struct Counted {
    inner: StoreInFlight,
    waits: AtomicUsize,
    blind: bool,
}

impl Counted {
    pub(super) fn waits(&self) -> usize {
        self.waits.load(Ordering::SeqCst)
    }

    fn count(&self, holder: &Result<Option<Holder>, String>) {
        if matches!(holder, Ok(Some(_))) {
            self.waits.fetch_add(1, Ordering::SeqCst);
        }
    }
}

impl InFlight for Counted {
    fn begin(
        &self,
        key: &str,
        expected_ms: Option<u64>,
        replacing: Option<&str>,
    ) -> Result<Option<Holder>, String> {
        let holder = self.inner.begin(key, expected_ms, replacing);
        self.count(&holder);
        holder
    }
    fn end(&self, key: &str, ended: Ended) {
        self.inner.end(key, ended)
    }
    fn leave(&self, key: &str, done: bool) {
        self.inner.leave(key, done)
    }
    fn holder(&self, key: &str) -> Result<Option<Holder>, String> {
        if self.blind {
            return Ok(None);
        }
        let holder = self.inner.holder(key);
        self.count(&holder);
        holder
    }
    fn ended(&self, key: &str, holder: &Holder) -> Option<Ended> {
        self.inner.ended(key, holder)
    }
    fn look(&self) -> Result<Look, String> {
        self.inner.look()
    }
    fn timing(&self) -> InFlightTiming {
        self.inner.timing()
    }
}

/// The markers of run `run` on `runner`, in `scope` (`b-main` for a push
/// to the default branch, anything else a pull request, which also reads
/// the default branch's), saying it is alive every `every`.
pub(super) fn counted_on(
    store: &Arc<dyn ObjectStore>,
    run: &str,
    runner: &str,
    scope: &str,
    every: Duration,
    blind: bool,
) -> Arc<Counted> {
    let reads: Vec<String> = if scope == "b-main" {
        vec!["b-main".into()]
    } else {
        vec![scope.into(), "b-main".into()]
    };
    Arc::new(Counted {
        inner: StoreInFlight::with_timing(
            store.clone(),
            &RepoId::new("acme").unwrap(),
            &RepoId::new("app").unwrap(),
            (scope, &reads),
            &RepoId::new(run).unwrap(),
            runner,
            FAST,
            every,
        ),
        waits: AtomicUsize::new(0),
        blind,
    })
}

fn counted(store: &Arc<dyn ObjectStore>, run: &str, scope: &str) -> Arc<Counted> {
    counted_on(store, run, "ci-1", scope, Duration::from_millis(20), false)
}

/// Which jobs of a run have started, and which may go on.
#[derive(Default)]
struct Gates {
    open: Mutex<HashSet<String>>,
    started: Mutex<Vec<String>>,
}

impl Gates {
    fn open(&self, job: &str) {
        self.open.lock().unwrap().insert(job.into());
    }

    fn started(&self, job: &str) -> bool {
        self.started.lock().unwrap().iter().any(|j| j == job)
    }
}

/// [`FakeExecutor`], whose `held` jobs wait for their gate to open and
/// whose `failing` jobs exit 1.
struct GateExec {
    inner: FakeExecutor,
    gates: Arc<Gates>,
    held: Vec<&'static str>,
    failing: Vec<&'static str>,
}

impl GateExec {
    fn new(gates: &Arc<Gates>, held: &[&'static str], failing: &[&'static str]) -> Self {
        Self {
            inner: FakeExecutor {
                seen_env: Mutex::default(),
                seen_tools: Mutex::default(),
                order: Mutex::default(),
                running: AtomicUsize::new(0),
                most_at_once: AtomicUsize::new(0),
            },
            gates: gates.clone(),
            held: held.to_vec(),
            failing: failing.to_vec(),
        }
    }

    fn ran(&self) -> Vec<String> {
        ran(&self.inner)
    }
}

impl Executor<String> for GateExec {
    fn execute(
        &self,
        tool: &String,
        path_tools: &[Arc<String>],
        services: &[ServiceRun<'_, String>],
        action: &Action,
        inv: Invocation<'_>,
    ) -> Result<Execution, String> {
        let id = inv.job.id.clone();
        if self.held.contains(&id.as_str()) {
            self.gates.started.lock().unwrap().push(id.clone());
            let until = Instant::now() + Duration::from_secs(10);
            while !self.gates.open.lock().unwrap().contains(&id) && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
        let mut execution = self
            .inner
            .execute(tool, path_tools, services, action, inv)?;
        if self.failing.contains(&id.as_str()) {
            execution.exit_code = 1;
        }
        Ok(execution)
    }
}

/// What one run of a test is given.
fn options_for(
    caches: Arc<dyn Caches>,
    inflight: &Arc<Counted>,
    budget: Option<&Arc<MemoryBudget>>,
    slots: Option<&Arc<Slots>>,
    parallelism: usize,
) -> Options {
    Options {
        parallelism,
        changed_paths: None,
        base_env: Vec::new(),
        memory: budget.cloned(),
        caches: Some(caches),
        logs: None,
        slots: slots.cloned(),
        secrets: BTreeMap::new(),
        skip_task_cache: false,
        durations: None,
        split: None,
        helping: None,
        inflight: Some(inflight.clone()),
        downloads: None,
        cancel: None,
        access: Default::default(),
    }
}

fn go_with(plan: &Plan, exec: &GateExec, options: &Options) -> RunReport {
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

/// One run of `plan`, with its own slots and memory when given.
fn go(
    plan: &Plan,
    exec: &GateExec,
    caches: &Arc<MemoryCaches>,
    inflight: &Arc<Counted>,
    budget: Option<&Arc<MemoryBudget>>,
    slots: Option<&Arc<Slots>>,
    parallelism: usize,
) -> RunReport {
    let options = options_for(caches.clone(), inflight, budget, slots, parallelism);
    go_with(plan, exec, &options)
}

fn job<'a>(report: &'a RunReport, id: &str) -> &'a JobReport {
    report.jobs.iter().find(|j| j.id == id).unwrap()
}

/// What the store still has of the markers of `acme/app`.
fn markers_left(store: &Arc<dyn ObjectStore>) -> Vec<String> {
    store
        .list("inflight/acme/app/")
        .unwrap()
        .into_iter()
        .filter(|k| k.contains("/keys/"))
        .collect()
}

/// `lib` keeps its artifacts in the task cache; `check` reads them.
const LIB: &str = "name: x\njobs:\n  lib:\n    using: builtin:art-write@1\n    artifacts: [dist]\n    task-cache: true\n  check:\n    using: builtin:art-read@1\n    needs: [lib]\n";

#[test]
fn a_second_run_waits_for_the_first_and_replays_its_entry_holding_nothing() {
    let (store, dir) = store("replay");
    let p = plan(LIB);
    let caches = Arc::new(MemoryCaches::default());
    let (a_gates, b_gates) = (Arc::new(Gates::default()), Arc::new(Gates::default()));
    let (a_exec, b_exec) = (
        GateExec::new(&a_gates, &["lib"], &[]),
        GateExec::new(&b_gates, &[], &[]),
    );
    let (a_in, b_in) = (
        counted(&store, "run-a", "b-main"),
        counted(&store, "run-b", "b-main"),
    );
    // The second run's own slots and memory, which waiting must not touch.
    let budget = Arc::new(MemoryBudget::new(8 << 30));
    let slots = Arc::new(Slots::new(2));
    let (a, b) = std::thread::scope(|scope| {
        let a = scope.spawn(|| go(&p, &a_exec, &caches, &a_in, None, None, 2));
        eventually("the first run to start lib", || a_gates.started("lib"));
        let b = scope.spawn(|| go(&p, &b_exec, &caches, &b_in, Some(&budget), Some(&slots), 2));
        eventually("the second run to wait", || b_in.waits() >= 1);
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(budget.used(), 0, "a waiting job holds no memory");
        assert_eq!(budget.waiting(), 0, "nor is it queued for any");
        assert_eq!(slots.in_use(), 0, "nor does it hold a slot");
        assert!(b_exec.ran().is_empty());
        a_gates.open("lib");
        (a.join().unwrap(), b.join().unwrap())
    });
    assert!(a.passed() && b.passed(), "{:#?}", b.jobs);
    let (a_lib, b_lib) = (job(&a, "lib"), job(&b, "lib"));
    assert!(!a_lib.cached && a_lib.waited_for.is_none());
    assert!(b_lib.cached, "{b_lib:#?}");
    assert_eq!(b_lib.waited_for.as_deref(), Some("run-a"));
    assert!(
        b_lib.notes[0].contains("run `run-a` was running it"),
        "{:?}",
        b_lib.notes
    );
    assert!(
        b_lib.caches[0].contains("saved by run `run-a`"),
        "{:?}",
        b_lib.caches
    );
    // Its artifacts reached the job after it, which ran here.
    assert_eq!(b_exec.ran(), vec!["check"]);
    assert_eq!(stdout_of(&b, "check"), "lib.txt");
    assert_eq!(
        caches.saved.lock().unwrap().len(),
        1,
        "saved once, by the first"
    );
    // Billed nothing: it did not run here.
    assert_eq!(crate::runner::usage_of(&b, 4).jobs, 1);
    assert!(markers_left(&store).is_empty());
    drop((a_in, b_in));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_job_that_finds_the_marker_as_it_starts_gives_back_its_memory_and_waits() {
    let (store, dir) = store("begin");
    let p = plan(LIB);
    let caches = Arc::new(MemoryCaches::default());
    let (a_gates, b_gates) = (Arc::new(Gates::default()), Arc::new(Gates::default()));
    let (a_exec, b_exec) = (
        GateExec::new(&a_gates, &["lib"], &[]),
        GateExec::new(&b_gates, &[], &[]),
    );
    // The second run's lookups do not see the marker: its job finds it
    // only once it has its memory and is about to start.
    let a_in = counted(&store, "run-a", "b-main");
    let b_in = counted_on(
        &store,
        "run-b",
        "ci-2",
        "b-main",
        Duration::from_millis(20),
        true,
    );
    let budget = Arc::new(MemoryBudget::new(8 << 30));
    let (a, b) = std::thread::scope(|scope| {
        let a = scope.spawn(|| go(&p, &a_exec, &caches, &a_in, None, None, 2));
        eventually("the first run to start lib", || a_gates.started("lib"));
        let b = scope.spawn(|| go(&p, &b_exec, &caches, &b_in, Some(&budget), None, 2));
        eventually("the second run to wait", || b_in.waits() >= 1);
        eventually("its memory to be given back", || budget.used() == 0);
        assert_eq!(budget.waiting(), 0);
        a_gates.open("lib");
        (a.join().unwrap(), b.join().unwrap())
    });
    assert!(a.passed() && b.passed());
    assert_eq!(job(&b, "lib").waited_for.as_deref(), Some("run-a"));
    assert_eq!(b_exec.ran(), vec!["check"]);
    drop((a_in, b_in));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_failure_in_the_first_run_means_the_second_runs_it() {
    let (store, dir) = store("failed");
    let p = plan(LIB);
    let caches = Arc::new(MemoryCaches::default());
    let (a_gates, b_gates) = (Arc::new(Gates::default()), Arc::new(Gates::default()));
    let (a_exec, b_exec) = (
        GateExec::new(&a_gates, &["lib"], &["lib"]),
        GateExec::new(&b_gates, &[], &[]),
    );
    let (a_in, b_in) = (
        counted(&store, "run-a", "b-main"),
        counted(&store, "run-b", "b-main"),
    );
    let (a, b) = std::thread::scope(|scope| {
        let a = scope.spawn(|| go(&p, &a_exec, &caches, &a_in, None, None, 2));
        eventually("the first run to start lib", || a_gates.started("lib"));
        let b = scope.spawn(|| go(&p, &b_exec, &caches, &b_in, None, None, 2));
        eventually("the second run to wait", || b_in.waits() >= 1);
        a_gates.open("lib");
        (a.join().unwrap(), b.join().unwrap())
    });
    assert!(!a.passed());
    assert!(b.passed(), "{:#?}", b.jobs);
    let lib = job(&b, "lib");
    assert!(!lib.cached && lib.waited_for.is_none());
    assert!(
        lib.caches.iter().any(|l| l.contains("which did not pass")),
        "{:?}",
        lib.caches
    );
    assert_eq!(b_exec.ran(), vec!["lib", "check"]);
    assert_eq!(caches.saved.lock().unwrap().len(), 1, "saved by the second");
    drop((a_in, b_in));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_run_that_stops_saying_it_is_alive_is_not_waited_for() {
    let (store, dir) = store("dead");
    let p = plan(LIB);
    let caches = Arc::new(MemoryCaches::default());
    let (a_gates, b_gates) = (Arc::new(Gates::default()), Arc::new(Gates::default()));
    let (a_exec, b_exec) = (
        GateExec::new(&a_gates, &["lib"], &[]),
        GateExec::new(&b_gates, &[], &[]),
    );
    // The first run's sign of life never moves: as one that died holding
    // the marker looks to everyone else.
    let a_in = counted_on(
        &store,
        "run-a",
        "ci-1",
        "b-main",
        Duration::from_secs(3600),
        false,
    );
    let b_in = counted(&store, "run-b", "b-main");
    let (b, waited) = std::thread::scope(|scope| {
        let a = scope.spawn(|| go(&p, &a_exec, &caches, &a_in, None, None, 2));
        eventually("the first run to start lib", || a_gates.started("lib"));
        let started = Instant::now();
        let b = go(&p, &b_exec, &caches, &b_in, None, None, 2);
        let waited = started.elapsed();
        a_gates.open("lib");
        a.join().unwrap();
        (b, waited)
    });
    assert!(b.passed(), "{:#?}", b.jobs);
    let lib = job(&b, "lib");
    assert!(!lib.cached);
    assert!(
        lib.caches
            .iter()
            .any(|l| l.contains("had not said it was alive")),
        "{:?}",
        lib.caches
    );
    assert_eq!(b_exec.ran(), vec!["lib", "check"]);
    // About one lease, not the job's ten-minute timeout.
    assert!(
        waited >= FAST.lease && waited < Duration::from_secs(8),
        "{waited:?}"
    );
    drop((a_in, b_in));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_run_with_no_sign_of_life_at_all_is_given_up_after_a_lease() {
    let (store, dir) = store("gone");
    let p = plan(LIB);
    let caches = Arc::new(MemoryCaches::default());
    let (a_gates, b_gates) = (Arc::new(Gates::default()), Arc::new(Gates::default()));
    let (a_exec, b_exec) = (
        GateExec::new(&a_gates, &["lib"], &[]),
        GateExec::new(&b_gates, &[], &[]),
    );
    let a_in = counted_on(
        &store,
        "run-a",
        "ci-1",
        "b-main",
        Duration::from_secs(3600),
        false,
    );
    let b_in = counted(&store, "run-b", "b-main");
    let (b, waited) = std::thread::scope(|scope| {
        let a = scope.spawn(|| go(&p, &a_exec, &caches, &a_in, None, None, 2));
        eventually("the first run to start lib", || a_gates.started("lib"));
        // What a runner that died a day ago leaves once the sweep took its
        // sign of life: a marker and nothing else.
        for key in store.list("inflight/acme/app/b-main/runs/").unwrap() {
            store.delete(&key).unwrap();
        }
        let started = Instant::now();
        let b = go(&p, &b_exec, &caches, &b_in, None, None, 2);
        let waited = started.elapsed();
        a_gates.open("lib");
        a.join().unwrap();
        (b, waited)
    });
    assert!(b.passed());
    let lib = job(&b, "lib");
    assert!(
        lib.caches
            .iter()
            .any(|l| l.contains("had not said it was alive")),
        "{:?}",
        lib.caches
    );
    assert_eq!(b_exec.ran(), vec!["lib", "check"]);
    // A listing that shows no sign of life proves nothing on its own (one
    // can miss a sign of life renamed while it is read): a whole lease.
    assert!(waited >= FAST.lease, "{waited:?}");
    drop((a_in, b_in));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_run_that_is_alive_but_slow_is_waited_for_until_the_jobs_timeout() {
    let (store, dir) = store("slow");
    // No history: the limit is the job's timeout plus two leases.
    let p = plan(
        "name: x\njobs:\n  lib:\n    using: builtin:art-write@1\n    artifacts: [dist]\n    timeout: 1s\n    task-cache: true\n",
    );
    let caches = Arc::new(MemoryCaches::default());
    let (a_gates, b_gates) = (Arc::new(Gates::default()), Arc::new(Gates::default()));
    let (a_exec, b_exec) = (
        GateExec::new(&a_gates, &["lib"], &[]),
        GateExec::new(&b_gates, &[], &[]),
    );
    let (a_in, b_in) = (
        counted(&store, "run-a", "b-main"),
        counted(&store, "run-b", "b-main"),
    );
    let (b, waited) = std::thread::scope(|scope| {
        let a = scope.spawn(|| go(&p, &a_exec, &caches, &a_in, None, None, 2));
        eventually("the first run to start lib", || a_gates.started("lib"));
        let started = Instant::now();
        let b = go(&p, &b_exec, &caches, &b_in, None, None, 2);
        let waited = started.elapsed();
        a_gates.open("lib");
        a.join().unwrap();
        (b, waited)
    });
    assert!(b.passed());
    let lib = job(&b, "lib");
    assert!(
        lib.caches
            .iter()
            .any(|l| l.contains("had not finished it after 5.0s")),
        "{:?}",
        lib.caches
    );
    assert_eq!(b_exec.ran(), vec!["lib"]);
    let limit = Duration::from_secs(1) + FAST.lease * 2;
    assert!(waited >= limit && waited < limit * 3, "{waited:?}");
    drop((a_in, b_in));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn the_default_branch_never_waits_for_a_pull_request_and_a_pull_request_may_wait_for_it() {
    let (store, dir) = store("trust");
    let p = plan(LIB);
    let caches = Arc::new(MemoryCaches::default());
    // A pull request (a fork's, say) computing `lib`.
    let (pr_gates, main_gates) = (Arc::new(Gates::default()), Arc::new(Gates::default()));
    let (pr_exec, main_exec) = (
        GateExec::new(&pr_gates, &["lib"], &[]),
        GateExec::new(&main_gates, &[], &[]),
    );
    let (pr_in, main_in) = (
        counted(&store, "run-pr", "pr-1"),
        counted(&store, "run-main", "b-main"),
    );
    std::thread::scope(|scope| {
        let pr = scope.spawn(|| go(&p, &pr_exec, &caches, &pr_in, None, None, 2));
        eventually("the pull request to start lib", || pr_gates.started("lib"));
        // The push runs it itself, while the pull request still has it.
        let main = go(&p, &main_exec, &caches, &main_in, None, None, 2);
        assert!(main.passed());
        assert!(!job(&main, "lib").cached);
        assert_eq!(main_exec.ran(), vec!["lib", "check"]);
        assert_eq!(main_in.waits(), 0);
        pr_gates.open("lib");
        pr.join().unwrap();
    });

    // The other way round: a pull request reads the default branch's
    // entries, so it waits for a push computing one.
    let caches = Arc::new(MemoryCaches::default());
    let (main_gates, pr_gates) = (Arc::new(Gates::default()), Arc::new(Gates::default()));
    let (main_exec, pr_exec) = (
        GateExec::new(&main_gates, &["lib"], &[]),
        GateExec::new(&pr_gates, &[], &[]),
    );
    let (main_in, pr_in) = (
        counted(&store, "run-main2", "b-main"),
        counted(&store, "run-pr2", "pr-2"),
    );
    let pr = std::thread::scope(|scope| {
        let main = scope.spawn(|| go(&p, &main_exec, &caches, &main_in, None, None, 2));
        eventually("the push to start lib", || main_gates.started("lib"));
        let pr = scope.spawn(|| go(&p, &pr_exec, &caches, &pr_in, None, None, 2));
        eventually("the pull request to wait", || pr_in.waits() >= 1);
        main_gates.open("lib");
        main.join().unwrap();
        pr.join().unwrap()
    });
    assert_eq!(job(&pr, "lib").waited_for.as_deref(), Some("run-main2"));
    assert_eq!(pr_exec.ran(), vec!["check"]);
    drop((main_in, pr_in));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn two_runs_waiting_on_each_others_keys_both_finish() {
    let (store, dir) = store("crossed");
    // `x` and `y` are independent; `y` waits for `pre` first.
    let p = plan(
        "name: x\njobs:\n  x:\n    using: builtin:art-write@1\n    artifacts: [dist]\n    task-cache: true\n  pre:\n    using: builtin:ok@1\n  y:\n    using: builtin:art-write@1\n    artifacts: [dist]\n    needs: [pre]\n    task-cache: true\n",
    );
    let caches = Arc::new(MemoryCaches::default());
    let (a_gates, b_gates) = (Arc::new(Gates::default()), Arc::new(Gates::default()));
    // The first run computes `x` and is slow to get to `y`; the second
    // gets to `y` first.
    let (a_exec, b_exec) = (
        GateExec::new(&a_gates, &["x", "pre"], &[]),
        GateExec::new(&b_gates, &["y"], &[]),
    );
    let (a_in, b_in) = (
        counted(&store, "run-a", "b-main"),
        counted(&store, "run-b", "b-main"),
    );
    let started = Instant::now();
    let (a, b) = std::thread::scope(|scope| {
        let a = scope.spawn(|| go(&p, &a_exec, &caches, &a_in, None, None, 2));
        eventually("the first run to start x", || a_gates.started("x"));
        let b = scope.spawn(|| go(&p, &b_exec, &caches, &b_in, None, None, 2));
        eventually("the second run to start y", || b_gates.started("y"));
        eventually("the second run to wait for x", || b_in.waits() >= 1);
        a_gates.open("pre");
        // Now each waits for the other: the first for `y`, the second
        // for `x`. Both markers are held by jobs that run, so both end.
        eventually("the first run to wait for y", || a_in.waits() >= 1);
        a_gates.open("x");
        b_gates.open("y");
        (a.join().unwrap(), b.join().unwrap())
    });
    // Without waiting out a lease or a limit.
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(a.passed() && b.passed());
    assert_eq!(job(&a, "y").waited_for.as_deref(), Some("run-b"));
    assert_eq!(job(&b, "x").waited_for.as_deref(), Some("run-a"));
    let sorted = |mut ran: Vec<String>| {
        ran.sort();
        ran
    };
    assert_eq!(sorted(a_exec.ran()), vec!["pre", "x"]);
    assert_eq!(sorted(b_exec.ran()), vec!["pre", "y"]);
    assert!(markers_left(&store).is_empty());
    drop((a_in, b_in));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn an_entry_saved_while_a_job_queued_is_replayed_when_it_would_start() {
    let (store, dir) = store("queued");
    // `slow` holds the second run's one slot while `lib` queues behind it.
    let p = plan(
        "name: x\njobs:\n  slow:\n    using: builtin:ok@1\n  lib:\n    using: builtin:art-write@1\n    artifacts: [dist]\n    task-cache: true\n",
    );
    let caches = Arc::new(MemoryCaches::default());
    let (a_gates, b_gates) = (Arc::new(Gates::default()), Arc::new(Gates::default()));
    let (a_exec, b_exec) = (
        GateExec::new(&a_gates, &[], &[]),
        GateExec::new(&b_gates, &["slow"], &[]),
    );
    let (a_in, b_in) = (
        counted(&store, "run-a", "b-main"),
        counted(&store, "run-b", "b-main"),
    );
    let b = std::thread::scope(|scope| {
        let b = scope.spawn(|| go(&p, &b_exec, &caches, &b_in, None, None, 1));
        eventually("the second run to start slow", || b_gates.started("slow"));
        // Its lookup of `lib` missed; the first run now computes and saves
        // it, never seeing a marker of the second's.
        std::thread::sleep(Duration::from_millis(100));
        let a = go(&p, &a_exec, &caches, &a_in, None, None, 2);
        assert!(a.passed());
        std::thread::sleep(FAST.recheck);
        b_gates.open("slow");
        b.join().unwrap()
    });
    assert!(b.passed(), "{:#?}", b.jobs);
    let lib = job(&b, "lib");
    assert!(lib.cached && lib.waited_for.is_none(), "{lib:#?}");
    assert!(
        lib.caches
            .iter()
            .any(|l| l.contains("saved by another run while this one queued")),
        "{:?}",
        lib.caches
    );
    assert_eq!(b_exec.ran(), vec!["slow"]);
    assert_eq!(b_in.waits(), 0);
    drop((a_in, b_in));
    let _ = std::fs::remove_dir_all(dir);
}

/// A marker of run `run` for `lib`'s key in `scope`, as another run wrote
/// it. The key is read off the store, where the run waited for it.
fn put_marker(store: &Arc<dyn ObjectStore>, scope: &str, id: &str, run: &str) {
    store
        .put(
            &format!("inflight/acme/app/{scope}/keys/{id}"),
            format!("{{\"run\":\"{run}\",\"runner\":\"ci-9\"}}").as_bytes(),
            "application/json",
        )
        .unwrap();
}

/// The ids of the markers in `scope`.
fn marker_ids(store: &Arc<dyn ObjectStore>, scope: &str) -> Vec<String> {
    let prefix = format!("inflight/acme/app/{scope}/keys/");
    store
        .list(&prefix)
        .unwrap()
        .into_iter()
        .filter_map(|k| k.strip_prefix(&prefix).map(str::to_string))
        .collect()
}

#[test]
fn a_waiter_follows_its_holders_own_marker_not_anothers_for_the_same_key() {
    let (store, dir) = store("follow");
    let p = plan(LIB);
    let caches = Arc::new(MemoryCaches::default());
    let (main_gates, pr_gates) = (Arc::new(Gates::default()), Arc::new(Gates::default()));
    let (main_exec, pr_exec) = (
        GateExec::new(&main_gates, &["lib"], &[]),
        GateExec::new(&pr_gates, &[], &[]),
    );
    let (main_in, pr_in) = (
        counted(&store, "run-main", "b-main"),
        counted(&store, "run-pr", "pr-1"),
    );
    let (pr, after) = std::thread::scope(|scope| {
        let main = scope.spawn(|| go(&p, &main_exec, &caches, &main_in, None, None, 2));
        eventually("the push to start lib", || main_gates.started("lib"));
        let pr = scope.spawn(|| go(&p, &pr_exec, &caches, &pr_in, None, None, 2));
        eventually("the pull request to wait", || pr_in.waits() >= 1);
        // Another run of the pull request's branch marks the same key in
        // the pull request's own scope, and stays.
        let id = marker_ids(&store, "b-main").pop().unwrap();
        put_marker(&store, "pr-1", &id, "run-pr2");
        std::thread::sleep(Duration::from_millis(50));
        let opened = Instant::now();
        main_gates.open("lib");
        main.join().unwrap();
        (pr.join().unwrap(), opened.elapsed())
    });
    assert_eq!(job(&pr, "lib").waited_for.as_deref(), Some("run-main"));
    assert!(after < Duration::from_secs(2), "{after:?}");
    drop((main_in, pr_in));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_marker_written_again_by_another_run_ends_the_wait() {
    let (store, dir) = store("rewritten");
    let p = plan(LIB);
    let caches = Arc::new(MemoryCaches::default());
    let (a_gates, b_gates) = (Arc::new(Gates::default()), Arc::new(Gates::default()));
    let (a_exec, b_exec) = (
        GateExec::new(&a_gates, &["lib"], &[]),
        GateExec::new(&b_gates, &[], &[]),
    );
    let (a_in, b_in) = (
        counted(&store, "run-a", "b-main"),
        counted(&store, "run-b", "b-main"),
    );
    let b = std::thread::scope(|scope| {
        let a = scope.spawn(|| go(&p, &a_exec, &caches, &a_in, None, None, 2));
        eventually("the first run to start lib", || a_gates.started("lib"));
        let b = scope.spawn(|| go(&p, &b_exec, &caches, &b_in, None, None, 2));
        eventually("the second run to wait", || b_in.waits() >= 1);
        // The holder's marker goes and another run's takes its place, in a
        // later second than the one the waiter saw (the store's listing
        // says when an object was written to the second).
        std::thread::sleep(Duration::from_millis(1100));
        let id = marker_ids(&store, "b-main").pop().unwrap();
        put_marker(&store, "b-main", &id, "run-c");
        let b = b.join().unwrap();
        a_gates.open("lib");
        a.join().unwrap();
        b
    });
    let lib = job(&b, "lib");
    assert!(!lib.cached, "{lib:#?}");
    assert!(
        lib.caches
            .iter()
            .any(|l| l.contains("which saved no entry and did not say why")),
        "{:?}",
        lib.caches
    );
    assert_eq!(b_exec.ran(), vec!["lib", "check"]);
    drop((a_in, b_in));
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_holder_whose_sign_of_life_the_store_dates_long_ago_is_given_up_at_once_and_its_marker_taken_over()
 {
    let (store, dir) = store("crashed");
    let p = plan(
        "name: x\njobs:\n  lib:\n    using: builtin:art-write@1\n    artifacts: [dist]\n    task-cache: true\n",
    );
    let caches = Arc::new(MemoryCaches::default());
    // Find the key's marker id from a run that marks it.
    let probe = counted(&store, "run-probe", "b-probe");
    let gates = Arc::new(Gates::default());
    let exec = GateExec::new(&gates, &["lib"], &[]);
    let id = std::thread::scope(|scope| {
        let run = scope.spawn(|| {
            let options = options_for(caches.clone(), &probe, None, None, 1);
            go_with(&p, &exec, &options)
        });
        eventually("the probe to start lib", || gates.started("lib"));
        let id = marker_ids(&store, "b-probe").pop().unwrap();
        gates.open("lib");
        run.join().unwrap();
        id
    });
    drop(probe);
    caches.entries.lock().unwrap().clear();
    // What a runner that crashed an hour ago left: its marker and its last
    // sign of life, which nothing deleted.
    put_marker(&store, "b-main", &id, "run-dead");
    let beat = "inflight/acme/app/b-main/runs/run-dead/ci-9.7";
    store.put(beat, b"", "text/plain").unwrap();
    let file = dir.join(beat);
    std::fs::File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_modified(std::time::SystemTime::now() - Duration::from_secs(3600))
        .unwrap();
    let b_in = counted(&store, "run-b", "b-main");
    let b_exec = GateExec::new(&Arc::new(Gates::default()), &[], &[]);
    let started = Instant::now();
    let b = go(&p, &b_exec, &caches, &b_in, None, None, 1);
    let took = started.elapsed();
    assert!(b.passed());
    let lib = job(&b, "lib");
    assert!(
        lib.caches
            .iter()
            .any(|l| l.contains("is no longer running")),
        "{:?}",
        lib.caches
    );
    assert_eq!(b_exec.ran(), vec!["lib"]);
    assert!(took < FAST.lease, "not a lease: {took:?}");
    // It took the marker over, and deleted it when it was done.
    drop(b_in);
    eventually("the taken-over marker to go", || {
        marker_ids(&store, "b-main").is_empty()
    });
    let _ = std::fs::remove_dir_all(dir);
}

#[test]
fn a_run_cancelled_while_its_jobs_wait_reports_them_cancelled_at_once() {
    let (store, dir) = store("cancel");
    let p = plan(LIB);
    let caches = Arc::new(MemoryCaches::default());
    let (a_gates, b_gates) = (Arc::new(Gates::default()), Arc::new(Gates::default()));
    let (a_exec, b_exec) = (
        GateExec::new(&a_gates, &["lib"], &[]),
        GateExec::new(&b_gates, &[], &[]),
    );
    let (a_in, b_in) = (
        counted(&store, "run-a", "b-main"),
        counted(&store, "run-b", "b-main"),
    );
    let mut b_options = options_for(caches.clone(), &b_in, None, None, 2);
    let cancel = iwci_runtime::Cancel::new();
    b_options.cancel = Some(cancel.clone());
    let (b, took) = std::thread::scope(|scope| {
        let a = scope.spawn(|| go(&p, &a_exec, &caches, &a_in, None, None, 2));
        eventually("the first run to start lib", || a_gates.started("lib"));
        let b = scope.spawn(|| go_with(&p, &b_exec, &b_options));
        eventually("the second run to wait", || b_in.waits() >= 1);
        let at = Instant::now();
        cancel.cancel();
        let b = b.join().unwrap();
        let took = at.elapsed();
        a_gates.open("lib");
        a.join().unwrap();
        (b, took)
    });
    assert!(took < Duration::from_secs(2), "{took:?}");
    assert!(matches!(job(&b, "lib").status, Status::Cancelled { .. }));
    assert!(matches!(job(&b, "check").status, Status::Cancelled { .. }));
    assert!(b_exec.ran().is_empty());
    drop((a_in, b_in));
    let _ = std::fs::remove_dir_all(dir);
}

/// A store that will not delete markers.
struct KeepsMarkers(Arc<dyn ObjectStore>);

impl ObjectStore for KeepsMarkers {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, iwci_store::StoreError> {
        self.0.get(key)
    }
    fn head(&self, key: &str) -> Result<Option<iwci_store::ObjectMeta>, iwci_store::StoreError> {
        self.0.head(key)
    }
    fn put(&self, key: &str, bytes: &[u8], ct: &str) -> Result<(), iwci_store::StoreError> {
        self.0.put(key, bytes, ct)
    }
    fn put_if_absent(
        &self,
        key: &str,
        bytes: &[u8],
        ct: &str,
    ) -> Result<bool, iwci_store::StoreError> {
        self.0.put_if_absent(key, bytes, ct)
    }
    fn list(&self, prefix: &str) -> Result<Vec<String>, iwci_store::StoreError> {
        self.0.list(prefix)
    }
    fn list_detailed(
        &self,
        prefix: &str,
    ) -> Result<Vec<iwci_store::ObjectInfo>, iwci_store::StoreError> {
        self.0.list_detailed(prefix)
    }
    fn delete(&self, key: &str) -> Result<(), iwci_store::StoreError> {
        if key.contains("/keys/") {
            return Err(iwci_store::StoreError::Transport {
                method: "DELETE",
                key: key.into(),
                message: "the store did not answer".into(),
            });
        }
        self.0.delete(key)
    }
}

#[test]
fn a_holder_whose_marker_will_not_delete_is_followed_to_the_end_of_its_run() {
    let (store, dir) = store("undeleted");
    let p = plan(LIB);
    let caches = Arc::new(MemoryCaches::default());
    let (a_gates, b_gates) = (Arc::new(Gates::default()), Arc::new(Gates::default()));
    let (a_exec, b_exec) = (
        GateExec::new(&a_gates, &["lib"], &[]),
        GateExec::new(&b_gates, &[], &[]),
    );
    let keeps: Arc<dyn ObjectStore> = Arc::new(KeepsMarkers(store.clone()));
    let a_in = counted_on(
        &keeps,
        "run-a",
        "ci-1",
        "b-main",
        Duration::from_millis(20),
        false,
    );
    let b_in = counted(&store, "run-b", "b-main");
    let b = std::thread::scope(|scope| {
        let a_options = options_for(caches.clone(), &a_in, None, None, 2);
        let (plan, exec) = (&p, &a_exec);
        let a = scope.spawn(move || {
            let report = go_with(plan, exec, &a_options);
            // The run is over: its markers would go now, and its sign of
            // life does.
            drop(a_options);
            report
        });
        eventually("the first run to start lib", || a_gates.started("lib"));
        let b = scope.spawn(|| go(&p, &b_exec, &caches, &b_in, None, None, 2));
        eventually("the second run to wait", || b_in.waits() >= 1);
        a_gates.open("lib");
        assert!(a.join().unwrap().passed());
        // The test's own handle on the first run's markers goes too.
        drop(a_in);
        b.join().unwrap()
    });
    // The marker never went, but the run that held it ended: the entry it
    // saved is replayed.
    assert_eq!(job(&b, "lib").waited_for.as_deref(), Some("run-a"));
    assert_eq!(b_exec.ran(), vec!["check"]);
    assert_eq!(marker_ids(&store, "b-main").len(), 1, "left for the sweep");
    drop(b_in);
    let _ = std::fs::remove_dir_all(dir);
}

/// A store whose listings miss every sign of life three times in four, as
/// a listing that reads a renamed object's metadata after the rename can.
struct MissesSignsOfLife {
    inner: Arc<dyn ObjectStore>,
    listings: AtomicUsize,
}

impl ObjectStore for MissesSignsOfLife {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, iwci_store::StoreError> {
        self.inner.get(key)
    }
    fn head(&self, key: &str) -> Result<Option<iwci_store::ObjectMeta>, iwci_store::StoreError> {
        self.inner.head(key)
    }
    fn put(&self, key: &str, bytes: &[u8], ct: &str) -> Result<(), iwci_store::StoreError> {
        self.inner.put(key, bytes, ct)
    }
    fn put_if_absent(
        &self,
        key: &str,
        bytes: &[u8],
        ct: &str,
    ) -> Result<bool, iwci_store::StoreError> {
        self.inner.put_if_absent(key, bytes, ct)
    }
    fn list(&self, prefix: &str) -> Result<Vec<String>, iwci_store::StoreError> {
        self.inner.list(prefix)
    }
    fn list_detailed(
        &self,
        prefix: &str,
    ) -> Result<Vec<iwci_store::ObjectInfo>, iwci_store::StoreError> {
        let mut objects = self.inner.list_detailed(prefix)?;
        if !self
            .listings
            .fetch_add(1, Ordering::SeqCst)
            .is_multiple_of(4)
        {
            objects.retain(|o| !o.key.contains("/runs/"));
        }
        Ok(objects)
    }
    fn delete(&self, key: &str) -> Result<(), iwci_store::StoreError> {
        self.inner.delete(key)
    }
}

#[test]
fn a_holder_whose_sign_of_life_listings_keep_missing_is_still_waited_for() {
    let (store, dir) = store("misses");
    let p = plan(LIB);
    let caches = Arc::new(MemoryCaches::default());
    let (a_gates, b_gates) = (Arc::new(Gates::default()), Arc::new(Gates::default()));
    let (a_exec, b_exec) = (
        GateExec::new(&a_gates, &["lib"], &[]),
        GateExec::new(&b_gates, &[], &[]),
    );
    let misses: Arc<dyn ObjectStore> = Arc::new(MissesSignsOfLife {
        inner: store.clone(),
        listings: AtomicUsize::new(0),
    });
    let a_in = counted(&store, "run-a", "b-main");
    let b_in = counted_on(
        &misses,
        "run-b",
        "ci-2",
        "b-main",
        Duration::from_millis(20),
        false,
    );
    let b = std::thread::scope(|scope| {
        let a = scope.spawn(|| go(&p, &a_exec, &caches, &a_in, None, None, 2));
        eventually("the first run to start lib", || a_gates.started("lib"));
        let b = scope.spawn(|| go(&p, &b_exec, &caches, &b_in, None, None, 2));
        eventually("the second run to wait", || b_in.waits() >= 1);
        // Many looks, most of them without the holder's sign of life, all
        // well within a lease.
        std::thread::sleep(Duration::from_millis(500));
        a_gates.open("lib");
        a.join().unwrap();
        b.join().unwrap()
    });
    assert_eq!(job(&b, "lib").waited_for.as_deref(), Some("run-a"));
    assert_eq!(b_exec.ran(), vec!["check"]);
    drop((a_in, b_in));
    let _ = std::fs::remove_dir_all(dir);
}
