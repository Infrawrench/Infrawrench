//! Cross-VM resource accounting for the N-API (`imports`) provider.
//!
//! An edgejs guest running under the `imports` provider splits execution and
//! allocation across two VMs: the wasmer store (guest wasm linear memory) and
//! host-native V8. To keep an embedder-imposed memory budget honest across
//! *both*, every pool charges against one shared [`ResourceBudget`] per app.
//!
//! This module implements **Phase 1** of that design: the accountant itself
//! plus exact, deterministic charging of **guest wasm linear memory**. Later
//! phases charge the V8 heap, external memory, and host transients against the
//! same budget, and add CPU metering; the [`Pool`] enum and the budget API are
//! the insertion points for them.
//!
//! ## Native sys install path
//!
//! The guest's linear memory is *imported* (host-created). wasmer's public API
//! does not let an embedder inject a custom [`LinearMemory`] into a
//! [`wasmer::Memory`] directly (the backend `VMMemory` enum is private), so the
//! charge is installed one level down, via custom [`Tunables`]: a
//! [`BudgetedTunables`] wraps [`BaseTunables`] and returns every host memory
//! wrapped in a [`BudgetedMemory`]. Installing those tunables on the engine
//! (see `cli.rs`) makes `Memory::new` — and therefore the guest's imported
//! memory — budget-aware with no change to the memory-creation call site.
//!
//! This tunables path exists only for Wasmer's native `sys` backend. A
//! `wasm32` host-JavaScript build uses the host's WebAssembly memory and does
//! not compile or install [`BudgetedTunables`]. It still uses
//! [`ResourceBudget`] for provider-owned resources such as environments,
//! value handles, and declared external memory.

use std::ffi::c_void;
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
};
#[cfg(not(target_arch = "wasm32"))]
use std::time::Duration;

#[cfg(not(target_arch = "wasm32"))]
use wasmer::sys::vm::{
    ExpectedValue, LinearMemory, MemoryError, ThreadConditions, VMMemory, VMMemoryDefinition,
    VMSharedMemory, VMTable, VMTableDefinition, WaiterError,
};
#[cfg(not(target_arch = "wasm32"))]
use wasmer::sys::{BaseTunables, Tunables};
#[cfg(not(target_arch = "wasm32"))]
use wasmer::{MemoryStyle, MemoryType, Pages, TableStyle, TableType, WASM_PAGE_SIZE};

/// Sentinel meaning "no memory limit". A budget built with this total tracks
/// charges for observability but never denies one.
const UNLIMITED: u64 = u64::MAX;

const MIB: u64 = 1024 * 1024;

/// Initial `max_old_generation_size` charged per V8 isolate at env creation.
pub const DEFAULT_INITIAL_ISOLATE_HEAP: u64 = 64 * MIB;
/// Increment the near-heap-limit callback reserves per grow grant.
pub const DEFAULT_HEAP_GROW_STEP: u64 = 32 * MIB;
/// One-time V8 heap slack reserved up front so a denied growth callback can
/// terminate and unwind without entering V8s fatal out-of-memory path.
pub const DEFAULT_UNWIND_SLACK: u64 = 16 * MIB;
/// Fixed per-isolate overhead charged to cover young generation, code range,
/// and V8's own malloc'd metadata without sampling.
pub const DEFAULT_PER_ISOLATE_OVERHEAD: u64 = 8 * MIB;

/// Estimated host-side bytes held per N-API value handle crossed to the guest:
/// the `napi_ref` struct, the handle-map node, and a V8 global-handle slot. The
/// referenced JS value itself lives in the (separately charged) V8 heap. Used
/// only to derive a per-env cap on live handles — see
/// [`ResourceBudget::value_handle_limit`].
pub const EST_HOST_BYTES_PER_VALUE: u64 = 128;

#[cfg(not(target_arch = "wasm32"))]
fn pages_to_bytes(pages: Pages) -> u64 {
    u64::from(pages.0) * WASM_PAGE_SIZE as u64
}

/// Round `bytes` up to a whole number of wasm pages, saturating.
#[cfg(not(target_arch = "wasm32"))]
fn round_up_to_page(bytes: u64) -> u64 {
    let page = WASM_PAGE_SIZE as u64;
    bytes.div_ceil(page).saturating_mul(page)
}

/// A distinct byte pool metered against the budget.
///
/// Later phases add external-memory and host-transient pools.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Pool {
    /// Guest wasm linear memory (wasmer `WasmMmap`).
    WasmLinear,
    /// V8 per-isolate heap *ceiling* (old + young + code range + per-isolate
    /// overhead + pre-reserved unwind slack), charged by reservation at env
    /// creation and raised in grow-steps by the near-heap-limit callback. Charged by ceiling, not
    /// live usage, so the guarantee never races V8's GC.
    V8HeapReserved,
    /// V8 external memory the guest has explicitly declared via
    /// `napi_adjust_external_memory` (`NapiEnv::charge_declared_external`).
    /// ArrayBuffer/Buffer backing stores are NOT charged here: GuestHeap is
    /// the only allocation path for them and they're charged as
    /// [`Pool::WasmLinear`] instead — see [`crate::guest_heap::GuestHeap`].
    V8External,
}

/// Embedder-owned aggregate accounting for byte reservations made by N-API.
///
/// N-API retains its own per-pool counters; the embedder sees only byte totals,
/// keeping pool policy and future N-API implementation details out of Edge.
pub trait NapiMemoryAccountant: Send + Sync {
    fn memory_limit(&self) -> u64;
    fn memory_charged(&self) -> u64;
    fn try_charge(&self, bytes: u64) -> bool;
    fn uncharge(&self, bytes: u64);
}

/// Error returned by [`ResourceBudget::try_charge`] when a charge would push
/// total live bytes past the app's memory budget.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OverBudget {
    /// Pool the rejected charge targeted.
    pub pool: Pool,
    /// Bytes the caller tried to charge.
    pub requested: u64,
    /// Bytes already charged when the request was rejected.
    pub charged: u64,
    /// The app's total memory budget.
    pub total: u64,
}

impl std::fmt::Display for OverBudget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "resource budget exceeded charging {} bytes to {:?}: {} of {} bytes already charged",
            self.requested, self.pool, self.charged, self.total
        )
    }
}

impl std::error::Error for OverBudget {}

