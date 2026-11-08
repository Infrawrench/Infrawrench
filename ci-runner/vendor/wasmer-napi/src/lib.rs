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
    EnvRejected, HeapReservation, NapiMemoryAccountant, OverBudget, Pool, RequestedHeap,
    ResourceBudget, ResourceUsage,
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
