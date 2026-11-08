// ============================================================
// WASM import handlers for "napi" module
// ============================================================

// --- Init ---

use std::ffi::{CString, c_void};

use wasmer::{AsStoreMut, Function, FunctionEnv, FunctionEnvMut, Imports, namespace};

#[cfg(all(target_arch = "wasm32", feature = "js"))]
use wasm_bindgen::JsValue;
#[cfg(all(target_arch = "wasm32", feature = "js"))]
use wasmer::AsyncFunctionEnvMut;

use crate::{
    NAPI_EXTENSION_WASMER_MODULE_NAME, NAPI_MODULE_NAME, NapiEnv,
    guest::{
        MAX_GUEST_CSTRING_SCAN, MAX_NAPI_BIGINT_WORDS, MAX_NAPI_CALLBACK_ARGS,
        callback::{
            flush_host_buffer_copies_for_owner, install_persistent_callback_state,
            publish_pending_host_buffer_copies, refresh_host_buffer_copies, with_callback_state,
            with_callback_state_async,
        },
        typedarray_element_size,
    },
    snapi::*,
};

use super::{abi, util::*};

const JS_BACKING_TOKEN_MARKER: u64 = 1 << 63;
const JS_BACKING_TOKEN_OFFSET_MASK: u64 = u32::MAX as u64;

fn guest_napi_wasm_init_env(mut env: FunctionEnvMut<NapiEnv>) -> i32 {
    let _ = unsafe { snapi_bridge_init() };
    let _ = unsafe { snapi_bridge_unofficial_configure_runtime(std::ptr::null(), 0) };

    if let Some(env_id) = env.data().default_napi_env_id {
        return env_id as i32;
    }

    let mut snapi_env_state: SnapiEnv = std::ptr::null_mut();
    let status =
        unsafe { snapi_bridge_unofficial_create_env(8, std::ptr::null(), &mut snapi_env_state) };
    if status != 0 || snapi_env_state.is_null() {
        return 0;
    }

    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    let async_env = env.as_async_mut();
    let (env_id, _scope_id) = env.data_mut().register_napi_env(snapi_env_state);
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    if let Some(async_env) = async_env {
        install_persistent_callback_state(&mut env, env_id, snapi_env_state, async_env);
    }
    env.data_mut().default_napi_env_id = Some(env_id);
    env_id as i32
}

fn with_cb_context<R>(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_env: i32,
    f: impl FnOnce() -> R,
) -> R {
    let snapi_env = env.data().resolve_napi_env(guest_env);
    publish_pending_host_buffer_copies(env, snapi_env);
    let result = with_callback_state(env, snapi_env, f);
    refresh_host_buffer_copies(env, snapi_env);
    result
}

fn snapi_env(env: &FunctionEnvMut<NapiEnv>, guest_env: i32) -> SnapiEnv {
    env.data().resolve_napi_env(guest_env)
}

fn drain_ready_guest_buffers(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_env: u32,
    env_handle: SnapiEnv,
    force: bool,
) {
    loop {
        let mut handle_id = 0u32;
        let mut guest_ptr = 0u32;
        let mut recyclable = 0i32;
        let status = unsafe {
            crate::snapi::snapi_bridge_take_ready_guest_buffer_finalizer(
                env_handle,
                i32::from(force),
                &mut handle_id,
                &mut guest_ptr,
                &mut recyclable,
            )
        };
        if status != 0 {
            break;
        }
        let Some(index) = env.data().host_buffer_copies.iter().position(|mapping| {
            mapping.guest_env == guest_env
                && mapping.handle_id == handle_id
                && mapping.guest_ptr == guest_ptr
                && mapping.persistent
        }) else {
            continue;
        };
        let mapping = env.data_mut().host_buffer_copies.remove(index);
        if mapping.host_reference_id != 0 {
            unsafe {
                crate::snapi::snapi_bridge_delete_reference(env_handle, mapping.host_reference_id);
            }
        }
        env.data_mut()
            .guest_data_ptrs
            .remove(&(guest_env, handle_id));
        if mapping.backing_store_token != 0 {
            env.data_mut()
                .guest_data_backing_stores
                .remove(&(guest_env, mapping.backing_store_token));
        }
        if recyclable != 0 {
            recycle_guest_allocation(env, guest_ptr);
        }
    }
}

fn host_backing_store_token(env: &FunctionEnvMut<NapiEnv>, guest_env: i32, handle_id: u32) -> u64 {
    let mut token = 0u64;
    let status = unsafe {
        snapi_bridge_get_backing_store_token(snapi_env(env, guest_env), handle_id, &mut token)
    };
    if status == 0 { token } else { 0 }
}

fn write_guest_pod<T>(env: &mut FunctionEnvMut<NapiEnv>, guest_ptr: i32, value: &T) -> bool {
    if guest_ptr <= 0 {
        return false;
    }
    let bytes = unsafe {
        std::slice::from_raw_parts((value as *const T).cast::<u8>(), std::mem::size_of::<T>())
    };
    write_guest_bytes(env, guest_ptr as u32, bytes)
}

fn write_guest_pod_slice<T>(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_ptr: i32,
    values: &[T],
) -> bool {
    if values.is_empty() {
        return true;
    }
    if guest_ptr <= 0 {
        return false;
    }
    let bytes = unsafe {
        std::slice::from_raw_parts(values.as_ptr().cast::<u8>(), std::mem::size_of_val(values))
    };
    write_guest_bytes(env, guest_ptr as u32, bytes)
}

fn remember_guest_backing_store(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_env: u32,
    handle_id: u32,
    backing_store_token: u64,
    host_addr: u64,
    guest_ptr: u32,
    byte_len: usize,
    covers_full_backing_store: bool,
) {
    let state = env.data_mut();
    state
        .guest_data_ptrs
        .insert((guest_env, handle_id), guest_ptr);
    if backing_store_token != 0 {
        // A Buffer created as a direct view over guest WebAssembly memory has
        // a token whose low 32 bits are its byte offset in that memory.
        // Register the whole backing store as an identity mapping as well as
        // the exact view. Buffer.subarray() then resolves offset aliases back
        // to guest memory instead of allocating a mirrored host copy.
        if host_addr == 0 && backing_store_token & JS_BACKING_TOKEN_MARKER != 0 {
            let byte_offset = backing_store_token & JS_BACKING_TOKEN_OFFSET_MASK;
            if byte_offset == u64::from(guest_ptr) {
                let base_token = backing_store_token & !JS_BACKING_TOKEN_OFFSET_MASK;
                state.guest_data_backing_stores.insert(
                    (guest_env, base_token),
                    crate::GuestBackingStoreMapping {
                        host_addr: 0,
                        guest_ptr: 0,
                        // JavaScript already bounds-checked this view against
                        // the same Wasm memory. The guest memory access applies
                        // the final bounds check after resolving the offset.
                        byte_len: usize::MAX,
                        covers_full_backing_store: true,
                    },
                );
            }
        }
        state.guest_data_backing_stores.insert(
            (guest_env, backing_store_token),
            crate::GuestBackingStoreMapping {
                host_addr,
                guest_ptr,
                byte_len,
                covers_full_backing_store,
            },
        );
    }
}

// TODO: Route Buffer/ArrayBuffer allocation through guest memory from the start
// so host-owned buffers do not need snapshot-and-flush fallback synchronization.
fn remember_host_buffer_copy(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_env: u32,
    handle_id: u32,
    backing_store_token: u64,
    host_addr: u64,
    guest_ptr: u32,
    byte_len: usize,
    guest_allocation_recyclable: bool,
    persistent: bool,
    needs_flush: bool,
    covers_full_backing_store: bool,
) -> bool {
    let mut host_reference_id = 0u32;
    if unsafe {
        snapi_bridge_create_reference(
            snapi_env(env, guest_env as i32),
            handle_id,
            if persistent { 0 } else { 1 },
            &mut host_reference_id,
        )
    } != 0
    {
        return false;
    }
    {
        let state = env.data_mut();
        state
            .guest_data_ptrs
            .insert((guest_env, handle_id), guest_ptr);
        if backing_store_token != 0 {
            state.guest_data_backing_stores.insert(
                (guest_env, backing_store_token),
                crate::GuestBackingStoreMapping {
                    host_addr,
                    guest_ptr,
                    byte_len,
                    covers_full_backing_store,
                },
            );
        }
        state.host_buffer_copies.push(crate::HostBufferCopy {
            owner_id: state.current_host_buffer_owner(),
            guest_env,
            handle_id,
            host_reference_id,
            backing_store_token,
            guest_ptr,
            byte_len,
            guest_allocation_recyclable,
            persistent,
            reference_holds: 0,
            needs_flush,
        });
    }
    if persistent
        && unsafe {
            crate::snapi::snapi_bridge_register_guest_buffer_finalizer(
                snapi_env(env, guest_env as i32),
                handle_id,
                guest_ptr,
                i32::from(guest_allocation_recyclable),
            )
        } != 0
    {
        if let Some(mapping) = env.data_mut().host_buffer_copies.pop() {
            unsafe {
                crate::snapi::snapi_bridge_delete_reference(
                    snapi_env(env, guest_env as i32),
                    mapping.host_reference_id,
                );
            }
        }
        env.data_mut()
            .guest_data_ptrs
            .remove(&(guest_env, handle_id));
        if backing_store_token != 0 {
            env.data_mut()
                .guest_data_backing_stores
                .remove(&(guest_env, backing_store_token));
        }
        return false;
    }
    true
}

fn prepare_cached_guest_data(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_env: u32,
    handle_id: u32,
    guest_ptr: u32,
) -> bool {
    let matching = env
        .data()
        .host_buffer_copies
        .iter()
        .enumerate()
        .filter(|(_, mapping)| {
            let mapping_end = mapping.guest_ptr.saturating_add(mapping.byte_len as u32);
            mapping.guest_env == guest_env
                && guest_ptr >= mapping.guest_ptr
                && guest_ptr < mapping_end
        });
    let Some((index, mapping)) = matching
        .clone()
        .find(|(_, mapping)| mapping.handle_id == handle_id)
        .or_else(|| matching.into_iter().next())
    else {
        // Guest-memory-backed views are already coherent with JavaScript.
        return false;
    };
    let refresh = if mapping.handle_id != handle_id {
        // Distinct Buffer objects may reuse the same pooled ArrayBuffer range.
        // Only the originating handle is coherent with an in-frame guest copy.
        true
    } else {
        mapping.owner_id != env.data().current_host_buffer_owner()
    };
    // Standard N-API pointers are writable. The JS backend cannot observe
    // Wasm stores directly, so the mapping is conservatively dirty until the
    // next guest-to-JavaScript coherence boundary.
    env.data_mut().host_buffer_copies[index].needs_flush = true;
    refresh
}

fn resolve_current_host_data_to_guest(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_env: i32,
    handle_id: u32,
    backing_store_token: u64,
    host_addr: u64,
    byte_len: usize,
    covers_full_backing_store: bool,
) -> Option<u32> {
    if backing_store_token != 0
        && let Some(guest_data_ptr) = resolve_guest_backing_store_token(
            env.data(),
            guest_env as u32,
            handle_id,
            backing_store_token,
            host_addr,
            byte_len,
        )
    {
        // JavaScript may mutate a retained Buffer/TypedArray between native
        // calls. Refresh an existing guest-side cache before exposing its
        // pointer again; the backing-store token identifies the allocation,
        // not a particular version of its bytes.
        if prepare_cached_guest_data(env, guest_env as u32, handle_id, guest_data_ptr)
            && host_addr != 0
        {
            let snapshot = unsafe { std::slice::from_raw_parts(host_addr as *const u8, byte_len) };
            let _ = write_guest_bytes(env, guest_data_ptr, snapshot);
        }
        env.data_mut()
            .guest_data_ptrs
            .insert((guest_env as u32, handle_id), guest_data_ptr);
        return Some(guest_data_ptr);
    }
    if let Some(&guest_data_ptr) = env
        .data()
        .guest_data_ptrs
        .get(&(guest_env as u32, handle_id))
    {
        if prepare_cached_guest_data(env, guest_env as u32, handle_id, guest_data_ptr)
            && host_addr != 0
        {
            let snapshot = unsafe { std::slice::from_raw_parts(host_addr as *const u8, byte_len) };
            let _ = write_guest_bytes(env, guest_data_ptr, snapshot);
        }
        return Some(guest_data_ptr);
    }
    if host_addr == 0 {
        return Some(0);
    }
    if byte_len == 0 {
        return Some(0);
    }

    resolve_or_copy_host_data_to_guest(
        env,
        guest_env as u32,
        handle_id,
        backing_store_token,
        host_addr,
        byte_len,
        covers_full_backing_store,
    )
}

fn resolve_current_host_value_to_guest(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_env: i32,
    handle_id: u32,
    backing_store_token: u64,
    byte_len: usize,
    covers_full_backing_store: bool,
) -> Option<u32> {
    let cached = if backing_store_token != 0 {
        resolve_guest_backing_store_token(
            env.data(),
            guest_env as u32,
            handle_id,
            backing_store_token,
            0,
            byte_len,
        )
    } else {
        None
    }
    .or_else(|| {
        env.data()
            .guest_data_ptrs
            .get(&(guest_env as u32, handle_id))
            .copied()
    });

    if let Some(guest_ptr) = cached {
        if prepare_cached_guest_data(env, guest_env as u32, handle_id, guest_ptr) {
            let memory = env.data().memory.clone()?;
            let memory_buffer = memory.as_js().js_buffer();
            if crate::snapi_js::copy_value_bytes_to_memory(
                snapi_env(env, guest_env),
                handle_id,
                &memory_buffer,
                guest_ptr,
                byte_len as u32,
            ) != 0
            {
                return None;
            }
        }
        env.data_mut()
            .guest_data_ptrs
            .insert((guest_env as u32, handle_id), guest_ptr);
        return Some(guest_ptr);
    }

    if byte_len == 0 {
        return Some(0);
    }
    let guest_ptr = allocate_guest_buffer(env, byte_len)?;
    let memory = env.data().memory.clone()?;
    let memory_buffer = memory.as_js().js_buffer();
    if crate::snapi_js::copy_value_bytes_to_memory(
        snapi_env(env, guest_env),
        handle_id,
        &memory_buffer,
        guest_ptr,
        byte_len as u32,
    ) != 0
    {
        recycle_guest_allocation(env, guest_ptr);
        return None;
    }
    if !remember_host_buffer_copy(
        env,
        guest_env as u32,
        handle_id,
        backing_store_token,
        0,
        guest_ptr,
        byte_len,
        true,
        false,
        true,
        covers_full_backing_store,
    ) {
        recycle_guest_allocation(env, guest_ptr);
        return None;
    }
    Some(guest_ptr)
}

fn guest_unofficial_napi_configure_runtime(
    mut env: FunctionEnvMut<NapiEnv>,
    options_ptr: i32,
) -> i32 {
    let Some(flags) = abi::read_runtime_options(&mut env, options_ptr) else {
        return 1;
    };
    let Ok(flags) = CString::new(flags) else {
        return 1;
    };
    unsafe {
        snapi_bridge_unofficial_configure_runtime(flags.as_ptr(), flags.as_bytes().len() as u32)
    }
}

fn guest_unofficial_napi_create_env(
    mut env: FunctionEnvMut<NapiEnv>,
    module_api_version: i32,
    options_ptr: i32,
    env_out_ptr: i32,
    scope_out_ptr: i32,
) -> i32 {
    let (
        total_memory,
        constrained_memory,
        max_young_generation_size_in_bytes,
        max_old_generation_size_in_bytes,
        code_range_size_in_bytes,
        stack_limit,
    ) = if options_ptr > 0 {
        let Some(options) = abi::read_env_create(&mut env, options_ptr) else {
            return 1;
        };
        (
            options.total_memory,
            options.constrained_memory,
            options.max_young_generation_size_in_bytes,
            options.max_old_generation_size_in_bytes,
            options.code_range_size_in_bytes,
            options.stack_limit,
        )
    } else {
        (0, 0, 0, 0, 0, 0)
    };

    let mut snapi_env_state: SnapiEnv = std::ptr::null_mut();
    let status = unsafe {
        snapi_bridge_unofficial_create_env_with_options(
            module_api_version,
            total_memory,
            constrained_memory,
            max_young_generation_size_in_bytes,
            max_old_generation_size_in_bytes,
            code_range_size_in_bytes,
            stack_limit,
            std::ptr::null(),
            &mut snapi_env_state,
        )
    };
    if status != 0 {
        return status;
    }
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    let async_env = env.as_async_mut();
    let (env_id, scope_id) = env.data_mut().register_napi_env(snapi_env_state);
    #[cfg(all(target_arch = "wasm32", feature = "js"))]
    if let Some(async_env) = async_env {
        install_persistent_callback_state(&mut env, env_id, snapi_env_state, async_env);
    }
    if env_out_ptr > 0 {
        write_guest_u32(&mut env, env_out_ptr as u32, env_id);
    }
    if scope_out_ptr > 0 {
        write_guest_u32(&mut env, scope_out_ptr as u32, scope_id);
    }
    0
}

fn drain_env_guest_finalizers(env: &mut FunctionEnvMut<NapiEnv>, scope_id: u32) -> i32 {
    let guest_env = env.data().napi_scopes.get(&scope_id).copied().unwrap_or(0);
    let snapi_env_state = env
        .data()
        .napi_scopes
        .get(&scope_id)
        .and_then(|guest_env| env.data().napi_envs.get(guest_env))
        .copied()
        .map(|state| state as SnapiEnv)
        .unwrap_or(std::ptr::null_mut());
    if !snapi_env_state.is_null() {
        publish_pending_host_buffer_copies(env, snapi_env_state);
        let status = with_callback_state(env, snapi_env_state, || unsafe {
            crate::snapi::snapi_bridge_drain_all_guest_finalizers(snapi_env_state)
        });
        refresh_host_buffer_copies(env, snapi_env_state);
        drain_ready_guest_buffers(env, guest_env, snapi_env_state, true);
        return status;
    }
    0
}

fn guest_unofficial_napi_release_env(
    mut env: FunctionEnvMut<NapiEnv>,
    scope_ptr: i32,
    loop_ptr: i32,
) -> i32 {
    let scope_id = if scope_ptr > 0 { scope_ptr as u32 } else { 0 };
    let status = drain_env_guest_finalizers(&mut env, scope_id);
    if status != 0 {
        return status;
    }
    let Some(snapi_env_state) = env.data_mut().unregister_napi_scope(scope_id) else {
        return 1;
    };
    let loop_id = if loop_ptr > 0 { loop_ptr as u32 } else { 0 };
    unsafe { snapi_bridge_unofficial_release_env_with_loop(snapi_env_state, loop_id) }
}

fn guest_unofficial_napi_attach_env(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    hooks_ptr: i32,
    accepted_hooks_ptr: i32,
) -> i32 {
    let Some(hooks) = abi::read_env_hooks(&mut env, hooks_ptr) else {
        return 1;
    };
    if napi_env <= 0 || accepted_hooks_ptr <= 0 {
        return 1;
    }
    let mut accepted_hooks = 0u64;
    let status = unsafe {
        snapi_bridge_unofficial_attach_env(
            snapi_env(&env, napi_env),
            hooks.fatal,
            hooks.oom,
            &mut accepted_hooks,
        )
    };
    if status == 0 {
        write_guest_u64(&mut env, accepted_hooks_ptr as u32, accepted_hooks);
        debug_assert_eq!(accepted_hooks & !hooks.requested, 0);
    }
    status
}

fn guest_unofficial_napi_collect_garbage(env: FunctionEnvMut<NapiEnv>, napi_env: i32) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    unsafe { snapi_bridge_unofficial_collect_garbage(env_handle) }
}

fn provider_event_loop_checkpoint_sync(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    mode: i32,
    has_runnable_work: i32,
    checkpoint_state_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let mut checkpoint_state = 0;
    let status = with_cb_context(&mut env, napi_env, || unsafe {
        let status = snapi_bridge_drain_pending_callbacks(env_handle);
        if status != 0 {
            return status;
        }
        snapi_bridge_unofficial_event_loop_checkpoint(
            env_handle,
            mode,
            has_runnable_work,
            &mut checkpoint_state,
        )
    });
    drain_ready_guest_buffers(&mut env, napi_env as u32, env_handle, false);
    if checkpoint_state_ptr > 0 {
        write_guest_u32(&mut env, checkpoint_state_ptr as u32, checkpoint_state);
    }
    status
}

#[cfg(all(target_arch = "wasm32", feature = "js"))]
async fn event_loop_checkpoint(
    allow_host_tasks: bool,
    has_runnable_work: bool,
) -> Result<JsValue, JsValue> {
    crate::snapi_js::event_loop_checkpoint(allow_host_tasks, has_runnable_work).await
}

#[cfg(all(target_arch = "wasm32", feature = "js"))]
async fn guest_unofficial_napi_event_loop_checkpoint(
    mut env: AsyncFunctionEnvMut<NapiEnv>,
    napi_env: i32,
    mode: i32,
    has_runnable_work: i32,
    checkpoint_state_ptr: i32,
) -> i32 {
    // The host JavaScript realm owns its Promise and task queues. One explicit
    // JSPI suspension is the only async scheduling primitive exposed to Edge.
    let env_handle = {
        let env = env.read().await;
        env.data().resolve_napi_env(napi_env)
    };
    let (status, checkpoint_state) =
        with_callback_state_async(env.as_mut(), env_handle, async move {
            if mode != 0 && mode != 1 {
                return (1, 0);
            }
            if event_loop_checkpoint(mode == 1, has_runnable_work != 0)
                .await
                .is_err()
            {
                return (9, 0);
            }
            let status = unsafe { snapi_bridge_drain_pending_callbacks(env_handle) };
            if status != 0 {
                return (status, 0);
            }
            let mut checkpoint_state = 0;
            let status = unsafe {
                snapi_bridge_unofficial_event_loop_checkpoint(
                    env_handle,
                    mode,
                    has_runnable_work,
                    &mut checkpoint_state,
                )
            };
            if status == 0 && mode == 1 {
                checkpoint_state |= 1 << 1;
            }
            (status, checkpoint_state)
        })
        .await;
    {
        let mut locked = env.write().await;
        let mut sync_env = locked.as_function_env_mut();
        drain_ready_guest_buffers(&mut sync_env, napi_env as u32, env_handle, false);
        if checkpoint_state_ptr > 0 {
            write_guest_u32(&mut sync_env, checkpoint_state_ptr as u32, checkpoint_state);
        }
    }
    status
}