/// A point-in-time view of a budget's charges, for metrics / billing.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResourceUsage {
    /// The app's total memory budget (`u64::MAX` if unlimited).
    pub mem_total: u64,
    /// Aggregate bytes currently charged. With an embedder accountant this also
    /// includes non-N-API memory sharing the same application budget.
    pub mem_charged: u64,
    /// Currently-charged guest wasm linear memory bytes.
    pub wasm_linear: u64,
    /// Currently-reserved V8 per-isolate heap ceiling bytes.
    pub v8_heap_reserved: u64,
    /// Currently-charged V8 external memory (ArrayBuffer/Buffer) bytes.
    pub v8_external: u64,
    /// Number of live V8 isolates (envs) counted against `max_envs`.
    pub live_isolates: usize,
}

/// The (possibly clamped) heap constraints a guest requested for a new V8 env.
/// Fields are bytes; `0` means "unset" (V8 picks its default).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RequestedHeap {
    pub max_young: u32,
    pub max_old: u32,
    pub code_range: u32,
}

/// The outcome of reserving budget for a new V8 env: the constraints to forward
/// to V8 (clamped to fit the budget) and the ceiling charged for them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HeapReservation {
    pub max_young: u32,
    pub max_old: u32,
    pub code_range: u32,
    /// Bytes charged to [`Pool::V8HeapReserved`]; `0` under an unlimited budget.
    pub ceiling_bytes: u64,
    /// Whether budget clamping was applied (i.e. constraints must be forwarded
    /// to V8 even if the guest requested none).
    pub clamped: bool,
}

/// Why a new V8 env was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvRejected {
    /// The app is already at its `max_envs` isolate cap.
    TooManyEnvs,
    /// The minimum viable heap ceiling does not fit the remaining budget.
    HeapDoesNotFit,
}

/// One shared accountant per app, `Arc`-shared into every pool that allocates.
///
/// Charging is **reserve-based**: bytes are charged before (or exactly at) the
/// moment they become live, so `actual usage <= mem_charged <= mem_total`
/// always holds and enforcement never races a garbage collector. All state is
/// atomic, so worker threads (each its own store + isolate) share one budget.
pub struct ResourceBudget {
    /// Total byte budget. `UNLIMITED` disables enforcement (tracking only).
    mem_total: u64,
    /// Sum of all currently-charged bytes across every pool.
    mem_charged: AtomicU64,
    accountant: Option<Arc<dyn NapiMemoryAccountant>>,
    /// Per-pool charge, for observability and reconciliation.
    wasm_linear: AtomicU64,
    v8_heap_reserved: AtomicU64,
    v8_external: AtomicU64,
    /// Live V8 isolates (envs), counted against `max_envs`.
    live_isolates: AtomicUsize,
}

impl std::fmt::Debug for ResourceBudget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResourceBudget")
            .field("mem_total", &self.memory_limit())
            .field("mem_charged", &self.memory_charged())
            .field("wasm_linear", &self.wasm_linear.load(Ordering::Acquire))
            .field(
                "v8_heap_reserved",
                &self.v8_heap_reserved.load(Ordering::Acquire),
            )
            .field("v8_external", &self.v8_external.load(Ordering::Acquire))
            .field("live_isolates", &self.live_isolates.load(Ordering::Acquire))
            .finish()
    }
}

impl ResourceBudget {
    /// A budget that tracks charges but never denies one.
    pub fn unlimited() -> Arc<Self> {
        Arc::new(Self::with_total(UNLIMITED))
    }

    /// A budget that denies any charge pushing live bytes past `bytes`.
    pub fn with_memory_limit(bytes: u64) -> Arc<Self> {
        Arc::new(Self::with_total(bytes))
    }

    /// Use an embedder-owned total while retaining N-API per-pool policy.
    /// Whether an embedder owns wasm linear-memory accounting.
    ///
    /// The guest heap grows the guest's memory through the store, so an
    /// embedder that meters growth through its own tunables has already
    /// charged those bytes by the time we see them; charging again would
    /// count one allocation twice against the same total. With no accountant
    /// nothing else is counting, so the heap charges its own claims.
    pub(crate) fn wasm_is_externally_accounted(&self) -> bool {
        self.accountant.is_some()
    }

    pub fn with_accountant(accountant: Arc<dyn NapiMemoryAccountant>) -> Arc<Self> {
        Arc::new(Self {
            mem_total: accountant.memory_limit(),
            mem_charged: AtomicU64::new(0),
            accountant: Some(accountant),
            wasm_linear: AtomicU64::new(0),
            v8_heap_reserved: AtomicU64::new(0),
            v8_external: AtomicU64::new(0),
            live_isolates: AtomicUsize::new(0),
        })
    }

    fn with_total(mem_total: u64) -> Self {
        Self {
            mem_total,
            mem_charged: AtomicU64::new(0),
            accountant: None,
            wasm_linear: AtomicU64::new(0),
            v8_heap_reserved: AtomicU64::new(0),
            v8_external: AtomicU64::new(0),
            live_isolates: AtomicUsize::new(0),
        }
    }

    /// Whether this budget enforces a limit.
    pub fn is_unlimited(&self) -> bool {
        self.memory_limit() == UNLIMITED
    }

    /// The total memory budget (`u64::MAX` if unlimited).
    pub fn memory_limit(&self) -> u64 {
        self.accountant
            .as_ref()
            .map_or(self.mem_total, |x| x.memory_limit())
    }

    /// Bytes currently charged across all pools.
    pub fn memory_charged(&self) -> u64 {
        self.accountant.as_ref().map_or_else(
            || self.mem_charged.load(Ordering::Acquire),
            |x| x.memory_charged(),
        )
    }

    /// Bytes still available before the budget is exhausted.
    pub fn memory_remaining(&self) -> u64 {
        self.memory_limit().saturating_sub(self.memory_charged())
    }

