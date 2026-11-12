use std::sync::Mutex;
use std::{pin::Pin, sync::Arc, time::Duration};

use futures::{Future, future::BoxFuture};
use tokio::runtime::{Handle, Runtime};
use virtual_mio::block_on;

use crate::runtime::{SpawnType, task_manager::TaskWasmCallbacks};
use crate::{WasiFunctionEnv, os::task::thread::WasiThreadError};

use super::{SpawnMemoryTypeOrStore, TaskWasm, TaskWasmRunProperties, VirtualTaskManager};

#[derive(Debug, Clone)]
pub enum RuntimeOrHandle {
    Handle(Handle),
    Runtime(Handle, Arc<Mutex<Option<Runtime>>>),
}
impl From<Handle> for RuntimeOrHandle {
    fn from(value: Handle) -> Self {
        Self::Handle(value)
    }
}
impl From<Runtime> for RuntimeOrHandle {
    fn from(value: Runtime) -> Self {
        Self::Runtime(value.handle().clone(), Arc::new(Mutex::new(Some(value))))
    }
}

impl Drop for RuntimeOrHandle {
    fn drop(&mut self) {
        if let Self::Runtime(_, runtime) = self
            && let Some(h) = runtime.lock().unwrap().take()
        {
            h.shutdown_timeout(Duration::from_secs(0))
        }
    }
}

impl RuntimeOrHandle {
    pub fn handle(&self) -> &Handle {
        match self {
            Self::Handle(h) => h,
            Self::Runtime(h, _) => h,
        }
    }
}

/// iwci patch (#1063): the threads WASIX processes and threads run on. A
/// task goes to a thread that has finished its last one, or to a new
/// thread, never into a queue, so a task that waits for another one it
/// started is never waiting behind it. A thread with nothing to do for
/// [`ThreadPool::KEEP_ALIVE`] ends. `rusty_pool` with a core size of
/// `max(200, 100 * cores)` kept every thread it ever made, and made a new
/// one for each task until it had that many, idle ones or not: an idle
/// runner on 16 cores held 1,600 of them, with their stacks, for good.
#[derive(Clone)]
pub struct ThreadPool {
    shared: Arc<PoolShared>,
}

type Job = Box<dyn FnOnce() + Send + 'static>;

struct PoolShared {
    name: String,
    keep_alive: Duration,
    /// Threads waiting for a task, the most recently idle last.
    idle: Mutex<Vec<Arc<Handoff>>>,
    threads: std::sync::atomic::AtomicUsize,
}

/// Where an idle thread is handed its next task.
#[derive(Default)]
struct Handoff {
    job: Mutex<Option<Job>>,
    ready: std::sync::Condvar,
}

impl ThreadPool {
    /// How long a thread waits for another task before it ends.
    pub const KEEP_ALIVE: Duration = Duration::from_secs(60);

    pub fn new(name: impl Into<String>, keep_alive: Duration) -> Self {
        Self {
            shared: Arc::new(PoolShared {
                name: name.into(),
                keep_alive,
                idle: Mutex::default(),
                threads: Default::default(),
            }),
        }
    }

    /// Runs `job` on an idle thread, or on a new one if none is idle.
    pub fn execute(&self, job: impl FnOnce() + Send + 'static) {
        let job: Job = Box::new(job);
        // Popped under the lock, so no other task is handed to it.
        let idle = self.shared.idle.lock().unwrap().pop();
        if let Some(handoff) = idle {
            *handoff.job.lock().unwrap() = Some(job);
            handoff.ready.notify_one();
            return;
        }
        let shared = self.shared.clone();
        shared
            .threads
            .fetch_add(1, std::sync::atomic::Ordering::AcqRel);
        std::thread::Builder::new()
            .name(self.shared.name.clone())
            .spawn(move || work(shared, job))
            .expect("spawning a task thread");
    }

    /// Threads alive, busy or idle.
    pub fn threads(&self) -> usize {
        self.shared
            .threads
            .load(std::sync::atomic::Ordering::Acquire)
    }

