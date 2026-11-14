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
use std::sync::atomic::{AtomicBool, Ordering};

use wasmer::sys::vm::{
    LinearMemory, MemoryError, MemoryStyle, TableStyle, ThreadConditions, Trap, VMConfig, VMMemory,
    VMMemoryDefinition, VMSharedMemory, VMTable, VMTableDefinition,
};
use wasmer::sys::{BaseTunables, Tunables};
use wasmer::{MemoryType, Pages, TableType, WASM_PAGE_SIZE};

use crate::cache::JobModules;

/// Tunables that cap every linear memory at `max_pages` and run guests on a
/// native stack of `stack_bytes`.
pub(crate) struct LimitingTunables {
    base: BaseTunables,
    max_pages: Pages,
    vmconfig: VMConfig,
    /// Set when a memory could not be created or grown because of the cap,
    /// which is how a job learns it ran out of memory rather than crashed.
    hit_limit: Arc<AtomicBool>,
    /// The job's modules, kept for as long as any of its stores.
    _modules: Option<JobModules>,
}

impl LimitingTunables {
    pub(crate) fn new(memory_bytes: u64, stack_bytes: usize, hit_limit: Arc<AtomicBool>) -> Self {
        let pages = (memory_bytes / WASM_PAGE_SIZE as u64).clamp(1, u64::from(u32::MAX >> 16) + 1);
        Self {
            base: BaseTunables::new(),
            max_pages: Pages(pages as u32),
            vmconfig: VMConfig {
                wasm_stack_size: Some(stack_bytes),
            },
            hit_limit,
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
        Ok(TrackedMemory::wrap(memory.0, self.hit_limit.clone()))
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
        Ok(TrackedMemory::wrap(memory.0, self.hit_limit.clone()))
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

/// A linear memory that records a refused `grow`. Everything else is the
/// wrapped memory's own behaviour.
#[derive(Debug)]
struct TrackedMemory {
    inner: Box<dyn LinearMemory + Send + Sync + 'static>,
    hit_limit: Arc<AtomicBool>,
}

impl TrackedMemory {
    fn wrap(
        inner: Box<dyn LinearMemory + Send + Sync + 'static>,
        hit: Arc<AtomicBool>,
    ) -> VMMemory {
        VMMemory(Box::new(TrackedMemory {
            inner,
            hit_limit: hit,
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
        self.note(result)
    }

    fn grow_at_least(&mut self, min_size: u64) -> Result<(), MemoryError> {
        let result = self.inner.grow_at_least(min_size);
        self.note(result)
    }

    fn reset(&mut self) -> Result<(), MemoryError> {
        self.inner.reset()
    }

    fn vmmemory(&self) -> NonNull<VMMemoryDefinition> {
        self.inner.vmmemory()
    }

    fn try_clone(&self) -> Result<Box<dyn LinearMemory + Send + Sync + 'static>, MemoryError> {
        Ok(Box::new(TrackedMemory {
            inner: self.inner.try_clone()?,
            hit_limit: self.hit_limit.clone(),
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
        Ok(Box::new(TrackedMemory {
            inner: self.inner.copy()?,
            hit_limit: self.hit_limit.clone(),
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
