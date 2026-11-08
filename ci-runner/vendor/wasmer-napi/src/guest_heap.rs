//! Host-side allocator over guest linear memory.
//!
//! The N-API bridge frequently needs guest-addressable memory: buffer and
//! arraybuffer backing stores, copies of host-only data, and (via the V8
//! array-buffer allocator hooks) every backing store JS allocates. Historically
//! the bridge called the guest's exported `malloc` for this — a reentrant call
//! into the wasm guest with no matching free path. `GuestHeap` replaces that:
//! it claims pages of the guest's linear memory by issuing `memory.grow` from
//! the host and manages allocations within the claimed ranges itself.
//!
//! Claiming pages this way is sound because every grow of a wasm memory is
//! serialized (one lock per memory) and returns the previous size: whoever
//! issues a grow owns exactly `[prev, prev+delta)` pages. The guest's own
//! sbrk/malloc uses the same protocol, so host and guest claims interleave
//! without overlap. (The WASIX dynamic linker claims guest pages from the host
//! the same way.)
//!
//! ## Metadata lives host-side only
//!
//! The allocator ([`offset_allocator`]) keeps all of its bookkeeping in its own
//! host-heap structures and only hands out offsets; the `live` side table maps
//! offsets to allocation handles. Guest memory holds nothing but payload bytes,
//! so a buggy or hostile guest can corrupt its own data but can never corrupt
//! allocator state or induce the host to touch memory outside the guest range.
//!
//! ## Base-pointer stability
//!
//! Host pointers derived from `base` are handed to V8 as external backing
//! stores, so the mapping must never move. On 64-bit hosts every wasm32 memory
//! is `MemoryStyle::Static` with the full range reserved up front (growth can
//! never remap), which [`GuestHeap::new`] verifies. As defense-in-depth every
//! grow re-checks the base and aborts the process on a move (continuing would
//! be immediate use-after-unmap all over the host).
//!
//! ## Where the store comes from
//!
//! Growing a wasm memory needs the store that owns it. Ordinary import handlers
//! pass their store explicitly. V8 array-buffer allocation arrives from inside
//! C++ frames, so only bridge operations that may synchronously invoke guest
//! code install an invocation guard and lend their store
//! ([`crate::guest::callback`]). A foreground allocation inside such a guarded
//! call can recover that store; a background allocator thread has no lent store
//! and remains arena-only. Growth is always the ordinary `Memory::grow`.
//!
//! Memory handles are store-scoped and WASIX worker threads share one linear
//! memory while each has its own store, so the heap keeps one handle per store
//! that reaches it and grows through whichever handle belongs to the explicitly
//! supplied store.
//!
//! Nothing guarantees a store is available: a V8 background thread has none.
//! So the heap keeps an arena ahead of demand — pre-claimed at instantiation
//! and topped up from import boundaries ([`GuestHeap::maybe_refill`]) — and an
//! allocation that arrives store-less is served from it.
//!
//! ## Concurrency
//!
//! `alloc`/`free` take the internal mutex only. Frees need no store at all, so
//! V8's GC threads can release backing stores off the JS thread. Lock order is
//! the `inner` mutex → budget atomics → the memory's own grow lock; nothing
//! else is acquired while the mutex is held.

use std::collections::HashMap;
use std::sync::{
    Arc, Mutex, OnceLock, Weak,
    atomic::{AtomicU64, Ordering},
};

use offset_allocator::{Allocation, Allocator as OffsetAllocator};
use wasmer::sys::NativeEngineExt;
use wasmer::{AsStoreRef, Memory, MemoryStyle, Pages, Store, StoreMut};

use crate::budget::{Pool, ResourceBudget};

/// Allocation granularity: every allocation is a multiple of 16 bytes and
/// 16-byte aligned (the offset allocator works in units, so offsets scale by
/// this factor). 16 covers V8 backing-store alignment and every bridge use.
const UNIT: u32 = 16;

const WASM_PAGE: u32 = wasmer::WASM_PAGE_SIZE as u32;

/// Minimum bytes claimed per grow, to amortize grow calls and chunk overhead.
const MIN_CHUNK_BYTES: u32 = 1024 * 1024;

/// Bytes pre-claimed at heap creation, so an allocation that arrives without a
/// store has somewhere to come from.
const PREFUND_BYTES: u32 = 16 * 1024 * 1024;

/// When free space drops below this, the next [`GuestHeap::maybe_refill`]
/// claims more.
const LOW_WATER_BYTES: u64 = 4 * 1024 * 1024;

struct Chunk {
    /// Guest offset of the first byte this chunk manages.
    start: u32,
    /// Managed length in bytes.
    len: u32,
    alloc: OffsetAllocator<u32>,
}

struct LiveAlloc {
    chunk_idx: usize,
    allocation: Allocation<u32>,
    /// Requested length in bytes. Also serves finalizers, so a buffer's length
    /// never needs to travel through guest-reachable memory.
    len: u32,
    /// Units the allocator actually reserved (bin rounding included), for
    /// exact free-space accounting.
    units: u32,
}

struct HeapInner {
    /// One handle to this heap's linear memory per store that has reached it.
    /// A handle only works with the store that made it, so growing means
    /// finding the one belonging to the store currently lent.
    memories: Vec<Memory>,
    chunks: Vec<Chunk>,
    live: HashMap<u32, LiveAlloc>,
    /// Free bytes across all chunks (maintained on alloc/free/claim).
    free_bytes: u64,
    /// Bytes a recent allocation failed to find: the next refill claims at
    /// least this much.
    pending_want: u32,
}

