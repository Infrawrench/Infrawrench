use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

#[cfg(all(target_arch = "wasm32", feature = "js"))]
use std::sync::atomic::{AtomicU32, Ordering as AtomicOrdering};

#[cfg(all(target_arch = "wasm32", feature = "js"))]
use wasmer::TypedFunction;
use wasmer::{Function, Memory, Table};

use crate::budget::{
    EnvHeapCharge, EnvRejected, HeapReservation, Pool, RequestedHeap, ResourceBudget,
};
use crate::snapi::{
    SnapiEnv, snapi_bridge_unofficial_release_env,
    snapi_bridge_unofficial_set_host_near_heap_limit_callback,
    snapi_bridge_unofficial_set_value_limit,
};

#[cfg(all(target_arch = "wasm32", feature = "js"))]
use crate::{guest::callback::CallbackInvocationCtx, snapi::snapi_bridge_swap_active_callback_ctx};

#[cfg(all(target_arch = "wasm32", feature = "js"))]
pub(crate) struct HostBufferCopy {
    pub(crate) owner_id: u64,
    pub(crate) guest_env: u32,
    pub(crate) handle_id: u32,
    pub(crate) host_reference_id: u32,
    pub(crate) backing_store_token: u64,
    pub(crate) guest_ptr: u32,
    pub(crate) byte_len: usize,
    pub(crate) guest_allocation_recyclable: bool,
    pub(crate) persistent: bool,
    pub(crate) reference_holds: u32,
    pub(crate) needs_flush: bool,
}

#[cfg(all(target_arch = "wasm32", feature = "js"))]
pub(crate) struct HostBufferLease {
    pub(crate) guest_ptr: u32,
    pub(crate) byte_offset: u32,
    pub(crate) byte_len: u32,
    pub(crate) writable: bool,
    pub(crate) host_reference_id: u32,
}

#[cfg(all(target_arch = "wasm32", feature = "js"))]
pub(crate) struct GuestBackingStoreMapping {
    pub(crate) host_addr: u64,
    pub(crate) guest_ptr: u32,
    pub(crate) byte_len: usize,
    pub(crate) covers_full_backing_store: bool,
}

#[cfg(not(all(target_arch = "wasm32", feature = "js")))]
pub(crate) struct NativeBufferLease {
    pub(crate) guest_ptr: u32,
    pub(crate) host_ptr: u64,
    pub(crate) byte_len: usize,
    pub(crate) writable: bool,
    pub(crate) copied: bool,
}

// FunctionEnv is cloned for WASIX workers, while Edge's guest-side native
// globals are shared. Keep JS-backend env IDs unique across those clones.
#[cfg(all(target_arch = "wasm32", feature = "js"))]
static NEXT_NAPI_ENV_ID: AtomicU32 = AtomicU32::new(1);

#[cfg(all(target_arch = "wasm32", feature = "js"))]
fn next_js_napi_env_id() -> u32 {
    loop {
        let id = NEXT_NAPI_ENV_ID.fetch_add(1, AtomicOrdering::Relaxed);
        if id != 0 {
            return id;
        }
    }
}

/// Bookkeeping for one live V8 env's heap charge: the initial ceiling plus a
/// pointer (as `usize`, so [`NapiEnv`] stays `Send`) to the boxed
/// [`EnvHeapCharge`] the near-heap-limit callback grows. `tracker == 0` means
/// the env is unbudgeted (unlimited).
struct EnvHeapChargeHandle {
    ceiling: u64,
    tracker: usize,
}

