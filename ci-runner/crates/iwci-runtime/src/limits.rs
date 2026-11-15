//! Per-job resource limits, enforced through wasmer's `Tunables`.
//!
//! Tunables belong to an engine, but compiled code only depends on the
//! memory and table *styles* they choose. A clone of a job's engine with
//! different tunables therefore runs the same compiled artifacts while
//! creating memories with a different ceiling and running guests on a
//! different native stack. Every store of a job is built on such a clone,
//! and since every store holds its engine's tunables, they also hold the
//! job's compiled modules (cache.rs).

use std::ptr::NonNull;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use wasmer::sys::vm::{
    LinearMemory, MemoryError, MemoryStyle, TableStyle, ThreadConditions, Trap, VMConfig, VMMemory,
    VMMemoryDefinition, VMSharedMemory, VMTable, VMTableDefinition,
};
use wasmer::sys::{BaseTunables, Tunables};
use wasmer::{MemoryType, Pages, TableType, WASM_PAGE_SIZE};

use crate::cache::JobModules;

/// How much memory a job holds, and the most it held at once: the sizes of
/// its live linear memories (every process and thread group of the job and
/// of its services has one), plus what its Node reports of its V8 heaps
/// (`MemoryMeter::set_heaps`). A job's report carries the peak, so a
/// pipeline can size `memory:` from what its jobs used.
///
/// It counts a V8 heap twice over, for two readers. Against `memory:` a
/// heap counts for the room it has reserved, which is what it is refused
/// or stopped by (`peak`). What the job holds of the host's memory is what
/// the heap has committed, a half to a fifth of that room (`held_peak`),
/// and that is what the runner's budget may admit other jobs beside.
#[derive(Default)]
pub(crate) struct MemoryMeter {
    /// Bytes of linear memory alive now.
    linear: AtomicU64,
    /// The room the job's V8 heaps had reserved when last read.
    heaps: AtomicU64,
    /// The most `linear + heaps` has been.
    peak: AtomicU64,
    /// What the job's V8 heaps had committed when last read.
    committed: AtomicU64,
    /// The most `linear + committed` has been.
    held_peak: AtomicU64,
    /// Told each new `held_peak`.
    watch: Option<crate::MemoryWatch>,
}

impl std::fmt::Debug for MemoryMeter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("MemoryMeter")
            .field("linear", &self.linear)
            .field("heaps", &self.heaps)
            .field("peak", &self.peak)
            .field("committed", &self.committed)
            .field("held_peak", &self.held_peak)
            .finish_non_exhaustive()
    }
}

impl MemoryMeter {
    /// A meter that tells `watch` whenever the job holds more than it has
    /// before.
    pub(crate) fn watched(watch: Option<crate::MemoryWatch>) -> Self {
        Self {
            watch,
            ..Self::default()
        }
    }

    fn grew(&self, bytes: u64) {
        let linear = self.linear.fetch_add(bytes, Ordering::AcqRel) + bytes;
        self.note(linear + self.heaps.load(Ordering::Acquire));
        self.note_held(linear + self.committed.load(Ordering::Acquire));
    }

    fn shrank(&self, bytes: u64) {
        self.linear.fetch_sub(bytes, Ordering::AcqRel);
    }

    fn note(&self, total: u64) {
        self.peak.fetch_max(total, Ordering::AcqRel);
    }

    fn note_held(&self, total: u64) {
        let before = self.held_peak.fetch_max(total, Ordering::AcqRel);
        if total > before
            && let Some(watch) = &self.watch
        {
            watch(total);
        }
    }

    /// What the job's V8 heaps hold now, read by whoever waits for the job:
    /// the room they have `reserved` and what they have `committed`.
    pub(crate) fn set_heaps(&self, reserved: u64, committed: u64) {
        self.heaps.store(reserved, Ordering::Release);
        self.committed.store(committed, Ordering::Release);
        let linear = self.linear.load(Ordering::Acquire);
        self.note(linear + reserved);
        self.note_held(linear + committed);
    }

    /// The most the job held at once against its `memory:`, in bytes.
    pub(crate) fn peak(&self) -> u64 {
        self.peak.load(Ordering::Acquire)
    }

    /// The most of the host's memory the job held at once, in bytes.
    pub(crate) fn held_peak(&self) -> u64 {
        self.held_peak.load(Ordering::Acquire)
    }
}