pub(crate) struct GuestHeap {
    /// Cached host address of guest offset 0. Stable for the life of the
    /// memory (verified after every grow).
    base: *mut u8,
    /// The memory's maximum size in bytes (post-clamp when budgeted).
    max_bytes: u64,
    budget: Arc<ResourceBudget>,
    /// Linear-memory bytes this heap has claimed, charged to
    /// [`Pool::WasmLinear`]; uncharged on drop.
    charged: AtomicU64,
    inner: Mutex<HeapInner>,
}

// SAFETY: `base` points into a mapping that outlives the heap: the instance's
// store keeps it alive, and the heap is dropped with the env. All mutable
// state is behind the mutex or atomics.
unsafe impl Send for GuestHeap {}
unsafe impl Sync for GuestHeap {}

/// Bytes to claim for a chunk that must satisfy a `min_bytes` allocation.
/// The offset allocator rounds requests UP to a size bin (worst case ~12.5%),
/// so an exact-capacity chunk cannot serve the allocation that sized it; add
/// that headroom plus a page, and never claim less than the chunk minimum.
fn chunk_size_for(min_bytes: u32) -> u32 {
    min_bytes
        .saturating_add(min_bytes / 8)
        .saturating_add(WASM_PAGE)
        .max(MIN_CHUNK_BYTES)
}

/// Average bytes per allocation a chunk's node budget is sized for. The
/// allocator needs a node per live allocation plus one per free region between
/// them, so budgeting one node per 256 bytes leaves roughly 2x headroom for the
/// ~10 KiB buffers this heap actually serves.
const BYTES_PER_NODE: u32 = 256;
/// Node-budget floor/ceiling. The floor keeps a small chunk usable; the ceiling
/// stops a very large chunk from re-introducing the cost this bounds.
const MIN_CHUNK_ALLOCS: u32 = 1024;
const MAX_CHUNK_ALLOCS: u32 = 32 * 1024;

/// Node budget for a chunk of `len` bytes.
///
/// [`OffsetAllocator::new`] sizes every chunk for 128Ki allocations no matter
/// how small the chunk is, and its `reset` eagerly allocates that many `Node`s
/// (28 bytes each) plus a `u32` free-list entry — about **2 MiB of host
/// metadata per 1 MiB guest chunk**. Chunks are claimed as the workload's peak
/// grows and are never released, so that overhead accumulated on the host heap
/// for the life of the process: RSS grew roughly 3x the guest memory actually
/// being managed, which is what made large request bodies look like a leak.
///
/// Running out of nodes is graceful, not fatal: [`OffsetAllocator::allocate`]
/// returns `None`, and [`GuestHeap::try_chunks`] simply moves on to another
/// chunk (claiming one if needed), so an under-estimate costs a little
/// fragmentation rather than correctness.
fn chunk_max_allocs(len: u32) -> u32 {
    (len / BYTES_PER_NODE).clamp(MIN_CHUNK_ALLOCS, MAX_CHUNK_ALLOCS)
}

/// Log a heap-integrity complaint, at most a handful of times per process.
fn integrity_warn(what: &str) {
    static COUNT: AtomicU64 = AtomicU64::new(0);
    if COUNT.fetch_add(1, Ordering::Relaxed) < 8 {
        eprintln!("[wasmer-napi guest-heap] {what}");
    }
}

/// Process-global registry of shared-memory heaps, keyed by the memory's base
/// address. WASIX worker threads share one linear memory but each instantiates
/// its own N-API env; without this they would each build a separate heap over
/// the same memory, giving every heap an identical ownership range and no
/// serialization between them. Sharing one heap per memory means a single
/// allocator, live table, and mutex serialize all threads with unambiguous
/// ownership. Weak refs let a heap drop once its last env releases it.
fn shared_registry() -> &'static Mutex<HashMap<usize, Weak<GuestHeap>>> {
    static REG: OnceLock<Mutex<HashMap<usize, Weak<GuestHeap>>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

impl GuestHeap {
    /// Get the shared heap for `memory`, building it on first use. All envs on
    /// the same shared linear memory receive the same `Arc<GuestHeap>`. Returns
    /// `None` when the memory cannot support host-side allocation with a stable
    /// base, in which case callers must treat guest allocation as unavailable.
    pub(crate) fn get_or_create(
        store: &mut StoreMut<'_>,
        memory: &wasmer::Memory,
        budget: Arc<ResourceBudget>,
    ) -> Option<Arc<Self>> {
        let base = memory.view(store).data_ptr() as usize;
        if base == 0 {
            return Self::new(store, memory, budget);
        }
        // Shared memories: one heap per base, reused across threads/envs.
        // Non-shared memories are single-threaded (conformance lane) — a fresh
        // heap each time is fine and avoids cross-instance base-key collisions.
        if !memory.ty(store).shared {
            return Self::new(store, memory, budget);
        }
        let mut reg = shared_registry()
            .lock()
            .expect("guest-heap registry poisoned");
        if let Some(existing) = reg.get(&base).and_then(Weak::upgrade) {
            // This store reaches the heap for the first time; its handle is
            // the only one that can grow the memory while it is the store
            // being lent.
            existing.register_memory(store, memory);
            return Some(existing);
        }
        let heap = Self::new(store, memory, budget)?;
        reg.insert(base, Arc::downgrade(&heap));
        // Opportunistically drop dead entries so the map cannot grow unbounded
        // across many short-lived instances that reuse addresses.
        reg.retain(|_, w| w.strong_count() > 0);
        Some(heap)
    }