pub(crate) struct NapiEnv {
    /// The app's shared accountant. V8 env (isolate) heap ceilings and the
    /// `max_envs` isolate count are charged against it; workers share the same
    /// `Arc` so the app-wide budget stays honest across stores.
    pub(crate) budget: Arc<ResourceBudget>,
    /// Per-app cap on live V8 isolates (`None` = unlimited).
    pub(crate) max_envs: Option<usize>,
    env_registry: Arc<std::sync::Mutex<HashSet<usize>>>,
    host_stopped: Arc<AtomicBool>,
    /// Heap charge per live V8 env, keyed by guest env id, so teardown releases
    /// exactly what creation charged plus what the callback later granted.
    env_heap_charges: HashMap<u32, EnvHeapChargeHandle>,
    /// External memory the guest has declared via `napi_adjust_external_memory`,
    /// charged to [`Pool::V8External`]. Tracked so a negative adjustment can
    /// only release what this env actually declared, never more, and so
    /// teardown releases the remainder.
    external_declared: u64,
    /// Depth of nested guest↔host callback crossings on this thread, bounded to
    /// keep guest→host→guest recursion from overflowing the host native stack
    /// (an uncatchable SIGSEGV). See [`NapiEnv::enter_callback`].
    callback_depth: u32,
    pub(crate) memory: Option<Memory>,
    /// Host-side allocator over the guest's linear memory. `None` only before
    /// `NapiSession::configure_instance` runs; that call fails instantiation
    /// outright if a `GuestHeap` can't be built, so any env reachable from
    /// guest code is guaranteed to have one — it is the only allocation path
    /// for guest-visible V8 memory, never a best-effort fallback.
    #[cfg(not(all(target_arch = "wasm32", feature = "js")))]
    pub(crate) guest_heap: Option<Arc<crate::guest_heap::GuestHeap>>,
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    pub(crate) malloc_fn: Option<TypedFunction<i32, i32>>,
    pub(crate) table: Option<Table>,
    /// Cache of resolved guest callback functions, keyed by their
    /// `__indirect_function_table` index. `Function::from_vm_funcref` (invoked
    /// by `Table::get`) unconditionally appends a new entry to the store's
    /// function arena on every call with no dedup, so re-resolving the same
    /// `wasm_fn_ptr` on every guest→host→guest callback invocation leaks
    /// memory unboundedly. `Function` clones are cheap (a store handle), so
    /// caching by table index and cloning on repeat hits avoids the
    /// unconditional store growth. See `guest::callback::call_guest_callback`.
    pub(crate) func_cache: HashMap<u32, Function>,
    pub(crate) default_napi_env_id: Option<u32>,
    pub(crate) next_napi_env_id: u32,
    pub(crate) next_napi_scope_id: u32,
    pub(crate) napi_envs: HashMap<u32, usize>,
    pub(crate) napi_state_to_guest_env: HashMap<usize, u32>,
    pub(crate) napi_scopes: HashMap<u32, u32>,
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    pub(crate) guest_buffer_pool: Vec<(u32, usize)>,
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    pub(crate) guest_buffer_capacities: HashMap<u32, usize>,
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    pub(crate) guest_buffer_allocated_bytes: usize,
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    pub(crate) guest_data_ptrs: HashMap<(u32, u32), u32>,
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    pub(crate) guest_data_backing_stores: HashMap<(u32, u64), GuestBackingStoreMapping>,
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    pub(crate) host_buffer_copies: Vec<HostBufferCopy>,
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    pub(crate) host_buffer_copy_frames: Vec<u64>,
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    pub(crate) next_host_buffer_owner_id: u64,
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    pub(crate) host_buffer_handle_scopes: Vec<(u32, u32, u64)>,
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    pub(crate) host_buffer_reference_holds: HashMap<(u32, u32), u32>,
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    pub(crate) next_buffer_lease_id: u32,
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    pub(crate) host_buffer_leases: HashMap<(u32, u32), HostBufferLease>,
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    pub(crate) persistent_callback_contexts: HashMap<u32, Box<CallbackInvocationCtx>>,
    #[cfg(not(all(target_arch = "wasm32", feature = "js")))]
    pub(crate) native_buffer_leases: HashMap<(u32, u32), NativeBufferLease>,
}

