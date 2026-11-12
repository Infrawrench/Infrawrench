//! Telling a hung job from a quiet one (#938).
//!
//! A job that has finished its work but never exits (#938 was a `node`
//! joining a worker thread that never ended, every thread parked) looks
//! from outside like one still working, and used to hold its slot until its
//! timeout. What tells them apart is CPU time: a long compile
//! that prints nothing still uses CPU, a hung process uses none. So a job is
//! *stalled* once it has neither written output nor used more than a sliver
//! of CPU time for [`StallWatch`]'s window, and it is stopped then rather
//! than at its timeout.
//!
//! Jobs share one process, so a job's CPU time is the sum over the threads
//! working for it, each counted by the job's [`CpuMeter`] while it does:
//!
//! - **Its processes and guest threads.** wasmer-wasix runs every process
//!   (bash, each command it spawns, a fork) and every guest thread (libuv's
//!   pool, a `worker_threads` Worker, Edge.js's own threads) as a task on
//!   the job's task manager; [`JobTasks`] wraps that manager so each task
//!   registers the pool thread it got.
//! - **A pool thread waiting to resume one of them** from a deep sleep,
//!   for what the wait itself computes (`Counted`).
//! - **The thread driving the job**, which loads its packages and modules
//!   and starts its first process (`wasix::run`).
//! - **V8's worker threads**, while they run a task posted by one of the
//!   job's threads: garbage collection, background compilation of JavaScript
//!   and WebAssembly. The pool is process-wide, so the vendored N-API bridge
//!   asks whose each task is when it is posted ([`node_hooks`]).
//!
//! The first and third of these stay for as long as a process or thread
//! runs, and are registered: their clocks are read as they run
//! ([`CpuMeter::enter`]). The other two are brief and frequent, thousands a
//! second in a job that churns threads, and are measured from the inside
//! with no lock ([`CpuMeter::visit`]): a lock taken that often is a queue
//! every thread of the job stands in, and the watchdog must not be what a
//! job's threads wait on.
//!
//! Two kinds of work happen where no thread can be registered, and make
//! the job *busy* instead; a busy job is never stalled:
//!
//! - **A task being set up**: wasmer-wasix creates the store and
//!   instantiates the module on the pool thread before the task's first
//!   callback, while the thread that asked waits ([`JobTasks::task_wasm`]).
//!   How long that took is then counted as CPU time.
//! - **A module being loaded or compiled, by any job.** Wasmer compiles on
//!   its own threads while the job's thread waits, and loading the result
//!   into the shared engine holds that engine's lock, which every other job
//!   needs to start a process (the compile itself runs on a private engine,
//!   see `cache::ModuleStore::compile`, so that wait is short now). So this
//!   one is the runtime's, not the job's (`cache::Working`), and every job
//!   is busy while it lasts.
//!
//! What is deliberately not counted is waiting: a job blocked on the
//! network, on a sleep or on a lock uses no CPU and prints nothing, and is
//! stopped like a hang if that lasts the whole window.
//!
//! Only Linux has per-thread CPU clocks another thread can read; elsewhere
//! [`CpuMeter::total`] is `None` and nothing is ever stalled.

use std::cell::RefCell;
use std::collections::HashMap;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures::future::BoxFuture;
use wasmer::{Module, StoreMut};
use wasmer_wasix::WasiThreadError;
use wasmer_wasix::runtime::task_manager::{SpawnType, TaskWasm, VirtualTaskManager};

/// How long a job may go without output or CPU use before it is stopped as
/// stalled, unless the runner is told otherwise.
pub const DEFAULT_STALL_AFTER: Duration = Duration::from_secs(300);

thread_local! {
    /// The job this thread is working for now, if any: what a V8 worker task
    /// posted from here is counted for.
    static CURRENT: RefCell<Option<Arc<CpuMeter>>> = const { RefCell::new(None) };
}

/// The CPU time used by the threads working for a job.
#[derive(Default)]
pub(crate) struct CpuMeter {
    /// The threads that work for the job for a long time: the ones its
    /// processes and guest threads run on.
    threads: Mutex<Threads>,
    /// Nanoseconds of CPU time counted without registering a thread: brief
    /// work on shared threads ([`CpuMeter::visit`]), and how long the job
    /// was busy ([`CpuMeter::busy`]). These happen thousands of times a
    /// second in a job that churns threads, so they take no lock.
    brief: AtomicU64,
    /// Work in progress for the job on threads that are not registered
    /// (see the module comment).
    busy: AtomicUsize,
}