    /// Record the handle `store` uses for this heap's linear memory, if it has
    /// not already. Only the handle belonging to the store being lent can grow
    /// the memory, so every store that reaches a shared heap contributes one.
    fn register_memory(&self, store: &impl AsStoreRef, memory: &Memory) {
        let mut inner = self.inner.lock().expect("guest-heap mutex poisoned");
        if inner
            .memories
            .iter()
            .any(|known| known.is_from_store(store))
        {
            return;
        }
        inner.memories.push(memory.clone());
    }

    /// Build a fresh heap over the instance's imported memory. Prefer
    /// [`GuestHeap::get_or_create`] so envs sharing a memory share the heap.
    pub(crate) fn new(
        store: &mut StoreMut<'_>,
        memory: &wasmer::Memory,
        budget: Arc<ResourceBudget>,
    ) -> Option<Arc<Self>> {
        let ty = memory.ty(store);
        let view = memory.view(store);
        let base = view.data_ptr();
        if base.is_null() {
            integrity_warn("memory has no base mapping; guest heap disabled");
            return None;
        }
        let max_pages = ty.maximum.map(|p| p.0).unwrap_or(65536).min(65536);
        let max_bytes = u64::from(max_pages) * u64::from(WASM_PAGE);

        // The base can only be stable if the whole range is reserved up
        // front. On 64-bit hosts this is always the case for wasm32.
        match store.engine().tunables().memory_style(&ty) {
            MemoryStyle::Static if MemoryStyle::static_bound().0 >= max_pages => {}
            style => {
                integrity_warn(&format!(
                    "memory style {style:?} does not guarantee a stable base; \
                     guest heap disabled"
                ));
                return None;
            }
        }

        let heap = Arc::new(Self {
            base,
            max_bytes,
            budget,
            charged: AtomicU64::new(0),
            inner: Mutex::new(HeapInner {
                memories: vec![memory.clone()],
                chunks: Vec::new(),
                live: HashMap::new(),
                free_bytes: 0,
                pending_want: 0,
            }),
        });

        {
            // Claim a working arena while a store is unambiguously in hand.
            // Best effort: an allocation that arrives with a store can
            // still claim for itself, so an unfunded heap is slower, not
            // broken. One that arrives without one has only this to draw on.
            let mut inner = heap.inner.lock().expect("guest-heap mutex poisoned");
            if !heap.refill_with_store_locked(&mut inner, store, PREFUND_BYTES) {
                integrity_warn("could not pre-claim the guest heap arena");
            }
        }

        Some(heap)
    }

    /// Host address of guest offset 0.
    #[allow(dead_code)] // consumed by the V8 allocator hooks (next commit)
    pub(crate) fn base(&self) -> *mut u8 {
        self.base
    }

    /// Size in bytes of the guest address range this heap can ever cover.
    #[allow(dead_code)] // consumed by the V8 allocator hooks (next commit)
    pub(crate) fn range_len(&self) -> u64 {
        self.max_bytes
    }

    /// Whether `ptr` points into the guest memory range. Purely an integer
    /// comparison; does not imply the pointer is (or ever was) an allocation.
    pub(crate) fn owns(&self, ptr: *const u8) -> bool {
        let p = ptr as u64;
        let b = self.base as u64;
        p >= b && p < b + self.max_bytes
    }

    pub(crate) fn offset_to_host(&self, offset: u32) -> *mut u8 {
        // SAFETY: callers only pass offsets inside the (reserved) range.
        unsafe { self.base.add(offset as usize) }
    }

    /// Allocate `len` bytes of guest memory, 16-byte aligned. Returns the
    /// guest offset. `zero` clears the payload (freed regions hold stale
    /// bytes). Fails when the memory maximum or the budget is exhausted (or,
    /// for non-shared memories, when the pre-claimed arena runs dry).
    pub(crate) fn alloc(&self, len: usize, zero: bool) -> Option<u32> {
        if len > self.max_bytes as usize {
            return None;
        }
        let units = u32::try_from(len.max(1).div_ceil(UNIT as usize)).ok()?;

        let mut inner = self.inner.lock().expect("guest-heap mutex poisoned");
        let offset = match Self::try_chunks(&mut inner, units) {
            Some(offset) => offset,
            None => {
                // Remember what we needed so a store-side refill can size
                // itself (non-shared lane; harmless for shared).
                inner.pending_want = inner.pending_want.max(units.saturating_mul(UNIT));
                return None;
            }
        };
        drop(inner);

        if zero {
            // SAFETY: `offset..offset+len` lies within a chunk this heap owns
            // (bounds were validated in alloc_locked).
            unsafe { std::ptr::write_bytes(self.base.add(offset as usize), 0, len) };
        }
        Some(offset)
    }