impl NapiEnv {
    pub(crate) fn new(
        budget: Arc<ResourceBudget>,
        max_envs: Option<usize>,
        env_registry: Arc<std::sync::Mutex<HashSet<usize>>>,
        host_stopped: Arc<AtomicBool>,
    ) -> Self {
        Self {
            budget,
            max_envs,
            env_registry,
            host_stopped,
            env_heap_charges: HashMap::new(),
            external_declared: 0,
            callback_depth: 0,
            memory: None,
            #[cfg(not(all(target_arch = "wasm32", feature = "js")))]
            guest_heap: None,
            #[cfg(all(target_arch = "wasm32", feature = "js"))]
            malloc_fn: None,
            table: None,
            func_cache: HashMap::new(),
            default_napi_env_id: None,
            next_napi_env_id: 0,
            next_napi_scope_id: 0,
            napi_envs: HashMap::new(),
            napi_state_to_guest_env: HashMap::new(),
            napi_scopes: HashMap::new(),
            #[cfg(all(target_arch = "wasm32", feature = "js"))]
            guest_buffer_pool: Vec::new(),
            #[cfg(all(target_arch = "wasm32", feature = "js"))]
            guest_buffer_capacities: HashMap::new(),
            #[cfg(all(target_arch = "wasm32", feature = "js"))]
            guest_buffer_allocated_bytes: 0,
            #[cfg(all(target_arch = "wasm32", feature = "js"))]
            guest_data_ptrs: HashMap::new(),
            #[cfg(all(target_arch = "wasm32", feature = "js"))]
            guest_data_backing_stores: HashMap::new(),
            #[cfg(all(target_arch = "wasm32", feature = "js"))]
            host_buffer_copies: Vec::new(),
            #[cfg(all(target_arch = "wasm32", feature = "js"))]
            host_buffer_copy_frames: Vec::new(),
            #[cfg(all(target_arch = "wasm32", feature = "js"))]
            next_host_buffer_owner_id: 1,
            #[cfg(all(target_arch = "wasm32", feature = "js"))]
            host_buffer_handle_scopes: Vec::new(),
            #[cfg(all(target_arch = "wasm32", feature = "js"))]
            host_buffer_reference_holds: HashMap::new(),
            #[cfg(all(target_arch = "wasm32", feature = "js"))]
            next_buffer_lease_id: 1,
            #[cfg(all(target_arch = "wasm32", feature = "js"))]
            host_buffer_leases: HashMap::new(),
            #[cfg(all(target_arch = "wasm32", feature = "js"))]
            persistent_callback_contexts: HashMap::new(),
            #[cfg(not(all(target_arch = "wasm32", feature = "js")))]
            native_buffer_leases: HashMap::new(),
        }
    }

    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    pub(crate) fn next_host_buffer_owner(&mut self) -> u64 {
        loop {
            let id = self.next_host_buffer_owner_id.max(1);
            self.next_host_buffer_owner_id = id.wrapping_add(1).max(1);
            if !self.host_buffer_copy_frames.contains(&id)
                && !self
                    .host_buffer_handle_scopes
                    .iter()
                    .any(|(_, _, owner_id)| *owner_id == id)
            {
                return id;
            }
        }
    }

    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    pub(crate) fn current_host_buffer_owner(&self) -> u64 {
        self.host_buffer_handle_scopes
            .last()
            .map(|(_, _, owner_id)| *owner_id)
            .or_else(|| self.host_buffer_copy_frames.last().copied())
            .unwrap_or(0)
    }

    /// Reserve budget for a new V8 env before creating it: acquire an isolate
    /// slot against `max_envs` and charge its (clamped) heap ceiling. The
    /// returned constraints must be forwarded to V8. Follow with exactly one of
    /// [`commit_isolate`] (on success) or [`abort_isolate`] (on failure).
    ///
    /// [`commit_isolate`]: NapiEnv::commit_isolate
    /// [`abort_isolate`]: NapiEnv::abort_isolate
    pub(crate) fn reserve_isolate(
        &self,
        requested: RequestedHeap,
    ) -> Result<HeapReservation, EnvRejected> {
        self.budget.try_reserve_env(requested, self.max_envs)
    }