    /// Atomically charge `bytes` against `pool`; `Err` if it would exceed the
    /// total. On success the caller owns the charge and must [`uncharge`] it
    /// (directly or via an owner whose `Drop` does).
    ///
    /// [`uncharge`]: ResourceBudget::uncharge
    pub fn try_charge(&self, pool: Pool, bytes: u64) -> Result<(), OverBudget> {
        if bytes == 0 {
            return Ok(());
        }

        if let Some(accountant) = &self.accountant {
            if !accountant.try_charge(bytes) {
                return Err(OverBudget {
                    pool,
                    requested: bytes,
                    charged: accountant.memory_charged(),
                    total: accountant.memory_limit(),
                });
            }
            self.mem_charged.fetch_add(bytes, Ordering::AcqRel);
        } else if self.mem_total == UNLIMITED {
            self.mem_charged.fetch_add(bytes, Ordering::AcqRel);
        } else {
            // CAS loop so a concurrent charge can never let the sum slip past
            // the total between the check and the commit.
            let mut current = self.mem_charged.load(Ordering::Acquire);
            loop {
                let next = current
                    .checked_add(bytes)
                    .filter(|next| *next <= self.mem_total);
                let Some(next) = next else {
                    return Err(OverBudget {
                        pool,
                        requested: bytes,
                        charged: current,
                        total: self.mem_total,
                    });
                };
                match self.mem_charged.compare_exchange_weak(
                    current,
                    next,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                ) {
                    Ok(_) => break,
                    Err(observed) => current = observed,
                }
            }
        }

        self.pool_counter(pool).fetch_add(bytes, Ordering::AcqRel);
        Ok(())
    }

    /// Release a previously-charged `bytes` from `pool`.
    pub fn uncharge(&self, pool: Pool, bytes: u64) {
        if bytes == 0 {
            return;
        }
        self.pool_counter(pool).fetch_sub(bytes, Ordering::AcqRel);
        self.mem_charged.fetch_sub(bytes, Ordering::AcqRel);
        if let Some(accountant) = &self.accountant {
            accountant.uncharge(bytes);
        }
    }

    fn pool_counter(&self, pool: Pool) -> &AtomicU64 {
        match pool {
            Pool::WasmLinear => &self.wasm_linear,
            Pool::V8HeapReserved => &self.v8_heap_reserved,
            Pool::V8External => &self.v8_external,
        }
    }

    /// Snapshot the current charges for metrics / billing.
    pub fn snapshot(&self) -> ResourceUsage {
        ResourceUsage {
            mem_total: self.memory_limit(),
            mem_charged: self.memory_charged(),
            wasm_linear: self.wasm_linear.load(Ordering::Acquire),
            v8_heap_reserved: self.v8_heap_reserved.load(Ordering::Acquire),
            v8_external: self.v8_external.load(Ordering::Acquire),
            live_isolates: self.live_isolates.load(Ordering::Acquire),
        }
    }

    /// Number of live V8 isolates counted against `max_envs`.
    pub fn live_isolates(&self) -> usize {
        self.live_isolates.load(Ordering::Acquire)
    }

    /// Cap on the number of live per-value host handles an env may hold, derived
    /// from the memory budget so this bookkeeping (which the byte pools don't
    /// see) cannot grow the host RSS without bound. `None` under an unlimited
    /// budget.
    pub fn value_handle_limit(&self) -> Option<u64> {
        if self.is_unlimited() {
            None
        } else {
            Some((self.memory_limit() / EST_HOST_BYTES_PER_VALUE).max(1))
        }
    }

    /// Reserve budget for a new V8 env: acquire an isolate slot against
    /// `max_envs` and charge the (clamped) heap ceiling. On success the caller
    /// owns both and must release them with [`release_env`] exactly once — on
    /// env teardown, or immediately if env creation then fails.
    ///
    /// [`release_env`]: ResourceBudget::release_env
    pub fn try_reserve_env(
        &self,
        req: RequestedHeap,
        max_envs: Option<usize>,
    ) -> Result<HeapReservation, EnvRejected> {
        if !self.try_acquire_isolate(max_envs) {
            return Err(EnvRejected::TooManyEnvs);
        }
        let Some(reservation) = self.plan_heap_reservation(req) else {
            self.release_isolate();
            return Err(EnvRejected::HeapDoesNotFit);
        };
        if self
            .try_charge(Pool::V8HeapReserved, reservation.ceiling_bytes)
            .is_err()
        {
            self.release_isolate();
            return Err(EnvRejected::HeapDoesNotFit);
        }
        Ok(reservation)
    }

    /// Release an env reservation: uncharge its heap ceiling and free its
    /// isolate slot. Pair with exactly one successful [`try_reserve_env`].
    ///
    /// [`try_reserve_env`]: ResourceBudget::try_reserve_env
    pub fn release_env(&self, ceiling_bytes: u64) {
        self.uncharge(Pool::V8HeapReserved, ceiling_bytes);
        self.release_isolate();
    }

    /// Atomically claim an isolate slot if under `max_envs` (always succeeds
    /// when `max_envs` is `None`).
    fn try_acquire_isolate(&self, max_envs: Option<usize>) -> bool {
        let Some(max) = max_envs else {
            self.live_isolates.fetch_add(1, Ordering::AcqRel);
            return true;
        };
        let mut current = self.live_isolates.load(Ordering::Acquire);
        loop {
            if current >= max {
                return false;
            }
            match self.live_isolates.compare_exchange_weak(
                current,
                current + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => return true,
                Err(observed) => current = observed,
            }
        }
    }

    fn release_isolate(&self) {
        self.live_isolates.fetch_sub(1, Ordering::AcqRel);
    }

    /// Clamp requested heap constraints to fit the remaining budget, applying
    /// the default old-generation ceiling and per-isolate overhead. Returns
    /// `None` if not even the minimum viable ceiling fits. Under an unlimited
    /// budget the request passes through unchanged and uncharged.
    fn plan_heap_reservation(&self, req: RequestedHeap) -> Option<HeapReservation> {
        if self.is_unlimited() {
            return Some(HeapReservation {
                max_young: req.max_young,
                max_old: req.max_old,
                code_range: req.code_range,
                ceiling_bytes: 0,
                clamped: false,
            });
        }

        // Explicit young/code plus a fixed overhead are reserved first; the
        // overhead also covers V8's own metadata and any unset young/code.
        let young = u64::from(req.max_young);
        let code = u64::from(req.code_range);
        let fixed = DEFAULT_PER_ISOLATE_OVERHEAD
            .checked_add(DEFAULT_UNWIND_SLACK)?
            .checked_add(young)?
            .checked_add(code)?;

        let remaining = self.memory_remaining();
        if remaining <= fixed {
            return None;
        }

        let old_available = remaining - fixed;
        let requested_old = if req.max_old > 0 {
            u64::from(req.max_old)
        } else {
            DEFAULT_INITIAL_ISOLATE_HEAP
        };
        let old = requested_old.min(old_available);
        if old == 0 {
            return None;
        }

        Some(HeapReservation {
            max_young: req.max_young,
            max_old: u32::try_from(old).unwrap_or(u32::MAX),
            code_range: req.code_range,
            ceiling_bytes: fixed + old,
            clamped: true,
        })
    }
}