    /// Allocate with explicit access to the store that owns this heap's memory.
    /// Existing arena space remains the fast path; only exhaustion grows the
    /// memory. This is used directly by import handlers and, through a lent
    /// store, by synchronous foreground V8 allocator calls in guarded bridges.
    pub(crate) fn alloc_with_store(
        &self,
        store: &mut StoreMut<'_>,
        len: usize,
        zero: bool,
    ) -> Option<u32> {
        if len > self.max_bytes as usize {
            return None;
        }
        let units = u32::try_from(len.max(1).div_ceil(UNIT as usize)).ok()?;

        let mut inner = self.inner.lock().expect("guest-heap mutex poisoned");
        let offset = if let Some(offset) = Self::try_chunks(&mut inner, units) {
            offset
        } else {
            let needed_bytes = units.checked_mul(UNIT)?;
            if !self.refill_with_store_locked(&mut inner, store, needed_bytes) {
                inner.pending_want = inner.pending_want.max(needed_bytes);
                return None;
            }
            match Self::try_chunks(&mut inner, units) {
                Some(offset) => offset,
                None => {
                    inner.pending_want = inner.pending_want.max(needed_bytes);
                    return None;
                }
            }
        };
        drop(inner);

        if zero {
            // SAFETY: `offset..offset+len` lies within a chunk this heap owns.
            unsafe { std::ptr::write_bytes(self.base.add(offset as usize), 0, len) };
        }
        Some(offset)
    }

    fn try_chunks(inner: &mut HeapInner, units: u32) -> Option<u32> {
        for (idx, chunk) in inner.chunks.iter_mut().enumerate() {
            let Some(allocation) = chunk.alloc.allocate(units) else {
                continue;
            };
            let reserved = chunk.alloc.allocation_size(allocation);
            let rel = allocation.offset.checked_mul(UNIT)?;
            let end = rel.checked_add(units.checked_mul(UNIT)?)?;
            if end > chunk.len {
                // The allocator handed out a range beyond the chunk. This
                // cannot happen unless our own bookkeeping is broken; treat it
                // as fatal for the allocation but not the process.
                chunk.alloc.free(allocation);
                integrity_warn("allocator returned out-of-chunk range");
                return None;
            }
            let offset = chunk.start + rel;
            inner.free_bytes = inner
                .free_bytes
                .saturating_sub(u64::from(reserved) * u64::from(UNIT));
            inner.live.insert(
                offset,
                LiveAlloc {
                    chunk_idx: idx,
                    allocation,
                    len: units * UNIT,
                    units: reserved,
                },
            );
            return Some(offset);
        }
        None
    }

    /// Top the arena up when free space is low or an allocation recently came
    /// up short. Called from import boundaries, where the store is in hand
    /// without any parking, so the arena stays ahead of allocations that
    /// arrive without a store.
    pub(crate) fn maybe_refill(&self, store: &mut StoreMut<'_>) {
        let mut inner = self.inner.lock().expect("guest-heap mutex poisoned");
        if inner.free_bytes >= LOW_WATER_BYTES && inner.pending_want == 0 {
            return;
        }
        let want = inner.pending_want.max(PREFUND_BYTES);
        let _ = self.refill_with_store_locked(&mut inner, store, want);
    }

    fn refill_with_store_locked(
        &self,
        inner: &mut HeapInner,
        store: &mut StoreMut<'_>,
        min_bytes: u32,
    ) -> bool {
        let Some(memory) = inner
            .memories
            .iter()
            .find(|memory| memory.is_from_store(store))
            .cloned()
        else {
            // This store has no handle on the heap's memory, so it is not the
            // store that owns it.
            return false;
        };
        let want_bytes = chunk_size_for(min_bytes);
        let delta_pages = want_bytes.div_ceil(WASM_PAGE);
        // Only charge here when no embedder
        // is already accounting for growth through its tunables.
        let delta_bytes = u64::from(delta_pages) * u64::from(WASM_PAGE);
        let charge = if self.budget.wasm_is_externally_accounted() {
            0
        } else {
            if self
                .budget
                .try_charge(Pool::WasmLinear, delta_bytes)
                .is_err()
            {
                return false;
            }
            delta_bytes
        };

        let prev = match memory.grow(&mut *store, Pages(delta_pages)) {
            Ok(prev) => prev,
            Err(_) => {
                self.budget.uncharge(Pool::WasmLinear, charge);
                return false;
            }
        };
        let base_now = memory.view(store).data_ptr();
        inner.pending_want = 0;
        self.finish_claim(inner, prev, delta_pages, base_now, charge)
            .is_some()
    }

    fn finish_claim(
        &self,
        inner: &mut HeapInner,
        prev: Pages,
        delta_pages: u32,
        base_now: *mut u8,
        charged_bytes: u64,
    ) -> Option<()> {
        // The whole design (external backing stores, cached host pointers)
        // relies on the mapping never moving. A moved base means every live
        // pointer is dangling: abort before anything dereferences one.
        if base_now != self.base {
            eprintln!(
                "[wasmer-napi guest-heap] FATAL: linear memory base moved on grow \
                 ({:p} -> {base_now:p}); aborting",
                self.base
            );
            std::process::abort();
        }

        let start = u64::from(prev.0) * u64::from(WASM_PAGE);
        let len = u64::from(delta_pages) * u64::from(WASM_PAGE);
        // Once the physical grow succeeds its bytes remain resident even if an
        // integrity check prevents this allocator from using the new range.
        self.charged.fetch_add(charged_bytes, Ordering::AcqRel);
        if start + len > self.max_bytes {
            // Cannot happen (grow enforces the maximum), but never hand out
            // ranges beyond the reservation.
            integrity_warn("claimed range beyond memory maximum");
            return None;
        }
        let start = start as u32;
        let len = len as u32;
        inner.chunks.push(Chunk {
            start,
            len,
            alloc: OffsetAllocator::with_max_allocs(len / UNIT, chunk_max_allocs(len)),
        });
        inner.free_bytes += u64::from(len);
        Some(())
    }

