use std::ffi::c_void;

use wasmer::{AsStoreMut, FunctionEnv, FunctionEnvMut, Store, StoreMut, Table, Value};
use wasmer_wasix::WasiError;
use wasmer_wasix::wasmer_wasix_types::wasi::ExitCode;

use crate::{NapiEnv, snapi::SnapiEnv};

thread_local! {
    /// A guest instance exit (`WasiError::Exit`) that trapped out of a guest
    /// callback and must be re-raised through the N-API import layers.
    ///
    /// When the guest calls `_exit`/`proc_exit` — e.g. Node's fatal-exception
    /// path taking `std::_Exit` on the main thread after an unhandled exception
    /// — WASI `proc_exit` unwinds the guest and the [`func.call`] that dispatched
    /// the callback returns a trap carrying [`WasiError::Exit`]. The trampoline
    /// runs inside host V8 (a native C++ frame that cannot carry a Rust trap), so
    /// it cannot re-raise directly. Instead it stashes the exit here; the nearest
    /// enclosing N-API import boundary ([`with_cb_context`]) takes it back out and
    /// returns it as an `Err`, so wasmer re-raises the same exit through every
    /// guest→host layer until the runner (`bin_factory`/`thread_spawn`) handles
    /// it — the standard WASIX process-exit propagation. Swallowing it (the old
    /// behavior) left the host event loop spinning forever (observed as
    /// `test-tls-handshake-exception` hanging).
    ///
    /// This terminates only the guest instance whose callback exited, never the
    /// host process.
    ///
    /// [`func.call`]: wasmer::Function::call
    /// [`with_cb_context`]: crate::guest::napi::with_cb_context
    static PENDING_GUEST_EXIT: std::cell::Cell<Option<ExitCode>> =
        const { std::cell::Cell::new(None) };
}

/// If a guest callback trapped with a WASI process exit, stash the exit code so
/// the enclosing import boundary can re-raise it, and report whether it did.
/// Non-exit traps return `false` and are left for the caller to log.
fn stash_guest_exit(err: &wasmer::RuntimeError) -> bool {
    if let Some(WasiError::Exit(code)) = err.downcast_ref::<WasiError>() {
        PENDING_GUEST_EXIT.with(|slot| slot.set(Some(*code)));
        return true;
    }
    false
}

/// Take a pending guest instance exit stashed by a callback trampoline, if any.
/// Called at each N-API import boundary to re-raise the exit outward.
pub(crate) fn take_pending_guest_exit() -> Option<ExitCode> {
    PENDING_GUEST_EXIT.with(|slot| slot.take())
}

/// What a V8 callback needs to reach the guest: a handle to the N-API env of
/// the import that installed it. The handle is store-free, so this holds
/// nothing that points into the installer's stack frame — the store itself is
/// picked back up from the thread, which the installer lends by parking its
/// own borrow (see [`with_callback_state`]). C++ only ever passes this back as
/// an opaque pointer.
struct CallbackInvocationCtx {
    func_env: FunctionEnv<NapiEnv>,
}

fn call_guest_callback(
    store: &mut StoreMut<'_>,
    func_env: &FunctionEnv<NapiEnv>,
    table: &Table,
    guest_env: i32,
    wasm_fn_ptr: u32,
    callback_arg: u32,
) -> u32 {
    let func = match func_env.as_ref(store).func_cache.get(&wasm_fn_ptr).cloned() {
        Some(func) => func,
        None => {
            let Some(elem) = table.get(store, wasm_fn_ptr) else {
                return 0;
            };
            let func = match elem {
                Value::FuncRef(Some(func)) => func,
                Value::FuncRef(None) => return 0,
                _ => return 0,
            };
            func_env
                .as_mut(store)
                .func_cache
                .insert(wasm_fn_ptr, func.clone());
            func
        }
    };
    match func.call(
        store,
        &[Value::I32(guest_env), Value::I32(callback_arg as i32)],
    ) {
        Ok(ret_vals) => match ret_vals.first() {
            Some(Value::I32(v)) => *v as u32,
            Some(Value::I64(v)) => *v as u32,
            _ => 0,
        },
        Err(err) => {
            if stash_guest_exit(&err) {
                return 0;
            }
            eprintln!("[callback trampoline] error calling function: {err}");
            0
        }
    }
}

/// Like [`call_guest_callback`] but passes two data arguments in addition to
/// the guest env handle. Used to dispatch N-API finalizers into the guest,
/// whose ABI is `void finalize(napi_env env, void* data, void* hint)`.
fn call_guest_callback2(
    store: &mut StoreMut<'_>,
    func_env: &FunctionEnv<NapiEnv>,
    table: &Table,
    guest_env: i32,
    wasm_fn_ptr: u32,
    arg0: u32,
    arg1: u32,
) -> u32 {
    let func = match func_env.as_ref(store).func_cache.get(&wasm_fn_ptr).cloned() {
        Some(func) => func,
        None => {
            let Some(elem) = table.get(store, wasm_fn_ptr) else {
                return 0;
            };
            let func = match elem {
                Value::FuncRef(Some(func)) => func,
                Value::FuncRef(None) => return 0,
                _ => return 0,
            };
            func_env
                .as_mut(store)
                .func_cache
                .insert(wasm_fn_ptr, func.clone());
            func
        }
    };
    match func.call(
        store,
        &[
            Value::I32(guest_env),
            Value::I32(arg0 as i32),
            Value::I32(arg1 as i32),
        ],
    ) {
        Ok(ret_vals) => match ret_vals.first() {
            Some(Value::I32(v)) => *v as u32,
            Some(Value::I64(v)) => *v as u32,
            _ => 0,
        },
        Err(err) => {
            if stash_guest_exit(&err) {
                return 0;
            }
            eprintln!("[finalizer trampoline] error calling guest finalizer: {err}");
            0
        }
    }
}