#[cfg(all(target_arch = "wasm32", feature = "js"))]
fn event_loop_checkpoint_import(
    store: &mut impl AsStoreMut,
    fe: &FunctionEnv<NapiEnv>,
) -> Function {
    Function::new_typed_with_env_async(store, fe, guest_unofficial_napi_event_loop_checkpoint)
}

#[cfg(not(all(target_arch = "wasm32", feature = "js")))]
fn guest_unofficial_napi_event_loop_checkpoint_sync(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    mode: i32,
    has_runnable_work: i32,
    checkpoint_state_ptr: i32,
) -> i32 {
    provider_event_loop_checkpoint_sync(
        env,
        napi_env,
        mode,
        has_runnable_work,
        checkpoint_state_ptr,
    )
}

fn guest_unofficial_napi_create_uninitialized_arraybuffer(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    length: i32,
    _zero_fill: i32,
    result_ptr: i32,
) -> i32 {
    if length < 0 {
        return 1;
    }
    // JavaScript ArrayBuffers are engine-owned and zero-initialized. Avoid a
    // guest snapshot entirely when Edge does not request a native pointer.
    guest_napi_create_arraybuffer(env, napi_env, length, 0, result_ptr)
}

#[cfg(not(all(target_arch = "wasm32", feature = "js")))]
fn event_loop_checkpoint_import(
    store: &mut impl AsStoreMut,
    fe: &FunctionEnv<NapiEnv>,
) -> Function {
    Function::new_typed_with_env(store, fe, guest_unofficial_napi_event_loop_checkpoint_sync)
}

fn guest_unofficial_napi_get_promise_details(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    promise: i32,
    state_ptr: i32,
    result_ptr: i32,
    has_result_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let promise_id = if promise > 0 { promise as u32 } else { 0 };
    let mut state = 0i32;
    let mut result_id = 0u32;
    let mut has_result = 0i32;
    let status = unsafe {
        snapi_bridge_unofficial_get_promise_details(
            env_handle,
            promise_id,
            &mut state,
            &mut result_id,
            &mut has_result,
        )
    };
    if status != 0 {
        return status;
    }
    if state_ptr > 0 {
        write_guest_i32(&mut env, state_ptr as u32, state);
    }
    if result_ptr > 0 {
        write_guest_u32(&mut env, result_ptr as u32, result_id);
    }
    if has_result_ptr > 0 {
        write_guest_u8(&mut env, has_result_ptr as u32, (has_result != 0) as u8);
    }
    0
}

fn guest_unofficial_napi_get_proxy_details(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    proxy: i32,
    target_ptr: i32,
    handler_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let proxy_id = if proxy > 0 { proxy as u32 } else { 0 };
    let mut target_id = 0u32;
    let mut handler_id = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_get_proxy_details(
            env_handle,
            proxy_id,
            &mut target_id,
            &mut handler_id,
        )
    };
    if status != 0 {
        return status;
    }
    if target_ptr > 0 {
        write_guest_u32(&mut env, target_ptr as u32, target_id);
    }
    if handler_ptr > 0 {
        write_guest_u32(&mut env, handler_ptr as u32, handler_id);
    }
    0
}

fn guest_unofficial_napi_preview_entries(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    value: i32,
    entries_ptr: i32,
    is_key_value_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let value_id = if value > 0 { value as u32 } else { 0 };
    let mut entries_id = 0u32;
    let mut is_key_value = 0i32;
    let status = unsafe {
        snapi_bridge_unofficial_preview_entries(
            env_handle,
            value_id,
            &mut entries_id,
            &mut is_key_value,
        )
    };
    if status != 0 {
        return status;
    }
    if entries_ptr > 0 {
        write_guest_u32(&mut env, entries_ptr as u32, entries_id);
    }
    if is_key_value_ptr > 0 {
        write_guest_u8(&mut env, is_key_value_ptr as u32, (is_key_value != 0) as u8);
    }
    0
}

fn guest_unofficial_napi_get_call_sites(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    frames: i32,
    callsites_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let mut callsites_id = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_get_call_sites(env_handle, frames as u32, &mut callsites_id)
    };
    if status == 0 && callsites_ptr > 0 {
        write_guest_u32(&mut env, callsites_ptr as u32, callsites_id);
    }
    status
}

fn guest_unofficial_napi_arraybuffer_view_has_buffer(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    value: i32,
    result_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let value_id = if value > 0 { value as u32 } else { 0 };
    let mut result = 0i32;
    let status = unsafe {
        snapi_bridge_unofficial_arraybuffer_view_has_buffer(env_handle, value_id, &mut result)
    };
    if status == 0 && result_ptr > 0 {
        write_guest_u8(&mut env, result_ptr as u32, (result != 0) as u8);
    }
    status
}

fn guest_unofficial_napi_get_constructor_name(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    value: i32,
    name_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let value_id = if value > 0 { value as u32 } else { 0 };
    let mut name_id = 0u32;
    let status =
        unsafe { snapi_bridge_unofficial_get_constructor_name(env_handle, value_id, &mut name_id) };
    if status == 0 && name_ptr > 0 {
        write_guest_u32(&mut env, name_ptr as u32, name_id);
    }
    status
}

fn guest_unofficial_napi_create_private_symbol(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    desc_ptr: i32,
    length: i32,
    result_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let wl = length as u32;
    let desc = if desc_ptr > 0 {
        if wl == 0xFFFFFFFFu32 {
            read_guest_c_string(&mut env, desc_ptr)
        } else {
            read_guest_bytes(&mut env, desc_ptr, wl as usize)
        }
    } else {
        Some(Vec::new())
    };
    let Some(desc) = desc else {
        return 1;
    };
    let desc_len = desc.len() as u32;
    let cs = CString::new(desc).unwrap_or_default();
    let mut out = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_create_private_symbol(env_handle, cs.as_ptr(), desc_len, &mut out)
    };
    if status == 0 && result_ptr > 0 {
        write_guest_u32(&mut env, result_ptr as u32, out);
    }
    status
}

fn guest_unofficial_napi_get_continuation_preserved_embedder_data(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    result_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let mut out = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_get_continuation_preserved_embedder_data(env_handle, &mut out)
    };
    if status == 0 && result_ptr > 0 {
        write_guest_u32(&mut env, result_ptr as u32, out);
    }
    status
}

fn guest_unofficial_napi_set_prepare_stack_trace_callback(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    callback: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let callback_id = if callback > 0 { callback as u32 } else { 0 };
    unsafe { snapi_bridge_unofficial_set_prepare_stack_trace_callback(env_handle, callback_id) }
}

fn guest_unofficial_napi_set_continuation_preserved_embedder_data(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    value: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let value_id = if value > 0 { value as u32 } else { 0 };
    unsafe {
        snapi_bridge_unofficial_set_continuation_preserved_embedder_data(env_handle, value_id)
    }
}

fn guest_unofficial_napi_notify_datetime_configuration_change(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    unsafe { snapi_bridge_unofficial_notify_datetime_configuration_change(env_handle) }
}

fn guest_unofficial_napi_terminate_execution(env: FunctionEnvMut<NapiEnv>, napi_env: i32) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    unsafe { snapi_bridge_unofficial_terminate_execution(env_handle) }
}

fn guest_unofficial_napi_cancel_terminate_execution(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    unsafe { snapi_bridge_unofficial_cancel_terminate_execution(env_handle) }
}

fn guest_unofficial_napi_request_interrupt(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    callback: i32,
    data: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let callback_id = if callback > 0 { callback as u32 } else { 0 };
    let data_val = if data > 0 { data as u32 } else { 0 };
    with_cb_context(&mut env, napi_env, || unsafe {
        snapi_bridge_unofficial_request_interrupt(
            env_handle,
            napi_env as u32,
            callback_id,
            data_val,
        )
    })
}

fn guest_unofficial_napi_structured_clone(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    value: i32,
    transfer_list: i32,
    result_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let value_id = if value > 0 { value as u32 } else { 0 };
    let transfer_list_id = if transfer_list > 0 {
        transfer_list as u32
    } else {
        0
    };
    let mut out = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_structured_clone(env_handle, value_id, transfer_list_id, &mut out)
    };
    if status == 0 && result_ptr > 0 {
        write_guest_u32(&mut env, result_ptr as u32, out);
    }
    status
}

fn guest_unofficial_napi_message_create(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    value: i32,
    payload_out_ptr: i32,
) -> i32 {
    if payload_out_ptr <= 0 {
        return 1;
    }
    let env_handle = snapi_env(&env, napi_env);
    let mut payload = 0u32;
    let status =
        unsafe { snapi_bridge_unofficial_message_create(env_handle, value as u32, &mut payload) };
    if status == 0 && payload_out_ptr > 0 {
        write_guest_u32(&mut env, payload_out_ptr as u32, payload);
    }
    status
}

#[cfg(all(target_arch = "wasm32", feature = "js"))]
async fn guest_unofficial_napi_message_take_async(
    mut env: AsyncFunctionEnvMut<NapiEnv>,
    napi_env: i32,
    payload: i32,
    result_out_ptr: i32,
) -> i32 {
    if payload <= 0 {
        return 1;
    }
    if result_out_ptr <= 0 {
        unsafe { snapi_bridge_unofficial_message_drop(payload as u32) };
        return 1;
    }
    let env_handle = {
        let env = env.read().await;
        env.data().resolve_napi_env(napi_env)
    };
    let (status, value) = with_callback_state_async(env.as_mut(), env_handle, async move {
        if crate::snapi_js::wait_for_message(payload as u32)
            .await
            .is_err()
        {
            unsafe { snapi_bridge_unofficial_message_drop(payload as u32) };
            return (9, 0);
        }
        let mut value = 0u32;
        let status =
            unsafe { snapi_bridge_unofficial_message_take(env_handle, payload as u32, &mut value) };
        (status, value)
    })
    .await;
    if status == 0 && result_out_ptr > 0 {
        let mut locked = env.write().await;
        let mut sync_env = locked.as_function_env_mut();
        write_guest_u32(&mut sync_env, result_out_ptr as u32, value);
    }
    status
}

#[cfg(not(all(target_arch = "wasm32", feature = "js")))]
fn guest_unofficial_napi_message_take_sync(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    payload: i32,
    result_out_ptr: i32,
) -> i32 {
    if payload <= 0 {
        return 1;
    }
    if result_out_ptr <= 0 {
        unsafe { snapi_bridge_unofficial_message_drop(payload as u32) };
        return 1;
    }
    let env_handle = snapi_env(&env, napi_env);
    let mut value = 0u32;
    let status =
        unsafe { snapi_bridge_unofficial_message_take(env_handle, payload as u32, &mut value) };
    if status == 0 && result_out_ptr > 0 {
        write_guest_u32(&mut env, result_out_ptr as u32, value);
    }
    status
}

#[cfg(all(target_arch = "wasm32", feature = "js"))]
fn message_take_import(store: &mut impl AsStoreMut, fe: &FunctionEnv<NapiEnv>) -> Function {
    Function::new_typed_with_env_async(store, fe, guest_unofficial_napi_message_take_async)
}

#[cfg(not(all(target_arch = "wasm32", feature = "js")))]
fn message_take_import(store: &mut impl AsStoreMut, fe: &FunctionEnv<NapiEnv>) -> Function {
    Function::new_typed_with_env(store, fe, guest_unofficial_napi_message_take_sync)
}

fn guest_unofficial_napi_message_drop(_env: FunctionEnvMut<NapiEnv>, payload: i32) {
    unsafe { snapi_bridge_unofficial_message_drop(payload as u32) };
}

fn guest_unofficial_napi_enqueue_microtask(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    callback: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let callback_id = if callback > 0 { callback as u32 } else { 0 };
    unsafe { snapi_bridge_unofficial_enqueue_microtask(env_handle, callback_id) }
}

fn guest_unofficial_napi_set_promise_reject_callback(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    callback: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let callback_id = if callback > 0 { callback as u32 } else { 0 };
    unsafe { snapi_bridge_unofficial_set_promise_reject_callback(env_handle, callback_id) }
}

fn guest_unofficial_napi_get_own_non_index_properties(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    value: i32,
    filter_bits: i32,
    result_out_ptr: i32,
) -> i32 {
    if value <= 0 || result_out_ptr <= 0 {
        return 1;
    }
    let env_handle = snapi_env(&env, napi_env);
    let mut out = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_get_own_non_index_properties(
            env_handle,
            value as u32,
            filter_bits.max(0) as u32,
            &mut out,
        )
    };
    if status == 0 {
        write_guest_u32(&mut env, result_out_ptr as u32, out);
    }
    status
}

fn guest_unofficial_napi_set_promise_hooks(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    init_callback: i32,
    before_callback: i32,
    after_callback: i32,
    resolve_callback: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    unsafe {
        snapi_bridge_unofficial_set_promise_hooks(
            env_handle,
            if init_callback > 0 {
                init_callback as u32
            } else {
                0
            },
            if before_callback > 0 {
                before_callback as u32
            } else {
                0
            },
            if after_callback > 0 {
                after_callback as u32
            } else {
                0
            },
            if resolve_callback > 0 {
                resolve_callback as u32
            } else {
                0
            },
        )
    }
}

fn guest_unofficial_napi_get_hash_seed(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    hash_seed_out: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let mut hash_seed = 0u64;
    let status = unsafe { snapi_bridge_unofficial_get_hash_seed(env_handle, &mut hash_seed) };
    if status == 0 && hash_seed_out > 0 {
        write_guest_u64(&mut env, hash_seed_out as u32, hash_seed);
    }
    status
}

fn guest_unofficial_napi_get_error_metadata(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    error: i32,
    mode: i32,
    metadata_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let error_id = if error > 0 { error as u32 } else { 0 };
    let mut source_line_id = 0u32;
    let mut script_resource_name_id = 0u32;
    let mut stderr_line_id = 0u32;
    let mut thrown_at_id = 0u32;
    let mut line_number = 0i32;
    let mut start_column = 0i32;
    let mut end_column = 0i32;
    let status = unsafe {
        snapi_bridge_unofficial_get_error_metadata(
            env_handle,
            error_id,
            mode,
            &mut source_line_id,
            &mut script_resource_name_id,
            &mut stderr_line_id,
            &mut thrown_at_id,
            &mut line_number,
            &mut start_column,
            &mut end_column,
        )
    };
    if status != 0 {
        return status;
    }
    if metadata_ptr > 0 {
        write_guest_u32(&mut env, metadata_ptr as u32, source_line_id);
        write_guest_u32(&mut env, metadata_ptr as u32 + 4, script_resource_name_id);
        write_guest_u32(&mut env, metadata_ptr as u32 + 8, stderr_line_id);
        write_guest_u32(&mut env, metadata_ptr as u32 + 12, thrown_at_id);
        write_guest_i32(&mut env, metadata_ptr as u32 + 16, line_number);
        write_guest_i32(&mut env, metadata_ptr as u32 + 20, start_column);
        write_guest_i32(&mut env, metadata_ptr as u32 + 24, end_column);
    }
    0
}

fn guest_unofficial_napi_configure_source_maps(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    enabled: i32,
    callback: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let callback_id = if callback > 0 { callback as u32 } else { 0 };
    unsafe { snapi_bridge_unofficial_configure_source_maps(env_handle, enabled, callback_id) }
}

fn guest_unofficial_napi_preserve_error_source_message(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    error: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let error_id = if error > 0 { error as u32 } else { 0 };
    unsafe { snapi_bridge_unofficial_preserve_error_source_message(env_handle, error_id) }
}

fn guest_unofficial_napi_mark_promise_as_handled(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    promise: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let promise_id = if promise > 0 { promise as u32 } else { 0 };
    unsafe { snapi_bridge_unofficial_mark_promise_as_handled(env_handle, promise_id) }
}

fn guest_unofficial_napi_get_heap_statistics(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    stats_ptr: i32,
) -> i32 {
    let Some(size) = abi::read_output_header(
        &mut env,
        stats_ptr,
        std::mem::size_of::<SnapiUnofficialHeapStatistics>(),
        1,
    ) else {
        return 1;
    };
    let env_handle = snapi_env(&env, napi_env);
    let mut stats = SnapiUnofficialHeapStatistics {
        size,
        version: 1,
        valid_fields: 0,
        total_heap_size: 0,
        total_heap_size_executable: 0,
        total_physical_size: 0,
        total_available_size: 0,
        used_heap_size: 0,
        heap_size_limit: 0,
        does_zap_garbage: 0,
        malloced_memory: 0,
        peak_malloced_memory: 0,
        number_of_native_contexts: 0,
        number_of_detached_contexts: 0,
        total_global_handles_size: 0,
        used_global_handles_size: 0,
        external_memory: 0,
        array_buffer_memory: 0,
    };
    let status = unsafe { snapi_bridge_unofficial_get_heap_statistics(env_handle, &mut stats) };
    if status == 0 && stats_ptr > 0 && !write_guest_pod(&mut env, stats_ptr, &stats) {
        return 1;
    }
    status
}

fn guest_unofficial_napi_get_heap_space_statistics(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    stats_ptr: i32,
    capacity: i32,
    count_ptr: i32,
) -> i32 {
    const MAX_HEAP_SPACE_CAPACITY: usize = 1024;
    if capacity < 0 || count_ptr <= 0 || (capacity > 0 && stats_ptr <= 0) {
        return 1;
    }
    let capacity = capacity as usize;
    if capacity > MAX_HEAP_SPACE_CAPACITY {
        return 1;
    }
    let env_handle = snapi_env(&env, napi_env);
    let mut stats: Vec<SnapiUnofficialHeapSpaceStatistics> = (0..capacity)
        .map(|_| SnapiUnofficialHeapSpaceStatistics {
            space_name: [0; 64],
            space_size: 0,
            space_used_size: 0,
            space_available_size: 0,
            physical_space_size: 0,
        })
        .collect();
    let mut count = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_get_heap_space_statistics(
            env_handle,
            if stats.is_empty() {
                std::ptr::null_mut()
            } else {
                stats.as_mut_ptr()
            },
            capacity as u32,
            &mut count,
        )
    };
    if status == 0 {
        if !write_guest_u32(&mut env, count_ptr as u32, count) {
            return 1;
        }
        let written = capacity.min(count as usize);
        if !write_guest_pod_slice(&mut env, stats_ptr, &stats[..written]) {
            return 1;
        }
    }
    status
}

fn guest_unofficial_napi_get_heap_code_statistics(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    stats_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let mut stats = SnapiUnofficialHeapCodeStatistics {
        code_and_metadata_size: 0,
        bytecode_and_metadata_size: 0,
        external_script_source_size: 0,
        cpu_profiler_metadata_size: 0,
    };
    let status =
        unsafe { snapi_bridge_unofficial_get_heap_code_statistics(env_handle, &mut stats) };
    if status == 0 && stats_ptr > 0 && !write_guest_pod(&mut env, stats_ptr, &stats) {
        return 1;
    }
    status
}

fn guest_unofficial_napi_configure_near_heap_limit_callback(
    _env: FunctionEnvMut<NapiEnv>,
    _napi_env: i32,
    _callback: i32,
    _data: i32,
    _restored_heap_limit: i32,
) -> i32 {
    0
}

fn guest_unofficial_napi_profile_start(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    kind: i32,
    result_ptr: i32,
    profile_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let mut result = 0i32;
    let mut profile = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_profile_start(env_handle, kind, &mut result, &mut profile)
    };
    if status != 0 {
        return status;
    }
    if result_ptr > 0 {
        write_guest_i32(&mut env, result_ptr as u32, result);
    }
    if profile_ptr > 0 {
        write_guest_u32(&mut env, profile_ptr as u32, profile);
    }
    0
}

fn guest_unofficial_napi_profile_stop(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    profile: i32,
    json_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let mut json = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_profile_stop(env_handle, profile.max(0) as u32, &mut json)
    };
    if status != 0 {
        return status;
    }
    if json_ptr > 0 && !write_guest_u32(&mut env, json_ptr as u32, json) {
        return 1;
    }
    0
}

fn guest_unofficial_napi_take_heap_snapshot(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    options_ptr: i32,
    json_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let (expose_internals, expose_numeric_values) = if options_ptr > 0 {
        let Some(bytes) = read_guest_bytes(&mut env, options_ptr, 2) else {
            return 1;
        };
        ((bytes[0] != 0) as i32, (bytes[1] != 0) as i32)
    } else {
        (0, 0)
    };
    let mut json = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_take_heap_snapshot(
            env_handle,
            expose_internals,
            expose_numeric_values,
            &mut json,
        )
    };
    if status != 0 {
        return status;
    }
    if json_ptr > 0 && !write_guest_u32(&mut env, json_ptr as u32, json) {
        return 1;
    }
    0
}

fn guest_unofficial_napi_create_serdes_binding(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    result_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let mut out = 0u32;
    let status = unsafe { snapi_bridge_unofficial_create_serdes_binding(env_handle, &mut out) };
    if status == 0 && result_ptr > 0 {
        write_guest_u32(&mut env, result_ptr as u32, out);
    }
    status
}

fn guest_napi_add_env_cleanup_hook(
    _env: FunctionEnvMut<NapiEnv>,
    _napi_env: i32,
    _fun: i32,
    _arg: i32,
) -> i32 {
    0
}

fn guest_napi_remove_env_cleanup_hook(
    _env: FunctionEnvMut<NapiEnv>,
    _napi_env: i32,
    _fun: i32,
    _arg: i32,
) -> i32 {
    0
}

fn guest_unofficial_napi_contextify_contains_module_syntax(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    code: i32,
    filename: i32,
    resource_name_or_undefined: i32,
    cjs_var_in_scope: i32,
    result_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let code_id = if code > 0 { code as u32 } else { 0 };
    let filename_id = if filename > 0 { filename as u32 } else { 0 };
    let resource_name_id = if resource_name_or_undefined > 0 {
        resource_name_or_undefined as u32
    } else {
        0
    };
    let mut result = 0i32;
    let status = unsafe {
        snapi_bridge_unofficial_contextify_contains_module_syntax(
            env_handle,
            code_id,
            filename_id,
            resource_name_id,
            cjs_var_in_scope,
            &mut result,
        )
    };
    if status == 0 && result_ptr > 0 {
        write_guest_u8(&mut env, result_ptr as u32, (result != 0) as u8);
    }
    status
}