    /// Free a previous [`GuestHeap::alloc`] by guest offset. Returns whether
    /// the offset was a live allocation (unknown offsets are rejected and
    /// logged — double-frees and fabricated pointers must not corrupt state).
    pub(crate) fn free_offset(&self, offset: u32) -> bool {
        let mut inner = self.inner.lock().expect("guest-heap mutex poisoned");
        let Some(live) = inner.live.remove(&offset) else {
            integrity_warn("rejecting free of unknown guest offset");
            return false;
        };
        let LiveAlloc {
            chunk_idx,
            allocation,
            units,
            ..
        } = live;
        inner.chunks[chunk_idx].alloc.free(allocation);
        inner.free_bytes += u64::from(units) * u64::from(UNIT);
        true
    }

    /// Free by host pointer, validating length. Returns `false` when the
    /// pointer is not a live allocation of this heap (callers use this to
    /// dispatch mixed-provenance frees).
    pub(crate) fn free_host_ptr(&self, ptr: *mut u8, len: usize) -> bool {
        if !self.owns(ptr) {
            return false;
        }
        let offset = (ptr as u64 - self.base as u64) as u32;
        {
            let inner = self.inner.lock().expect("guest-heap mutex poisoned");
            match inner.live.get(&offset) {
                None => {
                    integrity_warn("rejecting free of unknown in-range pointer");
                    return false;
                }
                Some(live) if len != 0 && u64::from(live.len) < len as u64 => {
                    integrity_warn("rejecting free with mismatched length");
                    return false;
                }
                Some(_) => {}
            }
        }
        self.free_offset(offset)
    }

    /// Requested length of a live allocation, if any.
    #[allow(dead_code)] // consumed by the buffer finalizers (next commit)
    pub(crate) fn live_len(&self, offset: u32) -> Option<u32> {
        let inner = self.inner.lock().expect("guest-heap mutex poisoned");
        inner.live.get(&offset).map(|l| l.len)
    }

    #[cfg(test)]
    fn free_bytes(&self) -> u64 {
        self.inner.lock().unwrap().free_bytes
    }

    #[cfg(test)]
    fn live_count(&self) -> usize {
        self.inner.lock().unwrap().live.len()
    }
}

impl Drop for GuestHeap {
    fn drop(&mut self) {
        let charged = self.charged.load(Ordering::Acquire);
        if charged > 0 {
            self.budget.uncharge(Pool::WasmLinear, charged);
        }
    }
}

// ============================================================
// C hooks for the V8 array-buffer allocator and buffer finalizers
// ============================================================
//
// These strong exports override the weak no-op fallbacks in
// v8/src/unofficial_napi.cc and src/napi_bridge_init.cc (embedders without
// this Rust host — e.g. the native edgejs build — link the no-ops and never
// install a context).
//
// The contexts hold a `Weak<GuestHeap>` plus copied integers, never an `Arc`:
// process-lifetime V8 globals are deliberately leaked (see the exit-race fix),
// and an `Arc` reachable from them would pin the instance's multi-GiB memory
// reservation forever. Ownership decisions use only the integers so a
// guest-heap pointer is never misrouted to the host allocator even after the
// heap is gone.

use std::ffi::c_void;

/// Context installed into a V8 array-buffer allocator
/// (`unofficial_napi_env_create_options.guest_heap`).
pub(crate) struct GuestHeapCtx {
    base: usize,
    len: u64,
    heap: Weak<GuestHeap>,
}

/// Context handed to the buffer-finalizer trampoline for a single
/// guest-heap-backed external buffer.
pub(crate) struct GuestHeapFinalizeCtx {
    heap: Weak<GuestHeap>,
    offset: u32,
}

impl GuestHeap {
    /// Box an allocator context for [`unofficial_napi_env_create_options`].
    /// The receiver takes ownership (released via
    /// [`napi_host_guest_heap_release`]).
    pub(crate) fn make_alloc_ctx(self: &Arc<Self>) -> *mut c_void {
        let p = Box::into_raw(Box::new(GuestHeapCtx {
            base: self.base as usize,
            len: self.max_bytes,
            heap: Arc::downgrade(self),
        }))
        .cast();
        p
    }

    /// Box a finalizer context for one allocation. The bridge takes ownership
    /// on success (released via [`napi_host_guest_heap_buffer_finalize`]);
    /// reclaim with [`GuestHeap::reclaim_finalize_ctx`] on failure.
    pub(crate) fn make_finalize_ctx(self: &Arc<Self>, offset: u32) -> *mut c_void {
        let p = Box::into_raw(Box::new(GuestHeapFinalizeCtx {
            heap: Arc::downgrade(self),
            offset,
        }))
        .cast();
        p
    }