/// Per-V8-env heap-growth tracker shared with the host-owned near-heap-limit
/// callback.
///
/// Boxed at env creation and handed to the callback as an opaque pointer; the
/// owning [`crate::env::NapiEnv`] reclaims it at env teardown to release the
/// bytes granted beyond the initial ceiling.
pub(crate) struct EnvHeapCharge {
    pub(crate) budget: Arc<ResourceBudget>,
    pub(crate) env: usize,
    pub(crate) host_stopped: Arc<AtomicBool>,
    pub(crate) unwind_slack_available: AtomicBool,
    /// Bytes granted beyond the initial ceiling by grow-step grants.
    pub(crate) granted: AtomicU64,
}

/// Host-owned near-heap-limit callback for a budgeted V8 isolate.
///
/// When V8 approaches a heap ceiling it invokes this on the isolate's JS
/// thread. We charge one [`DEFAULT_HEAP_GROW_STEP`] against the budget and, if
/// granted, raise the limit by that step. If the budget is exhausted, request
/// isolate termination and expose the pre-reserved unwind slack once. A second
/// denial leaves the limit unchanged, so the quota cannot be expanded repeatedly. The budget is atomic, so this is safe
/// to call concurrently with charges on other threads.
///
/// # Safety
/// `data` must be null or a pointer to an [`EnvHeapCharge`] that outlives the
/// call. The tracker is freed only at env teardown — after the callback is
/// removed from the isolate and while no JS runs — so a non-null pointer is
/// valid for every real invocation.
#[unsafe(no_mangle)]
pub extern "C" fn napi_host_near_heap_limit_grant(
    data: *const c_void,
    current_limit: usize,
    _initial_limit: usize,
) -> usize {
    if data.is_null() {
        return current_limit;
    }
    // SAFETY: see the function's safety contract.
    let tracker = unsafe { &*(data as *const EnvHeapCharge) };
    let step = DEFAULT_HEAP_GROW_STEP;
    match tracker.budget.try_charge(Pool::V8HeapReserved, step) {
        Ok(()) => {
            tracker.granted.fetch_add(step, Ordering::AcqRel);
            current_limit.saturating_add(step as usize)
        }
        Err(_) => {
            tracker.host_stopped.store(true, Ordering::Release);
            if tracker.env != 0 {
                unsafe {
                    crate::snapi::snapi_bridge_unofficial_terminate_execution(
                        tracker.env as crate::snapi::SnapiEnv,
                    );
                }
            }
            if tracker.unwind_slack_available.swap(false, Ordering::AcqRel) {
                current_limit.saturating_add(DEFAULT_UNWIND_SLACK as usize)
            } else {
                current_limit
            }
        }
    }
}

/// The live charge for one physical wasm-memory allocation.
///
/// Shared (`Arc`) between all [`BudgetedMemory`] handles that refer to the same
/// underlying mmap — cloning a shared memory shares this, so the charge is
/// released exactly once, when the last handle drops.
#[derive(Debug)]
#[cfg(not(target_arch = "wasm32"))]
struct MemoryCharge {
    budget: Arc<ResourceBudget>,
    /// Bytes currently charged for this allocation.
    bytes: AtomicU64,
}