#[allow(clippy::too_many_arguments)]
fn guest_unofficial_napi_contextify_make_context(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    sandbox_or_symbol: i32,
    name: i32,
    origin_or_undefined: i32,
    allow_code_gen_strings: i32,
    allow_code_gen_wasm: i32,
    own_microtask_queue: i32,
    host_defined_option_id: i32,
    result_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let mut result_id = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_contextify_make_context(
            env_handle,
            sandbox_or_symbol as u32,
            name as u32,
            if origin_or_undefined > 0 {
                origin_or_undefined as u32
            } else {
                0
            },
            allow_code_gen_strings,
            allow_code_gen_wasm,
            own_microtask_queue,
            if host_defined_option_id > 0 {
                host_defined_option_id as u32
            } else {
                0
            },
            &mut result_id,
        )
    };
    if status == 0 && result_ptr > 0 {
        write_guest_u32(&mut env, result_ptr as u32, result_id);
    }
    status
}

#[allow(clippy::too_many_arguments)]
fn guest_unofficial_napi_contextify_run_script(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    sandbox_or_null: i32,
    source_ptr: i32,
    filename: i32,
    line_offset: i32,
    column_offset: i32,
    timeout: i64,
    display_errors: i32,
    break_on_sigint: i32,
    break_on_first_line: i32,
    host_defined_option_id: i32,
    result_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let Some((source_text, source_bytecode)) = abi::read_js_source(&mut env, source_ptr) else {
        return 1;
    };
    let mut result_id = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_contextify_run_script(
            env_handle,
            if sandbox_or_null > 0 {
                sandbox_or_null as u32
            } else {
                0
            },
            source_text,
            source_bytecode,
            filename as u32,
            line_offset,
            column_offset,
            timeout,
            display_errors,
            break_on_sigint,
            break_on_first_line,
            if host_defined_option_id > 0 {
                host_defined_option_id as u32
            } else {
                0
            },
            &mut result_id,
        )
    };
    if status == 0 && result_ptr > 0 {
        write_guest_u32(&mut env, result_ptr as u32, result_id);
    }
    status
}

#[allow(clippy::too_many_arguments)]
fn guest_unofficial_napi_contextify_compile_function(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    source_ptr: i32,
    filename: i32,
    line_offset: i32,
    column_offset: i32,
    parsing_context_or_undefined: i32,
    context_extensions_or_undefined: i32,
    params_or_undefined: i32,
    host_defined_option_id: i32,
    result_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let Some((source_text, source_bytecode)) = abi::read_js_source(&mut env, source_ptr) else {
        return 1;
    };
    let mut result_id = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_contextify_compile_function(
            env_handle,
            source_text,
            source_bytecode,
            filename as u32,
            line_offset,
            column_offset,
            if parsing_context_or_undefined > 0 {
                parsing_context_or_undefined as u32
            } else {
                0
            },
            if context_extensions_or_undefined > 0 {
                context_extensions_or_undefined as u32
            } else {
                0
            },
            if params_or_undefined > 0 {
                params_or_undefined as u32
            } else {
                0
            },
            if host_defined_option_id > 0 {
                host_defined_option_id as u32
            } else {
                0
            },
            &mut result_id,
        )
    };
    if status == 0 && result_ptr > 0 {
        write_guest_u32(&mut env, result_ptr as u32, result_id);
    }
    status
}

fn guest_unofficial_napi_bytecode_open(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    options_ptr: i32,
    result_ptr: i32,
) -> i32 {
    let Some(options) = abi::read_bytecode_open(&mut env, options_ptr) else {
        return 1;
    };
    if result_ptr <= 0 {
        return 1;
    }
    let env_handle = snapi_env(&env, napi_env);
    let mut bytecode_id = 0u32;
    let mut cache_rejected = 0u8;
    let mut can_parse_as_module = 0u8;
    let status = unsafe {
        snapi_bridge_unofficial_bytecode_open(
            env_handle,
            options.source_text,
            options.filename,
            options.shape,
            options.params_or_undefined,
            options.host_defined_option_id,
            options.line_offset,
            options.column_offset,
            if options.has_cache != 0 {
                options.cache.as_ptr()
            } else {
                std::ptr::null()
            },
            options.cache.len(),
            options.has_cache,
            options.cache_policy,
            &mut bytecode_id,
            &mut cache_rejected,
            &mut can_parse_as_module,
        )
    };
    write_guest_u32(&mut env, result_ptr as u32, bytecode_id);
    write_guest_u8(&mut env, result_ptr as u32 + 4, cache_rejected);
    write_guest_u8(&mut env, result_ptr as u32 + 5, can_parse_as_module);
    status
}

fn guest_unofficial_napi_bytecode_serialize(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    bytecode: i32,
    buffer_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let mut buffer_id = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_bytecode_serialize(env_handle, bytecode as u32, &mut buffer_id)
    };
    if status == 0 && buffer_ptr > 0 {
        write_guest_u32(&mut env, buffer_ptr as u32, buffer_id);
    }
    status
}

fn guest_unofficial_napi_bytecode_release(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    bytecode: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    unsafe { snapi_bridge_unofficial_bytecode_release(env_handle, bytecode as u32) }
}

fn guest_unofficial_napi_module_wrap_create(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    options_ptr: i32,
    result_ptr: i32,
) -> i32 {
    let Some(options) = abi::read_module_create(&mut env, options_ptr) else {
        return 1;
    };
    if result_ptr <= 0 {
        return 1;
    }
    let env_handle = snapi_env(&env, napi_env);
    let mut handle_id = 0u32;
    let mut requests_id = 0u32;
    let mut has_top_level_await = 0u8;
    let status = unsafe {
        snapi_bridge_unofficial_module_wrap_create(
            env_handle,
            options.kind,
            options.wrapper,
            options.url,
            options.context_or_undefined,
            options.source_text,
            options.source_bytecode,
            options.line_offset,
            options.column_offset,
            options.host_defined_option_id,
            options.export_names,
            options.synthetic_eval_steps,
            &mut handle_id,
            &mut requests_id,
            &mut has_top_level_await,
        )
    };
    if status == 0 {
        write_guest_u32(&mut env, result_ptr as u32, handle_id);
        write_guest_u32(&mut env, result_ptr as u32 + 4, requests_id);
        write_guest_bytes(&mut env, result_ptr as u32 + 8, &[has_top_level_await]);
    }
    status
}

fn guest_unofficial_napi_module_wrap_destroy(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    handle: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    unsafe { snapi_bridge_unofficial_module_wrap_destroy(env_handle, handle as u32) }
}

fn guest_unofficial_napi_module_wrap_link(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    handle: i32,
    count: i32,
    linked_handles_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let count_u = count as u32;
    let linked_handles = if count_u > 0 {
        let Some(ids) = read_guest_u32_array(&mut env, linked_handles_ptr, count_u as usize) else {
            return 1;
        };
        ids
    } else {
        Vec::new()
    };
    unsafe {
        snapi_bridge_unofficial_module_wrap_link(
            env_handle,
            handle as u32,
            count_u,
            linked_handles.as_ptr(),
        )
    }
}

fn guest_unofficial_napi_module_wrap_instantiate(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    handle: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    unsafe { snapi_bridge_unofficial_module_wrap_instantiate(env_handle, handle as u32) }
}

fn guest_unofficial_napi_module_wrap_evaluate(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    handle: i32,
    timeout: i64,
    break_on_sigint: i32,
    result_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let mut result_id = 0u32;
    let status = with_cb_context(&mut env, napi_env, || unsafe {
        snapi_bridge_unofficial_module_wrap_evaluate(
            env_handle,
            handle as u32,
            timeout,
            break_on_sigint,
            &mut result_id,
        )
    });
    if status == 0 && result_ptr > 0 {
        write_guest_u32(&mut env, result_ptr as u32, result_id);
    }
    status
}

fn guest_unofficial_napi_module_wrap_evaluate_sync(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    handle: i32,
    filename: i32,
    parent_filename: i32,
    result_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let mut result_id = 0u32;
    let status = with_cb_context(&mut env, napi_env, || unsafe {
        snapi_bridge_unofficial_module_wrap_evaluate_sync(
            env_handle,
            handle as u32,
            if filename > 0 { filename as u32 } else { 0 },
            if parent_filename > 0 {
                parent_filename as u32
            } else {
                0
            },
            &mut result_id,
        )
    });
    if status == 0 && result_ptr > 0 {
        write_guest_u32(&mut env, result_ptr as u32, result_id);
    }
    status
}

fn guest_unofficial_napi_module_wrap_get_namespace(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    handle: i32,
    result_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let mut result_id = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_module_wrap_get_namespace(env_handle, handle as u32, &mut result_id)
    };
    if status == 0 && result_ptr > 0 {
        write_guest_u32(&mut env, result_ptr as u32, result_id);
    }
    status
}

fn guest_unofficial_napi_module_wrap_get_state(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    handle: i32,
    status_ptr: i32,
    error_ptr: i32,
    has_async_graph_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let mut status_val = 0i32;
    let mut error_id = 0u32;
    let mut has_async_graph = 0i32;
    let status = unsafe {
        snapi_bridge_unofficial_module_wrap_get_state(
            env_handle,
            handle as u32,
            if status_ptr > 0 {
                &mut status_val
            } else {
                std::ptr::null_mut()
            },
            if error_ptr > 0 {
                &mut error_id
            } else {
                std::ptr::null_mut()
            },
            if has_async_graph_ptr > 0 {
                &mut has_async_graph
            } else {
                std::ptr::null_mut()
            },
        )
    };
    if status == 0 {
        if status_ptr > 0 {
            write_guest_i32(&mut env, status_ptr as u32, status_val);
        }
        if error_ptr > 0 {
            write_guest_u32(&mut env, error_ptr as u32, error_id);
        }
        if has_async_graph_ptr > 0 {
            write_guest_u8(
                &mut env,
                has_async_graph_ptr as u32,
                (has_async_graph != 0) as u8,
            );
        }
    }
    status
}

fn guest_unofficial_napi_module_wrap_check_unsettled_top_level_await(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    handle: i32,
    warnings: i32,
    settled_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let handle_id = if handle > 0 { handle as u32 } else { 0 };
    let mut settled = 0i32;
    let status = unsafe {
        snapi_bridge_unofficial_module_wrap_check_unsettled_top_level_await(
            env_handle,
            handle_id,
            warnings,
            &mut settled,
        )
    };
    if status == 0 && settled_ptr > 0 {
        write_guest_u8(&mut env, settled_ptr as u32, (settled != 0) as u8);
    }
    status
}

fn guest_unofficial_napi_module_wrap_set_export(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    handle: i32,
    export_name: i32,
    export_value: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    unsafe {
        snapi_bridge_unofficial_module_wrap_set_export(
            env_handle,
            handle as u32,
            export_name as u32,
            if export_value > 0 {
                export_value as u32
            } else {
                0
            },
        )
    }
}

fn guest_unofficial_napi_module_wrap_set_module_source_object(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    handle: i32,
    source_object: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    unsafe {
        snapi_bridge_unofficial_module_wrap_set_module_source_object(
            env_handle,
            handle as u32,
            if source_object > 0 {
                source_object as u32
            } else {
                0
            },
        )
    }
}

fn guest_unofficial_napi_module_wrap_get_module_source_object(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    handle: i32,
    result_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let mut result_id = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_module_wrap_get_module_source_object(
            env_handle,
            handle as u32,
            &mut result_id,
        )
    };
    if status == 0 && result_ptr > 0 {
        write_guest_u32(&mut env, result_ptr as u32, result_id);
    }
    status
}

fn guest_unofficial_napi_module_wrap_create_cached_data(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    handle: i32,
    result_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let mut result_id = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_module_wrap_create_cached_data(
            env_handle,
            handle as u32,
            &mut result_id,
        )
    };
    if status == 0 && result_ptr > 0 {
        write_guest_u32(&mut env, result_ptr as u32, result_id);
    }
    status
}

fn guest_unofficial_napi_module_wrap_set_hooks(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    hooks_ptr: i32,
) -> i32 {
    let Some((dynamic_import, initialize_import_meta)) =
        abi::read_module_hooks(&mut env, hooks_ptr)
    else {
        return 1;
    };
    let env_handle = snapi_env(&env, napi_env);
    unsafe {
        snapi_bridge_unofficial_module_wrap_set_hooks(
            env_handle,
            dynamic_import,
            initialize_import_meta,
        )
    }
}

fn guest_unofficial_napi_module_wrap_create_required_module_facade(
    mut env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    handle: i32,
    result_ptr: i32,
) -> i32 {
    let env_handle = snapi_env(&env, napi_env);
    let mut result_id = 0u32;
    let status = unsafe {
        snapi_bridge_unofficial_module_wrap_create_required_module_facade(
            env_handle,
            handle as u32,
            &mut result_id,
        )
    };
    if status == 0 && result_ptr > 0 {
        write_guest_u32(&mut env, result_ptr as u32, result_id);
    }
    status
}

// --- Singleton getters ---