/// One linear memory's share of a [`MemoryMeter`]: its size as last seen,
/// taken off the meter when its last handle goes. Handles to the same
/// memory (`try_clone`) share one, so a shared memory counts once.
#[derive(Debug)]
struct Metered {
    meter: Arc<MemoryMeter>,
    bytes: AtomicU64,
}

impl Metered {
    fn new(meter: Arc<MemoryMeter>, memory: &dyn LinearMemory) -> Arc<Self> {
        let metered = Arc::new(Self {
            meter,
            bytes: AtomicU64::new(0),
        });
        metered.resized(memory);
        metered
    }

    /// Reads the memory's size again, after anything that may change it.
    fn resized(&self, memory: &dyn LinearMemory) {
        let now = memory.size().bytes().0 as u64;
        let before = self.bytes.swap(now, Ordering::AcqRel);
        if now >= before {
            self.meter.grew(now - before);
        } else {
            self.meter.shrank(before - now);
        }
    }
}

impl Drop for Metered {
    fn drop(&mut self) {
        self.meter.shrank(*self.bytes.get_mut());
    }
}

/// Tunables that cap every linear memory at `max_pages` and run guests on a
/// native stack of `stack_bytes`.
pub(crate) struct LimitingTunables {
    base: BaseTunables,
    max_pages: Pages,
    vmconfig: VMConfig,
    /// Set when a memory could not be created or grown because of the cap,
    /// which is how a job learns it ran out of memory rather than crashed.
    hit_limit: Arc<AtomicBool>,
    /// Counts the memories these make.
    meter: Arc<MemoryMeter>,
    /// The job's modules, kept for as long as any of its stores.
    _modules: Option<JobModules>,
}

impl LimitingTunables {
    pub(crate) fn new(
        memory_bytes: u64,
        stack_bytes: usize,
        hit_limit: Arc<AtomicBool>,
        meter: Arc<MemoryMeter>,
    ) -> Self {
        let pages = (memory_bytes / WASM_PAGE_SIZE as u64).clamp(1, u64::from(u32::MAX >> 16) + 1);
        Self {
            base: BaseTunables::new(),
            max_pages: Pages(pages as u32),
            vmconfig: VMConfig {
                wasm_stack_size: Some(stack_bytes),
            },
            hit_limit,
            meter,
            _modules: None,
        }
    }

    /// Keeps `modules` alive for as long as any store made with these.
    pub(crate) fn holding(mut self, modules: JobModules) -> Self {
        self._modules = Some(modules);
        self
    }

    /// `ty` with its maximum lowered to the cap, or an error when even its
    /// minimum is over it.
    fn limited(&self, ty: &MemoryType) -> Result<MemoryType, MemoryError> {
        if ty.minimum > self.max_pages {
            self.hit_limit.store(true, Ordering::Release);
            return Err(MemoryError::MinimumMemoryTooLarge {
                min_requested: ty.minimum,
                max_allowed: self.max_pages,
            });
        }
        let mut ty = *ty;
        ty.maximum = Some(match ty.maximum {
            Some(max) if max < self.max_pages => max,
            _ => self.max_pages,
        });
        Ok(ty)
    }
}

impl Tunables for LimitingTunables {
    fn memory_style(&self, memory: &MemoryType) -> MemoryStyle {
        // Must stay the base style: compiled artifacts are shared with the
        // engine that compiled them and bake the style into bounds checks.
        self.base.memory_style(memory)
    }

    fn table_style(&self, table: &TableType) -> TableStyle {
        self.base.table_style(table)
    }

    fn create_host_memory(
        &self,
        ty: &MemoryType,
        style: &MemoryStyle,
    ) -> Result<VMMemory, MemoryError> {
        let ty = self.limited(ty)?;
        let memory = self.base.create_host_memory(&ty, style)?;
        Ok(TrackedMemory::wrap(
            memory.0,
            self.hit_limit.clone(),
            self.meter.clone(),
        ))
    }

    unsafe fn create_vm_memory(
        &self,
        ty: &MemoryType,
        style: &MemoryStyle,
        vm_definition_location: NonNull<VMMemoryDefinition>,
    ) -> Result<VMMemory, MemoryError> {
        let ty = self.limited(ty)?;
        // SAFETY: forwarded unchanged from the caller, which upholds the
        // contract of `Tunables::create_vm_memory`.
        let memory = unsafe {
            self.base
                .create_vm_memory(&ty, style, vm_definition_location)?
        };
        Ok(TrackedMemory::wrap(
            memory.0,
            self.hit_limit.clone(),
            self.meter.clone(),
        ))
    }