#[cfg(not(target_arch = "wasm32"))]
impl MemoryCharge {
    fn new(budget: Arc<ResourceBudget>, bytes: u64) -> Result<Arc<Self>, OverBudget> {
        budget.try_charge(Pool::WasmLinear, bytes)?;
        Ok(Arc::new(Self {
            budget,
            bytes: AtomicU64::new(bytes),
        }))
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl Drop for MemoryCharge {
    fn drop(&mut self) {
        let bytes = self.bytes.swap(0, Ordering::AcqRel);
        self.budget.uncharge(Pool::WasmLinear, bytes);
    }
}

/// A [`LinearMemory`] that charges its bytes against a [`ResourceBudget`].
///
/// Delegates every operation to an inner backend `VMMemory`, except that growth
/// is charged first: `grow` (and `grow_at_least`) reserve the delta against the
/// budget and fail with [`MemoryError::CouldNotGrow`] — which the guest sees as
/// `memory.grow` returning `-1`, i.e. an ordinary allocation failure — when the
/// budget is exhausted. The initial (minimum) size is charged at construction.
#[derive(Debug)]
#[cfg(not(target_arch = "wasm32"))]
pub struct BudgetedMemory {
    inner: VMMemory,
    charge: Arc<MemoryCharge>,
}

#[cfg(not(target_arch = "wasm32"))]
impl BudgetedMemory {
    /// Wrap an already-allocated backend memory, charging its current size.
    ///
    /// The base tunables allocate the minimum pages before we can charge, so a
    /// minimum that alone exceeds the budget is allocated then rejected here;
    /// the transient over-allocation is one minimum-sized memory and is freed
    /// as `inner` drops on the error path.
    pub fn new(inner: VMMemory, budget: Arc<ResourceBudget>) -> Result<Self, MemoryError> {
        let bytes = pages_to_bytes(inner.size());
        let charge = MemoryCharge::new(budget, bytes).map_err(over_budget_to_memory_error)?;
        Ok(Self { inner, charge })
    }

    fn budget(&self) -> &Arc<ResourceBudget> {
        &self.charge.budget
    }
}

#[cfg(not(target_arch = "wasm32"))]
fn over_budget_to_memory_error(err: OverBudget) -> MemoryError {
    MemoryError::Generic(err.to_string())
}

#[cfg(not(target_arch = "wasm32"))]
impl LinearMemory for BudgetedMemory {
    fn ty(&self) -> MemoryType {
        self.inner.ty()
    }

    fn size(&self) -> Pages {
        self.inner.size()
    }

    fn style(&self) -> MemoryStyle {
        self.inner.style()
    }

    fn grow(&mut self, delta: Pages) -> Result<Pages, MemoryError> {
        let delta_bytes = pages_to_bytes(delta);
        // Reserve first: a denied charge must look exactly like hitting the
        // memory's maximum, so the guest's `memory.grow` returns -1.
        self.budget()
            .try_charge(Pool::WasmLinear, delta_bytes)
            .map_err(|_| MemoryError::CouldNotGrow {
                current: self.inner.size(),
                attempted_delta: delta,
            })?;

        match self.inner.grow(delta) {
            Ok(previous) => {
                self.charge.bytes.fetch_add(delta_bytes, Ordering::AcqRel);
                Ok(previous)
            }
            Err(err) => {
                // The real grow failed (e.g. hit its own maximum); give the
                // reservation back so it does not leak against the budget.
                self.budget().uncharge(Pool::WasmLinear, delta_bytes);
                Err(err)
            }
        }
    }

    fn grow_at_least(&mut self, min_size: u64) -> Result<(), MemoryError> {
        let before = pages_to_bytes(self.inner.size());
        if min_size <= before {
            // Already big enough; the inner call is a no-op that cannot grow.
            return self.inner.grow_at_least(min_size);
        }

        // Reserve an upper bound (page-rounded target minus current) up front,
        // then reconcile to the size actually reached.
        let reserve = round_up_to_page(min_size).saturating_sub(before);
        self.budget()
            .try_charge(Pool::WasmLinear, reserve)
            .map_err(|_| MemoryError::CouldNotGrow {
                current: self.inner.size(),
                attempted_delta: Pages::from_bytes_rounded_up(min_size.saturating_sub(before))
                    .unwrap_or(Pages(u32::MAX)),
            })?;

        match self.inner.grow_at_least(min_size) {
            Ok(()) => {
                let actual = pages_to_bytes(self.inner.size()).saturating_sub(before);
                if reserve > actual {
                    self.budget().uncharge(Pool::WasmLinear, reserve - actual);
                }
                self.charge.bytes.fetch_add(actual, Ordering::AcqRel);
                Ok(())
            }
            Err(err) => {
                self.budget().uncharge(Pool::WasmLinear, reserve);
                Err(err)
            }
        }
    }

    fn reset(&mut self) -> Result<(), MemoryError> {
        self.inner.reset()?;
        // reset only ever shrinks; release the freed bytes.
        let after = pages_to_bytes(self.inner.size());
        let previous = self.charge.bytes.swap(after, Ordering::AcqRel);
        if previous > after {
            self.budget().uncharge(Pool::WasmLinear, previous - after);
        }
        Ok(())
    }

    fn vmmemory(&self) -> std::ptr::NonNull<VMMemoryDefinition> {
        self.inner.vmmemory()
    }

    fn try_clone(&self) -> Result<Box<dyn LinearMemory + Send + Sync + 'static>, MemoryError> {
        // A clone shares the same underlying allocation (shared memory), so it
        // shares the same charge: the bytes are counted once and released when
        // the last handle drops.
        // `VMMemory::try_clone` (inherent) already yields a `VMMemory`.
        let inner = self.inner.try_clone()?;
        Ok(Box::new(BudgetedMemory {
            inner,
            charge: Arc::clone(&self.charge),
        }))
    }

    fn copy(&self) -> Result<Box<dyn LinearMemory + Send + Sync + 'static>, MemoryError> {
        // A copy is a genuinely new allocation, so it needs its own charge.
        let forked = self.inner.copy()?;
        let bytes = pages_to_bytes(forked.size());
        let charge = MemoryCharge::new(Arc::clone(self.budget()), bytes)
            .map_err(over_budget_to_memory_error)?;
        Ok(Box::new(BudgetedMemory {
            inner: VMMemory::from(forked),
            charge,
        }))
    }

    fn as_shared(&self) -> Result<VMSharedMemory, MemoryError> {
        self.inner.as_shared()
    }

    unsafe fn do_wait(
        &mut self,
        dst: u32,
        expected: ExpectedValue,
        timeout: Option<Duration>,
    ) -> Result<u32, WaiterError> {
        // SAFETY: forwarded verbatim to the inner memory, whose contract we
        // inherit; `dst` validity/alignment is the caller's responsibility.
        unsafe { self.inner.do_wait(dst, expected, timeout) }
    }

    fn do_notify(&mut self, dst: u32, count: u32) -> u32 {
        self.inner.do_notify(dst, count)
    }

    fn thread_conditions(&self) -> Option<&ThreadConditions> {
        self.inner.thread_conditions()
    }
}

/// [`Tunables`] that wrap every host memory in a [`BudgetedMemory`] and clamp a
/// requested memory's maximum to what the budget could ever grant.
///
/// All other logic delegates to the wrapped base tunables — mirroring the
/// `tunables_limit_memory` example. Module-*defined* memories (created via
/// `create_vm_memory` into a fixed VM slot) are left to the base tunables in
/// Phase 1; the edgejs guest *imports* its memory, so it flows through
/// `create_host_memory` and is charged. The max-pages clamp still bounds the
/// defined case cheaply.
#[cfg(not(target_arch = "wasm32"))]
pub struct BudgetedTunables<T: Tunables> {
    base: T,
    budget: Arc<ResourceBudget>,
}

#[cfg(not(target_arch = "wasm32"))]
impl<T: Tunables> BudgetedTunables<T> {
    /// Wrap `base`, charging every host memory against `budget`.
    pub fn new(base: T, budget: Arc<ResourceBudget>) -> Self {
        Self { base, budget }
    }

    /// The whole-budget page ceiling, or `None` when unlimited.
    fn budget_max_pages(&self) -> Option<Pages> {
        if self.budget.is_unlimited() {
            return None;
        }
        let pages = (self.budget.memory_limit() / WASM_PAGE_SIZE as u64).min(u64::from(u32::MAX));
        Some(Pages(pages as u32))
    }

    /// Clamp a requested memory's maximum to the budget ceiling (cheap layer-1
    /// cap; exact accounting still happens in [`BudgetedMemory`]).
    fn adjust_memory(&self, requested: &MemoryType) -> MemoryType {
        let mut adjusted = *requested;
        if let Some(cap) = self.budget_max_pages() {
            adjusted.maximum = Some(match adjusted.maximum {
                Some(max) => max.min(cap),
                None => cap,
            });
        }
        adjusted
    }