fn guest_napi_get_undefined(mut env: FunctionEnvMut<NapiEnv>, e: i32, rp: i32) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe { snapi_bridge_get_undefined(snapi_env(&env, e), &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_get_null(mut env: FunctionEnvMut<NapiEnv>, e: i32, rp: i32) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe { snapi_bridge_get_null(snapi_env(&env, e), &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_get_boolean(mut env: FunctionEnvMut<NapiEnv>, e: i32, value: i32, rp: i32) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe { snapi_bridge_get_boolean(snapi_env(&env, e), value, &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_get_global(mut env: FunctionEnvMut<NapiEnv>, e: i32, rp: i32) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe { snapi_bridge_get_global(snapi_env(&env, e), &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

// --- Value creation ---

fn guest_napi_create_string_utf8(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    str_ptr: i32,
    length: i32,
    rp: i32,
) -> i32 {
    let wl = length as u32;
    let sb = if wl == 0xFFFFFFFFu32 {
        read_guest_c_string(&mut env, str_ptr)
    } else {
        read_guest_bytes(&mut env, str_ptr, wl as usize)
    };
    let Some(sb) = sb else {
        return 1;
    };
    let mut out: u32 = 0;
    let s = unsafe {
        snapi_bridge_create_string_utf8(
            snapi_env(&env, e),
            sb.as_ptr() as *const i8,
            sb.len() as u32,
            &mut out,
        )
    };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_create_string_latin1(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    str_ptr: i32,
    length: i32,
    rp: i32,
) -> i32 {
    let wl = length as u32;
    let sb = if wl == 0xFFFFFFFFu32 {
        read_guest_c_string(&mut env, str_ptr)
    } else {
        read_guest_bytes(&mut env, str_ptr, wl as usize)
    };
    let Some(sb) = sb else {
        return 1;
    };
    let mut out: u32 = 0;
    let s = unsafe {
        snapi_bridge_create_string_latin1(
            snapi_env(&env, e),
            sb.as_ptr() as *const i8,
            sb.len() as u32,
            &mut out,
        )
    };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_create_int32(mut env: FunctionEnvMut<NapiEnv>, e: i32, value: i32, rp: i32) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe { snapi_bridge_create_int32(snapi_env(&env, e), value, &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_create_uint32(mut env: FunctionEnvMut<NapiEnv>, e: i32, value: i32, rp: i32) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe { snapi_bridge_create_uint32(snapi_env(&env, e), value as u32, &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_create_double(mut env: FunctionEnvMut<NapiEnv>, e: i32, value: f64, rp: i32) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe { snapi_bridge_create_double(snapi_env(&env, e), value, &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_create_int64(mut env: FunctionEnvMut<NapiEnv>, e: i32, value: i64, rp: i32) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe { snapi_bridge_create_int64(snapi_env(&env, e), value, &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_create_object(mut env: FunctionEnvMut<NapiEnv>, e: i32, rp: i32) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe { snapi_bridge_create_object(snapi_env(&env, e), &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_create_array(mut env: FunctionEnvMut<NapiEnv>, e: i32, rp: i32) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe { snapi_bridge_create_array(snapi_env(&env, e), &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_create_array_with_length(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    length: i32,
    rp: i32,
) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe {
        snapi_bridge_create_array_with_length(snapi_env(&env, e), length as u32, &mut out)
    };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_create_symbol(mut env: FunctionEnvMut<NapiEnv>, e: i32, desc: i32, rp: i32) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe { snapi_bridge_create_symbol(snapi_env(&env, e), desc as u32, &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_create_error(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    code: i32,
    msg: i32,
    rp: i32,
) -> i32 {
    let mut out: u32 = 0;
    let s =
        unsafe { snapi_bridge_create_error(snapi_env(&env, e), code as u32, msg as u32, &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_create_type_error(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    code: i32,
    msg: i32,
    rp: i32,
) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe {
        snapi_bridge_create_type_error(snapi_env(&env, e), code as u32, msg as u32, &mut out)
    };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_create_range_error(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    code: i32,
    msg: i32,
    rp: i32,
) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe {
        snapi_bridge_create_range_error(snapi_env(&env, e), code as u32, msg as u32, &mut out)
    };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_create_bigint_int64(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    value: i64,
    rp: i32,
) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe { snapi_bridge_create_bigint_int64(snapi_env(&env, e), value, &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_create_bigint_uint64(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    value: i64,
    rp: i32,
) -> i32 {
    let mut out: u32 = 0;
    let s =
        unsafe { snapi_bridge_create_bigint_uint64(snapi_env(&env, e), value as u64, &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_create_date(mut env: FunctionEnvMut<NapiEnv>, e: i32, time: f64, rp: i32) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe { snapi_bridge_create_date(snapi_env(&env, e), time, &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_create_external(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    data: i32,
    _finalize_cb: i32,
    _finalize_hint: i32,
    rp: i32,
) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe { snapi_bridge_create_external(snapi_env(&env, e), data as u64, &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

// --- Value reading ---

fn guest_napi_get_value_string_utf8(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    vh: i32,
    bp: i32,
    bs: i32,
    rp: i32,
) -> i32 {
    let hbs = if bs <= 0 { 0usize } else { bs as usize };
    if hbs as u64 > guest_data_size(&mut env) {
        return 1;
    }
    let mut hb = vec![0i8; hbs];
    let mut rl: usize = 0;
    let s = unsafe {
        snapi_bridge_get_value_string_utf8(
            snapi_env(&env, e),
            vh as u32,
            if hbs > 0 {
                hb.as_mut_ptr()
            } else {
                std::ptr::null_mut()
            },
            hbs,
            &mut rl,
        )
    };
    if s != 0 {
        return s;
    }
    if bp > 0 && hbs > 0 {
        let n = hbs.min(rl + 1);
        let b: Vec<u8> = hb[..n].iter().map(|&x| x as u8).collect();
        write_guest_bytes(&mut env, bp as u32, &b);
    }
    if rp > 0 {
        write_guest_u32(&mut env, rp as u32, rl as u32);
    }
    0
}

fn guest_napi_get_value_string_latin1(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    vh: i32,
    bp: i32,
    bs: i32,
    rp: i32,
) -> i32 {
    let hbs = if bs <= 0 { 0usize } else { bs as usize };
    if hbs as u64 > guest_data_size(&mut env) {
        return 1;
    }
    let mut hb = vec![0i8; hbs];
    let mut rl: usize = 0;
    let s = unsafe {
        snapi_bridge_get_value_string_latin1(
            snapi_env(&env, e),
            vh as u32,
            if hbs > 0 {
                hb.as_mut_ptr()
            } else {
                std::ptr::null_mut()
            },
            hbs,
            &mut rl,
        )
    };
    if s != 0 {
        return s;
    }
    if bp > 0 && hbs > 0 {
        let n = hbs.min(rl + 1);
        let b: Vec<u8> = hb[..n].iter().map(|&x| x as u8).collect();
        write_guest_bytes(&mut env, bp as u32, &b);
    }
    if rp > 0 {
        write_guest_u32(&mut env, rp as u32, rl as u32);
    }
    0
}

fn guest_napi_get_value_int32(mut env: FunctionEnvMut<NapiEnv>, e: i32, vh: i32, rp: i32) -> i32 {
    let mut r: i32 = 0;
    let s = unsafe { snapi_bridge_get_value_int32(snapi_env(&env, e), vh as u32, &mut r) };
    if s == 0 {
        write_guest_i32(&mut env, rp as u32, r);
    }
    s
}

fn guest_napi_get_value_uint32(mut env: FunctionEnvMut<NapiEnv>, e: i32, vh: i32, rp: i32) -> i32 {
    let mut r: u32 = 0;
    let s = unsafe { snapi_bridge_get_value_uint32(snapi_env(&env, e), vh as u32, &mut r) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, r);
    }
    s
}

fn guest_napi_get_value_double(mut env: FunctionEnvMut<NapiEnv>, e: i32, vh: i32, rp: i32) -> i32 {
    let mut r: f64 = 0.0;
    let s = unsafe { snapi_bridge_get_value_double(snapi_env(&env, e), vh as u32, &mut r) };
    if s == 0 {
        write_guest_f64(&mut env, rp as u32, r);
    }
    s
}

fn guest_napi_get_value_int64(mut env: FunctionEnvMut<NapiEnv>, e: i32, vh: i32, rp: i32) -> i32 {
    let mut r: i64 = 0;
    let s = unsafe { snapi_bridge_get_value_int64(snapi_env(&env, e), vh as u32, &mut r) };
    if s == 0 {
        write_guest_i64(&mut env, rp as u32, r);
    }
    s
}

fn guest_napi_get_value_bool(mut env: FunctionEnvMut<NapiEnv>, e: i32, vh: i32, rp: i32) -> i32 {
    let mut r: i32 = 0;
    let s = unsafe { snapi_bridge_get_value_bool(snapi_env(&env, e), vh as u32, &mut r) };
    if s == 0 {
        write_guest_u8(&mut env, rp as u32, r as u8);
    }
    s
}

fn guest_napi_get_value_bigint_int64(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    vh: i32,
    vp: i32,
    lp: i32,
) -> i32 {
    let mut val: i64 = 0;
    let mut lossless: i32 = 0;
    let s = unsafe {
        snapi_bridge_get_value_bigint_int64(snapi_env(&env, e), vh as u32, &mut val, &mut lossless)
    };
    if s == 0 {
        write_guest_i64(&mut env, vp as u32, val);
        write_guest_u8(&mut env, lp as u32, lossless as u8);
    }
    s
}

fn guest_napi_get_value_bigint_uint64(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    vh: i32,
    vp: i32,
    lp: i32,
) -> i32 {
    let mut val: u64 = 0;
    let mut lossless: i32 = 0;
    let s = unsafe {
        snapi_bridge_get_value_bigint_uint64(snapi_env(&env, e), vh as u32, &mut val, &mut lossless)
    };
    if s == 0 {
        write_guest_u64(&mut env, vp as u32, val);
        write_guest_u8(&mut env, lp as u32, lossless as u8);
    }
    s
}

fn guest_napi_get_date_value(mut env: FunctionEnvMut<NapiEnv>, e: i32, vh: i32, rp: i32) -> i32 {
    let mut r: f64 = 0.0;
    let s = unsafe { snapi_bridge_get_date_value(snapi_env(&env, e), vh as u32, &mut r) };
    if s == 0 {
        write_guest_f64(&mut env, rp as u32, r);
    }
    s
}

fn guest_napi_get_value_external(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    vh: i32,
    rp: i32,
) -> i32 {
    let mut data: u64 = 0;
    let s = unsafe { snapi_bridge_get_value_external(snapi_env(&env, e), vh as u32, &mut data) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, data as u32);
    }
    s
}

// --- Type checking ---

fn guest_napi_typeof(mut env: FunctionEnvMut<NapiEnv>, e: i32, vh: i32, rp: i32) -> i32 {
    let mut r: i32 = 0;
    let s = unsafe { snapi_bridge_typeof(snapi_env(&env, e), vh as u32, &mut r) };
    if s == 0 {
        write_guest_i32(&mut env, rp as u32, r);
    }
    s
}

macro_rules! guest_is_check {
    ($name:ident, $bridge:ident) => {
        fn $name(mut env: FunctionEnvMut<NapiEnv>, e: i32, vh: i32, rp: i32) -> i32 {
            let mut r: i32 = 0;
            let s = unsafe { $bridge(snapi_env(&env, e), vh as u32, &mut r) };
            if s == 0 {
                write_guest_u8(&mut env, rp as u32, r as u8);
            }
            s
        }
    };
}

guest_is_check!(guest_napi_is_array, snapi_bridge_is_array);
guest_is_check!(guest_napi_is_error, snapi_bridge_is_error);
guest_is_check!(guest_napi_is_arraybuffer, snapi_bridge_is_arraybuffer);
guest_is_check!(guest_napi_is_typedarray, snapi_bridge_is_typedarray);
guest_is_check!(guest_napi_is_dataview, snapi_bridge_is_dataview);
guest_is_check!(guest_napi_is_date, snapi_bridge_is_date);
guest_is_check!(guest_napi_is_promise, snapi_bridge_is_promise);

fn guest_napi_instanceof(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    obj: i32,
    ctor: i32,
    rp: i32,
) -> i32 {
    let mut r: i32 = 0;
    let s = unsafe { snapi_bridge_instanceof(snapi_env(&env, e), obj as u32, ctor as u32, &mut r) };
    if s == 0 {
        write_guest_u8(&mut env, rp as u32, r as u8);
    }
    s
}

// --- Coercion ---

macro_rules! guest_coerce {
    ($name:ident, $bridge:ident) => {
        fn $name(mut env: FunctionEnvMut<NapiEnv>, e: i32, vh: i32, rp: i32) -> i32 {
            let mut out: u32 = 0;
            let s = unsafe { $bridge(snapi_env(&env, e), vh as u32, &mut out) };
            if s == 0 {
                write_guest_u32(&mut env, rp as u32, out);
            }
            s
        }
    };
}

guest_coerce!(guest_napi_coerce_to_bool, snapi_bridge_coerce_to_bool);
guest_coerce!(guest_napi_coerce_to_number, snapi_bridge_coerce_to_number);
guest_coerce!(guest_napi_coerce_to_string, snapi_bridge_coerce_to_string);
guest_coerce!(guest_napi_coerce_to_object, snapi_bridge_coerce_to_object);

// --- Object operations ---

fn guest_napi_set_property(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    o: i32,
    k: i32,
    v: i32,
) -> i32 {
    let snapi = snapi_env(&env, e);
    with_cb_context(&mut env, e, || unsafe {
        snapi_bridge_set_property(snapi, o as u32, k as u32, v as u32)
    })
}

fn guest_napi_get_property(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    o: i32,
    k: i32,
    rp: i32,
) -> i32 {
    let mut out: u32 = 0;
    let snapi = snapi_env(&env, e);
    let s = with_cb_context(&mut env, e, || unsafe {
        snapi_bridge_get_property(snapi, o as u32, k as u32, &mut out)
    });
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_has_property(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    o: i32,
    k: i32,
    rp: i32,
) -> i32 {
    let mut r: i32 = 0;
    let snapi = snapi_env(&env, e);
    let s = with_cb_context(&mut env, e, || unsafe {
        snapi_bridge_has_property(snapi, o as u32, k as u32, &mut r)
    });
    if s == 0 {
        write_guest_u8(&mut env, rp as u32, r as u8);
    }
    s
}

fn guest_napi_has_own_property(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    o: i32,
    k: i32,
    rp: i32,
) -> i32 {
    let mut r: i32 = 0;
    let snapi = snapi_env(&env, e);
    let s = with_cb_context(&mut env, e, || unsafe {
        snapi_bridge_has_own_property(snapi, o as u32, k as u32, &mut r)
    });
    if s == 0 {
        write_guest_u8(&mut env, rp as u32, r as u8);
    }
    s
}

fn guest_napi_delete_property(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    o: i32,
    k: i32,
    rp: i32,
) -> i32 {
    let mut r: i32 = 0;
    let snapi = snapi_env(&env, e);
    let s = with_cb_context(&mut env, e, || unsafe {
        snapi_bridge_delete_property(snapi, o as u32, k as u32, &mut r)
    });
    if s == 0 {
        write_guest_u8(&mut env, rp as u32, r as u8);
    }
    s
}

fn guest_napi_set_named_property(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    o: i32,
    np: i32,
    v: i32,
) -> i32 {
    let Some(nb) = read_guest_c_string(&mut env, np) else {
        return 1;
    };
    let cn = CString::new(nb).unwrap_or_default();
    let snapi = snapi_env(&env, e);
    with_cb_context(&mut env, e, || unsafe {
        snapi_bridge_set_named_property(snapi, o as u32, cn.as_ptr(), v as u32)
    })
}

fn guest_napi_get_named_property(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    o: i32,
    np: i32,
    rp: i32,
) -> i32 {
    let Some(nb) = read_guest_c_string(&mut env, np) else {
        return 1;
    };
    let cn = CString::new(nb).unwrap_or_default();
    let mut out: u32 = 0;
    let snapi = snapi_env(&env, e);
    let s = with_cb_context(&mut env, e, || unsafe {
        snapi_bridge_get_named_property(snapi, o as u32, cn.as_ptr(), &mut out)
    });
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_has_named_property(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    o: i32,
    np: i32,
    rp: i32,
) -> i32 {
    let Some(nb) = read_guest_c_string(&mut env, np) else {
        return 1;
    };
    let cn = CString::new(nb).unwrap_or_default();
    let mut r: i32 = 0;
    let snapi = snapi_env(&env, e);
    let s = with_cb_context(&mut env, e, || unsafe {
        snapi_bridge_has_named_property(snapi, o as u32, cn.as_ptr(), &mut r)
    });
    if s == 0 {
        write_guest_u8(&mut env, rp as u32, r as u8);
    }
    s
}

fn guest_napi_set_element(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    o: i32,
    idx: i32,
    v: i32,
) -> i32 {
    let snapi = snapi_env(&env, e);
    with_cb_context(&mut env, e, || unsafe {
        snapi_bridge_set_element(snapi, o as u32, idx as u32, v as u32)
    })
}

fn guest_napi_get_element(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    o: i32,
    idx: i32,
    rp: i32,
) -> i32 {
    let mut out: u32 = 0;
    let snapi = snapi_env(&env, e);
    let s = with_cb_context(&mut env, e, || unsafe {
        snapi_bridge_get_element(snapi, o as u32, idx as u32, &mut out)
    });
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_has_element(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    o: i32,
    idx: i32,
    rp: i32,
) -> i32 {
    let mut r: i32 = 0;
    let snapi = snapi_env(&env, e);
    let s = with_cb_context(&mut env, e, || unsafe {
        snapi_bridge_has_element(snapi, o as u32, idx as u32, &mut r)
    });
    if s == 0 {
        write_guest_u8(&mut env, rp as u32, r as u8);
    }
    s
}

fn guest_napi_delete_element(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    o: i32,
    idx: i32,
    rp: i32,
) -> i32 {
    let mut r: i32 = 0;
    let snapi = snapi_env(&env, e);
    let s = with_cb_context(&mut env, e, || unsafe {
        snapi_bridge_delete_element(snapi, o as u32, idx as u32, &mut r)
    });
    if s == 0 {
        write_guest_u8(&mut env, rp as u32, r as u8);
    }
    s
}

fn guest_napi_get_array_length(mut env: FunctionEnvMut<NapiEnv>, e: i32, ah: i32, rp: i32) -> i32 {
    let mut r: u32 = 0;
    let s = unsafe { snapi_bridge_get_array_length(snapi_env(&env, e), ah as u32, &mut r) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, r);
    }
    s
}

fn guest_napi_get_property_names(mut env: FunctionEnvMut<NapiEnv>, e: i32, o: i32, rp: i32) -> i32 {
    let mut out: u32 = 0;
    let snapi = snapi_env(&env, e);
    // Property enumeration can synchronously invoke a Proxy's ownKeys trap.
    let s = with_cb_context(&mut env, e, || unsafe {
        snapi_bridge_get_property_names(snapi, o as u32, &mut out)
    });
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_get_all_property_names(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    o: i32,
    mode: i32,
    filter: i32,
    conversion: i32,
    rp: i32,
) -> i32 {
    let mut out: u32 = 0;
    let snapi = snapi_env(&env, e);
    // Property enumeration can synchronously invoke a Proxy's ownKeys trap.
    let s = with_cb_context(&mut env, e, || unsafe {
        snapi_bridge_get_all_property_names(snapi, o as u32, mode, filter, conversion, &mut out)
    });
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_get_prototype(mut env: FunctionEnvMut<NapiEnv>, e: i32, o: i32, rp: i32) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe { snapi_bridge_get_prototype(snapi_env(&env, e), o as u32, &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_object_freeze(env: FunctionEnvMut<NapiEnv>, e: i32, o: i32) -> i32 {
    unsafe { snapi_bridge_object_freeze(snapi_env(&env, e), o as u32) }
}

fn guest_napi_object_seal(env: FunctionEnvMut<NapiEnv>, e: i32, o: i32) -> i32 {
    unsafe { snapi_bridge_object_seal(snapi_env(&env, e), o as u32) }
}

// --- Comparison ---

fn guest_napi_strict_equals(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    lhs: i32,
    rhs: i32,
    rp: i32,
) -> i32 {
    let mut r: i32 = 0;
    let s =
        unsafe { snapi_bridge_strict_equals(snapi_env(&env, e), lhs as u32, rhs as u32, &mut r) };
    if s == 0 {
        write_guest_u8(&mut env, rp as u32, r as u8);
    }
    s
}

// --- Error handling ---

fn guest_napi_throw(env: FunctionEnvMut<NapiEnv>, e: i32, err: i32) -> i32 {
    unsafe { snapi_bridge_throw(snapi_env(&env, e), err as u32) }
}

fn guest_napi_throw_error(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    code_ptr: i32,
    msg_ptr: i32,
) -> i32 {
    let code_bytes = if code_ptr != 0 {
        read_guest_c_string(&mut env, code_ptr)
    } else {
        None
    };
    let Some(msg_bytes) = read_guest_c_string(&mut env, msg_ptr) else {
        return 1;
    };
    let c_code = code_bytes.map(|b| CString::new(b).unwrap_or_default());
    let c_msg = CString::new(msg_bytes).unwrap_or_default();
    unsafe {
        snapi_bridge_throw_error(
            snapi_env(&env, e),
            c_code.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
            c_msg.as_ptr(),
        )
    }
}

fn guest_napi_throw_type_error(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    code_ptr: i32,
    msg_ptr: i32,
) -> i32 {
    let code_bytes = if code_ptr != 0 {
        read_guest_c_string(&mut env, code_ptr)
    } else {
        None
    };
    let Some(msg_bytes) = read_guest_c_string(&mut env, msg_ptr) else {
        return 1;
    };
    let c_code = code_bytes.map(|b| CString::new(b).unwrap_or_default());
    let c_msg = CString::new(msg_bytes).unwrap_or_default();
    unsafe {
        snapi_bridge_throw_type_error(
            snapi_env(&env, e),
            c_code.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
            c_msg.as_ptr(),
        )
    }
}

fn guest_napi_throw_range_error(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    code_ptr: i32,
    msg_ptr: i32,
) -> i32 {
    let code_bytes = if code_ptr != 0 {
        read_guest_c_string(&mut env, code_ptr)
    } else {
        None
    };
    let Some(msg_bytes) = read_guest_c_string(&mut env, msg_ptr) else {
        return 1;
    };
    let c_code = code_bytes.map(|b| CString::new(b).unwrap_or_default());
    let c_msg = CString::new(msg_bytes).unwrap_or_default();
    unsafe {
        snapi_bridge_throw_range_error(
            snapi_env(&env, e),
            c_code.as_ref().map_or(std::ptr::null(), |c| c.as_ptr()),
            c_msg.as_ptr(),
        )
    }
}

fn guest_napi_is_exception_pending(mut env: FunctionEnvMut<NapiEnv>, e: i32, rp: i32) -> i32 {
    let mut r: i32 = 0;
    let s = unsafe { snapi_bridge_is_exception_pending(snapi_env(&env, e), &mut r) };
    if s == 0 {
        write_guest_u8(&mut env, rp as u32, r as u8);
    }
    s
}

fn guest_napi_get_and_clear_last_exception(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    rp: i32,
) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe { snapi_bridge_get_and_clear_last_exception(snapi_env(&env, e), &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

// --- Promise ---

fn guest_napi_create_promise(mut env: FunctionEnvMut<NapiEnv>, e: i32, dp: i32, rp: i32) -> i32 {
    let mut deferred_id: u32 = 0;
    let mut promise_id: u32 = 0;
    let s = unsafe {
        snapi_bridge_create_promise(snapi_env(&env, e), &mut deferred_id, &mut promise_id)
    };
    if s == 0 {
        write_guest_u32(&mut env, dp as u32, deferred_id);
        write_guest_u32(&mut env, rp as u32, promise_id);
    }
    s
}

fn guest_napi_resolve_deferred(mut env: FunctionEnvMut<NapiEnv>, e: i32, d: i32, v: i32) -> i32 {
    let snapi = snapi_env(&env, e);
    publish_pending_host_buffer_copies(&mut env, snapi);
    unsafe { snapi_bridge_resolve_deferred(snapi, d as u32, v as u32) }
}

fn guest_napi_reject_deferred(mut env: FunctionEnvMut<NapiEnv>, e: i32, d: i32, v: i32) -> i32 {
    let snapi = snapi_env(&env, e);
    publish_pending_host_buffer_copies(&mut env, snapi);
    unsafe { snapi_bridge_reject_deferred(snapi, d as u32, v as u32) }
}

// --- ArrayBuffer ---

fn guest_napi_create_arraybuffer(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    byte_length: i32,
    data_ptr: i32,
    rp: i32,
) -> i32 {
    #[cfg(feature = "js")]
    {
        if byte_length < 0 {
            return 1;
        }
        // A null data result means native code never observes a pointer into
        // this ArrayBuffer. Allocate it in the host realm so its lifetime is
        // governed by JavaScript GC instead of pinning an unreachable guest
        // malloc allocation.
        if data_ptr <= 0 {
            let mut out = 0u32;
            let status = unsafe {
                snapi_bridge_create_arraybuffer(snapi_env(&env, e), byte_length as u32, &mut out)
            };
            if status == 0 {
                write_guest_u32(&mut env, rp as u32, out);
            }
            return status;
        }
        let zeros = vec![0u8; byte_length as usize];
        let Some(guest_ptr) = allocate_guest_bytes(&mut env, &zeros) else {
            return 1;
        };
        let mut out = 0u32;
        let status = unsafe {
            snapi_bridge_create_arraybuffer(snapi_env(&env, e), byte_length as u32, &mut out)
        };
        if status != 0 {
            recycle_guest_allocation(&mut env, guest_ptr);
            return status;
        }
        let backing_store_token = host_backing_store_token(&env, e, out);
        if !remember_host_buffer_copy(
            &mut env,
            e as u32,
            out,
            backing_store_token,
            0,
            guest_ptr,
            byte_length as usize,
            true,
            true,
            true,
            true,
        ) {
            recycle_guest_allocation(&mut env, guest_ptr);
            return 1;
        }
        write_guest_u32(&mut env, rp as u32, out);
        if data_ptr > 0 {
            write_guest_u32(&mut env, data_ptr as u32, guest_ptr);
        }
        return 0;
    }

    #[cfg(not(feature = "js"))]
    {
        // Try to create a guest-memory-backed ArrayBuffer (for WASIX)
        let malloc_fn = env.data().malloc_fn.clone();
        let memory = env.data().memory.clone();

        if let (Some(malloc_fn), Some(memory)) = (malloc_fn, memory) {
            // Allocate memory in the guest's linear memory
            let guest_ptr: i32 = {
                let (_, mut store_ref) = env.data_and_store_mut();
                match malloc_fn.call(&mut store_ref, byte_length) {
                    Ok(ptr) if ptr > 0 => ptr,
                    _ => return 1, // allocation failed
                }
            };

            // Get host pointer corresponding to the guest allocation
            let host_addr: u64 = {
                let (_, store_ref) = env.data_and_store_mut();
                let view = memory.view(&store_ref);
                let host_base = view.data_ptr() as u64;
                host_base + guest_ptr as u64
            };

            // Zero-initialize the guest memory region
            {
                let zeros = vec![0u8; byte_length as usize];
                write_guest_bytes(&mut env, guest_ptr as u32, &zeros);
            }

            // Create external arraybuffer backed by guest memory
            let mut out: u32 = 0;
            let mut backing_store_token: u64 = 0;
            let s = unsafe {
                snapi_bridge_create_external_arraybuffer(
                    snapi_env(&env, e),
                    host_addr,
                    byte_length as u32,
                    &mut backing_store_token,
                    &mut out,
                )
            };
            if s == 0 {
                remember_guest_backing_store(
                    &mut env,
                    e as u32,
                    out,
                    backing_store_token,
                    host_addr,
                    guest_ptr as u32,
                    byte_length as usize,
                    true,
                );
                write_guest_u32(&mut env, rp as u32, out);
                if data_ptr > 0 {
                    write_guest_u32(&mut env, data_ptr as u32, guest_ptr as u32);
                }
            }
            s
        } else {
            // Fallback: host-memory-backed arraybuffer (non-WASIX path)
            let mut out: u32 = 0;
            let s = unsafe {
                snapi_bridge_create_arraybuffer(snapi_env(&env, e), byte_length as u32, &mut out)
            };
            if s == 0 {
                write_guest_u32(&mut env, rp as u32, out);
            }
            s
        }
    }
}

fn guest_napi_create_external_arraybuffer(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    external_data: i32,
    byte_length: i32,
    _finalize_cb: i32,
    _finalize_hint: i32,
    rp: i32,
) -> i32 {
    #[cfg(feature = "js")]
    {
        if external_data < 0 || byte_length < 0 {
            return 1;
        }
        let Some(source) = read_guest_bytes(&mut env, external_data, byte_length as usize) else {
            return 1;
        };
        let mut out = 0u32;
        let status = unsafe {
            snapi_bridge_create_arraybuffer(snapi_env(&env, e), byte_length as u32, &mut out)
        };
        if status != 0 {
            return status;
        }
        if byte_length > 0 {
            let status = unsafe {
                snapi_bridge_overwrite_value_bytes(
                    snapi_env(&env, e),
                    out,
                    source.as_ptr().cast(),
                    byte_length as u32,
                )
            };
            if status != 0 {
                return status;
            }
        }
        let backing_store_token = host_backing_store_token(&env, e, out);
        if !remember_host_buffer_copy(
            &mut env,
            e as u32,
            out,
            backing_store_token,
            0,
            external_data as u32,
            byte_length as usize,
            false,
            true,
            true,
            true,
        ) {
            return 1;
        }
        write_guest_u32(&mut env, rp as u32, out);
        return 0;
    }

    #[cfg(not(feature = "js"))]
    {
        let memory = env.data().memory.clone();
        let Some(memory) = memory else {
            return 1;
        };

        let host_addr: u64 = {
            let (_, store_ref) = env.data_and_store_mut();
            let view = memory.view(&store_ref);
            let host_base = view.data_ptr() as u64;
            host_base + external_data as u64
        };

        let mut out: u32 = 0;
        let mut backing_store_token: u64 = 0;
        let s = unsafe {
            snapi_bridge_create_external_arraybuffer(
                snapi_env(&env, e),
                host_addr,
                byte_length as u32,
                &mut backing_store_token,
                &mut out,
            )
        };
        if s == 0 {
            remember_guest_backing_store(
                &mut env,
                e as u32,
                out,
                backing_store_token,
                host_addr,
                external_data as u32,
                byte_length as usize,
                true,
            );
            write_guest_u32(&mut env, rp as u32, out);
        }
        s
    }
}

fn guest_napi_create_external_buffer(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    byte_length: i32,
    external_data: i32,
    _finalize_cb: i32,
    _finalize_hint: i32,
    rp: i32,
) -> i32 {
    #[cfg(feature = "js")]
    {
        if external_data < 0 || byte_length < 0 {
            return 1;
        }
        let Some(source) = read_guest_bytes(&mut env, external_data, byte_length as usize) else {
            return 1;
        };
        let mut host_data = 0u64;
        let mut out = 0u32;
        let status = unsafe {
            snapi_bridge_create_buffer_copy(
                snapi_env(&env, e),
                byte_length as u32,
                source.as_ptr(),
                &mut host_data,
                &mut out,
            )
        };
        if host_data != 0 {
            unsafe { snapi_bridge_free_buffer(host_data as *mut c_void) };
        }
        if status != 0 {
            return status;
        }
        let backing_store_token = host_backing_store_token(&env, e, out);
        if !remember_host_buffer_copy(
            &mut env,
            e as u32,
            out,
            backing_store_token,
            0,
            external_data as u32,
            byte_length as usize,
            false,
            true,
            true,
            false,
        ) {
            return 1;
        }
        write_guest_u32(&mut env, rp as u32, out);
        return 0;
    }

    #[cfg(not(feature = "js"))]
    {
        let memory = env.data().memory.clone();
        let Some(memory) = memory else {
            return 1;
        };

        let host_addr: u64 = {
            let (_, store_ref) = env.data_and_store_mut();
            let view = memory.view(&store_ref);
            let host_base = view.data_ptr() as u64;
            host_base + external_data as u64
        };

        let mut out: u32 = 0;
        let mut backing_store_token: u64 = 0;
        let s = unsafe {
            snapi_bridge_create_external_buffer(
                snapi_env(&env, e),
                host_addr,
                byte_length as u32,
                &mut backing_store_token,
                &mut out,
            )
        };
        if s == 0 {
            remember_guest_backing_store(
                &mut env,
                e as u32,
                out,
                backing_store_token,
                host_addr,
                external_data as u32,
                byte_length as usize,
                false,
            );
            write_guest_u32(&mut env, rp as u32, out);
        }
        s
    }
}

fn guest_napi_get_arraybuffer_info(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    vh: i32,
    data_ptr: i32,
    len_ptr: i32,
) -> i32 {
    let mut host_data_addr: u64 = 0;
    let mut bl: u32 = 0;
    let mut backing_store_token: u64 = 0;
    let s = unsafe {
        snapi_bridge_get_arraybuffer_info(
            snapi_env(&env, e),
            vh as u32,
            &mut host_data_addr,
            &mut bl,
            &mut backing_store_token,
        )
    };
    if s != 0 {
        return s;
    }

    if len_ptr > 0 {
        write_guest_u32(&mut env, len_ptr as u32, bl);
    }

    let guest_data_ptr = if data_ptr > 0 {
        resolve_current_host_data_to_guest(
            &mut env,
            e,
            vh as u32,
            backing_store_token,
            host_data_addr,
            bl as usize,
            true,
        )
    } else {
        None
    };
    if host_data_addr != 0 {
        unsafe { snapi_bridge_free_buffer(host_data_addr as *mut c_void) };
    }
    if let Some(guest_data_ptr) = guest_data_ptr {
        write_guest_u32(&mut env, data_ptr as u32, guest_data_ptr);
    }
    0
}

fn guest_napi_detach_arraybuffer(env: FunctionEnvMut<NapiEnv>, e: i32, vh: i32) -> i32 {
    unsafe { snapi_bridge_detach_arraybuffer(snapi_env(&env, e), vh as u32) }
}

fn guest_napi_is_detached_arraybuffer(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    vh: i32,
    rp: i32,
) -> i32 {
    let mut r: i32 = 0;
    let s = unsafe { snapi_bridge_is_detached_arraybuffer(snapi_env(&env, e), vh as u32, &mut r) };
    if s == 0 {
        write_guest_u8(&mut env, rp as u32, r as u8);
    }
    s
}

fn guest_node_api_is_sharedarraybuffer(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    value: i32,
    rp: i32,
) -> i32 {
    let mut r = 0i32;
    let s = unsafe { snapi_bridge_is_sharedarraybuffer(snapi_env(&env, e), value as u32, &mut r) };
    if s == 0 {
        write_guest_u8(&mut env, rp as u32, r as u8);
    }
    s
}

fn guest_node_api_create_sharedarraybuffer(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    byte_length: i32,
    data_ptr: i32,
    rp: i32,
) -> i32 {
    if byte_length < 0 {
        return 1;
    }
    let zeros = vec![0u8; byte_length as usize];
    let Some(guest_ptr) = allocate_guest_bytes(&mut env, &zeros) else {
        return 1;
    };
    let mut host_data_addr = 0u64;
    let mut out = 0u32;
    let s = unsafe {
        snapi_bridge_create_sharedarraybuffer(
            snapi_env(&env, e),
            byte_length as u32,
            &mut host_data_addr,
            &mut out,
        )
    };
    if s != 0 {
        recycle_guest_allocation(&mut env, guest_ptr);
        return s;
    }

    let backing_store_token = host_backing_store_token(&env, e, out);
    if !remember_host_buffer_copy(
        &mut env,
        e as u32,
        out,
        backing_store_token,
        0,
        guest_ptr,
        byte_length as usize,
        true,
        true,
        true,
        true,
    ) {
        recycle_guest_allocation(&mut env, guest_ptr);
        return 1;
    }

    if data_ptr > 0 {
        write_guest_u32(&mut env, data_ptr as u32, guest_ptr);
    }
    write_guest_u32(&mut env, rp as u32, out);
    s
}

fn guest_node_api_set_prototype(
    env: FunctionEnvMut<NapiEnv>,
    napi_env: i32,
    object: i32,
    prototype: i32,
) -> i32 {
    let object_id = if object > 0 { object as u32 } else { 0 };
    let prototype_id = if prototype > 0 { prototype as u32 } else { 0 };
    unsafe {
        snapi_bridge_node_api_set_prototype(snapi_env(&env, napi_env), object_id, prototype_id)
    }
}

// --- TypedArray ---

fn guest_napi_create_typedarray(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    typ: i32,
    length: i32,
    ab: i32,
    offset: i32,
    rp: i32,
) -> i32 {
    if length < 0 || offset < 0 || typedarray_element_size(typ).is_none() {
        return 1;
    }
    let mut out: u32 = 0;
    let s = unsafe {
        snapi_bridge_create_typedarray(
            snapi_env(&env, e),
            typ,
            length as u32,
            ab as u32,
            offset as u32,
            &mut out,
        )
    };
    if s == 0 {
        // A TypedArray view shares its ArrayBuffer's guest-side copy. Record
        // that alias immediately so a reference to the view keeps the backing
        // copy coherent for later native writes. Without this, long-lived
        // native pointers (for example Node's streamBaseState) are dropped at
        // the first JS callback boundary and JavaScript observes stale bytes.
        let byte_len = (length as usize)
            .saturating_mul(typedarray_element_size(typ).expect("validated typed-array kind"));
        let backing_store_token = host_backing_store_token(&env, e, out);
        let guest_ptr = if backing_store_token != 0 {
            resolve_guest_backing_store_token(
                env.data(),
                e as u32,
                out,
                backing_store_token,
                0,
                byte_len,
            )
        } else {
            env.data()
                .guest_data_ptrs
                .get(&(e as u32, ab as u32))
                .copied()
                .and_then(|base| base.checked_add(offset.max(0) as u32))
        };
        if let Some(guest_ptr) = guest_ptr {
            env.data_mut()
                .guest_data_ptrs
                .insert((e as u32, out), guest_ptr);
        }
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

#[allow(clippy::too_many_arguments)]
fn guest_napi_get_typedarray_info(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    vh: i32,
    tp: i32,
    lp: i32,
    dp: i32,
    abp: i32,
    bop: i32,
) -> i32 {
    let mut typ: i32 = 0;
    let mut len: u32 = 0;
    let mut host_data_addr: u64 = 0;
    let mut ab: u32 = 0;
    let mut bo: u32 = 0;
    let mut backing_store_token: u64 = 0;
    let s = unsafe {
        snapi_bridge_get_typedarray_info(
            snapi_env(&env, e),
            vh as u32,
            &mut typ,
            &mut len,
            if dp > 0 {
                &mut host_data_addr
            } else {
                std::ptr::null_mut()
            },
            if abp > 0 {
                &mut ab
            } else {
                std::ptr::null_mut()
            },
            if bop > 0 {
                &mut bo
            } else {
                std::ptr::null_mut()
            },
            if dp > 0 {
                &mut backing_store_token
            } else {
                std::ptr::null_mut()
            },
        )
    };
    if s == 0 {
        if tp > 0 {
            write_guest_i32(&mut env, tp as u32, typ);
        }
        if lp > 0 {
            write_guest_u32(&mut env, lp as u32, len);
        }
        if dp > 0 {
            let Some(elem_size) = typedarray_element_size(typ) else {
                return 1;
            };
            let byte_len = len as usize * elem_size;
            if let Some(guest_data_ptr) = resolve_current_host_data_to_guest(
                &mut env,
                e,
                vh as u32,
                backing_store_token,
                host_data_addr,
                byte_len,
                false,
            ) {
                write_guest_u32(&mut env, dp as u32, guest_data_ptr);
            }
        }
        if host_data_addr != 0 {
            unsafe { snapi_bridge_free_buffer(host_data_addr as *mut c_void) };
        }
        if abp > 0 {
            write_guest_u32(&mut env, abp as u32, ab);
        }
        if bop > 0 {
            write_guest_u32(&mut env, bop as u32, bo);
        }
    }
    s
}

// --- DataView ---

fn guest_napi_create_dataview(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    bl: i32,
    ab: i32,
    bo: i32,
    rp: i32,
) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe {
        snapi_bridge_create_dataview(
            snapi_env(&env, e),
            bl as u32,
            ab as u32,
            bo as u32,
            &mut out,
        )
    };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_get_dataview_info(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    vh: i32,
    blp: i32,
    dp: i32,
    abp: i32,
    bop: i32,
) -> i32 {
    let mut bl: u32 = 0;
    let mut host_data_addr: u64 = 0;
    let mut ab: u32 = 0;
    let mut bo: u32 = 0;
    let mut backing_store_token: u64 = 0;
    let s = unsafe {
        snapi_bridge_get_dataview_info(
            snapi_env(&env, e),
            vh as u32,
            &mut bl,
            &mut host_data_addr,
            &mut ab,
            &mut bo,
            &mut backing_store_token,
        )
    };
    if s == 0 {
        if blp > 0 {
            write_guest_u32(&mut env, blp as u32, bl);
        }
        let guest_data_ptr = if dp > 0 {
            resolve_current_host_data_to_guest(
                &mut env,
                e,
                vh as u32,
                backing_store_token,
                host_data_addr,
                bl as usize,
                false,
            )
        } else {
            None
        };
        if host_data_addr != 0 {
            unsafe { snapi_bridge_free_buffer(host_data_addr as *mut c_void) };
        }
        if let Some(guest_data_ptr) = guest_data_ptr {
            write_guest_u32(&mut env, dp as u32, guest_data_ptr);
        }
        if abp > 0 {
            write_guest_u32(&mut env, abp as u32, ab);
        }
        if bop > 0 {
            write_guest_u32(&mut env, bop as u32, bo);
        }
    }
    s
}

// --- References ---

fn guest_napi_create_reference(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    vh: i32,
    irc: i32,
    rp: i32,
) -> i32 {
    let mut ref_id: u32 = 0;
    let s = unsafe {
        snapi_bridge_create_reference(snapi_env(&env, e), vh as u32, irc as u32, &mut ref_id)
    };
    if s == 0 {
        let guest_ptr = env
            .data()
            .guest_data_ptrs
            .get(&(e as u32, vh as u32))
            .copied();
        let held_guest_ptr = guest_ptr.and_then(|guest_ptr| {
            env.data_mut()
                .host_buffer_copies
                .iter_mut()
                .find(|mapping| {
                    let mapping_end = mapping.guest_ptr.saturating_add(mapping.byte_len as u32);
                    mapping.guest_env == e as u32
                        && guest_ptr >= mapping.guest_ptr
                        && guest_ptr < mapping_end
                })
                .map(|mapping| {
                    mapping.reference_holds = mapping.reference_holds.saturating_add(1);
                    mapping.guest_ptr
                })
        });
        if let Some(backing_guest_ptr) = held_guest_ptr {
            env.data_mut()
                .host_buffer_reference_holds
                .insert((e as u32, ref_id), backing_guest_ptr);
        }
        write_guest_u32(&mut env, rp as u32, ref_id);
    }
    s
}

fn guest_napi_delete_reference(mut env: FunctionEnvMut<NapiEnv>, e: i32, r: i32) -> i32 {
    if let Some(guest_ptr) = env
        .data_mut()
        .host_buffer_reference_holds
        .remove(&(e as u32, r as u32))
        && let Some(mapping) = env
            .data_mut()
            .host_buffer_copies
            .iter_mut()
            .find(|mapping| mapping.guest_env == e as u32 && mapping.guest_ptr == guest_ptr)
    {
        mapping.reference_holds = mapping.reference_holds.saturating_sub(1);
    }
    unsafe { snapi_bridge_delete_reference(snapi_env(&env, e), r as u32) }
}

fn guest_napi_reference_ref(mut env: FunctionEnvMut<NapiEnv>, e: i32, r: i32, rp: i32) -> i32 {
    let mut count: u32 = 0;
    let s = unsafe { snapi_bridge_reference_ref(snapi_env(&env, e), r as u32, &mut count) };
    if s == 0 && rp > 0 {
        write_guest_u32(&mut env, rp as u32, count);
    }
    s
}

fn guest_napi_reference_unref(mut env: FunctionEnvMut<NapiEnv>, e: i32, r: i32, rp: i32) -> i32 {
    let mut count: u32 = 0;
    let s = unsafe { snapi_bridge_reference_unref(snapi_env(&env, e), r as u32, &mut count) };
    if s == 0 && rp > 0 {
        write_guest_u32(&mut env, rp as u32, count);
    }
    s
}

fn guest_napi_get_reference_value(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    r: i32,
    rp: i32,
) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe { snapi_bridge_get_reference_value(snapi_env(&env, e), r as u32, &mut out) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

// --- Handle scopes ---

fn guest_napi_open_handle_scope(mut env: FunctionEnvMut<NapiEnv>, e: i32, rp: i32) -> i32 {
    if snapi_env(&env, e).is_null() || rp <= 0 {
        return 1;
    }
    let mut scope_id = 0;
    let status =
        unsafe { crate::snapi::snapi_bridge_open_handle_scope(snapi_env(&env, e), &mut scope_id) };
    if status == 0 && !write_guest_u32(&mut env, rp as u32, scope_id) {
        return 1;
    }
    if status == 0 {
        let owner_id = env.data_mut().next_host_buffer_owner();
        env.data_mut()
            .host_buffer_handle_scopes
            .push((e as u32, scope_id, owner_id));
    }
    status
}
fn guest_napi_close_handle_scope(mut env: FunctionEnvMut<NapiEnv>, e: i32, scope: i32) -> i32 {
    let snapi = snapi_env(&env, e);
    if let Some(index) = env
        .data()
        .host_buffer_handle_scopes
        .iter()
        .rposition(|(guest_env, scope_id, _)| *guest_env == e as u32 && *scope_id == scope as u32)
    {
        let (_, _, owner_id) = env.data_mut().host_buffer_handle_scopes.remove(index);
        flush_host_buffer_copies_for_owner(&mut env, owner_id);
    }
    unsafe { crate::snapi::snapi_bridge_close_handle_scope(snapi, scope as u32) }
}

fn guest_napi_open_escapable_handle_scope(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    rp: i32,
) -> i32 {
    let mut scope_id: u32 = 0;
    let s = unsafe { snapi_bridge_open_escapable_handle_scope(snapi_env(&env, e), &mut scope_id) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, scope_id);
        let owner_id = env.data_mut().next_host_buffer_owner();
        env.data_mut()
            .host_buffer_handle_scopes
            .push((e as u32, scope_id, owner_id));
    }
    s
}

fn guest_napi_close_escapable_handle_scope(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    scope: i32,
) -> i32 {
    let snapi = snapi_env(&env, e);
    if let Some(index) = env
        .data()
        .host_buffer_handle_scopes
        .iter()
        .rposition(|(guest_env, scope_id, _)| *guest_env == e as u32 && *scope_id == scope as u32)
    {
        let (_, _, owner_id) = env.data_mut().host_buffer_handle_scopes.remove(index);
        flush_host_buffer_copies_for_owner(&mut env, owner_id);
    }
    unsafe { snapi_bridge_close_escapable_handle_scope(snapi, scope as u32) }
}

fn guest_napi_escape_handle(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    scope: i32,
    escapee: i32,
    rp: i32,
) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe {
        snapi_bridge_escape_handle(snapi_env(&env, e), scope as u32, escapee as u32, &mut out)
    };
    if s == 0 {
        if let Some(&guest_ptr) = env.data().guest_data_ptrs.get(&(e as u32, escapee as u32)) {
            env.data_mut()
                .guest_data_ptrs
                .insert((e as u32, out), guest_ptr);
        }
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

// --- Type tagging ---

fn guest_napi_type_tag_object(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    obj: i32,
    tag_ptr: i32,
) -> i32 {
    // napi_type_tag is { uint64_t lower; uint64_t upper; } = 16 bytes
    let Some(tag_bytes) = read_guest_bytes(&mut env, tag_ptr, 16) else {
        return 1;
    };
    let lower = u64::from_le_bytes(tag_bytes[0..8].try_into().unwrap());
    let upper = u64::from_le_bytes(tag_bytes[8..16].try_into().unwrap());
    unsafe { snapi_bridge_type_tag_object(snapi_env(&env, e), obj as u32, lower, upper) }
}

fn guest_napi_check_object_type_tag(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    obj: i32,
    tag_ptr: i32,
    rp: i32,
) -> i32 {
    let Some(tag_bytes) = read_guest_bytes(&mut env, tag_ptr, 16) else {
        return 1;
    };
    let lower = u64::from_le_bytes(tag_bytes[0..8].try_into().unwrap());
    let upper = u64::from_le_bytes(tag_bytes[8..16].try_into().unwrap());
    let mut r: i32 = 0;
    let s = unsafe {
        snapi_bridge_check_object_type_tag(snapi_env(&env, e), obj as u32, lower, upper, &mut r)
    };
    if s == 0 {
        write_guest_u8(&mut env, rp as u32, r as u8);
    }
    s
}

// --- Function calling ---

fn guest_napi_call_function(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    recv: i32,
    func: i32,
    argc: i32,
    argv_ptr: i32,
    rp: i32,
) -> i32 {
    let argc_u = argc as u32;
    let argv_ids = if argc_u > 0 {
        let Some(ids) = read_guest_u32_array(&mut env, argv_ptr, argc_u as usize) else {
            return 1;
        };
        ids
    } else {
        vec![]
    };

    let snapi = snapi_env(&env, e);
    // Native code may have written through a guest-memory pointer obtained for
    // a host-owned Buffer/ArrayBuffer. Synchronize those bytes at the handoff
    // back to JavaScript, immediately before JavaScript can observe the value.
    publish_pending_host_buffer_copies(&mut env, snapi);
    let mut out: u32 = 0;
    let s = with_cb_context(&mut env, e, || unsafe {
        snapi_bridge_call_function(
            snapi,
            recv as u32,
            func as u32,
            argc_u,
            argv_ids.as_ptr(),
            &mut out,
        )
    });

    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

// --- napi_create_function ---

fn guest_napi_create_function(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    name_ptr: i32,
    name_len: i32,
    cb: i32,
    data: i32,
    rp: i32,
) -> i32 {
    // Read function name
    let wl = name_len as u32;
    let name_bytes: Vec<u8> = if wl == 0xFFFFFFFFu32 {
        // NAPI_AUTO_LENGTH: read null-terminated string
        read_guest_c_string(&mut env, name_ptr).unwrap_or_default()
    } else if wl > 0 && name_ptr != 0 {
        let Some(bytes) = read_guest_bytes(&mut env, name_ptr, wl as usize) else {
            return 1;
        };
        bytes
    } else {
        vec![]
    };

    // Allocate a registration ID in the C++ callback registry
    let snapi = snapi_env(&env, e);
    let reg_id = unsafe { snapi_bridge_alloc_cb_reg_id(snapi) };

    // Register the WASM callback and data pointer in the C++ registry
    unsafe { snapi_bridge_register_callback(snapi, reg_id, e as u32, cb as u32, data as u64) };

    // Create a JS function in V8 with generic_wasm_callback as its native callback.
    // The reg_id is stored as the function's data pointer so generic_wasm_callback
    // can look up which WASM function to invoke.
    let actual_name_len = name_bytes.len() as u32;
    let c_name = CString::new(name_bytes).unwrap_or_default();
    let mut out: u32 = 0;
    let s = unsafe {
        snapi_bridge_create_function(snapi, c_name.as_ptr(), actual_name_len, reg_id, &mut out)
    };
    if s != 0 {
        return s;
    }

    write_guest_u32(&mut env, rp as u32, out);
    0
}

// --- napi_get_cb_info ---

fn guest_napi_get_cb_info(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    _cbinfo: i32,
    argc_ptr: i32,
    argv_ptr: i32,
    this_ptr: i32,
    data_ptr: i32,
) -> i32 {
    // Read the caller's requested argc (size of their argv array)
    let wanted: u32 = if argc_ptr > 0 {
        let Some(bytes) = read_guest_bytes(&mut env, argc_ptr, 4) else {
            return 1;
        };
        u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])
    } else {
        0
    };
    if wanted as usize > MAX_NAPI_CALLBACK_ARGS {
        return 1;
    }

    // Query the bridge for callback context
    let mut actual_argc: u32 = wanted;
    let mut argv_ids = vec![0u32; wanted as usize];
    let mut this_id: u32 = 0;
    let mut data_val: u64 = 0;

    let s = unsafe {
        snapi_bridge_get_cb_info(
            snapi_env(&env, e),
            if _cbinfo > 0 { _cbinfo as u32 } else { 0 },
            &mut actual_argc,
            if wanted > 0 {
                argv_ids.as_mut_ptr()
            } else {
                std::ptr::null_mut()
            },
            wanted,
            &mut this_id,
            &mut data_val,
        )
    };
    if s != 0 {
        return s;
    }

    // Write actual argc back
    if argc_ptr > 0 {
        write_guest_u32(&mut env, argc_ptr as u32, actual_argc);
    }

    // Write argv (array of handle IDs) - only write up to min(wanted, actual)
    if argv_ptr > 0 {
        let to_write = std::cmp::min(wanted, actual_argc);
        for i in 0..to_write {
            write_guest_u32(&mut env, (argv_ptr as u32) + i * 4, argv_ids[i as usize]);
        }
    }

    // Write this_arg
    if this_ptr > 0 {
        write_guest_u32(&mut env, this_ptr as u32, this_id);
    }

    // Write data pointer (as a 32-bit guest pointer)
    if data_ptr > 0 {
        write_guest_u32(&mut env, data_ptr as u32, data_val as u32);
    }

    0
}

// --- napi_get_new_target ---

fn guest_napi_get_new_target(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    _cbinfo: i32,
    rp: i32,
) -> i32 {
    let mut out: u32 = 0;
    let s = unsafe {
        snapi_bridge_get_new_target(
            snapi_env(&env, e),
            if _cbinfo > 0 { _cbinfo as u32 } else { 0 },
            &mut out,
        )
    };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

// --- napi_define_class ---
// Guest layout of napi_property_descriptor (32-bit WASM, 32 bytes):
//   offset  0: const char* utf8name     (4 bytes, guest pointer)
//   offset  4: napi_value name          (4 bytes, handle ID)
//   offset  8: napi_callback method     (4 bytes, fn pointer)
//   offset 12: napi_callback getter     (4 bytes, fn pointer)
//   offset 16: napi_callback setter     (4 bytes, fn pointer)
//   offset 20: napi_value value         (4 bytes, handle ID)
//   offset 24: napi_property_attributes (4 bytes, enum)
//   offset 28: void* data               (4 bytes, guest pointer)
const PROP_DESC_SIZE: usize = 32;

#[allow(clippy::too_many_arguments)]
fn guest_napi_define_class(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    name_ptr: i32,
    name_len: i32,
    constructor: i32,
    ctor_data: i32,
    prop_count: i32,
    props_ptr: i32,
    rp: i32,
) -> i32 {
    // Read class name
    let wl = name_len as u32;
    let name_bytes: Vec<u8> = if wl == 0xFFFFFFFFu32 {
        read_guest_c_string(&mut env, name_ptr).unwrap_or_default()
    } else if wl > 0 && name_ptr != 0 {
        let Some(bytes) = read_guest_bytes(&mut env, name_ptr, wl as usize) else {
            return 1;
        };
        bytes
    } else {
        vec![]
    };

    // Register the constructor callback
    let snapi = snapi_env(&env, e);
    let ctor_reg_id = unsafe { snapi_bridge_alloc_cb_reg_id(snapi) };
    unsafe {
        snapi_bridge_register_callback(
            snapi,
            ctor_reg_id,
            e as u32,
            constructor as u32,
            ctor_data as u64,
        )
    };

    let pc = prop_count as u32;
    let actual_name_len = name_bytes.len() as u32;
    let c_name = CString::new(name_bytes).unwrap_or_default();

    if pc == 0 {
        // No properties — simple case
        let mut out: u32 = 0;
        let s = unsafe {
            snapi_bridge_define_class(
                snapi_env(&env, e),
                c_name.as_ptr(),
                actual_name_len,
                ctor_reg_id,
                0,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                &mut out,
            )
        };
        if s != 0 {
            return s;
        }
        write_guest_u32(&mut env, rp as u32, out);
        return 0;
    }

    // Read property descriptors from guest memory
    let total_bytes = pc as usize * PROP_DESC_SIZE;
    let Some(raw) = read_guest_bytes(&mut env, props_ptr, total_bytes) else {
        return 1;
    };

    let mut prop_names_c: Vec<CString> = Vec::with_capacity(pc as usize);
    let mut prop_names_ptrs: Vec<*const i8> = Vec::with_capacity(pc as usize);
    let mut prop_name_ids: Vec<u32> = Vec::with_capacity(pc as usize);
    let mut prop_types: Vec<u32> = Vec::with_capacity(pc as usize);
    let mut prop_value_ids: Vec<u32> = Vec::with_capacity(pc as usize);
    let mut prop_method_reg_ids: Vec<u32> = Vec::with_capacity(pc as usize);
    let mut prop_getter_reg_ids: Vec<u32> = Vec::with_capacity(pc as usize);
    let mut prop_setter_reg_ids: Vec<u32> = Vec::with_capacity(pc as usize);
    let mut prop_attributes: Vec<i32> = Vec::with_capacity(pc as usize);

    for i in 0..pc as usize {
        let base = i * PROP_DESC_SIZE;
        let utf8name_guest =
            u32::from_le_bytes([raw[base], raw[base + 1], raw[base + 2], raw[base + 3]]);
        let name_id =
            u32::from_le_bytes([raw[base + 4], raw[base + 5], raw[base + 6], raw[base + 7]]);
        let method_ptr =
            u32::from_le_bytes([raw[base + 8], raw[base + 9], raw[base + 10], raw[base + 11]]);
        let getter_ptr = u32::from_le_bytes([
            raw[base + 12],
            raw[base + 13],
            raw[base + 14],
            raw[base + 15],
        ]);
        let setter_ptr = u32::from_le_bytes([
            raw[base + 16],
            raw[base + 17],
            raw[base + 18],
            raw[base + 19],
        ]);
        let value_id = u32::from_le_bytes([
            raw[base + 20],
            raw[base + 21],
            raw[base + 22],
            raw[base + 23],
        ]);
        let attrs = i32::from_le_bytes([
            raw[base + 24],
            raw[base + 25],
            raw[base + 26],
            raw[base + 27],
        ]);
        let data_ptr = u32::from_le_bytes([
            raw[base + 28],
            raw[base + 29],
            raw[base + 30],
            raw[base + 31],
        ]);

        // Read property name
        let pname = if utf8name_guest != 0 {
            read_guest_c_string(&mut env, utf8name_guest as i32).unwrap_or_default()
        } else {
            vec![]
        };
        let c_pname = CString::new(pname).unwrap_or_default();
        prop_name_ids.push(name_id);

        // Determine property type and register callbacks as needed
        if method_ptr != 0 {
            // Method property
            let reg_id = unsafe { snapi_bridge_alloc_cb_reg_id(snapi) };
            unsafe {
                snapi_bridge_register_callback(snapi, reg_id, e as u32, method_ptr, data_ptr as u64)
            };
            prop_types.push(1);
            prop_value_ids.push(0);
            prop_method_reg_ids.push(reg_id);
            prop_getter_reg_ids.push(0);
            prop_setter_reg_ids.push(0);
        } else if getter_ptr != 0 && setter_ptr != 0 {
            // Getter + Setter
            let reg_id = unsafe { snapi_bridge_alloc_cb_reg_id(snapi) };
            unsafe {
                snapi_bridge_register_callback_pair(
                    snapi,
                    reg_id,
                    e as u32,
                    getter_ptr,
                    setter_ptr,
                    data_ptr as u64,
                )
            };
            prop_types.push(4);
            prop_value_ids.push(0);
            prop_method_reg_ids.push(0);
            prop_getter_reg_ids.push(reg_id);
            prop_setter_reg_ids.push(0);
        } else if getter_ptr != 0 {
            // Getter only
            let reg_id = unsafe { snapi_bridge_alloc_cb_reg_id(snapi) };
            unsafe {
                snapi_bridge_register_callback(snapi, reg_id, e as u32, getter_ptr, data_ptr as u64)
            };
            prop_types.push(2);
            prop_value_ids.push(0);
            prop_method_reg_ids.push(0);
            prop_getter_reg_ids.push(reg_id);
            prop_setter_reg_ids.push(0);
        } else if setter_ptr != 0 {
            // Setter only
            let reg_id = unsafe { snapi_bridge_alloc_cb_reg_id(snapi) };
            unsafe {
                snapi_bridge_register_callback(snapi, reg_id, e as u32, setter_ptr, data_ptr as u64)
            };
            prop_types.push(3);
            prop_value_ids.push(0);
            prop_method_reg_ids.push(0);
            prop_getter_reg_ids.push(0);
            prop_setter_reg_ids.push(reg_id);
        } else {
            // Value property
            prop_types.push(0);
            prop_value_ids.push(value_id);
            prop_method_reg_ids.push(0);
            prop_getter_reg_ids.push(0);
            prop_setter_reg_ids.push(0);
        }

        prop_attributes.push(attrs);
        prop_names_c.push(c_pname);
    }

    // Build pointer array (must live as long as the FFI call)
    for cn in &prop_names_c {
        prop_names_ptrs.push(cn.as_ptr());
    }

    let mut out: u32 = 0;
    let s = unsafe {
        snapi_bridge_define_class(
            snapi_env(&env, e),
            c_name.as_ptr(),
            actual_name_len,
            ctor_reg_id,
            pc,
            prop_names_ptrs.as_ptr(),
            prop_name_ids.as_ptr(),
            prop_types.as_ptr(),
            prop_value_ids.as_ptr(),
            prop_method_reg_ids.as_ptr(),
            prop_getter_reg_ids.as_ptr(),
            prop_setter_reg_ids.as_ptr(),
            prop_attributes.as_ptr(),
            &mut out,
        )
    };
    if s != 0 {
        return s;
    }
    write_guest_u32(&mut env, rp as u32, out);
    0
}

fn guest_napi_define_properties(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    obj: i32,
    prop_count: i32,
    props_ptr: i32,
) -> i32 {
    let snapi = snapi_env(&env, e);
    let pc = prop_count as u32;
    if pc == 0 {
        return unsafe {
            snapi_bridge_define_properties(
                snapi,
                obj as u32,
                0,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null(),
            )
        };
    }

    let total_bytes = pc as usize * PROP_DESC_SIZE;
    let Some(raw) = read_guest_bytes(&mut env, props_ptr, total_bytes) else {
        return 1;
    };

    let mut prop_names_c: Vec<CString> = Vec::with_capacity(pc as usize);
    let mut prop_names_ptrs: Vec<*const i8> = Vec::with_capacity(pc as usize);
    let mut prop_name_ids: Vec<u32> = Vec::with_capacity(pc as usize);
    let mut prop_types: Vec<u32> = Vec::with_capacity(pc as usize);
    let mut prop_value_ids: Vec<u32> = Vec::with_capacity(pc as usize);
    let mut prop_method_reg_ids: Vec<u32> = Vec::with_capacity(pc as usize);
    let mut prop_getter_reg_ids: Vec<u32> = Vec::with_capacity(pc as usize);
    let mut prop_setter_reg_ids: Vec<u32> = Vec::with_capacity(pc as usize);
    let mut prop_attributes: Vec<i32> = Vec::with_capacity(pc as usize);

    for i in 0..pc as usize {
        let base = i * PROP_DESC_SIZE;
        let utf8name_guest =
            u32::from_le_bytes([raw[base], raw[base + 1], raw[base + 2], raw[base + 3]]);
        let name_id =
            u32::from_le_bytes([raw[base + 4], raw[base + 5], raw[base + 6], raw[base + 7]]);
        let method_ptr =
            u32::from_le_bytes([raw[base + 8], raw[base + 9], raw[base + 10], raw[base + 11]]);
        let getter_ptr = u32::from_le_bytes([
            raw[base + 12],
            raw[base + 13],
            raw[base + 14],
            raw[base + 15],
        ]);
        let setter_ptr = u32::from_le_bytes([
            raw[base + 16],
            raw[base + 17],
            raw[base + 18],
            raw[base + 19],
        ]);
        let value_id = u32::from_le_bytes([
            raw[base + 20],
            raw[base + 21],
            raw[base + 22],
            raw[base + 23],
        ]);
        let attrs = i32::from_le_bytes([
            raw[base + 24],
            raw[base + 25],
            raw[base + 26],
            raw[base + 27],
        ]);
        let data_ptr = u32::from_le_bytes([
            raw[base + 28],
            raw[base + 29],
            raw[base + 30],
            raw[base + 31],
        ]);

        let pname = if utf8name_guest != 0 {
            read_guest_c_string(&mut env, utf8name_guest as i32).unwrap_or_default()
        } else {
            vec![]
        };
        let c_pname = CString::new(pname).unwrap_or_default();
        prop_name_ids.push(name_id);

        if method_ptr != 0 {
            let reg_id = unsafe { snapi_bridge_alloc_cb_reg_id(snapi) };
            unsafe {
                snapi_bridge_register_callback(snapi, reg_id, e as u32, method_ptr, data_ptr as u64)
            };
            prop_types.push(1);
            prop_value_ids.push(0);
            prop_method_reg_ids.push(reg_id);
            prop_getter_reg_ids.push(0);
            prop_setter_reg_ids.push(0);
        } else if getter_ptr != 0 && setter_ptr != 0 {
            let reg_id = unsafe { snapi_bridge_alloc_cb_reg_id(snapi) };
            unsafe {
                snapi_bridge_register_callback_pair(
                    snapi,
                    reg_id,
                    e as u32,
                    getter_ptr,
                    setter_ptr,
                    data_ptr as u64,
                )
            };
            prop_types.push(4);
            prop_value_ids.push(0);
            prop_method_reg_ids.push(0);
            prop_getter_reg_ids.push(reg_id);
            prop_setter_reg_ids.push(0);
        } else if getter_ptr != 0 {
            let reg_id = unsafe { snapi_bridge_alloc_cb_reg_id(snapi) };
            unsafe {
                snapi_bridge_register_callback(snapi, reg_id, e as u32, getter_ptr, data_ptr as u64)
            };
            prop_types.push(2);
            prop_value_ids.push(0);
            prop_method_reg_ids.push(0);
            prop_getter_reg_ids.push(reg_id);
            prop_setter_reg_ids.push(0);
        } else if setter_ptr != 0 {
            let reg_id = unsafe { snapi_bridge_alloc_cb_reg_id(snapi) };
            unsafe {
                snapi_bridge_register_callback(snapi, reg_id, e as u32, setter_ptr, data_ptr as u64)
            };
            prop_types.push(3);
            prop_value_ids.push(0);
            prop_method_reg_ids.push(0);
            prop_getter_reg_ids.push(0);
            prop_setter_reg_ids.push(reg_id);
        } else {
            prop_types.push(0);
            prop_value_ids.push(value_id);
            prop_method_reg_ids.push(0);
            prop_getter_reg_ids.push(0);
            prop_setter_reg_ids.push(0);
        }

        prop_attributes.push(attrs);
        prop_names_c.push(c_pname);
    }

    for cn in &prop_names_c {
        prop_names_ptrs.push(cn.as_ptr());
    }

    unsafe {
        snapi_bridge_define_properties(
            snapi,
            obj as u32,
            pc,
            prop_names_ptrs.as_ptr(),
            prop_name_ids.as_ptr(),
            prop_types.as_ptr(),
            prop_value_ids.as_ptr(),
            prop_method_reg_ids.as_ptr(),
            prop_getter_reg_ids.as_ptr(),
            prop_setter_reg_ids.as_ptr(),
            prop_attributes.as_ptr(),
        )
    }
}

// --- Script execution ---

fn guest_napi_run_script(mut env: FunctionEnvMut<NapiEnv>, e: i32, sh: i32, rp: i32) -> i32 {
    let snapi = snapi_env(&env, e);
    let mut out: u32 = 0;
    let s = with_cb_context(&mut env, e, || unsafe {
        snapi_bridge_run_script(snapi, sh as u32, &mut out)
    });

    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

// --- UTF-16 strings ---

fn guest_napi_create_string_utf16(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    str_ptr: i32,
    length: i32,
    rp: i32,
) -> i32 {
    let wl = length as u32;
    // UTF-16: each char is 2 bytes
    let char_count: usize = if wl == 0xFFFFFFFFu32 {
        // Auto-length: scan for null terminator (u16 == 0)
        let mut scan_len: usize = 0;
        loop {
            let Some(bytes) = read_guest_bytes(&mut env, str_ptr + (scan_len as i32 * 2), 2) else {
                break;
            };
            let ch = u16::from_le_bytes([bytes[0], bytes[1]]);
            if ch == 0 {
                break;
            }
            scan_len += 1;
            if scan_len > MAX_GUEST_CSTRING_SCAN {
                break;
            }
        }
        scan_len
    } else {
        wl as usize
    };
    let Some(byte_len) = char_count.checked_mul(2) else {
        return 1;
    };
    if byte_len as u64 > guest_data_size(&mut env) {
        return 1;
    }
    let Some(raw_bytes) = read_guest_bytes(&mut env, str_ptr, byte_len) else {
        return 1;
    };
    // Convert bytes to u16 array
    let u16_data: Vec<u16> = raw_bytes
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let mut out: u32 = 0;
    // Always pass the actual char count to the 64-bit bridge (not the WASM32 NAPI_AUTO_LENGTH sentinel)
    let s = unsafe {
        snapi_bridge_create_string_utf16(
            snapi_env(&env, e),
            u16_data.as_ptr(),
            char_count as u32,
            &mut out,
        )
    };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_get_value_string_utf16(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    vh: i32,
    bp: i32,
    bs: i32,
    rp: i32,
) -> i32 {
    let hbs = if bs <= 0 { 0usize } else { bs as usize };
    let Some(byte_len) = hbs.checked_mul(2) else {
        return 1;
    };
    if byte_len as u64 > guest_data_size(&mut env) {
        return 1;
    }
    let mut hb = vec![0u16; hbs];
    let mut rl: usize = 0;
    let s = unsafe {
        snapi_bridge_get_value_string_utf16(
            snapi_env(&env, e),
            vh as u32,
            if hbs > 0 {
                hb.as_mut_ptr()
            } else {
                std::ptr::null_mut()
            },
            hbs,
            &mut rl,
        )
    };
    if s != 0 {
        return s;
    }
    if bp > 0 && hbs > 0 {
        let n = hbs.min(rl + 1);
        // Write u16 values as LE bytes to guest memory
        let bytes: Vec<u8> = hb[..n].iter().flat_map(|&v| v.to_le_bytes()).collect();
        write_guest_bytes(&mut env, bp as u32, &bytes);
    }
    if rp > 0 {
        write_guest_u32(&mut env, rp as u32, rl as u32);
    }
    0
}

// --- BigInt words ---

fn guest_napi_create_bigint_words(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    sign_bit: i32,
    word_count: i32,
    words_ptr: i32,
    rp: i32,
) -> i32 {
    if word_count < 0 || word_count as usize > MAX_NAPI_BIGINT_WORDS {
        return 1;
    }
    let wc = word_count as u32;
    // Read u64 words from guest memory (each is 8 bytes)
    let Some(byte_len) = (wc as usize).checked_mul(8) else {
        return 1;
    };
    let Some(words_bytes) = read_guest_bytes(&mut env, words_ptr, byte_len) else {
        return 1;
    };
    let words: Vec<u64> = words_bytes
        .chunks_exact(8)
        .map(|c| u64::from_le_bytes(c.try_into().unwrap()))
        .collect();
    let mut out: u32 = 0;
    let s = unsafe {
        snapi_bridge_create_bigint_words(snapi_env(&env, e), sign_bit, wc, words.as_ptr(), &mut out)
    };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

fn guest_napi_get_value_bigint_words(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    vh: i32,
    sign_ptr: i32,
    wc_ptr: i32,
    words_ptr: i32,
) -> i32 {
    // First, read the word_count from guest to know how many to allocate
    let Some(wc_bytes) = read_guest_bytes(&mut env, wc_ptr, 4) else {
        return 1;
    };
    let mut word_count = u32::from_le_bytes(wc_bytes.try_into().unwrap()) as usize;
    if word_count > MAX_NAPI_BIGINT_WORDS {
        return 1;
    }

    if words_ptr <= 0 {
        // Query mode: just get the word count
        let mut sign: i32 = 0;
        let s = unsafe {
            snapi_bridge_get_value_bigint_words(
                snapi_env(&env, e),
                vh as u32,
                &mut sign,
                &mut word_count,
                std::ptr::null_mut(),
            )
        };
        if s == 0 {
            write_guest_i32(&mut env, sign_ptr as u32, sign);
            write_guest_u32(&mut env, wc_ptr as u32, word_count as u32);
        }
        return s;
    }

    let mut sign: i32 = 0;
    let mut words = vec![0u64; word_count];
    let s = unsafe {
        snapi_bridge_get_value_bigint_words(
            snapi_env(&env, e),
            vh as u32,
            &mut sign,
            &mut word_count,
            words.as_mut_ptr(),
        )
    };
    if s == 0 {
        write_guest_i32(&mut env, sign_ptr as u32, sign);
        write_guest_u32(&mut env, wc_ptr as u32, word_count as u32);
        // Write u64 words as LE bytes to guest
        let bytes: Vec<u8> = words[..word_count]
            .iter()
            .flat_map(|&v| v.to_le_bytes())
            .collect();
        write_guest_bytes(&mut env, words_ptr as u32, &bytes);
    }
    s
}

// --- Instance data ---

fn guest_napi_set_instance_data(
    env: FunctionEnvMut<NapiEnv>,
    e: i32,
    data: i32,
    _finalize_cb: i32,
    _finalize_hint: i32,
) -> i32 {
    unsafe { snapi_bridge_set_instance_data(snapi_env(&env, e), data as u64) }
}

fn guest_napi_get_instance_data(mut env: FunctionEnvMut<NapiEnv>, e: i32, rp: i32) -> i32 {
    let mut data: u64 = 0;
    let s = unsafe { snapi_bridge_get_instance_data(snapi_env(&env, e), &mut data) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, data as u32);
    }
    s
}

fn guest_napi_adjust_external_memory(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    change: i64,
    rp: i32,
) -> i32 {
    let mut adjusted: i64 = 0;
    let s =
        unsafe { snapi_bridge_adjust_external_memory(snapi_env(&env, e), change, &mut adjusted) };
    if s == 0 {
        write_guest_i64(&mut env, rp as u32, adjusted);
    }
    s
}

// --- Node Buffers ---

fn guest_napi_create_buffer(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    length: i32,
    data_ptr: i32,
    rp: i32,
) -> i32 {
    #[cfg(feature = "js")]
    {
        if length < 0 {
            return 1;
        }
        let zeros = vec![0u8; length as usize];
        let Some(guest_ptr) = allocate_guest_bytes(&mut env, &zeros) else {
            return 1;
        };
        let Some(memory) = env.data().memory.clone() else {
            return 1;
        };
        let memory_buffer = memory.as_js().js_buffer();
        let mut out = 0u32;
        let status = crate::snapi_js::create_guest_buffer_view(
            snapi_env(&env, e),
            &memory_buffer,
            guest_ptr,
            length as u32,
            &mut out,
        );
        if status != 0 {
            return status;
        }
        let backing_store_token = host_backing_store_token(&env, e, out);
        remember_guest_backing_store(
            &mut env,
            e as u32,
            out,
            backing_store_token,
            0,
            guest_ptr,
            length as usize,
            false,
        );
        write_guest_u32(&mut env, rp as u32, out);
        if data_ptr > 0 {
            write_guest_u32(&mut env, data_ptr as u32, guest_ptr);
        }
        return 0;
    }

    #[cfg(not(feature = "js"))]
    {
        // Buffers must be backed by guest linear memory (same pattern as create_arraybuffer)
        let malloc_fn = env.data().malloc_fn.clone();
        let memory = env.data().memory.clone();

        if let (Some(malloc_fn), Some(memory)) = (malloc_fn, memory) {
            // Allocate memory in the guest's linear memory
            let guest_ptr: i32 = {
                let (_, mut store_ref) = env.data_and_store_mut();
                match malloc_fn.call(&mut store_ref, length) {
                    Ok(ptr) if ptr > 0 => ptr,
                    _ => return 1,
                }
            };

            // Get host pointer corresponding to the guest allocation
            let host_addr: u64 = {
                let (_, store_ref) = env.data_and_store_mut();
                let view = memory.view(&store_ref);
                let host_base = view.data_ptr() as u64;
                host_base + guest_ptr as u64
            };

            // Zero-initialize the guest memory region
            if length > 0 {
                let zeros = vec![0u8; length as usize];
                write_guest_bytes(&mut env, guest_ptr as u32, &zeros);
            }

            let mut buf_id: u32 = 0;
            let mut backing_store_token: u64 = 0;
            let s = unsafe {
                snapi_bridge_create_external_buffer(
                    snapi_env(&env, e),
                    host_addr,
                    length as u32,
                    &mut backing_store_token,
                    &mut buf_id,
                )
            };
            if s != 0 {
                return s;
            }

            remember_guest_backing_store(
                &mut env,
                e as u32,
                buf_id,
                backing_store_token,
                host_addr,
                guest_ptr as u32,
                length as usize,
                false,
            );

            write_guest_u32(&mut env, rp as u32, buf_id);
            if data_ptr > 0 {
                write_guest_u32(&mut env, data_ptr as u32, guest_ptr as u32);
            }
            0
        } else {
            // Fallback for non-WASIX: use bridge directly
            let mut host_data: u64 = 0;
            let mut out: u32 = 0;
            let s = unsafe {
                snapi_bridge_create_buffer(
                    snapi_env(&env, e),
                    length as u32,
                    &mut host_data,
                    &mut out,
                )
            };
            if s != 0 {
                return s;
            }
            write_guest_u32(&mut env, rp as u32, out);
            0
        }
    }
}

fn guest_napi_create_buffer_copy(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    length: i32,
    data_ptr: i32,
    result_data_ptr: i32,
    rp: i32,
) -> i32 {
    // Read source data from guest memory first
    let Some(src_data) = read_guest_bytes(&mut env, data_ptr, length as usize) else {
        return 1;
    };

    #[cfg(feature = "js")]
    {
        // napi_create_buffer_copy() only exposes native memory when the caller
        // asks for result_data. Without that pointer, let JavaScript own the
        // copied Buffer directly; retaining a guest allocation would pin one
        // allocation per network chunk with no observable native benefit.
        if result_data_ptr <= 0 {
            let mut out = 0u32;
            let status = unsafe {
                snapi_bridge_create_buffer_copy(
                    snapi_env(&env, e),
                    length as u32,
                    src_data.as_ptr(),
                    std::ptr::null_mut(),
                    &mut out,
                )
            };
            if status == 0 {
                write_guest_u32(&mut env, rp as u32, out);
            }
            return status;
        }

        // result_data must remain a real pointer into guest linear memory.
        let Some(guest_ptr) = allocate_guest_bytes(&mut env, &src_data) else {
            return 1;
        };
        let Some(memory) = env.data().memory.clone() else {
            return 1;
        };
        let memory_buffer = memory.as_js().js_buffer();
        let mut out = 0u32;
        let status = crate::snapi_js::create_guest_buffer_view(
            snapi_env(&env, e),
            &memory_buffer,
            guest_ptr,
            length as u32,
            &mut out,
        );
        if status != 0 {
            return status;
        }
        let backing_store_token = host_backing_store_token(&env, e, out);
        remember_guest_backing_store(
            &mut env,
            e as u32,
            out,
            backing_store_token,
            0,
            guest_ptr,
            length as usize,
            false,
        );
        write_guest_u32(&mut env, rp as u32, out);
        if result_data_ptr > 0 {
            write_guest_u32(&mut env, result_data_ptr as u32, guest_ptr);
        }
        return 0;
    }

    #[cfg(not(feature = "js"))]
    {
        let malloc_fn = env.data().malloc_fn.clone();
        let memory = env.data().memory.clone();

        if let (Some(malloc_fn), Some(memory)) = (malloc_fn, memory) {
            // Allocate memory in the guest's linear memory
            let guest_ptr: i32 = {
                let (_, mut store_ref) = env.data_and_store_mut();
                match malloc_fn.call(&mut store_ref, length) {
                    Ok(ptr) if ptr > 0 => ptr,
                    _ => return 1,
                }
            };

            // Copy source data to guest memory
            write_guest_bytes(&mut env, guest_ptr as u32, &src_data);

            // Get host pointer corresponding to the guest allocation
            let host_addr: u64 = {
                let (_, store_ref) = env.data_and_store_mut();
                let view = memory.view(&store_ref);
                let host_base = view.data_ptr() as u64;
                host_base + guest_ptr as u64
            };

            let mut buf_id: u32 = 0;
            let mut backing_store_token: u64 = 0;
            let s = unsafe {
                snapi_bridge_create_external_buffer(
                    snapi_env(&env, e),
                    host_addr,
                    length as u32,
                    &mut backing_store_token,
                    &mut buf_id,
                )
            };
            if s != 0 {
                return s;
            }

            remember_guest_backing_store(
                &mut env,
                e as u32,
                buf_id,
                backing_store_token,
                host_addr,
                guest_ptr as u32,
                length as usize,
                false,
            );

            write_guest_u32(&mut env, rp as u32, buf_id);
            if result_data_ptr > 0 {
                write_guest_u32(&mut env, result_data_ptr as u32, guest_ptr as u32);
            }
            0
        } else {
            // Fallback for non-WASIX
            let mut result_host_data: u64 = 0;
            let mut out: u32 = 0;
            let s = unsafe {
                snapi_bridge_create_buffer_copy(
                    snapi_env(&env, e),
                    length as u32,
                    src_data.as_ptr(),
                    &mut result_host_data,
                    &mut out,
                )
            };
            if s == 0 {
                write_guest_u32(&mut env, rp as u32, out);
            }
            s
        }
    }
}

guest_is_check!(guest_napi_is_buffer, snapi_bridge_is_buffer);

fn guest_napi_get_buffer_info(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    vh: i32,
    data_ptr: i32,
    len_ptr: i32,
) -> i32 {
    let (bl, backing_store_token) =
        match crate::snapi_js::get_value_byte_length_and_token(snapi_env(&env, e), vh as u32) {
            Ok(info) => info,
            Err(status) => return status,
        };
    if len_ptr > 0 {
        write_guest_u32(&mut env, len_ptr as u32, bl);
    }
    let guest_data_ptr = if data_ptr > 0 {
        resolve_current_host_value_to_guest(
            &mut env,
            e,
            vh as u32,
            backing_store_token,
            bl as usize,
            false,
        )
    } else {
        None
    };
    if let Some(guest_data_ptr) = guest_data_ptr {
        write_guest_u32(&mut env, data_ptr as u32, guest_data_ptr);
    }
    0
}

fn guest_unofficial_napi_acquire_buffer_lease(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    vh: i32,
    byte_offset: i32,
    byte_length: i32,
    mode: i32,
    lease_out: i32,
    data_out: i32,
) -> i32 {
    if byte_offset < 0
        || byte_length < 0
        || lease_out <= 0
        || data_out <= 0
        || mode & !3 != 0
        || mode == 0
    {
        return 1;
    }
    let snapi = snapi_env(&env, e);
    let (value_len, _) = match crate::snapi_js::get_value_byte_length_and_token(snapi, vh as u32) {
        Ok(info) => info,
        Err(status) => return status,
    };
    let offset = byte_offset as u32;
    let len = byte_length as u32;
    if offset > value_len || len > value_len - offset {
        return 1;
    }

    let Some(guest_ptr) = allocate_guest_buffer(&mut env, len as usize) else {
        return 9;
    };
    if mode & 1 != 0 && len > 0 {
        let Some(memory) = env.data().memory.clone() else {
            recycle_guest_allocation(&mut env, guest_ptr);
            return 9;
        };
        let status = crate::snapi_js::copy_value_range_to_memory(
            snapi,
            vh as u32,
            &memory.as_js().js_buffer(),
            guest_ptr,
            offset,
            len,
        );
        if status != 0 {
            recycle_guest_allocation(&mut env, guest_ptr);
            return status;
        }
    }

    let mut host_reference_id = 0u32;
    let status =
        unsafe { snapi_bridge_create_reference(snapi, vh as u32, 1, &mut host_reference_id) };
    if status != 0 {
        recycle_guest_allocation(&mut env, guest_ptr);
        return status;
    }

    let lease_id = env.data().next_buffer_lease_id.max(1);
    env.data_mut().next_buffer_lease_id = lease_id.wrapping_add(1).max(1);
    if env
        .data_mut()
        .host_buffer_leases
        .insert(
            (e as u32, lease_id),
            crate::env::HostBufferLease {
                guest_ptr,
                byte_offset: offset,
                byte_len: len,
                writable: mode & 2 != 0,
                host_reference_id,
            },
        )
        .is_some()
    {
        let _ = unsafe { snapi_bridge_delete_reference(snapi, host_reference_id) };
        recycle_guest_allocation(&mut env, guest_ptr);
        return 9;
    }
    write_guest_u32(&mut env, lease_out as u32, lease_id);
    write_guest_u32(&mut env, data_out as u32, guest_ptr);
    0
}

fn guest_unofficial_napi_release_buffer_lease(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    lease_id: i32,
    modified: i32,
) -> i32 {
    if lease_id <= 0 {
        return 1;
    }
    let Some(lease) = env
        .data_mut()
        .host_buffer_leases
        .remove(&(e as u32, lease_id as u32))
    else {
        return 1;
    };
    let snapi = snapi_env(&env, e);
    let mut status = 0;
    if lease.writable && modified != 0 && lease.byte_len > 0 {
        let Some(memory) = env.data().memory.clone() else {
            recycle_guest_allocation(&mut env, lease.guest_ptr);
            let _ = unsafe { snapi_bridge_delete_reference(snapi, lease.host_reference_id) };
            return 9;
        };
        status = crate::snapi_js::copy_memory_range_to_reference(
            snapi,
            lease.host_reference_id,
            &memory.as_js().js_buffer(),
            lease.guest_ptr,
            lease.byte_offset,
            lease.byte_len,
        );
    }
    let delete_status = unsafe { snapi_bridge_delete_reference(snapi, lease.host_reference_id) };
    recycle_guest_allocation(&mut env, lease.guest_ptr);
    if status != 0 { status } else { delete_status }
}

fn guest_unofficial_napi_create_guest_backed_typedarray(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    typ: i32,
    length: i32,
    data_out: i32,
    result_out: i32,
) -> i32 {
    if length < 0 || data_out <= 0 || result_out <= 0 {
        return 1;
    }
    let Some(element_size) = typedarray_element_size(typ) else {
        return 1;
    };
    let Some(byte_len) = (length as usize).checked_mul(element_size) else {
        return 1;
    };
    let Some(guest_ptr) = allocate_guest_buffer(&mut env, byte_len) else {
        return 9;
    };
    if byte_len > 0 && !write_guest_bytes(&mut env, guest_ptr, &vec![0; byte_len]) {
        recycle_guest_allocation(&mut env, guest_ptr);
        return 9;
    }
    let Some(memory) = env.data().memory.clone() else {
        recycle_guest_allocation(&mut env, guest_ptr);
        return 9;
    };
    let memory_buffer = memory.as_js().js_buffer();
    let mut out = 0u32;
    let status = crate::snapi_js::create_guest_typedarray_view(
        snapi_env(&env, e),
        &memory_buffer,
        typ,
        guest_ptr,
        length as u32,
        &mut out,
    );
    if status != 0 {
        recycle_guest_allocation(&mut env, guest_ptr);
        return status;
    }
    let backing_store_token = host_backing_store_token(&env, e, out);
    remember_guest_backing_store(
        &mut env,
        e as u32,
        out,
        backing_store_token,
        0,
        guest_ptr,
        byte_len,
        false,
    );
    write_guest_u32(&mut env, data_out as u32, guest_ptr);
    write_guest_u32(&mut env, result_out as u32, out);
    0
}

// --- Node version ---

fn guest_napi_get_node_version(mut env: FunctionEnvMut<NapiEnv>, e: i32, rp: i32) -> i32 {
    let mut major: u32 = 0;
    let mut minor: u32 = 0;
    let mut patch: u32 = 0;
    let s = unsafe {
        snapi_bridge_get_node_version(snapi_env(&env, e), &mut major, &mut minor, &mut patch)
    };
    if s != 0 {
        return s;
    }
    // Write a napi_node_version struct to guest memory:
    // { uint32_t major, uint32_t minor, uint32_t patch, const char* release }
    // For WASM: we write the struct (16 bytes) into a static-ish location
    // But the N-API spec says we return a *pointer* to the version struct.
    // Actually, the API signature is: napi_get_node_version(env, const napi_node_version** version)
    // So we need to allocate memory in guest for the struct and write the pointer.
    // For simplicity, use malloc if available, otherwise just write the pointer to a fixed value.
    let malloc_fn = env.data().malloc_fn.clone();
    if let Some(malloc_fn) = malloc_fn {
        // Allocate 16 bytes for the struct (major, minor, patch, release_ptr)
        // Then allocate a small buffer for the release string
        let release_str = b"napi-external\0";
        let struct_size = 16i32; // 4 * u32 = 16 (release is a pointer)
        let total = struct_size + release_str.len() as i32;
        let guest_ptr: i32 = {
            let (_, mut store_ref) = env.data_and_store_mut();
            match malloc_fn.call(&mut store_ref, total) {
                Ok(ptr) if ptr > 0 => ptr,
                _ => return 1,
            }
        };
        // Write release string
        let release_offset = guest_ptr + struct_size;
        write_guest_bytes(&mut env, release_offset as u32, release_str);
        // Write struct fields
        write_guest_u32(&mut env, guest_ptr as u32, major);
        write_guest_u32(&mut env, (guest_ptr + 4) as u32, minor);
        write_guest_u32(&mut env, (guest_ptr + 8) as u32, patch);
        write_guest_u32(&mut env, (guest_ptr + 12) as u32, release_offset as u32);
        // Write pointer to struct
        write_guest_u32(&mut env, rp as u32, guest_ptr as u32);
    } else {
        // Fallback: just write major version as a simple value
        write_guest_u32(&mut env, rp as u32, major);
    }
    0
}

// --- Object wrapping ---

fn guest_napi_wrap(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    obj: i32,
    native_data: i32,
    finalize_cb: i32,
    finalize_hint: i32,
    ref_ptr: i32,
) -> i32 {
    if finalize_cb != 0 {
        let mut ref_out = 0u32;
        let status = unsafe {
            snapi_bridge_wrap_finalized(
                snapi_env(&env, e),
                obj as u32,
                native_data as u64,
                e as u32,
                finalize_cb as u32,
                native_data as u32,
                finalize_hint as u32,
                if ref_ptr > 0 {
                    &mut ref_out
                } else {
                    std::ptr::null_mut()
                },
            )
        };
        if status == 0 && ref_ptr > 0 {
            write_guest_u32(&mut env, ref_ptr as u32, ref_out);
        }
        return status;
    }
    let mut ref_out: u32 = 0;
    let s = if ref_ptr > 0 {
        unsafe {
            snapi_bridge_wrap(
                snapi_env(&env, e),
                obj as u32,
                native_data as u64,
                &mut ref_out,
            )
        }
    } else {
        unsafe {
            snapi_bridge_wrap(
                snapi_env(&env, e),
                obj as u32,
                native_data as u64,
                std::ptr::null_mut(),
            )
        }
    };
    if s == 0 && ref_ptr > 0 {
        write_guest_u32(&mut env, ref_ptr as u32, ref_out);
    }
    s
}

fn guest_napi_unwrap(mut env: FunctionEnvMut<NapiEnv>, e: i32, obj: i32, rp: i32) -> i32 {
    let mut data: u64 = 0;
    let s = unsafe { snapi_bridge_unwrap(snapi_env(&env, e), obj as u32, &mut data) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, data as u32);
    }
    s
}

fn guest_napi_remove_wrap(mut env: FunctionEnvMut<NapiEnv>, e: i32, obj: i32, rp: i32) -> i32 {
    let mut data: u64 = 0;
    let s = unsafe { snapi_bridge_remove_wrap(snapi_env(&env, e), obj as u32, &mut data) };
    if s == 0 {
        write_guest_u32(&mut env, rp as u32, data as u32);
    }
    s
}

fn guest_napi_add_finalizer(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    obj: i32,
    data: i32,
    finalize_cb: i32,
    finalize_hint: i32,
    ref_ptr: i32,
) -> i32 {
    let mut ref_out: u32 = 0;
    let s = if finalize_cb != 0 {
        unsafe {
            snapi_bridge_add_finalizer_cb(
                snapi_env(&env, e),
                obj as u32,
                data as u64,
                e as u32,
                finalize_cb as u32,
                data as u32,
                finalize_hint as u32,
                if ref_ptr > 0 {
                    &mut ref_out
                } else {
                    std::ptr::null_mut()
                },
            )
        }
    } else if ref_ptr > 0 {
        unsafe {
            snapi_bridge_add_finalizer(snapi_env(&env, e), obj as u32, data as u64, &mut ref_out)
        }
    } else {
        unsafe {
            snapi_bridge_add_finalizer(
                snapi_env(&env, e),
                obj as u32,
                data as u64,
                std::ptr::null_mut(),
            )
        }
    };
    if s == 0 && ref_ptr > 0 {
        write_guest_u32(&mut env, ref_ptr as u32, ref_out);
    }
    s
}

// --- Misc stubs ---

fn guest_napi_get_last_error_info(_env: FunctionEnvMut<NapiEnv>, _e: i32, _rp: i32) -> i32 {
    0
}

fn guest_napi_get_version(mut env: FunctionEnvMut<NapiEnv>, _e: i32, rp: i32) -> i32 {
    write_guest_u32(&mut env, rp as u32, 8);
    0
}

fn guest_napi_fatal_error(
    mut env: FunctionEnvMut<NapiEnv>,
    loc_ptr: i32,
    loc_len: i32,
    msg_ptr: i32,
    msg_len: i32,
) -> i32 {
    // Read location and message from guest memory
    let loc = if loc_ptr > 0 {
        let len = if loc_len as u32 == 0xFFFFFFFFu32 {
            read_guest_c_string(&mut env, loc_ptr)
                .map(|v| v.len())
                .unwrap_or(0)
        } else {
            loc_len as usize
        };
        read_guest_bytes(&mut env, loc_ptr, len).map(|b| String::from_utf8_lossy(&b).to_string())
    } else {
        None
    };
    let msg = if msg_ptr > 0 {
        let len = if msg_len as u32 == 0xFFFFFFFFu32 {
            read_guest_c_string(&mut env, msg_ptr)
                .map(|v| v.len())
                .unwrap_or(0)
        } else {
            msg_len as usize
        };
        read_guest_bytes(&mut env, msg_ptr, len).map(|b| String::from_utf8_lossy(&b).to_string())
    } else {
        None
    };
    eprintln!(
        "FATAL ERROR: location={}, message={}",
        loc.as_deref().unwrap_or("(null)"),
        msg.as_deref().unwrap_or("(null)")
    );
    std::process::abort();
}

// --- Constructor ---

fn guest_napi_new_instance(
    mut env: FunctionEnvMut<NapiEnv>,
    e: i32,
    ctor: i32,
    argc: i32,
    argv_ptr: i32,
    rp: i32,
) -> i32 {
    let argc_u = argc as u32;
    let argv_ids = if argc_u > 0 {
        let Some(ids) = read_guest_u32_array(&mut env, argv_ptr, argc_u as usize) else {
            return 1;
        };
        ids
    } else {
        vec![]
    };

    let snapi = snapi_env(&env, e);
    let mut out: u32 = 0;
    let s = with_cb_context(&mut env, e, || unsafe {
        snapi_bridge_new_instance(snapi, ctor as u32, argc_u, argv_ids.as_ptr(), &mut out)
    });

    if s == 0 {
        write_guest_u32(&mut env, rp as u32, out);
    }
    s
}

// ============================================================
// Register WASM imports for both the core "napi" module and the
// Wasmer-specific "napi_extension_wasmer_v0" extension module.
// ============================================================

pub(crate) fn is_known_napi_import(name: &str) -> bool {
    matches!(
        name,
        "napi_wasm_init_env"
            | "napi_get_undefined"
            | "napi_get_null"
            | "napi_get_boolean"
            | "napi_get_global"
            | "napi_create_string_utf8"
            | "napi_create_string_latin1"
            | "napi_create_int32"
            | "napi_create_uint32"
            | "napi_create_double"
            | "napi_create_int64"
            | "napi_create_object"
            | "napi_create_array"
            | "napi_create_array_with_length"
            | "napi_create_symbol"
            | "napi_create_error"
            | "napi_create_type_error"
            | "napi_create_range_error"
            | "napi_create_bigint_int64"
            | "napi_create_bigint_uint64"
            | "napi_create_date"
            | "napi_create_external"
            | "napi_create_arraybuffer"
            | "napi_create_external_arraybuffer"
            | "napi_create_external_buffer"
            | "napi_create_typedarray"
            | "napi_create_dataview"
            | "napi_create_promise"
            | "napi_get_value_string_utf8"
            | "napi_get_value_string_latin1"
            | "napi_get_value_int32"
            | "napi_get_value_uint32"
            | "napi_get_value_double"
            | "napi_get_value_int64"
            | "napi_get_value_bool"
            | "napi_get_value_bigint_int64"
            | "napi_get_value_bigint_uint64"
            | "napi_get_date_value"
            | "napi_get_value_external"
            | "napi_typeof"
            | "napi_is_array"
            | "napi_is_error"
            | "napi_is_arraybuffer"
            | "napi_is_typedarray"
            | "napi_is_dataview"
            | "napi_is_date"
            | "napi_is_promise"
            | "napi_instanceof"
            | "napi_coerce_to_bool"
            | "napi_coerce_to_number"
            | "napi_coerce_to_string"
            | "napi_coerce_to_object"
            | "napi_set_property"
            | "napi_get_property"
            | "napi_has_property"
            | "napi_has_own_property"
            | "napi_delete_property"
            | "napi_set_named_property"
            | "napi_get_named_property"
            | "napi_has_named_property"
            | "napi_set_element"
            | "napi_get_element"
            | "napi_has_element"
            | "napi_delete_element"
            | "napi_get_array_length"
            | "napi_get_property_names"
            | "napi_get_all_property_names"
            | "napi_get_prototype"
            | "napi_object_freeze"
            | "napi_object_seal"
            | "napi_strict_equals"
            | "napi_throw"
            | "napi_throw_error"
            | "napi_throw_type_error"
            | "napi_throw_range_error"
            | "napi_is_exception_pending"
            | "napi_get_and_clear_last_exception"
            | "napi_resolve_deferred"
            | "napi_reject_deferred"
            | "napi_get_arraybuffer_info"
            | "napi_detach_arraybuffer"
            | "napi_is_detached_arraybuffer"
            | "node_api_is_sharedarraybuffer"
            | "node_api_create_sharedarraybuffer"
            | "node_api_set_prototype"
            | "napi_get_typedarray_info"
            | "napi_get_dataview_info"
            | "napi_create_reference"
            | "napi_delete_reference"
            | "napi_reference_ref"
            | "napi_reference_unref"
            | "napi_get_reference_value"
            | "napi_open_handle_scope"
            | "napi_close_handle_scope"
            | "napi_open_escapable_handle_scope"
            | "napi_close_escapable_handle_scope"
            | "napi_escape_handle"
            | "napi_type_tag_object"
            | "napi_check_object_type_tag"
            | "napi_call_function"
            | "napi_create_function"
            | "napi_get_cb_info"
            | "napi_get_new_target"
            | "napi_run_script"
            | "napi_create_string_utf16"
            | "napi_get_value_string_utf16"
            | "napi_create_bigint_words"
            | "napi_get_value_bigint_words"
            | "napi_set_instance_data"
            | "napi_get_instance_data"
            | "napi_adjust_external_memory"
            | "napi_create_buffer"
            | "napi_create_buffer_copy"
            | "napi_is_buffer"
            | "napi_get_buffer_info"
            | "napi_get_node_version"
            | "napi_wrap"
            | "napi_unwrap"
            | "napi_remove_wrap"
            | "napi_add_finalizer"
            | "napi_new_instance"
            | "napi_define_properties"
            | "napi_define_class"
            | "napi_fatal_error"
            | "napi_get_last_error_info"
            | "napi_get_version"
            | "napi_add_env_cleanup_hook"
            | "napi_remove_env_cleanup_hook"
    )
}

pub fn register_napi_imports(
    store: &mut impl AsStoreMut,
    fe: &FunctionEnv<NapiEnv>,
    io: &mut Imports,
) {
    let napi_namespace = namespace! {
        "napi_wasm_init_env" => Function::new_typed_with_env(store, fe, guest_napi_wasm_init_env),
        "napi_get_undefined" => Function::new_typed_with_env(store, fe, guest_napi_get_undefined),
        "napi_get_null" => Function::new_typed_with_env(store, fe, guest_napi_get_null),
        "napi_get_boolean" => Function::new_typed_with_env(store, fe, guest_napi_get_boolean),
        "napi_get_global" => Function::new_typed_with_env(store, fe, guest_napi_get_global),
        "napi_create_string_utf8" => Function::new_typed_with_env(store, fe, guest_napi_create_string_utf8),
        "napi_create_string_latin1" => Function::new_typed_with_env(store, fe, guest_napi_create_string_latin1),
        "napi_create_int32" => Function::new_typed_with_env(store, fe, guest_napi_create_int32),
        "napi_create_uint32" => Function::new_typed_with_env(store, fe, guest_napi_create_uint32),
        "napi_create_double" => Function::new_typed_with_env(store, fe, guest_napi_create_double),
        "napi_create_int64" => Function::new_typed_with_env(store, fe, guest_napi_create_int64),
        "napi_create_object" => Function::new_typed_with_env(store, fe, guest_napi_create_object),
        "napi_create_array" => Function::new_typed_with_env(store, fe, guest_napi_create_array),
        "napi_create_array_with_length" => Function::new_typed_with_env(store, fe, guest_napi_create_array_with_length),
        "napi_create_symbol" => Function::new_typed_with_env(store, fe, guest_napi_create_symbol),
        "napi_create_error" => Function::new_typed_with_env(store, fe, guest_napi_create_error),
        "napi_create_type_error" => Function::new_typed_with_env(store, fe, guest_napi_create_type_error),
        "napi_create_range_error" => Function::new_typed_with_env(store, fe, guest_napi_create_range_error),
        "napi_create_bigint_int64" => Function::new_typed_with_env(store, fe, guest_napi_create_bigint_int64),
        "napi_create_bigint_uint64" => Function::new_typed_with_env(store, fe, guest_napi_create_bigint_uint64),
        "napi_create_date" => Function::new_typed_with_env(store, fe, guest_napi_create_date),
        "napi_create_external" => Function::new_typed_with_env(store, fe, guest_napi_create_external),
        "napi_create_arraybuffer" => Function::new_typed_with_env(store, fe, guest_napi_create_arraybuffer),
        "napi_create_external_arraybuffer" => Function::new_typed_with_env(store, fe, guest_napi_create_external_arraybuffer),
        "napi_create_external_buffer" => Function::new_typed_with_env(store, fe, guest_napi_create_external_buffer),
        "napi_create_typedarray" => Function::new_typed_with_env(store, fe, guest_napi_create_typedarray),
        "napi_create_dataview" => Function::new_typed_with_env(store, fe, guest_napi_create_dataview),
        "napi_create_promise" => Function::new_typed_with_env(store, fe, guest_napi_create_promise),
        "napi_get_value_string_utf8" => Function::new_typed_with_env(store, fe, guest_napi_get_value_string_utf8),
        "napi_get_value_string_latin1" => Function::new_typed_with_env(store, fe, guest_napi_get_value_string_latin1),
        "napi_get_value_int32" => Function::new_typed_with_env(store, fe, guest_napi_get_value_int32),
        "napi_get_value_uint32" => Function::new_typed_with_env(store, fe, guest_napi_get_value_uint32),
        "napi_get_value_double" => Function::new_typed_with_env(store, fe, guest_napi_get_value_double),
        "napi_get_value_int64" => Function::new_typed_with_env(store, fe, guest_napi_get_value_int64),
        "napi_get_value_bool" => Function::new_typed_with_env(store, fe, guest_napi_get_value_bool),
        "napi_get_value_bigint_int64" => Function::new_typed_with_env(store, fe, guest_napi_get_value_bigint_int64),
        "napi_get_value_bigint_uint64" => Function::new_typed_with_env(store, fe, guest_napi_get_value_bigint_uint64),
        "napi_get_date_value" => Function::new_typed_with_env(store, fe, guest_napi_get_date_value),
        "napi_get_value_external" => Function::new_typed_with_env(store, fe, guest_napi_get_value_external),
        "napi_typeof" => Function::new_typed_with_env(store, fe, guest_napi_typeof),
        "napi_is_array" => Function::new_typed_with_env(store, fe, guest_napi_is_array),
        "napi_is_error" => Function::new_typed_with_env(store, fe, guest_napi_is_error),
        "napi_is_arraybuffer" => Function::new_typed_with_env(store, fe, guest_napi_is_arraybuffer),
        "napi_is_typedarray" => Function::new_typed_with_env(store, fe, guest_napi_is_typedarray),
        "napi_is_dataview" => Function::new_typed_with_env(store, fe, guest_napi_is_dataview),
        "napi_is_date" => Function::new_typed_with_env(store, fe, guest_napi_is_date),
        "napi_is_promise" => Function::new_typed_with_env(store, fe, guest_napi_is_promise),
        "napi_instanceof" => Function::new_typed_with_env(store, fe, guest_napi_instanceof),
        "napi_coerce_to_bool" => Function::new_typed_with_env(store, fe, guest_napi_coerce_to_bool),
        "napi_coerce_to_number" => Function::new_typed_with_env(store, fe, guest_napi_coerce_to_number),
        "napi_coerce_to_string" => Function::new_typed_with_env(store, fe, guest_napi_coerce_to_string),
        "napi_coerce_to_object" => Function::new_typed_with_env(store, fe, guest_napi_coerce_to_object),
        "napi_set_property" => Function::new_typed_with_env(store, fe, guest_napi_set_property),
        "napi_get_property" => Function::new_typed_with_env(store, fe, guest_napi_get_property),
        "napi_has_property" => Function::new_typed_with_env(store, fe, guest_napi_has_property),
        "napi_has_own_property" => Function::new_typed_with_env(store, fe, guest_napi_has_own_property),
        "napi_delete_property" => Function::new_typed_with_env(store, fe, guest_napi_delete_property),
        "napi_set_named_property" => Function::new_typed_with_env(store, fe, guest_napi_set_named_property),
        "napi_get_named_property" => Function::new_typed_with_env(store, fe, guest_napi_get_named_property),
        "napi_has_named_property" => Function::new_typed_with_env(store, fe, guest_napi_has_named_property),
        "napi_set_element" => Function::new_typed_with_env(store, fe, guest_napi_set_element),
        "napi_get_element" => Function::new_typed_with_env(store, fe, guest_napi_get_element),
        "napi_has_element" => Function::new_typed_with_env(store, fe, guest_napi_has_element),
        "napi_delete_element" => Function::new_typed_with_env(store, fe, guest_napi_delete_element),
        "napi_get_array_length" => Function::new_typed_with_env(store, fe, guest_napi_get_array_length),
        "napi_get_property_names" => Function::new_typed_with_env(store, fe, guest_napi_get_property_names),
        "napi_get_all_property_names" => Function::new_typed_with_env(store, fe, guest_napi_get_all_property_names),
        "napi_get_prototype" => Function::new_typed_with_env(store, fe, guest_napi_get_prototype),
        "napi_object_freeze" => Function::new_typed_with_env(store, fe, guest_napi_object_freeze),
        "napi_object_seal" => Function::new_typed_with_env(store, fe, guest_napi_object_seal),
        "napi_strict_equals" => Function::new_typed_with_env(store, fe, guest_napi_strict_equals),
        "napi_throw" => Function::new_typed_with_env(store, fe, guest_napi_throw),
        "napi_throw_error" => Function::new_typed_with_env(store, fe, guest_napi_throw_error),
        "napi_throw_type_error" => Function::new_typed_with_env(store, fe, guest_napi_throw_type_error),
        "napi_throw_range_error" => Function::new_typed_with_env(store, fe, guest_napi_throw_range_error),
        "napi_is_exception_pending" => Function::new_typed_with_env(store, fe, guest_napi_is_exception_pending),
        "napi_get_and_clear_last_exception" => Function::new_typed_with_env(store, fe, guest_napi_get_and_clear_last_exception),
        "napi_resolve_deferred" => Function::new_typed_with_env(store, fe, guest_napi_resolve_deferred),
        "napi_reject_deferred" => Function::new_typed_with_env(store, fe, guest_napi_reject_deferred),
        "napi_get_arraybuffer_info" => Function::new_typed_with_env(store, fe, guest_napi_get_arraybuffer_info),
        "napi_detach_arraybuffer" => Function::new_typed_with_env(store, fe, guest_napi_detach_arraybuffer),
        "napi_is_detached_arraybuffer" => Function::new_typed_with_env(store, fe, guest_napi_is_detached_arraybuffer),
        "node_api_is_sharedarraybuffer" => Function::new_typed_with_env(store, fe, guest_node_api_is_sharedarraybuffer),
        "node_api_create_sharedarraybuffer" => Function::new_typed_with_env(store, fe, guest_node_api_create_sharedarraybuffer),
        "node_api_set_prototype" => Function::new_typed_with_env(store, fe, guest_node_api_set_prototype),
        "napi_get_typedarray_info" => Function::new_typed_with_env(store, fe, guest_napi_get_typedarray_info),
        "napi_get_dataview_info" => Function::new_typed_with_env(store, fe, guest_napi_get_dataview_info),
        "napi_create_reference" => Function::new_typed_with_env(store, fe, guest_napi_create_reference),
        "napi_delete_reference" => Function::new_typed_with_env(store, fe, guest_napi_delete_reference),
        "napi_reference_ref" => Function::new_typed_with_env(store, fe, guest_napi_reference_ref),
        "napi_reference_unref" => Function::new_typed_with_env(store, fe, guest_napi_reference_unref),
        "napi_get_reference_value" => Function::new_typed_with_env(store, fe, guest_napi_get_reference_value),
        "napi_open_handle_scope" => Function::new_typed_with_env(store, fe, guest_napi_open_handle_scope),
        "napi_close_handle_scope" => Function::new_typed_with_env(store, fe, guest_napi_close_handle_scope),
        "napi_open_escapable_handle_scope" => Function::new_typed_with_env(store, fe, guest_napi_open_escapable_handle_scope),
        "napi_close_escapable_handle_scope" => Function::new_typed_with_env(store, fe, guest_napi_close_escapable_handle_scope),
        "napi_escape_handle" => Function::new_typed_with_env(store, fe, guest_napi_escape_handle),
        "napi_type_tag_object" => Function::new_typed_with_env(store, fe, guest_napi_type_tag_object),
        "napi_check_object_type_tag" => Function::new_typed_with_env(store, fe, guest_napi_check_object_type_tag),
        "napi_call_function" => Function::new_typed_with_env(store, fe, guest_napi_call_function),
        "napi_create_function" => Function::new_typed_with_env(store, fe, guest_napi_create_function),
        "napi_get_cb_info" => Function::new_typed_with_env(store, fe, guest_napi_get_cb_info),
        "napi_get_new_target" => Function::new_typed_with_env(store, fe, guest_napi_get_new_target),
        "napi_run_script" => Function::new_typed_with_env(store, fe, guest_napi_run_script),
        "napi_create_string_utf16" => Function::new_typed_with_env(store, fe, guest_napi_create_string_utf16),
        "napi_get_value_string_utf16" => Function::new_typed_with_env(store, fe, guest_napi_get_value_string_utf16),
        "napi_create_bigint_words" => Function::new_typed_with_env(store, fe, guest_napi_create_bigint_words),
        "napi_get_value_bigint_words" => Function::new_typed_with_env(store, fe, guest_napi_get_value_bigint_words),
        "napi_set_instance_data" => Function::new_typed_with_env(store, fe, guest_napi_set_instance_data),
        "napi_get_instance_data" => Function::new_typed_with_env(store, fe, guest_napi_get_instance_data),
        "napi_adjust_external_memory" => Function::new_typed_with_env(store, fe, guest_napi_adjust_external_memory),
        "napi_create_buffer" => Function::new_typed_with_env(store, fe, guest_napi_create_buffer),
        "napi_create_buffer_copy" => Function::new_typed_with_env(store, fe, guest_napi_create_buffer_copy),
        "napi_is_buffer" => Function::new_typed_with_env(store, fe, guest_napi_is_buffer),
        "napi_get_buffer_info" => Function::new_typed_with_env(store, fe, guest_napi_get_buffer_info),
        "napi_get_node_version" => Function::new_typed_with_env(store, fe, guest_napi_get_node_version),
        "napi_wrap" => Function::new_typed_with_env(store, fe, guest_napi_wrap),
        "napi_unwrap" => Function::new_typed_with_env(store, fe, guest_napi_unwrap),
        "napi_remove_wrap" => Function::new_typed_with_env(store, fe, guest_napi_remove_wrap),
        "napi_add_finalizer" => Function::new_typed_with_env(store, fe, guest_napi_add_finalizer),
        "napi_new_instance" => Function::new_typed_with_env(store, fe, guest_napi_new_instance),
        "napi_define_properties" => Function::new_typed_with_env(store, fe, guest_napi_define_properties),
        "napi_define_class" => Function::new_typed_with_env(store, fe, guest_napi_define_class),
        "napi_fatal_error" => Function::new_typed_with_env(store, fe, guest_napi_fatal_error),
        "napi_get_last_error_info" => Function::new_typed_with_env(store, fe, guest_napi_get_last_error_info),
        "napi_get_version" => Function::new_typed_with_env(store, fe, guest_napi_get_version),
        "napi_add_env_cleanup_hook" => Function::new_typed_with_env(store, fe, guest_napi_add_env_cleanup_hook),
        "napi_remove_env_cleanup_hook" => Function::new_typed_with_env(store, fe, guest_napi_remove_env_cleanup_hook),
    };

    let napi_extension_wasmer_namespace = namespace! {
        "unofficial_napi_configure_runtime" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_configure_runtime),
        "unofficial_napi_create_env" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_create_env),
        "unofficial_napi_attach_env" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_attach_env),
        "unofficial_napi_release_env" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_release_env),
        "unofficial_napi_collect_garbage" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_collect_garbage),
        "unofficial_napi_event_loop_checkpoint" => event_loop_checkpoint_import(store, fe),
        "unofficial_napi_create_uninitialized_arraybuffer" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_create_uninitialized_arraybuffer),
        "unofficial_napi_acquire_buffer_lease" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_acquire_buffer_lease),
        "unofficial_napi_release_buffer_lease" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_release_buffer_lease),
        "unofficial_napi_create_guest_backed_typedarray" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_create_guest_backed_typedarray),
        "unofficial_napi_set_prepare_stack_trace_callback" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_set_prepare_stack_trace_callback),
        "unofficial_napi_get_promise_details" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_get_promise_details),
        "unofficial_napi_get_proxy_details" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_get_proxy_details),
        "unofficial_napi_preview_entries" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_preview_entries),
        "unofficial_napi_get_call_sites" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_get_call_sites),
        "unofficial_napi_arraybuffer_view_has_buffer" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_arraybuffer_view_has_buffer),
        "unofficial_napi_get_constructor_name" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_get_constructor_name),
        "unofficial_napi_create_private_symbol" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_create_private_symbol),
        "unofficial_napi_get_continuation_preserved_embedder_data" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_get_continuation_preserved_embedder_data),
        "unofficial_napi_set_continuation_preserved_embedder_data" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_set_continuation_preserved_embedder_data),
        "unofficial_napi_notify_datetime_configuration_change" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_notify_datetime_configuration_change),
        "unofficial_napi_terminate_execution" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_terminate_execution),
        "unofficial_napi_cancel_terminate_execution" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_cancel_terminate_execution),
        "unofficial_napi_request_interrupt" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_request_interrupt),
        "unofficial_napi_structured_clone" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_structured_clone),
        "unofficial_napi_message_create" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_message_create),
        "unofficial_napi_message_take" => message_take_import(store, fe),
        "unofficial_napi_message_drop" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_message_drop),
        "unofficial_napi_enqueue_microtask" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_enqueue_microtask),
        "unofficial_napi_set_promise_reject_callback" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_set_promise_reject_callback),
        "unofficial_napi_get_own_non_index_properties" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_get_own_non_index_properties),
        "unofficial_napi_set_promise_hooks" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_set_promise_hooks),
        "unofficial_napi_get_hash_seed" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_get_hash_seed),
        "unofficial_napi_get_error_metadata" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_get_error_metadata),
        "unofficial_napi_configure_source_maps" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_configure_source_maps),
        "unofficial_napi_preserve_error_source_message" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_preserve_error_source_message),
        "unofficial_napi_mark_promise_as_handled" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_mark_promise_as_handled),
        "unofficial_napi_get_heap_statistics" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_get_heap_statistics),
        "unofficial_napi_get_heap_space_statistics" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_get_heap_space_statistics),
        "unofficial_napi_get_heap_code_statistics" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_get_heap_code_statistics),
        "unofficial_napi_configure_near_heap_limit_callback" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_configure_near_heap_limit_callback),
        "unofficial_napi_profile_start" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_profile_start),
        "unofficial_napi_profile_stop" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_profile_stop),
        "unofficial_napi_take_heap_snapshot" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_take_heap_snapshot),
        "unofficial_napi_create_serdes_binding" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_create_serdes_binding),
        "unofficial_napi_contextify_contains_module_syntax" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_contextify_contains_module_syntax),
        "unofficial_napi_contextify_make_context" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_contextify_make_context),
        "unofficial_napi_contextify_run_script" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_contextify_run_script),
        "unofficial_napi_contextify_compile_function" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_contextify_compile_function),
        "unofficial_napi_bytecode_open" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_bytecode_open),
        "unofficial_napi_bytecode_serialize" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_bytecode_serialize),
        "unofficial_napi_bytecode_release" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_bytecode_release),
        "unofficial_napi_module_wrap_create" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_module_wrap_create),
        "unofficial_napi_module_wrap_destroy" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_module_wrap_destroy),
        "unofficial_napi_module_wrap_link" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_module_wrap_link),
        "unofficial_napi_module_wrap_instantiate" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_module_wrap_instantiate),
        "unofficial_napi_module_wrap_evaluate" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_module_wrap_evaluate),
        "unofficial_napi_module_wrap_evaluate_sync" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_module_wrap_evaluate_sync),
        "unofficial_napi_module_wrap_get_namespace" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_module_wrap_get_namespace),
        "unofficial_napi_module_wrap_get_state" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_module_wrap_get_state),
        "unofficial_napi_module_wrap_check_unsettled_top_level_await" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_module_wrap_check_unsettled_top_level_await),
        "unofficial_napi_module_wrap_set_export" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_module_wrap_set_export),
        "unofficial_napi_module_wrap_set_module_source_object" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_module_wrap_set_module_source_object),
        "unofficial_napi_module_wrap_get_module_source_object" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_module_wrap_get_module_source_object),
        "unofficial_napi_module_wrap_create_cached_data" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_module_wrap_create_cached_data),
        "unofficial_napi_module_wrap_set_hooks" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_module_wrap_set_hooks),
        "unofficial_napi_module_wrap_create_required_module_facade" => Function::new_typed_with_env(store, fe, guest_unofficial_napi_module_wrap_create_required_module_facade),
    };

    io.register_namespace(NAPI_MODULE_NAME, napi_namespace);
    io.register_namespace(
        NAPI_EXTENSION_WASMER_MODULE_NAME,
        napi_extension_wasmer_namespace,
    );
}

