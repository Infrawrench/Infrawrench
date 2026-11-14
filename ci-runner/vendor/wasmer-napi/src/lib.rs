pub mod budget;
#[cfg(feature = "cli")]
pub mod cli;
mod ctx;
mod env;
mod guest;
#[cfg(not(all(target_arch = "wasm32", feature = "js")))]
mod guest_heap;
mod snapi;
#[cfg(all(target_arch = "wasm32", feature = "js"))]
mod snapi_js;
#[cfg(feature = "wasix")]
mod wasix;
use std::fmt::Display;

pub const NAPI_MODULE_NAME: &str = "napi";
pub const NAPI_EXTENSION_WASMER_MODULE_PREFIX: &str = "napi_extension_wasmer_v";
pub const NAPI_EXTENSION_WASMER_MODULE_NAME: &str = "napi_extension_wasmer_v0";

#[cfg(not(target_arch = "wasm32"))]
pub use budget::{BudgetedMemory, BudgetedTunables, budgeted_tunables};
pub use budget::{
    EnvRejected, HeapReservation, IsolateRole, MemoryExhaustion, NapiMemoryAccountant,
    OverBudget, Pool, RequestedHeap, ResourceBudget, ResourceUsage,
};
// iwci patch (#1063): the V8 heap space every isolate of the process shares.
pub use budget::{
    HeapSpaceUsage, HeapSpaceWaitHook, V8_HEAP_CAGE, heap_space, set_heap_space,
    set_heap_space_wait_hook,
};
pub use ctx::{
    NapiCtx, NapiCtxBuilder, NapiInstantiationState, NapiLimits, NapiRuntimeControl,
    NapiRuntimeHooks, NapiSession,
};
use enum_iterator::Sequence;
pub(crate) use env::NapiEnv;
#[cfg(all(target_arch = "wasm32", feature = "js"))]
pub(crate) use env::{GuestBackingStoreMapping, HostBufferCopy};

/// Host capabilities required by the JavaScript-backed N-API implementation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostJsCapabilities {
    /// Whether the JavaScript engine exposes the JS Promise Integration API.
    pub jspi: bool,
}

/// Reports capabilities of the JavaScript host backend.
///
/// Returns `None` when the crate is not compiled for wasm32 with the `js`
/// feature. Promise-aware EdgeJS entry points must require `jspi == true`.
pub fn host_js_capabilities() -> Option<HostJsCapabilities> {
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    {
        return Some(HostJsCapabilities {
            jspi: snapi_js::has_jspi(),
        });
    }
    #[cfg(not(all(target_arch = "wasm32", feature = "js")))]
    {
        None
    }
}

/// Sets how many background worker threads V8 gets, process-wide.
///
/// V8 sizes this pool from the host's processor count, which suits a process
/// running one JS app. A host running many gets a pool whose threads compete
/// with every tenant's foreground JS, and whose work is attributed to no one:
/// GC marking and sweeping, parallel scavenging, and background compilation
/// all land there.
///
/// Passing `None` keeps V8's default. Lowering it doesn't strand work — V8's
/// parallel jobs are cooperative and the posting thread participates, so the
/// work migrates onto whichever thread asked for it.
///
/// The pool is built with the process-wide platform, when the first V8 isolate
/// is created, so this must be called before then. Afterwards, asking for the
/// size already in place still succeeds — several components may configure the
/// runtime from one setting — and asking for a different one returns
/// [`WorkerThreadsAlreadyFixed`].
pub fn set_v8_worker_threads(count: Option<u32>) -> Result<(), WorkerThreadsAlreadyFixed> {
    // Safety: plain integer in, no pointers; the callee only stores it.
    let applied = unsafe { snapi::snapi_bridge_set_v8_worker_thread_count(count.unwrap_or(0)) };
    if applied == 0 {
        return Err(WorkerThreadsAlreadyFixed);
    }
    Ok(())
}

/// iwci patch: configures the process's V8 from the embedder, with the
/// bridge's defaults and then `engine_flags` (V8's command-line syntax).
///
/// Call it once, after [`set_v8_worker_threads`] and
/// [`set_worker_task_hooks`] and before any guest runs. A guest's own
/// request (`unofficial_napi_configure_runtime`, which Edge.js makes at
/// every start) gets this runtime and never applies flags of its own.
/// Calling it again with the same flags succeeds; with others, or after a
/// guest started a runtime with the defaults alone, it returns
/// [`V8RuntimeError::AlreadyConfigured`].
pub fn configure_v8_runtime(engine_flags: &str) -> Result<(), V8RuntimeError> {
    let length = u32::try_from(engine_flags.len()).map_err(|_| V8RuntimeError::Failed)?;
    // Safety: the callee reads `length` bytes from the pointer during the
    // call and copies what it keeps.
    let status = unsafe {
        snapi::snapi_bridge_host_configure_runtime(engine_flags.as_ptr().cast(), length)
    };
    match status {
        0 => Ok(()),
        // napi_invalid_arg
        1 => Err(V8RuntimeError::AlreadyConfigured),
        _ => Err(V8RuntimeError::Failed),
    }
}