    fn validate_memory(&self, ty: &MemoryType) -> Result<(), MemoryError> {
        if let Some(cap) = self.budget_max_pages()
            && ty.minimum > cap
        {
            return Err(MemoryError::MinimumMemoryTooLarge {
                min_requested: ty.minimum,
                max_allowed: cap,
            });
        }
        Ok(())
    }
}

#[cfg(not(target_arch = "wasm32"))]
impl<T: Tunables> Tunables for BudgetedTunables<T> {
    fn memory_style(&self, memory: &MemoryType) -> MemoryStyle {
        self.base.memory_style(&self.adjust_memory(memory))
    }

    fn table_style(&self, table: &TableType) -> TableStyle {
        self.base.table_style(table)
    }

    fn create_host_memory(
        &self,
        ty: &MemoryType,
        style: &MemoryStyle,
    ) -> Result<VMMemory, MemoryError> {
        let adjusted = self.adjust_memory(ty);
        self.validate_memory(&adjusted)?;
        let inner = self.base.create_host_memory(&adjusted, style)?;
        let budgeted = BudgetedMemory::new(inner, Arc::clone(&self.budget))?;
        Ok(VMMemory::from(
            Box::new(budgeted) as Box<dyn LinearMemory + Send + Sync + 'static>
        ))
    }

    unsafe fn create_vm_memory(
        &self,
        ty: &MemoryType,
        style: &MemoryStyle,
        vm_definition_location: std::ptr::NonNull<VMMemoryDefinition>,
    ) -> Result<VMMemory, MemoryError> {
        let adjusted = self.adjust_memory(ty);
        self.validate_memory(&adjusted)?;
        // SAFETY: contract forwarded to base; `vm_definition_location` validity
        // is the caller's responsibility.
        unsafe {
            self.base
                .create_vm_memory(&adjusted, style, vm_definition_location)
        }
    }

    fn create_host_table(&self, ty: &TableType, style: &TableStyle) -> Result<VMTable, String> {
        self.base.create_host_table(ty, style)
    }

    unsafe fn create_vm_table(
        &self,
        ty: &TableType,
        style: &TableStyle,
        vm_definition_location: std::ptr::NonNull<VMTableDefinition>,
    ) -> Result<VMTable, String> {
        // SAFETY: contract forwarded to base.
        unsafe { self.base.create_vm_table(ty, style, vm_definition_location) }
    }
}

/// Build [`BudgetedTunables`] over the platform default base tunables.
#[cfg(not(target_arch = "wasm32"))]
pub fn budgeted_tunables(budget: Arc<ResourceBudget>) -> BudgetedTunables<BaseTunables> {
    BudgetedTunables::new(BaseTunables::new(), budget)
}

#[cfg(all(test, not(target_arch = "wasm32")))]
mod tests {
    use super::*;
    use wasmer::sys::{Cranelift, EngineBuilder};
    use wasmer::{Memory, MemoryType, Pages, Store, WASM_PAGE_SIZE};

    const PAGE: u64 = WASM_PAGE_SIZE as u64;

    /// A store whose engine charges guest wasm linear memory against `budget`.
    fn budgeted_store(budget: Arc<ResourceBudget>) -> Store {
        let mut engine = EngineBuilder::new(Cranelift::default()).engine();
        let tunables = budgeted_tunables(budget);
        engine.set_tunables(tunables);
        Store::new(engine)
    }

    #[test]
    fn try_charge_tracks_and_rejects() {
        let budget = ResourceBudget::with_memory_limit(100);
        budget.try_charge(Pool::WasmLinear, 60).expect("fits");
        assert_eq!(budget.memory_charged(), 60);
        assert_eq!(budget.memory_remaining(), 40);

        // A charge past the total is rejected atomically and changes nothing.
        let err = budget
            .try_charge(Pool::WasmLinear, 50)
            .expect_err("exceeds budget");
        assert_eq!(err.requested, 50);
        assert_eq!(err.charged, 60);
        assert_eq!(budget.memory_charged(), 60);

        budget.try_charge(Pool::WasmLinear, 40).expect("exact fit");
        assert_eq!(budget.memory_remaining(), 0);

        budget.uncharge(Pool::WasmLinear, 100);
        assert_eq!(budget.memory_charged(), 0);
        assert_eq!(budget.snapshot().wasm_linear, 0);
    }

    #[test]
    fn unlimited_budget_never_denies() {
        let budget = ResourceBudget::unlimited();
        assert!(budget.is_unlimited());
        budget
            .try_charge(Pool::WasmLinear, u64::from(u32::MAX))
            .expect("unlimited budget accepts any charge");
        assert_eq!(budget.snapshot().wasm_linear, u64::from(u32::MAX));
    }

    #[test]
    fn static_clamp_bounds_memory_maximum() {
        // Budget of 10 pages; a memory that requests no maximum is clamped.
        let budget = ResourceBudget::with_memory_limit(10 * PAGE);
        let mut store = budgeted_store(budget);
        let memory =
            Memory::new(&mut store, MemoryType::new(1, None, false)).expect("1-page memory fits");
        assert_eq!(memory.ty(&store).maximum, Some(Pages(10)));
    }

    #[test]
    fn wasm_memory_grow_bomb_is_capped() {
        // Budget of 10 pages. A guest that grows forever must be stopped at the
        // budget, with the failure surfacing as an ordinary grow failure.
        let budget = ResourceBudget::with_memory_limit(10 * PAGE);
        let mut store = budgeted_store(Arc::clone(&budget));

        let memory =
            Memory::new(&mut store, MemoryType::new(1, None, false)).expect("initial page fits");
        assert_eq!(budget.memory_charged(), PAGE, "minimum charged up front");

        let mut pages = 1u32;
        loop {
            match memory.grow(&mut store, Pages(1)) {
                Ok(_) => pages += 1,
                Err(_) => break,
            }
            assert!(pages <= 100, "grow was never capped");
        }

        assert_eq!(pages, 10, "capped at the 10-page budget");
        assert_eq!(budget.memory_charged(), 10 * PAGE);
        // Still denied after the cap, and no charge leaked from the attempt.
        assert!(memory.grow(&mut store, Pages(1)).is_err());
        assert_eq!(budget.memory_charged(), 10 * PAGE);
    }