fn guest_env_uv_cpu_info(_cpu_infos_out: i32, _count_out: i32) -> i32 {
    -1
}

fn guest_env_uv_interface_addresses(_addresses_out: i32, _count_out: i32) -> i32 {
    -1
}

fn guest_env_uv_free_interface_addresses(_addresses: i32, _count: i32) {}

fn guest_env_uv_resident_set_memory(_rss_out: i32) -> i32 {
    -1
}

fn guest_env_uv_get_free_memory() -> i64 {
    0
}

fn guest_env_uv_get_total_memory() -> i64 {
    0
}

fn guest_env_ossl_set_max_threads(_ctx: i32, _max_threads: i64) -> i32 {
    // The Wasm-hosted runtime executes on a single host thread, so there is no
    // native OpenSSL worker-pool sizing to apply here.
    1
}

pub fn register_env_imports(store: &mut impl AsStoreMut, io: &mut Imports) {
    macro_rules! reg_env {
        ($name:expr, $func:expr) => {
            io.define("env", $name, Function::new_typed(store, $func));
        };
    }

    reg_env!("uv_cpu_info", guest_env_uv_cpu_info);
    reg_env!("uv_interface_addresses", guest_env_uv_interface_addresses);
    reg_env!(
        "uv_free_interface_addresses",
        guest_env_uv_free_interface_addresses
    );
    reg_env!("uv_resident_set_memory", guest_env_uv_resident_set_memory);
    reg_env!("uv_get_free_memory", guest_env_uv_get_free_memory);
    reg_env!("uv_get_total_memory", guest_env_uv_get_total_memory);
    reg_env!(
        "_Z20OSSL_set_max_threadsP15ossl_lib_ctx_sty",
        guest_env_ossl_set_max_threads
    );
}
