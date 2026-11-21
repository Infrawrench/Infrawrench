use crate::syscalls::*;

/// Allocate a new slot in the __indirect_function_table for a closure
///
/// Until the slot is prepared with [`closure_prepare`], it is undefined behavior to call the function at the given index.
///
/// The slot should be freed with [`closure_free`] when it is no longer needed.
#[instrument(level = "trace", skip_all, ret)]
pub fn closure_allocate<M: MemorySize>(
    mut ctx: FunctionEnvMut<'_, WasiEnv>,
    closure: WasmPtr<u32, M>,
) -> Result<Errno, WasiError> {
    WasiEnv::do_pending_operations(&mut ctx)?;

    let (env, mut store) = ctx.data_and_store_mut();
    let Some(linker) = env.inner().linker().cloned() else {
        error!("Closures only work for dynamic modules.");
        return Ok(Errno::Notsup);
    };

    let function_id = match linker.allocate_closure_index(&mut ctx) {
        Ok(f) => f,
        Err(e) => {
            // Should never happen
            error!("Failed to allocate closure index: {e}");
            return Ok(Errno::Fault);
        }
    };

    let (env, mut store) = ctx.data_and_store_mut();
    let memory = unsafe { env.memory_view(&store) };
    // iwci patch (#1304): a pointer the index cannot be written to is the
    // guest's error, and the slot goes back rather than staying allocated
    // with nobody knowing its index.
    if let Err(e) = closure.write(&memory, function_id) {
        _ = linker.free_closure_index(&mut ctx, function_id);
        return Ok(mem_error_to_wasi(e));
    }
    return Ok(Errno::Success);
}