    #[test]
    fn charges_released_when_memory_drops() {
        let budget = ResourceBudget::with_memory_limit(100 * PAGE);
        {
            let mut store = budgeted_store(Arc::clone(&budget));
            let memory =
                Memory::new(&mut store, MemoryType::new(3, None, false)).expect("3 pages fit");
            memory
                .grow(&mut store, Pages(5))
                .expect("grow within budget");
            assert_eq!(budget.memory_charged(), 8 * PAGE, "3 min + 5 grown");
        }
        assert_eq!(
            budget.memory_charged(),
            0,
            "dropping the store releases the memory's charge"
        );
    }

    #[test]
    fn separate_memories_share_one_budget() {
        // Two memories in one store draw from the same budget; the aggregate,
        // not either one alone, is what the cap bounds.
        let budget = ResourceBudget::with_memory_limit(6 * PAGE);
        let mut store = budgeted_store(Arc::clone(&budget));

        let _a = Memory::new(&mut store, MemoryType::new(4, None, false)).expect("first fits");
        assert_eq!(budget.memory_charged(), 4 * PAGE);

        // The second memory's minimum (4 pages) no longer fits in the 2 pages
        // left, so creation fails rather than overrunning the shared budget.
        let b = Memory::new(&mut store, MemoryType::new(4, None, false));
        assert!(b.is_err(), "second memory exceeds the shared budget");
        assert_eq!(
            budget.memory_charged(),
            4 * PAGE,
            "failed create charged nothing"
        );

        // A memory that does fit is accepted.
        let _c = Memory::new(&mut store, MemoryType::new(2, None, false)).expect("2 pages fit");
        assert_eq!(budget.memory_charged(), 6 * PAGE);
    }

    #[test]
    fn env_reservation_charges_ceiling_and_releases() {
        let budget = ResourceBudget::with_memory_limit(100 * MIB);
        let res = budget
            .try_reserve_env(RequestedHeap::default(), None)
            .expect("env fits");
        assert!(res.clamped);
        // Default old-gen (64 MiB) fits, plus 8 MiB overhead and 16 MiB unwind slack.
        assert_eq!(u64::from(res.max_old), DEFAULT_INITIAL_ISOLATE_HEAP);
        assert_eq!(res.ceiling_bytes, 88 * MIB);
        assert_eq!(budget.snapshot().v8_heap_reserved, 88 * MIB);
        assert_eq!(budget.live_isolates(), 1);

        budget.release_env(res.ceiling_bytes);
        assert_eq!(budget.snapshot().v8_heap_reserved, 0);
        assert_eq!(budget.live_isolates(), 0);
    }

    #[test]
    fn env_reservation_clamps_old_gen_to_fit() {
        // Only 40 MiB: overhead (8) and unwind slack (16) leave 16 MiB for
        // old-gen, below the 64 MiB default, so it is clamped to fit.
        let budget = ResourceBudget::with_memory_limit(40 * MIB);
        let res = budget
            .try_reserve_env(RequestedHeap::default(), None)
            .expect("clamped env fits");
        assert_eq!(u64::from(res.max_old), 16 * MIB);
        assert_eq!(res.ceiling_bytes, 40 * MIB);
    }

    #[test]
    fn env_reservation_counts_explicit_young_and_code() {
        let budget = ResourceBudget::with_memory_limit(100 * MIB);
        let req = RequestedHeap {
            max_young: (4 * MIB) as u32,
            max_old: (16 * MIB) as u32,
            code_range: (2 * MIB) as u32,
        };
        let res = budget.try_reserve_env(req, None).expect("fits");
        // ceiling = overhead(8) + unwind(16) + young(4) + code(2) + old(16).
        assert_eq!(res.max_young, (4 * MIB) as u32);
        assert_eq!(res.max_old, (16 * MIB) as u32);
        assert_eq!(res.code_range, (2 * MIB) as u32);
        assert_eq!(res.ceiling_bytes, 46 * MIB);
    }

    #[test]
    fn env_reservation_refused_when_heap_cannot_fit() {
        // Below overhead plus unwind slack, so no viable heap exists.
        let budget = ResourceBudget::with_memory_limit(4 * MIB);
        let err = budget
            .try_reserve_env(RequestedHeap::default(), None)
            .expect_err("too small for any env");
        assert_eq!(err, EnvRejected::HeapDoesNotFit);
        // The isolate slot claimed up front was rolled back.
        assert_eq!(budget.live_isolates(), 0);
    }

    #[test]
    fn max_envs_caps_live_isolates() {
        let budget = ResourceBudget::with_memory_limit(1000 * MIB);
        let r1 = budget
            .try_reserve_env(RequestedHeap::default(), Some(2))
            .expect("first env");
        let _r2 = budget
            .try_reserve_env(RequestedHeap::default(), Some(2))
            .expect("second env");
        assert_eq!(budget.live_isolates(), 2);

        let err = budget
            .try_reserve_env(RequestedHeap::default(), Some(2))
            .expect_err("third env exceeds max_envs");
        assert_eq!(err, EnvRejected::TooManyEnvs);
        // A refused env neither counted nor charged.
        assert_eq!(budget.live_isolates(), 2);

        budget.release_env(r1.ceiling_bytes);
        assert_eq!(budget.live_isolates(), 1);
        // A slot freed, so another env fits again.
        let _r3 = budget
            .try_reserve_env(RequestedHeap::default(), Some(2))
            .expect("env fits after release");
    }

    #[test]
    fn unlimited_budget_passes_env_request_through() {
        let budget = ResourceBudget::unlimited();
        let req = RequestedHeap {
            max_young: 1,
            max_old: 2,
            code_range: 3,
        };
        let res = budget.try_reserve_env(req, None).expect("always fits");
        assert!(!res.clamped);
        assert_eq!(res.ceiling_bytes, 0);
        assert_eq!(
            (res.max_young, res.max_old, res.code_range),
            (1, 2, 3),
            "constraints forwarded unchanged"
        );
        assert_eq!(budget.snapshot().v8_heap_reserved, 0);
        assert_eq!(budget.live_isolates(), 1, "still counted for observability");
    }