    /// Threads waiting for a task.
    pub fn idle_threads(&self) -> usize {
        self.shared.idle.lock().unwrap().len()
    }
}

fn work(shared: Arc<PoolShared>, mut job: Job) {
    struct Alive(Arc<PoolShared>);
    impl Drop for Alive {
        fn drop(&mut self) {
            self.0
                .threads
                .fetch_sub(1, std::sync::atomic::Ordering::AcqRel);
        }
    }
    let alive = Alive(shared);
    let shared = &alive.0;
    let handoff = Arc::new(Handoff::default());
    loop {
        job();
        shared.idle.lock().unwrap().push(handoff.clone());
        let deadline = std::time::Instant::now() + shared.keep_alive;
        let mut slot = handoff.job.lock().unwrap();
        job = loop {
            if let Some(next) = slot.take() {
                break next;
            }
            let now = std::time::Instant::now();
            if now < deadline {
                slot = handoff.ready.wait_timeout(slot, deadline - now).unwrap().0;
                continue;
            }
            drop(slot);
            {
                let mut idle = shared.idle.lock().unwrap();
                if let Some(at) = idle.iter().position(|h| Arc::ptr_eq(h, &handoff)) {
                    idle.swap_remove(at);
                    return;
                }
            }
            // A task took this thread as it timed out: it is on its way.
            slot = handoff.job.lock().unwrap();
            while slot.is_none() {
                slot = handoff.ready.wait(slot).unwrap();
            }
        };
    }
}

impl std::fmt::Debug for ThreadPool {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ThreadPool")
            .field("name", &self.shared.name)
            .field("threads", &self.threads())
            .field("idle_threads", &self.idle_threads())
            .finish()
    }
}

/// A task manager that uses tokio to spawn tasks.
#[derive(Clone, Debug)]
pub struct TokioTaskManager {
    rt: RuntimeOrHandle,
    pool: Arc<ThreadPool>,
}

impl TokioTaskManager {
    pub fn new<I>(rt: I) -> Self
    where
        I: Into<RuntimeOrHandle>,
    {
        Self {
            rt: rt.into(),
            // iwci patch (#1063): threads that end when idle; see
            // `ThreadPool`.
            pool: Arc::new(ThreadPool::new(
                "TokioTaskManager Thread Pool",
                ThreadPool::KEEP_ALIVE,
            )),
        }
    }

    pub fn runtime_handle(&self) -> tokio::runtime::Handle {
        self.rt.handle().clone()
    }

    pub fn pool_handle(&self) -> Arc<ThreadPool> {
        self.pool.clone()
    }
}

impl Default for TokioTaskManager {
    fn default() -> Self {
        Self::new(Handle::current())
    }
}