impl std::fmt::Debug for CpuMeter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CpuMeter").finish_non_exhaustive()
    }
}

#[derive(Default)]
struct Threads {
    /// What threads that have left used while registered.
    retired: Duration,
    /// Threads registered now: their clock and its reading when they
    /// entered, by thread id.
    live: HashMap<i64, (Clock, Duration)>,
}

/// Registers the calling thread with a [`CpuMeter`] until dropped, which
/// must happen on the same thread.
pub(crate) struct CpuGuard {
    /// The job the thread worked for before, restored on drop.
    previous: Option<Arc<CpuMeter>>,
    meter: Arc<CpuMeter>,
    /// The thread's id when this guard registered it; `None` when it was
    /// registered already (a nested guard) or has no readable clock.
    registered: Option<i64>,
    /// Guards are tied to their thread.
    _not_send: std::marker::PhantomData<*const ()>,
}

/// Marks a [`CpuMeter`]'s job busy until dropped, and then counts how long
/// that was as CPU time used for the job.
pub(crate) struct BusyGuard {
    meter: Arc<CpuMeter>,
    since: Instant,
}

/// Counts what the calling thread does for a [`CpuMeter`]'s job until
/// dropped, on the same thread ([`CpuMeter::visit`]).
pub(crate) struct VisitGuard {
    /// The job the thread worked for before, restored on drop.
    previous: Option<Arc<CpuMeter>>,
    meter: Arc<CpuMeter>,
    /// The thread's own CPU clock at the start; `None` when the thread is
    /// registered with the job already, or has no clock.
    start: Option<Duration>,
    /// Guards are tied to their thread.
    _not_send: std::marker::PhantomData<*const ()>,
}

impl CpuMeter {
    /// Counts the calling thread's CPU time towards the job, and makes the
    /// job the one this thread works for, until the guard is dropped. Nests:
    /// a thread already counted for this job is not counted twice.
    pub(crate) fn enter(self: &Arc<Self>) -> CpuGuard {
        let previous = CURRENT.with(|current| current.replace(Some(self.clone())));
        let nested = previous
            .as_ref()
            .is_some_and(|previous| Arc::ptr_eq(previous, self));
        let registered = if nested {
            None
        } else {
            Clock::current().and_then(|(tid, clock)| {
                let start = clock.read()?;
                let mut threads = self.threads.lock().unwrap_or_else(|e| e.into_inner());
                // A thread is only in here twice if a guard was leaked;
                // keep the older entry, which holds more of its time.
                threads.live.entry(tid).or_insert((clock, start));
                Some(tid)
            })
        };
        CpuGuard {
            previous,
            meter: self.clone(),
            registered,
            _not_send: std::marker::PhantomData,
        }
    }

    /// Counts a short piece of work the calling thread does for the job,
    /// until the guard is dropped: a V8 worker task, one poll of a future.
    /// The job is busy meanwhile, and the thread's CPU time over the visit
    /// is added when it ends; nothing is locked, unlike [`Self::enter`],
    /// which is for a thread that stays (its time is then read while it
    /// runs). The job is also the one this thread works for meanwhile.
    pub(crate) fn visit(self: &Arc<Self>) -> VisitGuard {
        let previous = CURRENT.with(|current| current.replace(Some(self.clone())));
        // A thread registered with this job is being read already.
        let nested = previous
            .as_ref()
            .is_some_and(|previous| Arc::ptr_eq(previous, self));
        self.busy.fetch_add(1, Ordering::AcqRel);
        VisitGuard {
            previous,
            meter: self.clone(),
            start: if nested { None } else { Clock::own() },
            _not_send: std::marker::PhantomData,
        }
    }

    /// The job the calling thread is working for, if any.
    #[cfg(any(feature = "node", test))]
    pub(crate) fn current() -> Option<Arc<Self>> {
        CURRENT.with(|current| current.borrow().clone())
    }