    /// Register a successfully-created env, attach its heap charge, and — under
    /// a limited budget — install the host-owned near-heap-limit callback so V8
    /// heap growth for this isolate is charged against the budget. Teardown
    /// releases both the initial ceiling and any granted growth.
    pub(crate) fn commit_isolate(
        &mut self,
        env: SnapiEnv,
        reservation: &HeapReservation,
    ) -> (u32, u32) {
        let (env_id, scope_id) = self.register_napi_env(env);
        {
            let mut registry = self
                .env_registry
                .lock()
                .expect("poisoned N-API env registry");
            registry.insert(env as usize);

            // If the host already stopped this app's JS, an isolate created
            // afterwards must not start running either. Checking under the
            // registry lock closes the race against a concurrent
            // `NapiRuntimeControl::terminate_all`, which sets the flag before
            // taking this lock: either it sees this env in the registry, or
            // we see its flag here.
            if self.host_stopped.load(Ordering::Acquire) {
                // SAFETY: `env` is the isolate just created and is still live.
                unsafe {
                    crate::snapi::snapi_bridge_host_terminate_execution(env);
                }
            }
        }

        let tracker = if reservation.clamped {
            let boxed = Box::into_raw(Box::new(EnvHeapCharge {
                budget: Arc::clone(&self.budget),
                env: env as usize,
                host_stopped: Arc::clone(&self.host_stopped),
                unwind_slack_available: std::sync::atomic::AtomicBool::new(true),
                granted: AtomicU64::new(0),
            }));
            // SAFETY: `env` is the isolate just created; `boxed` outlives the
            // callback (freed only at this env's teardown, below).
            unsafe {
                snapi_bridge_unofficial_set_host_near_heap_limit_callback(
                    env,
                    boxed as *const c_void,
                );
            }

            // Cap per-value host handles / callback registrations so the C++
            // bookkeeping (invisible to the byte pools) cannot grow host RSS
            // without bound; derived from the budget.
            if let Some(limit) = self.budget.value_handle_limit() {
                // SAFETY: `env` is the isolate just created.
                unsafe {
                    snapi_bridge_unofficial_set_value_limit(env, limit);
                }
            }

            boxed as usize
        } else {
            0
        };

        self.env_heap_charges.insert(
            env_id,
            EnvHeapChargeHandle {
                ceiling: reservation.ceiling_bytes,
                tracker,
            },
        );
        (env_id, scope_id)
    }

    /// Release a reservation whose env creation failed after [`reserve_isolate`].
    ///
    /// [`reserve_isolate`]: NapiEnv::reserve_isolate
    pub(crate) fn abort_isolate(&self, reservation: &HeapReservation) {
        self.budget.release_env(reservation.ceiling_bytes);
    }

    /// Charge a positive `napi_adjust_external_memory` delta against the budget.
    /// Returns `false` (guest sees a failure) when it would exceed the budget.
    pub(crate) fn charge_declared_external(&mut self, bytes: u64) -> bool {
        if self.budget.try_charge(Pool::V8External, bytes).is_err() {
            return false;
        }
        self.external_declared = self.external_declared.saturating_add(bytes);
        true
    }

    /// Release a negative `napi_adjust_external_memory` delta, clamped to what
    /// this env actually declared so it can never underflow the pool or release
    /// the allocator's charges.
    pub(crate) fn uncharge_declared_external(&mut self, bytes: u64) {
        let release = bytes.min(self.external_declared);
        self.external_declared -= release;
        self.budget.uncharge(Pool::V8External, release);
    }

    pub(crate) fn host_stopped(&self) -> bool {
        self.host_stopped.load(Ordering::Acquire)
    }

    /// Claim one level of guest↔host callback reentrancy. Returns `false` (the
    /// callback must be refused) once [`MAX_CALLBACK_DEPTH`] is reached, so a
    /// runaway recursion across the FFI boundary cannot overflow the host native
    /// stack. Pair every `true` with exactly one [`leave_callback`].
    ///
    /// [`MAX_CALLBACK_DEPTH`]: crate::guest::MAX_CALLBACK_DEPTH
    /// [`leave_callback`]: NapiEnv::leave_callback
    pub(crate) fn enter_callback(&mut self) -> bool {
        if self.callback_depth >= crate::guest::MAX_CALLBACK_DEPTH {
            return false;
        }
        self.callback_depth += 1;
        true
    }

    /// Release one level claimed by a `true` [`enter_callback`].
    ///
    /// [`enter_callback`]: NapiEnv::enter_callback
    pub(crate) fn leave_callback(&mut self) {
        self.callback_depth = self.callback_depth.saturating_sub(1);
    }