    /// Take back a finalize ctx that was never handed to a live buffer.
    pub(crate) fn reclaim_finalize_ctx(ctx: *mut c_void) {
        if !ctx.is_null() {
            // SAFETY: `ctx` came from `make_finalize_ctx` and was not consumed.
            drop(unsafe { Box::from_raw(ctx.cast::<GuestHeapFinalizeCtx>()) });
        }
    }
}

/// Allocate a V8 backing store inside guest memory. Returns a host pointer,
/// or null when the heap is exhausted/gone (V8 then throws a RangeError).
#[unsafe(no_mangle)]
pub extern "C" fn napi_host_guest_heap_alloc(
    ctx: *const c_void,
    length: usize,
    zero: i32,
) -> *mut c_void {
    if ctx.is_null() {
        return std::ptr::null_mut();
    }
    // SAFETY: `ctx` is a live GuestHeapCtx owned by the calling allocator.
    let ctx = unsafe { &*ctx.cast::<GuestHeapCtx>() };
    let Some(heap) = ctx.heap.upgrade() else {
        return std::ptr::null_mut();
    };
    let offset = Store::with_current(|store| heap.alloc_with_store(store, length, zero != 0))
        .unwrap_or_else(|| heap.alloc(length, zero != 0));
    match offset {
        Some(offset) => heap.offset_to_host(offset).cast(),
        None => std::ptr::null_mut(),
    }
}

/// Free a backing store if it belongs to the guest heap. Returns 1 when the
/// pointer was guest-heap provenance (handled here — the caller must NOT pass
/// it to a host allocator), 0 when it predates the context and belongs to the
/// legacy backing allocator. Ownership is decided by the copied integer range
/// alone: even after the heap is dropped, in-range pointers are claimed (and
/// silently discarded — the mapping is gone, there is nothing to free).
#[unsafe(no_mangle)]
pub extern "C" fn napi_host_guest_heap_free(
    ctx: *const c_void,
    data: *mut c_void,
    length: usize,
) -> i32 {
    if ctx.is_null() || data.is_null() {
        return 0;
    }
    // SAFETY: `ctx` is a live GuestHeapCtx owned by the calling allocator.
    let ctx = unsafe { &*ctx.cast::<GuestHeapCtx>() };
    let addr = data as usize;
    if addr < ctx.base || (addr - ctx.base) as u64 >= ctx.len {
        return 0;
    }
    if let Some(heap) = ctx.heap.upgrade() {
        heap.free_host_ptr(data.cast(), length);
    }
    1
}

/// Release an allocator context (called from the allocator's destructor, or
/// from env-creation failure paths).
#[unsafe(no_mangle)]
pub extern "C" fn napi_host_guest_heap_release(ctx: *mut c_void) {
    if !ctx.is_null() {
        // SAFETY: `ctx` came from `make_alloc_ctx` and is released exactly once.
        drop(unsafe { Box::from_raw(ctx.cast::<GuestHeapCtx>()) });
    }
}