    /// Marks the job busy until the guard is dropped: work is being done
    /// for it on a thread that is not registered, while the caller waits.
    /// The time waited is then counted as CPU time, which is what the other
    /// thread spent unless it was itself kept waiting; that way a job whose
    /// only activity is a brief task now and then (an idle event loop's
    /// timer) uses a sliver of CPU, as it does on its own threads, rather
    /// than looking busy whenever a sample happens to catch it.
    pub(crate) fn busy(self: &Arc<Self>) -> BusyGuard {
        self.busy.fetch_add(1, Ordering::AcqRel);
        BusyGuard {
            meter: self.clone(),
            since: Instant::now(),
        }
    }

    /// Whether work is in progress for the job on threads it cannot count.
    pub(crate) fn is_busy(&self) -> bool {
        self.busy.load(Ordering::Acquire) > 0
    }

    /// The CPU time used so far, or `None` where it cannot be measured.
    pub(crate) fn total(&self) -> Option<Duration> {
        if !Clock::SUPPORTED {
            return None;
        }
        let threads = self.threads.lock().unwrap_or_else(|e| e.into_inner());
        // Reading under the lock: a live entry's thread cannot unregister,
        // and so cannot exit, while its clock is read.
        let live: Duration = threads
            .live
            .values()
            .filter_map(|(clock, start)| Some(clock.read()?.saturating_sub(*start)))
            .sum();
        let brief = Duration::from_nanos(self.brief.load(Ordering::Acquire));
        Some(threads.retired + live + brief)
    }

    fn add_brief(&self, time: Duration) {
        let nanos = u64::try_from(time.as_nanos()).unwrap_or(u64::MAX);
        self.brief.fetch_add(nanos, Ordering::AcqRel);
    }
}

impl Drop for CpuGuard {
    fn drop(&mut self) {
        CURRENT.with(|current| current.replace(self.previous.take()));
        let Some(tid) = self.registered else { return };
        let mut threads = self.meter.threads.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((clock, start)) = threads.live.remove(&tid) {
            let used = clock
                .read()
                .map_or(Duration::ZERO, |now| now.saturating_sub(start));
            threads.retired += used;
        }
    }
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.meter.add_brief(self.since.elapsed());
        self.meter.busy.fetch_sub(1, Ordering::AcqRel);
    }
}