/// Install a callback-invocation context for the duration of `f`, so host V8
/// callbacks fired inside the bridge call can be dispatched into the wasm
/// guest (see [`snapi_host_invoke_wasm_callback`]).
pub fn with_callback_state<R>(
    env: &mut FunctionEnvMut<NapiEnv>,
    snapi_env: SnapiEnv,
    f: impl FnOnce() -> R,
) -> R {
    if snapi_env.is_null() {
        // There is no guest callback context to install. Keep this path out of
        // Wasmer's store-lending TLS; callers that allocate guest memory pass
        // their store explicitly.
        return f();
    }

    let mut ctx = CallbackInvocationCtx {
        func_env: env.as_ref(),
    };
    let prev = unsafe {
        crate::snapi::snapi_bridge_swap_active_callback_ctx(
            snapi_env,
            (&mut ctx as *mut CallbackInvocationCtx).cast::<c_void>(),
        )
    };
    struct CallbackStateGuard {
        snapi_env: SnapiEnv,
        prev: *mut c_void,
    }
    impl Drop for CallbackStateGuard {
        fn drop(&mut self) {
            unsafe {
                crate::snapi::snapi_bridge_swap_active_callback_ctx(self.snapi_env, self.prev);
            }
        }
    }
    let _guard = CallbackStateGuard { snapi_env, prev };
    // Only bridges explicitly wrapped in this invocation guard lend the store.
    // Ordinary N-API imports keep their store local and pass it directly to
    // guest-heap allocation instead of publishing it through runtime TLS.
    env.as_store_mut().parked(f)
}

/// Rust trampoline called from C++ when a V8 callback fires.
/// Re-enters the active guest callback scope and dispatches into the WASM guest.
#[unsafe(no_mangle)]
pub extern "C" fn snapi_host_invoke_wasm_callback(
    callback_ctx: *mut c_void,
    guest_env: u32,
    wasm_fn_ptr: u32,
    callback_arg: u32,
) -> u32 {
    if callback_ctx.is_null() {
        eprintln!("[callback trampoline] no active callback scope available");
        return 0;
    }
    // SAFETY: `callback_ctx` is the context `with_callback_state` installed,
    // which outlives the bridge call this fired inside.
    let ctx = unsafe { &*(callback_ctx as *const CallbackInvocationCtx) };
    let func_env = ctx.func_env.clone();

    let dispatched = Store::with_current(|store| {
        let Some(table) = func_env.as_ref(store).table.clone() else {
            return 0;
        };

        // Bound guest↔host callback reentrancy so a runaway recursion cannot
        // overflow the host native stack (an uncatchable SIGSEGV that would take
        // down every co-tenant). Refuse the callback past the limit rather than
        // crash. The increment below always pairs with the decrement, since
        // `call_guest_callback` returns normally on both success and trap.
        if !func_env.as_mut(store).enter_callback() {
            eprintln!("[callback trampoline] reentrancy depth limit exceeded");
            return 0;
        }
        let result = call_guest_callback(
            store,
            &func_env,
            &table,
            guest_env as i32,
            wasm_fn_ptr,
            callback_arg,
        );
        func_env.as_mut(store).leave_callback();
        result
    });

    match dispatched {
        Some(result) => result,
        None => {
            // The import that entered V8 did not lend its store, so there is
            // no way back into the guest from here.
            eprintln!("[callback trampoline] no store lent to this thread");
            0
        }
    }
}

/// Rust trampoline called from C++ when a guest-registered N-API finalizer
/// fires (during the deferred finalizer drain, which runs inside a guest→bridge
/// import call, so an active callback scope is available). Re-enters the guest
/// and dispatches `finalize(env, data, hint)` through the indirect table.
#[unsafe(no_mangle)]
pub extern "C" fn snapi_host_invoke_wasm_finalizer(
    callback_ctx: *mut c_void,
    guest_env: u32,
    wasm_fn_ptr: u32,
    data: u32,
    hint: u32,
) -> u32 {
    if callback_ctx.is_null() {
        // No active guest call to re-enter (e.g. fired during env teardown,
        // when the guest instance is going away regardless). Nothing to do.
        return 0;
    }
    // SAFETY: as in `snapi_host_invoke_wasm_callback`.
    let ctx = unsafe { &*(callback_ctx as *const CallbackInvocationCtx) };
    let func_env = ctx.func_env.clone();

    Store::with_current(|store| {
        let Some(table) = func_env.as_ref(store).table.clone() else {
            return 0;
        };
        // Same reentrancy bound as the regular callback trampoline: a finalizer
        // may itself create/free values and trigger more callbacks.
        if !func_env.as_mut(store).enter_callback() {
            eprintln!("[finalizer trampoline] reentrancy depth limit exceeded");
            return 0;
        }
        let result = call_guest_callback2(
            store,
            &func_env,
            &table,
            guest_env as i32,
            wasm_fn_ptr,
            data,
            hint,
        );
        func_env.as_mut(store).leave_callback();
        result
    })
    .unwrap_or(0)
}
