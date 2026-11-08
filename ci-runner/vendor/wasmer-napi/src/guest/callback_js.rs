use std::ffi::c_void;

use wasmer::{FunctionEnvMut, Table, Value};

#[cfg(all(target_arch = "wasm32", feature = "js"))]
use std::future::Future;
#[cfg(all(target_arch = "wasm32", feature = "js"))]
use wasmer::AsyncFunctionEnvMut;

use crate::{NapiEnv, snapi::SnapiEnv};

use super::util::{forget_guest_allocation, recycle_guest_allocation};

type RawFunctionEnvMut = FunctionEnvMut<'static, NapiEnv>;

/// A value-handle ID reserved for callbacks which arrived while the guest was
/// suspended through JSPI. The host bridge keeps their callback frame alive
/// and retries them from the next synchronous guest checkpoint.
pub(crate) const CALLBACK_DEFERRED: u32 = u32::MAX;

#[repr(C)]
pub(crate) struct CallbackInvocationCtx {
    env: CallbackEnv,
}

// The JS backend is single-threaded; this marker only satisfies the generic
// FunctionEnv bound and the context is never transferred between workers.
#[cfg(all(target_arch = "wasm32", feature = "js"))]
unsafe impl Send for CallbackInvocationCtx {}

enum CallbackEnv {
    Sync(*mut RawFunctionEnvMut),
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    Async(AsyncFunctionEnvMut<NapiEnv>),
}

#[cfg(all(target_arch = "wasm32", feature = "js"))]
pub(crate) fn install_persistent_callback_state(
    env: &mut FunctionEnvMut<NapiEnv>,
    env_id: u32,
    snapi_env: SnapiEnv,
    async_env: AsyncFunctionEnvMut<NapiEnv>,
) {
    let mut ctx = Box::new(CallbackInvocationCtx {
        env: CallbackEnv::Async(async_env),
    });
    let ctx_ptr = (&mut *ctx as *mut CallbackInvocationCtx).cast::<c_void>();
    env.data_mut()
        .persistent_callback_contexts
        .insert(env_id, ctx);
    unsafe {
        crate::snapi::snapi_bridge_swap_active_callback_ctx(snapi_env, ctx_ptr);
    }
}

struct CallbackStateGuard {
    _ctx: Box<CallbackInvocationCtx>,
    snapi_env: SnapiEnv,
    prev: *mut c_void,
    env: *mut RawFunctionEnvMut,
    owner_id: u64,
}