impl VirtualTaskManager for TokioTaskManager {
    /// See [`VirtualTaskManager::sleep_now`].
    fn sleep_now(&self, time: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + Sync>> {
        let handle = self.runtime_handle();
        Box::pin(async move {
            SleepNow::default()
                .enter(handle, time)
                .await
                .ok()
                .unwrap_or(())
        })
    }

    /// See [`VirtualTaskManager::task_shared`].
    fn task_shared(
        &self,
        task: Box<dyn FnOnce() -> BoxFuture<'static, ()> + Send + 'static>,
    ) -> Result<(), WasiThreadError> {
        self.rt.handle().spawn(async move {
            let fut = task();
            fut.await
        });
        Ok(())
    }

    /// See [`VirtualTaskManager::task_wasm`].
    fn task_wasm(&self, task: TaskWasm) -> Result<(), WasiThreadError> {
        fn env_and_store(
            task: TaskWasm,
        ) -> Result<(WasiFunctionEnv, wasmer::Store, TaskWasmCallbacks), WasiThreadError> {
            let (make_memory, instance_group_data) = match task.spawn_type {
                SpawnType::CreateMemory => (SpawnMemoryTypeOrStore::New, None),
                SpawnType::NewLinkerInstanceGroup(instance_group_data) => {
                    (SpawnMemoryTypeOrStore::New, Some(instance_group_data))
                }
                SpawnType::CreateMemoryOfType(t) => (SpawnMemoryTypeOrStore::Type(t), None),
                SpawnType::AttachMemory(mem) => {
                    let mut store = task.env.runtime().new_store();
                    let memory = mem.attach(&mut store);
                    (SpawnMemoryTypeOrStore::StoreAndMemory(store, memory), None)
                }
            };

            let (env, store) = WasiFunctionEnv::new_with_store(
                task.module,
                task.env,
                task.globals,
                make_memory,
                task.update_layout,
                task.call_initialize,
                instance_group_data,
            )?;
            Ok((env, store, task.callbacks))
        }

        let (sx, rx) = std::sync::mpsc::channel();

        if task.callbacks.trigger.is_some() {
            tracing::trace!("spawning task_wasm trigger in async pool");
            self.pool.execute(move || {
                let (mut ctx, mut store, callbacks) = match env_and_store(task) {
                    Ok(x) => {
                        sx.send(Ok(())).unwrap();
                        x
                    }
                    Err(c) => {
                        tracing::error!("failed to prepare environment for task_wasm trigger: {c}");
                        sx.send(Err(c)).unwrap();
                        return;
                    }
                };

                let result = {
                    let mut trigger = (callbacks.trigger.unwrap())();
                    let pre_run = callbacks.pre_run;
                    let ctx = &mut ctx;
                    let store = &mut store;
                    block_on(async move {
                        // We wait for either the trigger or for a snapshot to take place
                        let result = loop {
                            let env = ctx.data(store);
                            break tokio::select! {
                                r = &mut trigger => r,
                                _ = env.thread.wait_for_signal() => {
                                    tracing::debug!("wait-for-signal(triggered)");
                                    let mut ctx = ctx.env.clone().into_mut(store);
                                    if let Err(err) =
                                        crate::WasiEnv::do_pending_link_operations(
                                            &mut ctx,
                                            false
                                        ).and_then(|()|
                                            crate::WasiEnv::process_signals_and_exit(&mut ctx)
                                        )
                                    {
                                        match err {
                                            crate::WasiError::Exit(code) => Err(code),
                                            err => {
                                                tracing::error!("failed to process signals - {}", err);
                                                continue;
                                            }
                                        }
                                    } else {
                                        continue;
                                    }
                                }
                                _ = crate::wait_for_snapshot(env) => {
                                    tracing::debug!("wait-for-snapshot(triggered)");
                                    let mut ctx = ctx.env.clone().into_mut(store);
                                    crate::os::task::WasiProcessInner::do_checkpoints_from_outside(&mut ctx);
                                    continue;
                                }
                            };
                        };

                        if let Some(pre_run) = pre_run {
                            pre_run(ctx, store).await;
                        }

                        result
                    })
                };

                // Invoke the callback
                (callbacks.run)(TaskWasmRunProperties {
                    ctx,
                    store,
                    trigger_result: Some(result),
                    recycle: callbacks.recycle,
                });
            });
        } else {
            tracing::trace!("spawning task_wasm in blocking thread");

            // Run the callback on a dedicated thread
            self.pool.execute(move || {
                tracing::trace!("task_wasm started in blocking thread");
                let (mut ctx, mut store, callbacks) = match env_and_store(task) {
                    Ok(x) => {
                        sx.send(Ok(())).unwrap();
                        x
                    }
                    Err(c) => {
                        sx.send(Err(c)).unwrap();
                        return;
                    }
                };

                if let Some(pre_run) = callbacks.pre_run {
                    block_on(pre_run(&mut ctx, &mut store));
                }

                // Invoke the callback
                (callbacks.run)(TaskWasmRunProperties {
                    ctx,
                    store,
                    trigger_result: None,
                    recycle: callbacks.recycle,
                });
            });
        }

        rx.recv()
            .map_err(|_| WasiThreadError::InvalidWasmContext)??;

        Ok(())
    }

    /// See [`VirtualTaskManager::task_dedicated`].
    fn task_dedicated(
        &self,
        task: Box<dyn FnOnce() + Send + 'static>,
    ) -> Result<(), WasiThreadError> {
        self.pool.execute(move || {
            task();
        });
        Ok(())
    }

    /// See [`VirtualTaskManager::thread_parallelism`].
    fn thread_parallelism(&self) -> Result<usize, WasiThreadError> {
        Ok(std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(8))
    }
}

// Used by [`VirtualTaskManager::sleep_now`] to abort a sleep task when drop.
#[derive(Default)]
pub struct SleepNow {
    abort_handle: Option<tokio::task::AbortHandle>,
}

impl SleepNow {
    pub async fn enter(
        &mut self,
        handle: tokio::runtime::Handle,
        time: Duration,
    ) -> Result<(), tokio::task::JoinError> {
        let handle = handle.spawn(async move {
            if time == Duration::ZERO {
                tokio::task::yield_now().await;
            } else {
                tokio::time::sleep(time).await;
            }
        });
        self.abort_handle = Some(handle.abort_handle());
        handle.await
    }
}

impl Drop for SleepNow {
    fn drop(&mut self) {
        if let Some(h) = self.abort_handle.as_ref() {
            h.abort()
        }
    }
}

/// iwci patch (#1063).
#[cfg(test)]
mod pool_tests {
    use super::ThreadPool;
    use std::sync::{Arc, Barrier, mpsc};
    use std::time::{Duration, Instant};