    fn create_host_table(&self, ty: &TableType, style: &TableStyle) -> Result<VMTable, String> {
        self.base.create_host_table(ty, style)
    }

    unsafe fn create_vm_table(
        &self,
        ty: &TableType,
        style: &TableStyle,
        vm_definition_location: NonNull<VMTableDefinition>,
    ) -> Result<VMTable, String> {
        // SAFETY: forwarded unchanged, as above.
        unsafe { self.base.create_vm_table(ty, style, vm_definition_location) }
    }

    fn vmconfig(&self) -> &VMConfig {
        &self.vmconfig
    }
}

/// A linear memory that records a refused `grow` and keeps its size on the
/// job's meter. Everything else is the wrapped memory's own behaviour.
#[derive(Debug)]
struct TrackedMemory {
    inner: Box<dyn LinearMemory + Send + Sync + 'static>,
    hit_limit: Arc<AtomicBool>,
    metered: Arc<Metered>,
}

impl TrackedMemory {
    fn wrap(
        inner: Box<dyn LinearMemory + Send + Sync + 'static>,
        hit: Arc<AtomicBool>,
        meter: Arc<MemoryMeter>,
    ) -> VMMemory {
        let metered = Metered::new(meter, inner.as_ref());
        VMMemory(Box::new(TrackedMemory {
            inner,
            hit_limit: hit,
            metered,
        }))
    }

    fn note<T>(&self, result: Result<T, MemoryError>) -> Result<T, MemoryError> {
        if let Err(MemoryError::CouldNotGrow { .. }) = &result {
            self.hit_limit.store(true, Ordering::Release);
        }
        result
    }
}

impl LinearMemory for TrackedMemory {
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
        let result = self.inner.grow(delta);
        self.metered.resized(self.inner.as_ref());
        self.note(result)
    }

    fn grow_at_least(&mut self, min_size: u64) -> Result<(), MemoryError> {
        let result = self.inner.grow_at_least(min_size);
        self.metered.resized(self.inner.as_ref());
        self.note(result)
    }

    fn reset(&mut self) -> Result<(), MemoryError> {
        let result = self.inner.reset();
        self.metered.resized(self.inner.as_ref());
        result
    }

    fn vmmemory(&self) -> NonNull<VMMemoryDefinition> {
        self.inner.vmmemory()
    }

    fn try_clone(&self) -> Result<Box<dyn LinearMemory + Send + Sync + 'static>, MemoryError> {
        // Another handle to the same memory: one share of the meter.
        Ok(Box::new(TrackedMemory {
            inner: self.inner.try_clone()?,
            hit_limit: self.hit_limit.clone(),
            metered: self.metered.clone(),
        }))
    }

    unsafe fn initialize_with_data(&self, start: usize, data: &[u8]) -> Result<(), Trap> {
        // SAFETY: forwarded unchanged to the wrapped memory.
        unsafe { self.inner.initialize_with_data(start, data) }
    }

    /// Forwarded too, or `memory.init` would copy a large data segment
    /// rather than map it (#996, vendor/README.md).
    fn claim_data_mapping(&self) -> bool {
        self.inner.claim_data_mapping()
    }

    fn copy(&self) -> Result<Box<dyn LinearMemory + Send + Sync + 'static>, MemoryError> {
        // A memory of its own (a forked process), counted on its own.
        let inner = self.inner.copy()?;
        let metered = Metered::new(self.metered.meter.clone(), inner.as_ref());
        Ok(Box::new(TrackedMemory {
            inner,
            hit_limit: self.hit_limit.clone(),
            metered,
        }))
    }

    fn as_shared(&self) -> Result<VMSharedMemory, MemoryError> {
        self.inner.as_shared()
    }

    unsafe fn do_wait(
        &mut self,
        dst: u32,
        expected: wasmer::sys::vm::ExpectedValue,
        timeout: Option<std::time::Duration>,
    ) -> Result<u32, wasmer::sys::vm::WaiterError> {
        // SAFETY: forwarded unchanged; the caller upholds alignment and bounds.
        unsafe { self.inner.do_wait(dst, expected, timeout) }
    }

    fn do_notify(&mut self, dst: u32, count: u32) -> u32 {
        self.inner.do_notify(dst, count)
    }

    fn thread_conditions(&self) -> Option<&ThreadConditions> {
        self.inner.thread_conditions()
    }
}
