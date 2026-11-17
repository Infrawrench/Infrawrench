use crate::syscalls::*;

/// Free a previously allocated slot for a closure in the `__indirect_function_table`
///
/// After calling this it is undefined behavior to call the function at the given index.
#[instrument(level = "trace", fields(%closure), ret)]
pub fn closure_free(
    mut ctx: FunctionEnvMut<'_, WasiEnv>,
    closure: u32,
) -> Result<Errno, WasiError> {
    WasiEnv::do_pending_operations(&mut ctx)?;

    let (env, mut store) = ctx.data_and_store_mut();

    let Some(linker) = env.inner().linker().cloned() else {
        error!("Closures only work for dynamic modules.");
        return Ok(Errno::Notsup);
    };

    // iwci patch (#1304): a failure here is reported to the guest, as
    // `closure_allocate`'s is, not a panic.
    if let Err(e) = linker.free_closure_index(&mut ctx, closure) {
        error!("Failed to free closure index {closure}: {e}");
        return Ok(Errno::Fault);
    }

    return Ok(Errno::Success);
}