    pub(crate) fn register_napi_env(&mut self, env: SnapiEnv) -> (u32, u32) {
        #[cfg(not(all(target_arch = "wasm32", feature = "js")))]
        let env_id = {
            let env_id = self.next_napi_env_id.max(1);
            self.next_napi_env_id = env_id.saturating_add(1);
            env_id
        };
        #[cfg(all(target_arch = "wasm32", feature = "js"))]
        let env_id = next_js_napi_env_id();

        let scope_id = self.next_napi_scope_id.max(1);
        self.next_napi_scope_id = scope_id.saturating_add(1);

        self.napi_envs.insert(env_id, env as usize);
        self.napi_state_to_guest_env.insert(env as usize, env_id);
        self.napi_scopes.insert(scope_id, env_id);
        (env_id, scope_id)
    }

    fn discard_buffer_leases_for_env(&mut self, env_id: u32) {
        #[cfg(all(target_arch = "wasm32", feature = "js"))]
        {
            let lease_ids: Vec<(u32, u32)> = self
                .host_buffer_leases
                .keys()
                .filter(|(lease_env_id, _)| *lease_env_id == env_id)
                .copied()
                .collect();
            for lease_id in lease_ids {
                let Some(lease) = self.host_buffer_leases.remove(&lease_id) else {
                    continue;
                };
                if lease.guest_ptr != 0
                    && let Some(capacity) = self.guest_buffer_capacities.remove(&lease.guest_ptr)
                {
                    self.guest_buffer_pool.push((lease.guest_ptr, capacity));
                }
            }
        }

        #[cfg(not(all(target_arch = "wasm32", feature = "js")))]
        {
            let lease_ids: Vec<(u32, u32)> = self
                .native_buffer_leases
                .keys()
                .filter(|(lease_env_id, _)| *lease_env_id == env_id)
                .copied()
                .collect();
            for lease_id in lease_ids {
                let Some(lease) = self.native_buffer_leases.remove(&lease_id) else {
                    continue;
                };
                if lease.copied
                    && let Some(heap) = self.guest_heap.as_ref()
                {
                    heap.free_offset(lease.guest_ptr);
                }
            }
        }
    }

    pub(crate) fn begin_unregister_napi_scope(&mut self, scope_id: u32) -> Option<(u32, SnapiEnv)> {
        let env_id = self.napi_scopes.remove(&scope_id)?;
        if self.default_napi_env_id == Some(env_id) {
            self.default_napi_env_id = None;
        }
        let env = *self.napi_envs.get(&env_id)?;
        // Remove from the shared registry before any env- or isolate-owned
        // state is reclaimed. This synchronizes against terminate_all, which
        // holds the same mutex while calling into V8.
        self.env_registry
            .lock()
            .expect("poisoned N-API env registry")
            .remove(&env);

        // Leases are environment-owned resources. Explicit release publishes
        // writes; environment teardown only discards snapshots and returns any
        // guest allocations because the JavaScript value is being destroyed.
        self.discard_buffer_leases_for_env(env_id);
        Some((env_id, env as SnapiEnv))
    }

    pub(crate) fn finish_unregister_napi_env(&mut self, env_id: u32, env: SnapiEnv) {
        // Release the heap ceiling + any callback-granted growth + isolate slot
        // this env reserved.
        if let Some(handle) = self.env_heap_charges.remove(&env_id) {
            let granted = if handle.tracker != 0 {
                // SAFETY: reclaim the box created in `commit_isolate`. The
                // near-heap-limit callback holding this pointer only runs during
                // JS execution, and no JS runs between here and the paired env
                // release that removes the callback and disposes the isolate, so
                // freeing it now is safe.
                let boxed = unsafe { Box::from_raw(handle.tracker as *mut EnvHeapCharge) };
                boxed.granted.load(Ordering::Acquire)
            } else {
                0
            };
            self.budget.uncharge(Pool::V8HeapReserved, granted);
            self.budget.release_env(handle.ceiling);
        }
        self.napi_envs.remove(&env_id);
        #[cfg(all(target_arch = "wasm32", feature = "js"))]
        unsafe {
            snapi_bridge_swap_active_callback_ctx(env, std::ptr::null_mut());
            self.persistent_callback_contexts.remove(&env_id);
        }
        self.napi_state_to_guest_env.remove(&(env as usize));
    }