impl Drop for VisitGuard {
    fn drop(&mut self) {
        CURRENT.with(|current| current.replace(self.previous.take()));
        if let Some(start) = self.start
            && let Some(now) = Clock::own()
        {
            self.meter.add_brief(now.saturating_sub(start));
        }
        self.meter.busy.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Counting V8's worker threads for the job whose task they run.
///
/// The vendored wasmer-napi calls these around every task V8 posts to its
/// process-wide worker pool (vendor/README.md): `capture` on the posting
/// thread, which is one of a job's threads or a worker already running a
/// task for one, and `enter`/`exit` on the worker around the task.
#[cfg(feature = "node")]
pub(crate) mod node_hooks {
    use std::cell::RefCell;
    use std::ffi::c_void;
    use std::sync::{Arc, Once};

    use super::{CpuMeter, VisitGuard};

    thread_local! {
        /// The guards of the tasks running on this worker thread (one,
        /// unless V8 runs a task inside another).
        static RUNNING: RefCell<Vec<VisitGuard>> = const { RefCell::new(Vec::new()) };
    }

    /// Installs the hooks, once per process, before any isolate exists.
    pub(crate) fn install() {
        static INSTALL: Once = Once::new();
        INSTALL.call_once(|| {
            wasmer_napi::set_worker_task_hooks(wasmer_napi::WorkerTaskHooks {
                capture,
                enter,
                exit,
                release,
            });
        });
    }

    /// The job the posting thread works for, as a token the task holds.
    unsafe extern "C" fn capture() -> *mut c_void {
        match CpuMeter::current() {
            Some(meter) => Arc::into_raw(meter).cast_mut().cast(),
            None => std::ptr::null_mut(),
        }
    }

    unsafe extern "C" fn enter(token: *mut c_void) {
        let token: *const CpuMeter = token.cast_const().cast();
        // SAFETY: `token` came from `capture` and the task that holds it is
        // running, so `release` has not been called: the meter is alive, and
        // the count taken here is this guard's own.
        let meter = unsafe {
            Arc::increment_strong_count(token);
            Arc::from_raw(token)
        };
        let guard = meter.visit();
        RUNNING.with(|running| running.borrow_mut().push(guard));
    }

    unsafe extern "C" fn exit(_token: *mut c_void) {
        drop(RUNNING.with(|running| running.borrow_mut().pop()));
    }

    unsafe extern "C" fn release(token: *mut c_void) {
        let token: *const CpuMeter = token.cast_const().cast();
        // SAFETY: `token` came from `capture`, and this is its one release.
        drop(unsafe { Arc::from_raw(token) });
    }
}

/// A thread's CPU clock.
#[derive(Clone, Copy)]
struct Clock(#[cfg_attr(not(target_os = "linux"), allow(dead_code))] i64);

#[cfg(target_os = "linux")]
impl Clock {
    const SUPPORTED: bool = true;

    /// The calling thread's id and CPU clock.
    fn current() -> Option<(i64, Self)> {
        let mut clock: libc::clockid_t = 0;
        // SAFETY: pthread_self() is always a valid thread, and `clock` is a
        // valid place to write the id.
        let ok = unsafe { libc::pthread_getcpuclockid(libc::pthread_self(), &mut clock) } == 0;
        // SAFETY: gettid has no preconditions.
        let tid = i64::from(unsafe { libc::gettid() });
        ok.then_some((tid, Self(i64::from(clock))))
    }

    /// The calling thread's own CPU time.
    fn own() -> Option<Duration> {
        Self(i64::from(libc::CLOCK_THREAD_CPUTIME_ID)).read()
    }

    fn read(self) -> Option<Duration> {
        let mut ts = libc::timespec {
            tv_sec: 0,
            tv_nsec: 0,
        };
        let clock = libc::clockid_t::try_from(self.0).ok()?;
        // SAFETY: `ts` is a valid timespec to write; a stale clock id fails
        // with EINVAL rather than reading anything.
        if unsafe { libc::clock_gettime(clock, &mut ts) } != 0 {
            return None;
        }
        Some(Duration::new(
            u64::try_from(ts.tv_sec).ok()?,
            u32::try_from(ts.tv_nsec).ok()?,
        ))
    }
}

#[cfg(not(target_os = "linux"))]
impl Clock {
    const SUPPORTED: bool = false;

    fn current() -> Option<(i64, Self)> {
        None
    }

    fn own() -> Option<Duration> {
        None
    }

    fn read(self) -> Option<Duration> {
        None
    }
}

/// The runner's task manager as one job sees it: the same threads, with
/// every task that runs the job's wasm (or blocks on its behalf) counted by
/// the job's [`CpuMeter`].
#[derive(Debug)]
pub(crate) struct JobTasks {
    inner: Arc<dyn VirtualTaskManager>,
    meter: Arc<CpuMeter>,
}

impl JobTasks {
    pub(crate) fn new(inner: Arc<dyn VirtualTaskManager>, meter: Arc<CpuMeter>) -> Self {
        Self { inner, meter }
    }
}

impl VirtualTaskManager for JobTasks {
    fn build_memory(
        &self,
        store: &mut StoreMut,
        spawn_type: SpawnType,
    ) -> Result<Option<wasmer::Memory>, WasiThreadError> {
        self.inner.build_memory(store, spawn_type)
    }

    fn sleep_now(
        &self,
        time: Duration,
    ) -> Pin<Box<dyn Future<Output = ()> + Send + Sync + 'static>> {
        self.inner.sleep_now(time)
    }

    fn task_shared(
        &self,
        task: Box<dyn FnOnce() -> BoxFuture<'static, ()> + Send + 'static>,
    ) -> Result<(), WasiThreadError> {
        // Runs on the runner's async threads, which every job shares and
        // which only wait (timers, a process's exit): nothing to count.
        self.inner.task_shared(task)
    }

    fn task_wasm(&self, mut task: TaskWasm) -> Result<(), WasiThreadError> {
        // `run` executes the guest on the thread the task got, for as long as
        // the process or thread runs (or until it deep-sleeps, when a new
        // task resumes it).
        let run = task.callbacks.run;
        let meter = self.meter.clone();
        task.callbacks.run = Box::new(move |props| {
            let _counted = meter.enter();
            run(props)
        });
        // A process or thread resuming from a deep sleep first waits on the
        // pool thread for what it slept on (its trigger): a timer, a child's
        // exit, or a syscall's own work, such as loading the module of a
        // command it spawns. Whatever each poll of that future computes is
        // the job's.
        if let Some(trigger) = task.callbacks.trigger.take() {
            let meter = self.meter.clone();
            task.callbacks.trigger = Some(Box::new(move || {
                Box::pin(Counted {
                    inner: trigger(),
                    meter,
                })
            }));
        }
        // Before either, the pool thread creates the task's store and
        // instantiates its module, which this crate cannot wrap; the caller
        // waits in `task_wasm` until that is done, so the job is busy for
        // exactly that long.
        let _setting_up = self.meter.busy();
        self.inner.task_wasm(task)
    }

    fn task_dedicated(
        &self,
        task: Box<dyn FnOnce() + Send + 'static>,
    ) -> Result<(), WasiThreadError> {
        let meter = self.meter.clone();
        self.inner.task_dedicated(Box::new(move || {
            let _counted = meter.enter();
            task()
        }))
    }

    fn thread_parallelism(&self) -> Result<usize, WasiThreadError> {
        self.inner.thread_parallelism()
    }

    fn spawn_with_module(
        &self,
        module: Module,
        task: Box<dyn FnOnce(Module) + Send + 'static>,
    ) -> Result<(), WasiThreadError> {
        let meter = self.meter.clone();
        self.inner.spawn_with_module(
            module,
            Box::new(move |module| {
                let _counted = meter.enter();
                task(module)
            }),
        )
    }
}

/// A future whose polls count as the job's work, on whichever thread polls.
struct Counted<F> {
    inner: F,
    meter: Arc<CpuMeter>,
}

impl<F: Future + Unpin> Future for Counted<F> {
    type Output = F::Output;

    fn poll(
        mut self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Self::Output> {
        let _counted = self.meter.visit();
        Pin::new(&mut self.inner).poll(cx)
    }
}

/// A job that uses less than one core's `1 / IDLE_SHARE` over a window is
/// idle: 2%, six seconds in the default five minutes.
///
/// Idle is not free in a guest. Each wake-up of a waiting thread (a timer
/// firing, a timed `Atomics.wait` running out) costs about a quarter of a
/// millisecond of CPU in the runner, against tens of microseconds natively:
/// measured on ci-1, a `node` with a 100 ms `setInterval` and nothing else
/// used 2.6 ms of CPU a second, 50 ms 5.4 ms and 20 ms 13 ms. A hung Vitest
/// (#986: its workers refused for want of memory, its reporter's timer and
/// a worker thread's timed atomic wait still ticking) used 3.3 ms a second,
/// right at the 1-in-300 this used to be (one second in five minutes),
/// so it was stopped after five minutes, or ten, or held its slot until its
/// timeout, depending on how each window's wake-ups fell. Work is a core,
/// or most of one, and stays fifty times over this.
const IDLE_SHARE: u32 = 50;

/// Decides when a job has stalled, from samples of its output and CPU time.
#[derive(Debug)]
pub(crate) struct StallWatch {
    after: Duration,
    /// CPU time below which a window counts as idle: a sliver of one core
    /// ([`IDLE_SHARE`]), so an idle event loop's timer wake-ups do not keep
    /// a hung job alive but any real work does.
    min_cpu: Duration,
    since: Instant,
    output: u64,
    cpu: Duration,
}

impl StallWatch {
    /// Starts watching at `now`. `None` when CPU time cannot be measured,
    /// since output alone cannot tell a hang from a quiet compile.
    pub(crate) fn new(
        after: Duration,
        now: Instant,
        output: u64,
        cpu: Option<Duration>,
    ) -> Option<Self> {
        Some(Self {
            after,
            min_cpu: (after / IDLE_SHARE).max(Duration::from_millis(10)),
            since: now,
            output,
            cpu: cpu?,
        })
    }

    /// How often to sample.
    pub(crate) fn every(&self) -> Duration {
        (self.after / 10).clamp(Duration::from_millis(50), Duration::from_secs(10))
    }

    /// Takes a sample; true once the job has gone `after` without output,
    /// without using `min_cpu` of CPU time and without being `busy` (a task
    /// of its being set up, or a module loading for any job).
    pub(crate) fn stalled(
        &mut self,
        now: Instant,
        output: u64,
        cpu: Option<Duration>,
        busy: bool,
    ) -> bool {
        let Some(cpu) = cpu else { return false };
        if busy || output != self.output || cpu.saturating_sub(self.cpu) >= self.min_cpu {
            self.since = now;
            self.output = output;
            self.cpu = cpu;
            return false;
        }
        now.saturating_duration_since(self.since) >= self.after
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: Duration = Duration::from_secs(60);

    #[test]
    fn a_job_with_neither_output_nor_cpu_stalls_after_the_window() {
        let t0 = Instant::now();
        let mut watch = StallWatch::new(5 * MIN, t0, 10, Some(Duration::ZERO)).unwrap();
        assert!(!watch.stalled(t0 + MIN, 10, Some(Duration::ZERO), false));
        assert!(!watch.stalled(t0 + 4 * MIN, 10, Some(Duration::from_millis(5)), false));
        assert!(watch.stalled(t0 + 5 * MIN, 10, Some(Duration::from_millis(5)), false));
    }

    #[test]
    fn output_or_cpu_use_restarts_the_window() {
        let t0 = Instant::now();
        let mut watch = StallWatch::new(5 * MIN, t0, 0, Some(Duration::ZERO)).unwrap();
        // Output at minute 4: idle again only from there.
        assert!(!watch.stalled(t0 + 4 * MIN, 1, Some(Duration::ZERO), false));
        assert!(!watch.stalled(t0 + 8 * MIN, 1, Some(Duration::ZERO), false));
        // A silent compile: CPU time, no output.
        assert!(!watch.stalled(t0 + 12 * MIN, 1, Some(Duration::from_secs(30)), false));
        assert!(!watch.stalled(t0 + 16 * MIN, 1, Some(Duration::from_secs(60)), false));
        assert!(watch.stalled(t0 + 21 * MIN, 1, Some(Duration::from_secs(60)), false));
    }

    #[test]
    fn a_sliver_of_cpu_does_not_count_as_work() {
        let t0 = Instant::now();
        let mut watch = StallWatch::new(5 * MIN, t0, 0, Some(Duration::ZERO)).unwrap();
        // An idle event loop's wake-ups: well under a second in five minutes.
        for minute in 1..5 {
            let cpu = Duration::from_millis(100 * minute);
            assert!(!watch.stalled(t0 + MIN * minute as u32, 0, Some(cpu), false));
        }
        assert!(watch.stalled(t0 + 5 * MIN, 0, Some(Duration::from_millis(500)), false));
    }

    #[test]
    fn an_idle_event_loops_wake_ups_do_not_count_as_work() {
        // #986: a hung Vitest, its timers and a timed atomic wait still
        // waking it, at about 3.5 ms of CPU a second: just over a second in
        // five minutes, which once kept it alive window after window.
        let t0 = Instant::now();
        let mut watch = StallWatch::new(5 * MIN, t0, 0, Some(Duration::ZERO)).unwrap();
        let idle = |seconds: u64| Some(Duration::from_micros(3_500 * seconds));
        for minute in 1..5 {
            assert!(!watch.stalled(t0 + MIN * minute, 0, idle(60 * u64::from(minute)), false));
        }
        assert!(watch.stalled(t0 + 5 * MIN, 0, idle(300), false));

        // A job computing at a tenth of a core is working.
        let t0 = Instant::now();
        let mut watch = StallWatch::new(5 * MIN, t0, 0, Some(Duration::ZERO)).unwrap();
        for minute in 1..20u32 {
            let cpu = Duration::from_secs(6 * u64::from(minute));
            assert!(!watch.stalled(t0 + MIN * minute, 0, Some(cpu), false));
        }
    }

    #[test]
    fn a_busy_job_does_not_stall() {
        let t0 = Instant::now();
        let mut watch = StallWatch::new(5 * MIN, t0, 0, Some(Duration::ZERO)).unwrap();
        // A module compiling for ten minutes: no CPU of the job's own.
        assert!(!watch.stalled(t0 + 10 * MIN, 0, Some(Duration::ZERO), true));
        assert!(!watch.stalled(t0 + 14 * MIN, 0, Some(Duration::ZERO), false));
        assert!(watch.stalled(t0 + 15 * MIN, 0, Some(Duration::ZERO), false));
    }

    #[test]
    fn nothing_stalls_without_a_cpu_clock() {
        let t0 = Instant::now();
        assert!(StallWatch::new(MIN, t0, 0, None).is_none());
        let mut watch = StallWatch::new(MIN, t0, 0, Some(Duration::ZERO)).unwrap();
        assert!(!watch.stalled(t0 + 10 * MIN, 0, None, false));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_meter_counts_a_busy_thread_and_not_a_sleeping_one() {
        let meter = Arc::new(CpuMeter::default());
        let sleeper = {
            let meter = meter.clone();
            std::thread::spawn(move || {
                let _counted = meter.enter();
                std::thread::sleep(Duration::from_millis(300));
            })
        };
        sleeper.join().unwrap();
        let idle = meter.total().unwrap();
        assert!(idle < Duration::from_millis(50), "{idle:?}");

        let (started, wait) = std::sync::mpsc::channel();
        let (stop, stopped) = std::sync::mpsc::channel::<()>();
        let spinner = {
            let meter = meter.clone();
            std::thread::spawn(move || {
                let _counted = meter.enter();
                started.send(()).unwrap();
                let begin = Instant::now();
                while stopped.try_recv().is_err() {
                    std::hint::black_box(begin.elapsed());
                }
            })
        };
        wait.recv().unwrap();
        // Read while the thread still runs: live threads count too. How
        // soon its time shows depends on how much of a busy machine the
        // spinner gets, so wait for the time, not for the clock.
        let enough = idle + Duration::from_millis(50);
        let deadline = Instant::now() + Duration::from_secs(60);
        let live = loop {
            let live = meter.total().unwrap();
            if live >= enough || Instant::now() > deadline {
                break live;
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(live >= enough, "{live:?}");
        stop.send(()).unwrap();
        spinner.join().unwrap();
        let after = meter.total().unwrap();
        assert!(after >= live, "{after:?} < {live:?}");
        assert!(meter.threads.lock().unwrap().live.is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_thread_is_counted_once_however_often_it_enters() {
        let meter = Arc::new(CpuMeter::default());
        let other = Arc::new(CpuMeter::default());
        assert!(CpuMeter::current().is_none());
        {
            let _outer = meter.enter();
            let _inner = meter.enter();
            assert_eq!(meter.threads.lock().unwrap().live.len(), 1);
            {
                // Working for another job for a while: both count the
                // thread, and the first is current again afterwards.
                let _other = other.enter();
                assert!(Arc::ptr_eq(&CpuMeter::current().unwrap(), &other));
            }
            assert!(Arc::ptr_eq(&CpuMeter::current().unwrap(), &meter));
            drop(_inner);
            // The inner guard did not register the thread, so dropping it
            // leaves the thread counted.
            assert_eq!(meter.threads.lock().unwrap().live.len(), 1);
        }
        assert!(CpuMeter::current().is_none());
        assert!(meter.threads.lock().unwrap().live.is_empty());
        assert!(other.threads.lock().unwrap().live.is_empty());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_visit_counts_the_threads_own_time_and_only_when_nothing_else_does() {
        // Uses `cpu` of this thread's CPU time, however long that takes.
        let spin = |cpu: Duration| {
            let start = Clock::own().unwrap();
            while Clock::own().unwrap().saturating_sub(start) < cpu {
                std::hint::black_box(start);
            }
        };
        let meter = Arc::new(CpuMeter::default());
        {
            let _visit = meter.visit();
            assert!(meter.is_busy());
            assert!(Arc::ptr_eq(&CpuMeter::current().unwrap(), &meter));
            spin(Duration::from_millis(20));
        }
        assert!(!meter.is_busy());
        assert!(CpuMeter::current().is_none());
        let visited = meter.total().unwrap();
        assert!(visited >= Duration::from_millis(20), "{visited:?}");

        // On a thread registered with the job, whose clock is read as it
        // runs, a visit adds nothing of its own.
        let _registered = meter.enter();
        let brief = meter.brief.load(Ordering::Acquire);
        {
            let _visit = meter.visit();
            spin(Duration::from_millis(5));
        }
        assert_eq!(meter.brief.load(Ordering::Acquire), brief);
        assert!(meter.total().unwrap() >= visited + Duration::from_millis(5));
    }

    #[test]
    fn a_job_is_busy_while_any_guard_is_held() {
        let meter = Arc::new(CpuMeter::default());
        assert!(!meter.is_busy());
        let a = meter.busy();
        let b = meter.busy();
        drop(a);
        assert!(meter.is_busy());
        std::thread::sleep(Duration::from_millis(30));
        drop(b);
        assert!(!meter.is_busy());
        // The time it was busy counts as CPU time used for it.
        if let Some(total) = meter.total() {
            assert!(total >= Duration::from_millis(30), "{total:?}");
        }
    }
}