/// Finalizer for guest-heap-backed external buffers: frees the allocation and
/// drops the boxed context. Runs when V8 collects the buffer (any thread).
#[unsafe(no_mangle)]
pub extern "C" fn napi_host_guest_heap_buffer_finalize(_data: *mut c_void, hint: *mut c_void) {
    if hint.is_null() {
        return;
    }
    // SAFETY: `hint` came from `make_finalize_ctx`; the bridge calls this
    // exactly once per successfully created buffer.
    let ctx = unsafe { Box::from_raw(hint.cast::<GuestHeapFinalizeCtx>()) };
    if let Some(heap) = ctx.heap.upgrade() {
        heap.free_offset(ctx.offset);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wasmer::{AsStoreMut, Memory, MemoryType, Store};

    fn shared_heap(
        store: &mut Store,
        budget: Arc<ResourceBudget>,
    ) -> (wasmer::Memory, Arc<GuestHeap>) {
        let ty = MemoryType::new(Pages(64), Some(Pages(2048)), true);
        let memory = Memory::new(&mut *store, ty).expect("create shared memory");
        let heap = {
            let mut store_mut = store.as_store_mut();
            GuestHeap::new(&mut store_mut, &memory, budget).expect("guest heap")
        };
        (memory, heap)
    }

    #[test]
    fn chunk_node_budget_scales_with_chunk_size() {
        // What this pins: `OffsetAllocator::new` sizes every chunk for 128Ki
        // allocations regardless of size, costing ~2 MiB of host metadata per
        // 1 MiB guest chunk and retaining it for the process's life.
        const DEFAULT_MAX_ALLOCS: u32 = 128 * 1024;
        assert!(chunk_max_allocs(MIN_CHUNK_BYTES) < DEFAULT_MAX_ALLOCS / 16);

        // Proportional through the normal range, clamped at both ends.
        assert_eq!(chunk_max_allocs(MIN_CHUNK_BYTES), MIN_CHUNK_BYTES / 256);
        assert_eq!(chunk_max_allocs(64 * 1024 * 1024), MAX_CHUNK_ALLOCS);
        assert_eq!(chunk_max_allocs(0), MIN_CHUNK_ALLOCS);

        // A chunk must still comfortably hold the buffers this heap actually
        // serves: request bodies arrive as ~10 KiB pieces, ~102 to a 1 MiB chunk.
        let per_chunk = MIN_CHUNK_BYTES as usize / 10240;
        assert!(chunk_max_allocs(MIN_CHUNK_BYTES) as usize > 2 * per_chunk);
    }

    /// A chunk's node budget must not cap it below the allocations it can
    /// physically hold at the sizes this heap serves.
    #[test]
    fn chunk_serves_its_capacity_in_realistic_buffers() {
        let mut store = Store::default();
        let (_memory, heap) = shared_heap(&mut store, ResourceBudget::unlimited());

        // Fill well past a single 1 MiB chunk with 10 KiB buffers.
        let mut offsets = Vec::new();
        for _ in 0..512 {
            let offset = heap.alloc(10 * 1024, false).expect("10 KiB alloc");
            offsets.push(offset);
        }
        assert_eq!(heap.live_count(), offsets.len());

        for offset in offsets {
            assert!(heap.free_offset(offset));
        }
        assert_eq!(heap.live_count(), 0);
    }

    #[test]
    fn alloc_free_zero_and_validation() {
        let mut store = Store::default();
        let (_memory, heap) = shared_heap(&mut store, ResourceBudget::unlimited());

        let a = heap.alloc(100, true).expect("alloc a");
        let b = heap.alloc(4096, true).expect("alloc b");
        assert_ne!(a, b);
        assert_eq!(a % 16, 0);
        assert_eq!(b % 16, 0);

        // Zeroed payloads.
        let pa = heap.offset_to_host(a);
        // SAFETY: a..a+100 is an allocation we own.
        unsafe {
            assert!(std::slice::from_raw_parts(pa, 100).iter().all(|&x| x == 0));
            *pa = 0xAB;
        }

        assert_eq!(heap.live_len(a), Some(112)); // rounded to 16-byte units
        assert!(heap.free_offset(a));
        // Double-free and fabricated offsets are rejected.
        assert!(!heap.free_offset(a));
        assert!(!heap.free_offset(12345));

        // Freed space is reusable, and a reused region can be re-zeroed.
        let c = heap.alloc(100, true).expect("alloc c");
        let pc = heap.offset_to_host(c);
        // SAFETY: c..c+100 is an allocation we own.
        unsafe {
            assert!(std::slice::from_raw_parts(pc, 100).iter().all(|&x| x == 0));
        }
        assert!(heap.free_offset(c));
        assert!(heap.free_offset(b));
        assert_eq!(heap.live_count(), 0);
    }

    #[test]
    fn free_host_ptr_validates_ownership_and_length() {
        let mut store = Store::default();
        let (_memory, heap) = shared_heap(&mut store, ResourceBudget::unlimited());

        let a = heap.alloc(64, false).expect("alloc");
        let pa = heap.offset_to_host(a);
        assert!(heap.owns(pa));
        assert!(!heap.owns(std::ptr::null()));
        // Interior pointers and foreign pointers are rejected without effect.
        // SAFETY: pointer arithmetic only.
        assert!(!heap.free_host_ptr(unsafe { pa.add(8) }, 56));
        // Over-long length claims are rejected.
        assert!(!heap.free_host_ptr(pa, 4096));
        assert!(heap.free_host_ptr(pa, 64));
        assert!(!heap.free_host_ptr(pa, 64));
    }

    #[test]
    fn interleaved_guest_grows_stay_disjoint() {
        let mut store = Store::default();
        let (memory, heap) = shared_heap(&mut store, ResourceBudget::unlimited());

        // Simulate the guest's sbrk racing our claims: interleave direct grows
        // of the same memory with heap allocations that trigger claims.
        let mut offsets = Vec::new();
        for round in 0..4 {
            let big = heap
                .alloc(2 * 1024 * 1024 + round * 4096, false)
                .expect("big alloc");
            offsets.push((big, 2 * 1024 * 1024 + round * 4096));
            memory.grow(&mut store, Pages(3)).expect("guest-style grow");
        }
        // No two allocations overlap.
        offsets.sort();
        for w in offsets.windows(2) {
            let (a_off, a_len) = w[0];
            let (b_off, _) = w[1];
            assert!(u64::from(a_off) + a_len as u64 <= u64::from(b_off));
        }
        for (off, _) in offsets {
            assert!(heap.free_offset(off));
        }
    }

    #[test]
    fn threaded_alloc_free_without_store() {
        let mut store = Store::default();
        let (_memory, heap) = shared_heap(&mut store, ResourceBudget::unlimited());

        let mut handles = Vec::new();
        for t in 0..8 {
            let heap = Arc::clone(&heap);
            handles.push(std::thread::spawn(move || {
                for i in 0..200 {
                    let len = 16 + ((t * 200 + i) % 4000);
                    let off = heap.alloc(len, i % 2 == 0).expect("threaded alloc");
                    assert_eq!(off % 16, 0);
                    assert!(heap.free_offset(off));
                }
            }));
        }
        for h in handles {
            h.join().expect("thread");
        }
        assert_eq!(heap.live_count(), 0);
    }

    #[test]
    fn budget_charged_and_released_on_drop() {
        let mut store = Store::default();
        // Under the prefund, so the arena claims what the budget allows and no
        // more; the allocations below have to claim for themselves.
        let budget = ResourceBudget::with_memory_limit(8 * 1024 * 1024);
        let (_memory, heap) = shared_heap(&mut store, Arc::clone(&budget));

        let charged_after_prefund = budget.memory_charged();
        assert!(charged_after_prefund <= 8 * 1024 * 1024);

        let a = heap
            .alloc_with_store(&mut store.as_store_mut(), 1024, false)
            .expect("alloc under budget");
        assert!(budget.memory_charged() >= 1024 * 1024); // at least one chunk claimed

        // A request beyond the budget is denied without corrupting state.
        assert!(
            heap.alloc_with_store(&mut store.as_store_mut(), 64 * 1024 * 1024, false)
                .is_none()
        );
        assert!(heap.free_offset(a));

        drop(heap);
        assert_eq!(budget.memory_charged(), 0);
    }

    /// The heap grows through an explicitly supplied store. Without one it is
    /// limited to the arena it already claimed — which is the case the prefund
    /// and [`GuestHeap::maybe_refill`] exist to cover.
    #[test]
    fn growth_needs_an_explicit_store_and_the_arena_covers_the_rest() {
        let mut store = Store::default();
        let (_memory, heap) = shared_heap(&mut store, ResourceBudget::unlimited());

        // Served from the prefunded arena, with no store at all: this is
        // the V8-background-thread case.
        let from_arena = heap.alloc(1024, false).expect("served from the arena");
        assert!(heap.free_offset(from_arena));

        // Past what the arena holds, and with no store, the allocation
        // fails rather than growing the guest's memory behind its back.
        let past_arena = (PREFUND_BYTES as usize) * 2;
        assert!(heap.alloc(past_arena, false).is_none());

        // Supply one, and the same request claims the pages it needs.
        let grown = heap
            .alloc_with_store(&mut store.as_store_mut(), past_arena, false)
            .expect("claims with an explicit store");
        assert!(heap.free_offset(grown));
    }

    /// The foreign V8 allocator has no Rust store argument. It may recover a
    /// store only while an explicitly guarded bridge lends one; otherwise it
    /// is limited to the already-prefunded arena.
    #[test]
    fn allocator_hook_grows_only_with_a_lent_store() {
        let mut store = Store::default();
        let (_memory, heap) = shared_heap(&mut store, ResourceBudget::unlimited());
        let ctx = heap.make_alloc_ctx();
        let past_arena = (PREFUND_BYTES as usize) * 2;

        let without_guard = napi_host_guest_heap_alloc(ctx, past_arena, 0);
        assert!(without_guard.is_null());

        let with_guard = store
            .as_store_mut()
            .parked(|| napi_host_guest_heap_alloc(ctx, past_arena, 0));
        assert!(!with_guard.is_null());
        assert_eq!(napi_host_guest_heap_free(ctx, with_guard, past_arena), 1);

        napi_host_guest_heap_release(ctx);
    }

    /// A store that has not registered a handle on this heap's memory cannot
    /// grow it even when supplied explicitly.
    #[test]
    fn an_unregistered_store_does_not_grow_the_memory() {
        let mut store = Store::default();
        let (_memory, heap) = shared_heap(&mut store, ResourceBudget::unlimited());

        let mut stranger = Store::default();
        let past_arena = (PREFUND_BYTES as usize) * 2;
        assert!(
            heap.alloc_with_store(&mut stranger.as_store_mut(), past_arena, false)
                .is_none(),
            "another store's handle must not be used to grow this memory"
        );
    }

    #[test]
    fn successful_shared_grow_stays_charged_after_integrity_rejection() {
        let mut store = Store::default();
        let budget = ResourceBudget::with_memory_limit(2 * u64::from(WASM_PAGE));
        let (_memory, heap) = shared_heap(&mut store, Arc::clone(&budget));
        let charged = u64::from(WASM_PAGE);
        budget.try_charge(Pool::WasmLinear, charged).unwrap();

        {
            let mut inner = heap.inner.lock().unwrap();
            assert!(
                heap.finish_claim(&mut inner, Pages(2048), 1, heap.base, charged)
                    .is_none()
            );
        }
        assert_eq!(budget.memory_charged(), charged);

        drop(heap);
        assert_eq!(budget.memory_charged(), 0);
    }

    #[test]
    fn prefunds_and_refills() {
        let mut store = Store::default();
        let ty = MemoryType::new(Pages(64), Some(Pages(2048)), false);
        let memory = Memory::new(&mut store, ty).expect("create owned memory");
        let heap = {
            let mut store_mut = store.as_store_mut();
            GuestHeap::new(&mut store_mut, &memory, ResourceBudget::unlimited())
                .expect("guest heap")
        };

        // Prefunded arena serves store-free allocations.
        let a = heap.alloc(1024 * 1024, true).expect("alloc from prefund");
        let before = heap.free_bytes();

        // Exhaust beyond the arena: allocation fails (no store to grow with)…
        assert!(heap.alloc(64 * 1024 * 1024, false).is_none());

        // …and a store-side refill makes progress again.
        {
            let mut store_mut = store.as_store_mut();
            heap.maybe_refill(&mut store_mut);
        }
        assert!(heap.free_bytes() > before);
        let b = heap.alloc(20 * 1024 * 1024, false);
        assert!(b.is_some(), "refill should cover the pending want");
        assert!(heap.free_offset(b.unwrap()));
        assert!(heap.free_offset(a));
    }
}