    pub(crate) fn unregister_napi_scope(&mut self, scope_id: u32) -> Option<SnapiEnv> {
        let (env_id, env) = self.begin_unregister_napi_scope(scope_id)?;
        self.finish_unregister_napi_env(env_id, env);
        Some(env)
    }

    pub(crate) fn resolve_napi_env(&self, guest_env: i32) -> SnapiEnv {
        let env_id = if guest_env > 0 {
            guest_env as u32
        } else {
            return std::ptr::null_mut();
        };
        self.napi_envs
            .get(&env_id)
            .map(|env| *env as SnapiEnv)
            .unwrap_or(std::ptr::null_mut())
    }
}

impl Drop for NapiEnv {
    fn drop(&mut self) {
        let scope_ids: Vec<u32> = self.napi_scopes.keys().copied().collect();
        for scope_id in scope_ids {
            if let Some(env) = self.unregister_napi_scope(scope_id) {
                unsafe {
                    let _ = snapi_bridge_unofficial_release_env(env);
                }
            }
        }
        // Release any external memory the guest declared but did not take back.
        if self.external_declared > 0 {
            self.budget
                .uncharge(Pool::V8External, self.external_declared);
            self.external_declared = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIB: u64 = 1024 * 1024;

    #[test]
    fn declared_external_charges_denies_and_clamps() {
        let budget = ResourceBudget::with_memory_limit(10 * MIB);
        let mut env = NapiEnv::new(
            Arc::clone(&budget),
            None,
            Arc::new(std::sync::Mutex::new(HashSet::new())),
            Arc::new(AtomicBool::new(false)),
        );

        assert!(env.charge_declared_external(6 * MIB));
        assert_eq!(budget.snapshot().v8_external, 6 * MIB);

        // Over budget: denied, nothing charged.
        assert!(!env.charge_declared_external(6 * MIB));
        assert_eq!(budget.snapshot().v8_external, 6 * MIB);

        // A negative delta larger than declared is clamped to what was declared,
        // so it can never underflow the pool.
        env.uncharge_declared_external(100 * MIB);
        assert_eq!(budget.snapshot().v8_external, 0);
        assert_eq!(env.external_declared, 0);

        // Further release is a no-op.
        env.uncharge_declared_external(MIB);
        assert_eq!(budget.snapshot().v8_external, 0);
    }

    #[test]
    fn declared_external_released_on_drop() {
        let budget = ResourceBudget::with_memory_limit(10 * MIB);
        {
            let mut env = NapiEnv::new(
                Arc::clone(&budget),
                None,
                Arc::new(std::sync::Mutex::new(HashSet::new())),
                Arc::new(AtomicBool::new(false)),
            );
            assert!(env.charge_declared_external(4 * MIB));
            assert_eq!(budget.snapshot().v8_external, 4 * MIB);
        }
        assert_eq!(
            budget.snapshot().v8_external,
            0,
            "drop releases declared external"
        );
    }

    #[test]
    fn callback_reentrancy_is_bounded() {
        let mut env = NapiEnv::new(
            ResourceBudget::unlimited(),
            None,
            Arc::new(std::sync::Mutex::new(HashSet::new())),
            Arc::new(AtomicBool::new(false)),
        );
        let max = crate::guest::MAX_CALLBACK_DEPTH;

        // Reentrancy is allowed up to the limit, then refused.
        for _ in 0..max {
            assert!(env.enter_callback());
        }
        assert!(
            !env.enter_callback(),
            "past the limit the callback is refused"
        );

        // Unwinding one level frees exactly one slot.
        env.leave_callback();
        assert!(env.enter_callback());

        // Fully unwind; an extra leave saturates instead of underflowing.
        for _ in 0..max {
            env.leave_callback();
        }
        env.leave_callback();
        assert!(env.enter_callback());
    }
}