impl Drop for CallbackStateGuard {
    fn drop(&mut self) {
        if !self.env.is_null() {
            let env = unsafe { &mut *self.env.cast::<FunctionEnvMut<'_, NapiEnv>>() };
            flush_host_buffer_copies(env, self.owner_id);
            if env.data().host_buffer_copy_frames.is_empty() {
                flush_pending_host_buffer_copies(env, self.snapi_env);
            } else {
                publish_pending_host_buffer_copies(env, self.snapi_env);
            }
        }
        unsafe {
            crate::snapi::snapi_bridge_swap_active_callback_ctx(self.snapi_env, self.prev);
        }
    }
}

fn install_callback_state(
    env: &mut FunctionEnvMut<NapiEnv>,
    snapi_env: SnapiEnv,
) -> Option<CallbackStateGuard> {
    if snapi_env.is_null() {
        return None;
    }

    let env_ptr = (env as *mut FunctionEnvMut<'_, NapiEnv>).cast::<RawFunctionEnvMut>();
    let mut ctx = Box::new(CallbackInvocationCtx {
        env: CallbackEnv::Sync(env_ptr),
    });
    let owner_id = env.data_mut().next_host_buffer_owner();
    env.data_mut().host_buffer_copy_frames.push(owner_id);
    let prev = unsafe {
        crate::snapi::snapi_bridge_swap_active_callback_ctx(
            snapi_env,
            (&mut *ctx as *mut CallbackInvocationCtx).cast::<c_void>(),
        )
    };
    Some(CallbackStateGuard {
        env: env_ptr,
        _ctx: ctx,
        snapi_env,
        prev,
        owner_id,
    })
}

fn call_guest_callback(
    env: &mut FunctionEnvMut<NapiEnv>,
    table: &Table,
    guest_env: i32,
    wasm_fn_ptr: u32,
    callback_arg: u32,
) -> u32 {
    let func = match env.data().func_cache.get(&wasm_fn_ptr).cloned() {
        Some(func) => func,
        None => {
            let Some(elem) = table.get(env, wasm_fn_ptr) else {
                eprintln!("[callback trampoline] table entry missing for function {wasm_fn_ptr}");
                return 0;
            };
            let func = match elem {
                Value::FuncRef(Some(func)) => func,
                Value::FuncRef(None) => {
                    eprintln!("[callback trampoline] null function reference at {wasm_fn_ptr}");
                    return 0;
                }
                other => {
                    eprintln!(
                        "[callback trampoline] non-function table value at {wasm_fn_ptr}: {other:?}"
                    );
                    return 0;
                }
            };
            env.data_mut().func_cache.insert(wasm_fn_ptr, func.clone());
            func
        }
    };
    let result = func.call(
        env,
        &[Value::I32(guest_env), Value::I32(callback_arg as i32)],
    );
    match result {
        Ok(ret_vals) => match ret_vals.first() {
            Some(Value::I32(v)) => *v as u32,
            Some(Value::I64(v)) => *v as u32,
            _ => 0,
        },
        Err(err) => {
            eprintln!("[callback trampoline] error calling function: {err}");
            0
        }
    }
}

fn call_guest_finalizer(
    env: &mut FunctionEnvMut<NapiEnv>,
    table: &Table,
    guest_env: i32,
    wasm_fn_ptr: u32,
    data: u32,
    hint: u32,
) -> u32 {
    let func = match env.data().func_cache.get(&wasm_fn_ptr).cloned() {
        Some(func) => func,
        None => {
            let Some(Value::FuncRef(Some(func))) = table.get(env, wasm_fn_ptr) else {
                eprintln!("[finalizer trampoline] table entry missing for function {wasm_fn_ptr}");
                return 0;
            };
            env.data_mut().func_cache.insert(wasm_fn_ptr, func.clone());
            func
        }
    };
    match func.call(
        env,
        &[
            Value::I32(guest_env),
            Value::I32(data as i32),
            Value::I32(hint as i32),
        ],
    ) {
        Ok(values) => match values.first() {
            Some(Value::I32(value)) => *value as u32,
            Some(Value::I64(value)) => *value as u32,
            _ => 0,
        },
        Err(error) => {
            eprintln!("[finalizer trampoline] error calling function: {error}");
            0
        }
    }
}

fn call_guest_callback_and_flush(
    env: &mut FunctionEnvMut<NapiEnv>,
    table: &Table,
    guest_env: i32,
    wasm_fn_ptr: u32,
    callback_arg: u32,
) -> u32 {
    let snapi_env = env.data().resolve_napi_env(guest_env);
    refresh_host_buffer_copies(env, snapi_env);
    let owner_id = env.data_mut().next_host_buffer_owner();
    env.data_mut().host_buffer_copy_frames.push(owner_id);
    let result = call_guest_callback(env, table, guest_env, wasm_fn_ptr, callback_arg);
    flush_host_buffer_copies(env, owner_id);
    // Nested JavaScript callbacks must not end pointer lifetimes owned by their
    // caller. Only the outermost callback frame may release pending mappings.
    if env.data().host_buffer_copy_frames.is_empty() {
        flush_pending_host_buffer_copies(env, snapi_env);
    } else {
        publish_pending_host_buffer_copies(env, snapi_env);
    }
    result
}

fn flush_host_buffer_copies(env: &mut FunctionEnvMut<NapiEnv>, owner_id: u64) {
    if let Some(index) = env
        .data()
        .host_buffer_copy_frames
        .iter()
        .position(|candidate| *candidate == owner_id)
    {
        env.data_mut().host_buffer_copy_frames.remove(index);
    }
    flush_host_buffer_copies_for_owner(env, owner_id);
}

pub fn flush_pending_host_buffer_copies(env: &mut FunctionEnvMut<NapiEnv>, snapi_env: SnapiEnv) {
    if snapi_env.is_null() || env.data().host_buffer_copies.is_empty() {
        return;
    }

    let drained = {
        let state = env.data_mut();
        std::mem::take(&mut state.host_buffer_copies)
    };

    let mut held = Vec::new();
    for mut mapping in drained {
        let mapping_snapi = env.data().resolve_napi_env(mapping.guest_env as i32);
        if mapping.needs_flush && mapping.byte_len > 0 && !mapping_snapi.is_null() {
            if let Some(memory) = env.data().memory.clone() {
                let memory_buffer = memory.as_js().js_buffer();
                let _ = crate::snapi_js::copy_memory_bytes_to_reference(
                    mapping_snapi,
                    mapping.host_reference_id,
                    &memory_buffer,
                    mapping.guest_ptr,
                    mapping.byte_len as u32,
                );
            }
            // The guest snapshot is now coherent with JavaScript. Retained
            // mappings stay allocated and are refreshed before guest re-entry.
            mapping.needs_flush = false;
        }
        if mapping.persistent || mapping.reference_holds > 0 {
            held.push(mapping);
            continue;
        }
        if mapping.host_reference_id != 0 && !mapping_snapi.is_null() {
            unsafe {
                crate::snapi::snapi_bridge_delete_reference(
                    mapping_snapi,
                    mapping.host_reference_id,
                );
            }
        }

        let state = env.data_mut();
        let mapping_end = mapping.guest_ptr.saturating_add(mapping.byte_len as u32);
        state
            .guest_data_ptrs
            .retain(|(guest_env, handle_id), guest_ptr| {
                *guest_env != mapping.guest_env
                    || *handle_id != mapping.handle_id
                        && (*guest_ptr < mapping.guest_ptr || *guest_ptr >= mapping_end)
            });
        if mapping.backing_store_token != 0 {
            state
                .guest_data_backing_stores
                .retain(|(guest_env, _), backing_mapping| {
                    *guest_env != mapping.guest_env
                        || backing_mapping.guest_ptr < mapping.guest_ptr
                        || backing_mapping.guest_ptr >= mapping_end
                });
        }
        if mapping.guest_allocation_recyclable {
            recycle_guest_allocation(env, mapping.guest_ptr);
        } else {
            forget_guest_allocation(env, mapping.guest_ptr);
        }
    }
    env.data_mut().host_buffer_copies.extend(held);
}

/// Publish native writes before entering JavaScript without ending any native
/// pointer lifetime. A guest callback may call JavaScript and then continue to
/// use a pointer returned earlier by N-API (llhttp does this after its headers
/// callback). Recycling that mapping at the nested handoff turns the live
/// pointer into a use-after-release. Frame teardown remains the sole owner of
/// releasing unreferenced mappings.
pub fn publish_pending_host_buffer_copies(env: &mut FunctionEnvMut<NapiEnv>, snapi_env: SnapiEnv) {
    if snapi_env.is_null() || env.data().host_buffer_copies.is_empty() {
        return;
    }
    let Some(memory) = env.data().memory.clone() else {
        return;
    };
    let memory_buffer = memory.as_js().js_buffer();
    for index in 0..env.data().host_buffer_copies.len() {
        let (mapping_guest_env, host_reference_id, guest_ptr, byte_len, needs_flush) = {
            let mapping = &env.data().host_buffer_copies[index];
            (
                mapping.guest_env,
                mapping.host_reference_id,
                mapping.guest_ptr,
                mapping.byte_len,
                mapping.needs_flush,
            )
        };
        if !needs_flush || byte_len == 0 {
            continue;
        }
        let mapping_snapi = env.data().resolve_napi_env(mapping_guest_env as i32);
        if mapping_snapi.is_null() {
            continue;
        }
        if crate::snapi_js::copy_memory_bytes_to_reference(
            mapping_snapi,
            host_reference_id,
            &memory_buffer,
            guest_ptr,
            byte_len as u32,
        ) == 0
        {
            env.data_mut().host_buffer_copies[index].needs_flush = false;
        }
    }
}

/// Restore host-side mutations into stable guest allocations before native
/// code resumes. This is the inverse half of `publish_pending_host_buffer_copies`:
/// mappings stay allocated across the JavaScript phase, so retained and
/// interior native pointers remain valid across nested callbacks.
pub fn refresh_host_buffer_copies(env: &mut FunctionEnvMut<NapiEnv>, snapi_env: SnapiEnv) {
    if snapi_env.is_null() || env.data().host_buffer_copies.is_empty() {
        return;
    }
    let Some(memory) = env.data().memory.clone() else {
        return;
    };
    let memory_buffer = memory.as_js().js_buffer();
    for index in 0..env.data().host_buffer_copies.len() {
        let (mapping_guest_env, host_reference_id, guest_ptr, byte_len, needs_flush) = {
            let mapping = &env.data().host_buffer_copies[index];
            (
                mapping.guest_env,
                mapping.host_reference_id,
                mapping.guest_ptr,
                mapping.byte_len,
                mapping.needs_flush,
            )
        };
        if needs_flush || byte_len == 0 {
            continue;
        }
        let mapping_snapi = env.data().resolve_napi_env(mapping_guest_env as i32);
        if mapping_snapi.is_null() {
            continue;
        }
        if crate::snapi_js::copy_reference_bytes_to_memory(
            mapping_snapi,
            host_reference_id,
            &memory_buffer,
            guest_ptr,
            byte_len as u32,
        ) == 0
        {
            env.data_mut().host_buffer_copies[index].needs_flush = true;
        }
    }
}

pub fn flush_host_buffer_copies_for_owner(env: &mut FunctionEnvMut<NapiEnv>, owner_id: u64) {
    let (drained, mut retained): (Vec<_>, Vec<_>) =
        std::mem::take(&mut env.data_mut().host_buffer_copies)
            .into_iter()
            .partition(|mapping| mapping.owner_id == owner_id);

    let mut held = Vec::new();
    for mut mapping in drained {
        let mapping_snapi = env.data().resolve_napi_env(mapping.guest_env as i32);
        if mapping.needs_flush && mapping.byte_len > 0 && !mapping_snapi.is_null() {
            if let Some(memory) = env.data().memory.clone() {
                let memory_buffer = memory.as_js().js_buffer();
                let _ = crate::snapi_js::copy_memory_bytes_to_reference(
                    mapping_snapi,
                    mapping.host_reference_id,
                    &memory_buffer,
                    mapping.guest_ptr,
                    mapping.byte_len as u32,
                );
            }
            mapping.needs_flush = false;
        }
        if mapping.persistent || mapping.reference_holds > 0 {
            held.push(mapping);
            continue;
        }
        if mapping.host_reference_id != 0 && !mapping_snapi.is_null() {
            unsafe {
                crate::snapi::snapi_bridge_delete_reference(
                    mapping_snapi,
                    mapping.host_reference_id,
                );
            }
        }

        let state = env.data_mut();
        let mapping_end = mapping.guest_ptr.saturating_add(mapping.byte_len as u32);
        state
            .guest_data_ptrs
            .retain(|(guest_env, handle_id), guest_ptr| {
                *guest_env != mapping.guest_env
                    || *handle_id != mapping.handle_id
                        && (*guest_ptr < mapping.guest_ptr || *guest_ptr >= mapping_end)
            });
        if mapping.backing_store_token != 0 {
            state
                .guest_data_backing_stores
                .retain(|(guest_env, _), backing_mapping| {
                    *guest_env != mapping.guest_env
                        || backing_mapping.guest_ptr < mapping.guest_ptr
                        || backing_mapping.guest_ptr >= mapping_end
                });
        }
        if mapping.guest_allocation_recyclable {
            recycle_guest_allocation(env, mapping.guest_ptr);
        } else {
            forget_guest_allocation(env, mapping.guest_ptr);
        }
    }
    retained.extend(held);
    env.data_mut().host_buffer_copies = retained;
}

pub fn with_callback_state<R>(
    env: &mut FunctionEnvMut<NapiEnv>,
    snapi_env: SnapiEnv,
    f: impl FnOnce() -> R,
) -> R {
    let guard = install_callback_state(env, snapi_env);
    let result = f();
    drop(guard);
    result
}

#[cfg(all(target_arch = "wasm32", feature = "js"))]
pub async fn with_callback_state_async<R, F>(
    env: AsyncFunctionEnvMut<NapiEnv>,
    snapi_env: SnapiEnv,
    future: F,
) -> R
where
    F: Future<Output = R>,
{
    if snapi_env.is_null() {
        return future.await;
    }

    let owner_id = {
        let mut locked = env.write().await;
        let owner_id = locked.data_mut().next_host_buffer_owner();
        locked.data_mut().host_buffer_copy_frames.push(owner_id);
        owner_id
    };
    // The environment's persistent Async callback context is the owner of
    // host-to-guest re-entry while a JSPI import is suspended. Do not replace
    // it with a future-local context: multiple suspended imports can overlap
    // and complete out of order, so stack-style save/restore would eventually
    // restore a pointer to a context owned by an already-completed future.
    let result = future.await;
    {
        // Keep this guard in an explicit scope. A completed Rust future may
        // remain owned by its JavaScript Promise until a later GC cycle; if the
        // guard stays in the generator state, it also keeps the async Store
        // shared after the guest entrypoint has returned.
        let mut locked = env.write().await;
        let mut sync_env = locked.as_function_env_mut();
        flush_host_buffer_copies(&mut sync_env, owner_id);
        if sync_env.data().host_buffer_copy_frames.is_empty() {
            flush_pending_host_buffer_copies(&mut sync_env, snapi_env);
        } else {
            publish_pending_host_buffer_copies(&mut sync_env, snapi_env);
        }
    }
    result
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
    let ctx = unsafe { &mut *(callback_ctx as *mut CallbackInvocationCtx) };
    match &mut ctx.env {
        CallbackEnv::Sync(env) => {
            if env.is_null() {
                eprintln!("[callback trampoline] callback scope env cleared");
                return 0;
            }
            let env = unsafe { &mut *env.cast::<FunctionEnvMut<'_, NapiEnv>>() };
            let Some(table) = env.data().table.clone() else {
                eprintln!("[callback trampoline] guest function table is not installed");
                return 0;
            };
            call_guest_callback_and_flush(env, &table, guest_env as i32, wasm_fn_ptr, callback_arg)
        }
        #[cfg(all(target_arch = "wasm32", feature = "js"))]
        CallbackEnv::Async(env) => {
            if let Some(result) = env.with_current_mut(|mut sync_env| {
                let Some(table) = sync_env.data().table.clone() else {
                    eprintln!("[callback trampoline] guest function table is not installed");
                    return 0;
                };
                call_guest_callback_and_flush(
                    &mut sync_env,
                    &table,
                    guest_env as i32,
                    wasm_fn_ptr,
                    callback_arg,
                )
            }) {
                return result;
            }
            if let Some(mut locked) = env.try_write() {
                let mut sync_env = locked.as_function_env_mut();
                if let Some(table) = sync_env.data().table.clone() {
                    return call_guest_callback_and_flush(
                        &mut sync_env,
                        &table,
                        guest_env as i32,
                        wasm_fn_ptr,
                        callback_arg,
                    );
                }
            }
            CALLBACK_DEFERRED
        }
    }
}

/// Dispatch a deferred host-JS finalizer while the provider is at an explicit
/// guest checkpoint. JavaScript GC only makes the record ready; guest re-entry
/// happens here, under the same callback ownership rules as ordinary N-API
/// callbacks.
#[unsafe(no_mangle)]
pub extern "C" fn snapi_host_invoke_wasm_finalizer(
    callback_ctx: *mut c_void,
    guest_env: u32,
    wasm_fn_ptr: u32,
    data: u32,
    hint: u32,
) -> u32 {
    if callback_ctx.is_null() {
        return CALLBACK_DEFERRED;
    }
    let ctx = unsafe { &mut *(callback_ctx as *mut CallbackInvocationCtx) };
    let invoke = |env: &mut FunctionEnvMut<NapiEnv>| {
        let Some(table) = env.data().table.clone() else {
            return 0;
        };
        let snapi_env = env.data().resolve_napi_env(guest_env as i32);
        refresh_host_buffer_copies(env, snapi_env);
        let owner_id = env.data_mut().next_host_buffer_owner();
        env.data_mut().host_buffer_copy_frames.push(owner_id);
        let result = call_guest_finalizer(env, &table, guest_env as i32, wasm_fn_ptr, data, hint);
        flush_host_buffer_copies(env, owner_id);
        if env.data().host_buffer_copy_frames.is_empty() {
            flush_pending_host_buffer_copies(env, snapi_env);
        } else {
            publish_pending_host_buffer_copies(env, snapi_env);
        }
        result
    };
    match &mut ctx.env {
        CallbackEnv::Sync(env) => {
            if env.is_null() {
                return CALLBACK_DEFERRED;
            }
            invoke(unsafe { &mut *env.cast::<FunctionEnvMut<'_, NapiEnv>>() })
        }
        #[cfg(all(target_arch = "wasm32", feature = "js"))]
        CallbackEnv::Async(env) => {
            if let Some(result) = env.with_current_mut(|mut sync_env| invoke(&mut sync_env)) {
                return result;
            }
            if let Some(mut locked) = env.try_write() {
                let mut sync_env = locked.as_function_env_mut();
                return invoke(&mut sync_env);
            }
            CALLBACK_DEFERRED
        }
    }
}