    fn until(what: impl Fn() -> bool) {
        let end = Instant::now() + Duration::from_secs(10);
        while !what() {
            assert!(Instant::now() < end, "timed out");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_task_never_waits_behind_a_busy_thread() {
        // Each task waits for all the others: a queue would hang.
        let pool = ThreadPool::new("t", Duration::from_secs(60));
        let n = 16;
        let barrier = Arc::new(Barrier::new(n));
        let (tx, rx) = mpsc::channel();
        for _ in 0..n {
            let (barrier, tx) = (barrier.clone(), tx.clone());
            pool.execute(move || {
                barrier.wait();
                tx.send(()).unwrap();
            });
        }
        for _ in 0..n {
            rx.recv_timeout(Duration::from_secs(10)).unwrap();
        }
        assert_eq!(pool.threads(), n);
    }

    #[test]
    fn an_idle_thread_is_reused_and_ends_after_its_keep_alive() {
        let pool = ThreadPool::new("t", Duration::from_millis(300));
        let (tx, rx) = mpsc::channel();
        for _ in 0..20 {
            let tx = tx.clone();
            pool.execute(move || tx.send(std::thread::current().id()).unwrap());
            rx.recv_timeout(Duration::from_secs(10)).unwrap();
            until(|| pool.idle_threads() == 1);
        }
        assert_eq!(pool.threads(), 1);
        until(|| pool.threads() == 0);
        assert_eq!(pool.idle_threads(), 0);
        // And the pool still runs tasks afterwards.
        let tx2 = tx.clone();
        pool.execute(move || tx2.send(std::thread::current().id()).unwrap());
        rx.recv_timeout(Duration::from_secs(10)).unwrap();
    }

    #[test]
    fn tasks_handed_to_threads_as_they_time_out_still_run() {
        let pool = ThreadPool::new("t", Duration::from_millis(1));
        let (tx, rx) = mpsc::channel();
        for i in 0..2000 {
            let tx = tx.clone();
            pool.execute(move || tx.send(i).unwrap());
            if i % 7 == 0 {
                std::thread::sleep(Duration::from_millis(1));
            }
        }
        let mut got: Vec<i32> = (0..2000)
            .map(|_| rx.recv_timeout(Duration::from_secs(10)).unwrap())
            .collect();
        got.sort();
        assert_eq!(got, (0..2000).collect::<Vec<_>>());
        until(|| pool.threads() == 0);
    }
}