    #[test]
    fn near_heap_limit_callback_grants_until_budget_exhausted() {
        let step = DEFAULT_HEAP_GROW_STEP as usize;
        // The unwind slack is pre-reserved as part of the env ceiling, with room
        // for exactly two additional grow-step grants.
        let budget =
            ResourceBudget::with_memory_limit(DEFAULT_UNWIND_SLACK + 2 * DEFAULT_HEAP_GROW_STEP);
        budget
            .try_charge(Pool::V8HeapReserved, DEFAULT_UNWIND_SLACK)
            .unwrap();
        let host_stopped = Arc::new(AtomicBool::new(false));
        let ptr = Box::into_raw(Box::new(EnvHeapCharge {
            budget: Arc::clone(&budget),
            env: 0,
            host_stopped: Arc::clone(&host_stopped),
            unwind_slack_available: AtomicBool::new(true),
            granted: AtomicU64::new(0),
        }));
        let data = ptr as *const c_void;
        let base = 100 * 1024 * 1024usize;

        // Each of the first two grants raises the limit by a step and charges it.
        assert_eq!(
            napi_host_near_heap_limit_grant(data, base, base),
            base + step
        );
        assert_eq!(
            napi_host_near_heap_limit_grant(data, base + step, base),
            base + 2 * step
        );
        assert_eq!(
            budget.snapshot().v8_heap_reserved,
            DEFAULT_UNWIND_SLACK + 2 * DEFAULT_HEAP_GROW_STEP
        );

        // Budget exhaustion requests termination and exposes the already-reserved
        // unwind slack exactly once.
        assert_eq!(
            napi_host_near_heap_limit_grant(data, base + 2 * step, base),
            base + 2 * step + DEFAULT_UNWIND_SLACK as usize
        );
        assert_eq!(
            napi_host_near_heap_limit_grant(
                data,
                base + 2 * step + DEFAULT_UNWIND_SLACK as usize,
                base,
            ),
            base + 2 * step + DEFAULT_UNWIND_SLACK as usize
        );
        assert_eq!(
            budget.snapshot().v8_heap_reserved,
            DEFAULT_UNWIND_SLACK + 2 * DEFAULT_HEAP_GROW_STEP
        );

        assert!(host_stopped.load(Ordering::Acquire));

        // The tracker recorded exactly what was granted, and releasing it (as
        // env teardown does) returns the pool to zero.
        let tracker = unsafe { Box::from_raw(ptr) };
        let granted = tracker.granted.load(Ordering::Acquire);
        assert_eq!(granted, 2 * DEFAULT_HEAP_GROW_STEP);
        budget.uncharge(Pool::V8HeapReserved, granted + DEFAULT_UNWIND_SLACK);
        assert_eq!(budget.snapshot().v8_heap_reserved, 0);
    }

    #[test]
    fn near_heap_limit_callback_ignores_null_data() {
        assert_eq!(
            napi_host_near_heap_limit_grant(std::ptr::null(), 42, 7),
            42,
            "a null tracker leaves the limit unchanged"
        );
    }

    #[test]
    fn value_handle_limit_scales_with_budget() {
        // Limit = budget / EST_HOST_BYTES_PER_VALUE.
        let budget = ResourceBudget::with_memory_limit(1000 * EST_HOST_BYTES_PER_VALUE);
        assert_eq!(budget.value_handle_limit(), Some(1000));
        // Unlimited budget imposes no cap.
        assert_eq!(ResourceBudget::unlimited().value_handle_limit(), None);
        // A tiny budget still allows at least one handle.
        assert_eq!(
            ResourceBudget::with_memory_limit(1).value_handle_limit(),
            Some(1)
        );
    }

    #[test]
    fn wasm_and_external_share_one_budget() {
        // A mixed wasm + declared-external workload is bounded by the
        // *combined* cap, not either pool alone.
        let budget = ResourceBudget::with_memory_limit(10 * MIB);
        budget
            .try_charge(Pool::WasmLinear, 7 * MIB)
            .expect("wasm fits");

        // Only 3 MiB remains, so a 4 MiB external declaration is denied...
        assert!(budget.try_charge(Pool::V8External, 4 * MIB).is_err());
        // ...but 3 MiB exactly fits, exhausting the shared budget.
        budget
            .try_charge(Pool::V8External, 3 * MIB)
            .expect("remaining room fits exactly");
        assert_eq!(budget.memory_charged(), 10 * MIB);

        budget.uncharge(Pool::V8External, 3 * MIB);
        assert_eq!(budget.snapshot().v8_external, 0);
    }
}

#[cfg(test)]
mod external_accountant_tests {
    use super::*;

    struct TestAccountant {
        limit: u64,
        charged: AtomicU64,
    }

    impl TestAccountant {
        fn new(limit: u64) -> Arc<Self> {
            Arc::new(Self {
                limit,
                charged: AtomicU64::new(0),
            })
        }
    }

    impl NapiMemoryAccountant for TestAccountant {
        fn memory_limit(&self) -> u64 {
            self.limit
        }

        fn memory_charged(&self) -> u64 {
            self.charged.load(Ordering::Acquire)
        }

        fn try_charge(&self, bytes: u64) -> bool {
            let mut current = self.charged.load(Ordering::Acquire);
            loop {
                let Some(next) = current
                    .checked_add(bytes)
                    .filter(|next| *next <= self.limit)
                else {
                    return false;
                };
                match self.charged.compare_exchange_weak(
                    current,
                    next,
                    Ordering::AcqRel,
                    Ordering::Acquire,
                ) {
                    Ok(_) => return true,
                    Err(observed) => current = observed,
                }
            }
        }

        fn uncharge(&self, bytes: u64) {
            self.charged.fetch_sub(bytes, Ordering::AcqRel);
        }
    }

    #[test]
    fn external_accountant_includes_non_napi_charges() {
        let accountant = TestAccountant::new(100);
        assert!(accountant.try_charge(40));

        let external: Arc<dyn NapiMemoryAccountant> = accountant.clone();
        let budget = ResourceBudget::with_accountant(external);
        budget.try_charge(Pool::V8HeapReserved, 60).unwrap();

        let usage = budget.snapshot();
        assert_eq!(usage.mem_charged, 100);
        assert_eq!(usage.v8_heap_reserved, 60);
        assert!(budget.try_charge(Pool::V8External, 1).is_err());

        budget.uncharge(Pool::V8HeapReserved, 60);
        assert_eq!(accountant.memory_charged(), 40);
        assert_eq!(budget.snapshot().v8_heap_reserved, 0);
    }
}