/// See [`configure_v8_runtime`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum V8RuntimeError {
    /// The runtime already exists with other engine flags.
    AlreadyConfigured,
    /// V8's platform could not be made.
    Failed,
}

impl Display for V8RuntimeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::AlreadyConfigured => "the V8 runtime is already configured with other flags",
            Self::Failed => "the V8 runtime could not be configured",
        })
    }
}

impl std::error::Error for V8RuntimeError {}

/// iwci patch (#938): how an embedder learns whose work a V8 worker task is.
///
/// V8's background tasks (garbage collection, compilation) run on one
/// process-wide pool. `capture` is called on the thread that posts a task and
/// returns a token naming whoever that thread works for, or null for no one;
/// `enter` and `exit` are called on the pool thread around the task with
/// that token, and a task posted between them is captured on that thread in
/// turn; `release` is called once when the task is destroyed, whether or not
/// it ran.
#[derive(Debug, Clone, Copy)]
pub struct WorkerTaskHooks {
    pub capture: unsafe extern "C" fn() -> *mut core::ffi::c_void,
    pub enter: unsafe extern "C" fn(*mut core::ffi::c_void),
    pub exit: unsafe extern "C" fn(*mut core::ffi::c_void),
    pub release: unsafe extern "C" fn(*mut core::ffi::c_void),
}

/// Installs `hooks` for every V8 worker task posted from now on,
/// process-wide. Call it before the first isolate is created.
pub fn set_worker_task_hooks(hooks: WorkerTaskHooks) {
    // Safety: the callee only stores the four function pointers.
    unsafe {
        snapi::snapi_bridge_set_worker_task_hooks(
            hooks.capture,
            hooks.enter,
            hooks.exit,
            hooks.release,
        )
    };
}

/// iwci patch (#990): what confining V8's fatal out-of-memory to one isolate
/// (#972) has cost this process since it started. Each confinement parks the
/// thread that ran out for good and abandons its isolate, never disposed;
/// none of it comes back until the process ends.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct OutOfMemoryLosses {
    /// Isolates abandoned, with their heaps.
    pub lost_isolates: u64,
    /// Threads parked for good: an app's own, or a V8 worker thread.
    pub parked_threads: u64,
    /// Of those, V8 worker threads: the shared pool (sized by
    /// [`set_v8_worker_threads`]) is one thread short for each.
    pub parked_worker_threads: u64,
}

/// See [`OutOfMemoryLosses`].
pub fn out_of_memory_losses() -> OutOfMemoryLosses {
    let mut losses = OutOfMemoryLosses::default();
    // Safety: the callee writes three u64s under its own lock.
    unsafe {
        snapi::snapi_bridge_out_of_memory_losses(
            &mut losses.lost_isolates,
            &mut losses.parked_threads,
            &mut losses.parked_worker_threads,
        )
    };
    losses
}

/// The V8 platform already exists, so its worker pool can no longer be resized.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerThreadsAlreadyFixed;

impl Display for WorkerThreadsAlreadyFixed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(
            "the V8 worker thread count must be set before the first isolate is created, and \
             the V8 platform already exists",
        )
    }
}

impl std::error::Error for WorkerThreadsAlreadyFixed {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Sequence)]
pub enum NapiVersion {
    V10,
    Unknown,
}

impl Display for NapiVersion {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            NapiVersion::Unknown => write!(f, "napi_unknown"),
            NapiVersion::V10 => write!(f, "napi_v10"),
        }
    }
}

impl NapiVersion {
    pub const fn is_compatible_with(self, other: Self) -> bool {
        matches!(
            (self, other),
            (Self::V10, Self::V10) | (Self::Unknown, Self::V10)
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NapiWasmerExtensionVersion {
    V0,
    Unknown,
}

impl NapiWasmerExtensionVersion {
    pub const fn is_compatible_with(self, other: Self) -> bool {
        matches!((self, other), (Self::V0, Self::V0))
    }
}

pub fn module_needs_napi(
    module: &wasmer::Module,
) -> (Option<NapiVersion>, Option<NapiWasmerExtensionVersion>) {
    NapiCtx::module_needs_napi(module)
}
