// ============================================================
// Guest memory helpers
// ============================================================

use wasmer::FunctionEnvMut;

use crate::{
    GuestBackingStoreMapping, HostBufferCopy, NapiEnv, snapi::snapi_bridge_create_reference,
};

const JS_BACKING_TOKEN_MARKER: u64 = 1 << 63;
const JS_BACKING_TOKEN_OFFSET_MASK: u64 = u32::MAX as u64;

pub fn write_guest_bytes(env: &mut FunctionEnvMut<NapiEnv>, guest_ptr: u32, data: &[u8]) -> bool {
    let (state, store) = env.data_and_store_mut();
    let Some(memory) = state.memory.clone() else {
        return false;
    };
    let view = memory.view(&store);
    view.write(guest_ptr as u64, data).is_ok()
}

pub fn write_guest_u32(env: &mut FunctionEnvMut<NapiEnv>, guest_ptr: u32, val: u32) -> bool {
    write_guest_bytes(env, guest_ptr, &val.to_le_bytes())
}

pub fn write_guest_i32(env: &mut FunctionEnvMut<NapiEnv>, guest_ptr: u32, val: i32) -> bool {
    write_guest_bytes(env, guest_ptr, &val.to_le_bytes())
}

pub fn write_guest_u64(env: &mut FunctionEnvMut<NapiEnv>, guest_ptr: u32, val: u64) -> bool {
    write_guest_bytes(env, guest_ptr, &val.to_le_bytes())
}

pub fn write_guest_i64(env: &mut FunctionEnvMut<NapiEnv>, guest_ptr: u32, val: i64) -> bool {
    write_guest_bytes(env, guest_ptr, &val.to_le_bytes())
}

pub fn write_guest_f64(env: &mut FunctionEnvMut<NapiEnv>, guest_ptr: u32, val: f64) -> bool {
    write_guest_bytes(env, guest_ptr, &val.to_le_bytes())
}

pub fn write_guest_u8(env: &mut FunctionEnvMut<NapiEnv>, guest_ptr: u32, val: u8) -> bool {
    write_guest_bytes(env, guest_ptr, &[val])
}

pub fn read_guest_bytes(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_ptr: i32,
    len: usize,
) -> Option<Vec<u8>> {
    if guest_ptr < 0 {
        return None;
    }
    let (state, store) = env.data_and_store_mut();
    let memory = state.memory.clone()?;
    let view = memory.view(&store);
    // Reject an impossible guest range before allocating the host snapshot.
    // The bounds-checked read below is too late: `vec![0; len]` may otherwise
    // abort the host on a forged multi-gigabyte length.
    if (guest_ptr as u64).checked_add(len as u64)? > view.data_size() {
        return None;
    }
    let mut out = vec![0u8; len];
    view.read(guest_ptr as u64, &mut out).ok()?;
    Some(out)
}

pub fn guest_data_size(env: &mut FunctionEnvMut<NapiEnv>) -> u64 {
    let Some(memory) = env.data().memory.clone() else {
        return 0;
    };
    let (_, store) = env.data_and_store_mut();
    memory.view(&store).data_size()
}

pub fn allocate_guest_buffer(env: &mut FunctionEnvMut<NapiEnv>, byte_len: usize) -> Option<u32> {
    // Exact-size large transfers avoid doubling peak memory for package
    // archives and Wasm binaries while retaining cheap pooled size classes for
    // the small buffers used by ordinary Node I/O.
    let requested = byte_len.max(1);
    let required_capacity = if requested >= 16 * 1024 * 1024 {
        requested
    } else {
        requested.checked_next_power_of_two()?
    };
    let pooled = env
        .data()
        .guest_buffer_pool
        .iter()
        .enumerate()
        .filter(|(_, (_, capacity))| *capacity >= required_capacity)
        .min_by_key(|(_, (_, capacity))| *capacity)
        .map(|(index, _)| index);
    let (guest_ptr, capacity) = if let Some(index) = pooled {
        env.data_mut().guest_buffer_pool.swap_remove(index)
    } else {
        let malloc_fn = env.data().malloc_fn.clone()?;
        let allocation_len = i32::try_from(required_capacity).ok()?;
        let guest_ptr: i32 = {
            let (_, mut store_ref) = env.data_and_store_mut();
            match malloc_fn.call(&mut store_ref, allocation_len) {
                Ok(ptr) => ptr,
                Err(error) => {
                    eprintln!(
                        "[wasmer-napi] guest buffer allocation trapped: requested={required_capacity} allocated={} error={error}",
                        env.data().guest_buffer_allocated_bytes,
                    );
                    return None;
                }
            }
        };
        if guest_ptr <= 0 {
            eprintln!(
                "[wasmer-napi] guest buffer allocation failed: requested={required_capacity} allocated={} result={guest_ptr}",
                env.data().guest_buffer_allocated_bytes,
            );
            return None;
        }
        let allocated = env
            .data()
            .guest_buffer_allocated_bytes
            .saturating_add(required_capacity);
        env.data_mut().guest_buffer_allocated_bytes = allocated;
        (guest_ptr as u32, required_capacity)
    };
    env.data_mut()
        .guest_buffer_capacities
        .insert(guest_ptr, capacity);
    Some(guest_ptr)
}

pub fn allocate_guest_bytes(env: &mut FunctionEnvMut<NapiEnv>, data: &[u8]) -> Option<u32> {
    let guest_ptr = allocate_guest_buffer(env, data.len())?;
    if !data.is_empty() && !write_guest_bytes(env, guest_ptr, data) {
        recycle_guest_allocation(env, guest_ptr);
        return None;
    }
    Some(guest_ptr)
}

pub fn recycle_guest_allocation(env: &mut FunctionEnvMut<NapiEnv>, guest_ptr: u32) -> bool {
    if guest_ptr == 0 {
        return true;
    }
    let Some(capacity) = env.data_mut().guest_buffer_capacities.remove(&guest_ptr) else {
        return false;
    };
    env.data_mut().guest_buffer_pool.push((guest_ptr, capacity));
    true
}

pub fn forget_guest_allocation(env: &mut FunctionEnvMut<NapiEnv>, guest_ptr: u32) {
    env.data_mut().guest_buffer_capacities.remove(&guest_ptr);
}

pub fn host_ptr_to_guest_ptr(env: &mut FunctionEnvMut<NapiEnv>, host_addr: u64) -> Option<u32> {
    #[cfg(feature = "js")]
    {
        let _ = (env, host_addr);
        return None;
    }

    #[cfg(not(feature = "js"))]
    {
        let memory = env.data().memory.clone()?;
        let (_, store_ref) = env.data_and_store_mut();
        let view = memory.view(&store_ref);
        let host_base = view.data_ptr() as u64;
        let memory_len = view.data_size();
        if host_addr < host_base || host_addr >= host_base + memory_len {
            return None;
        }
        u32::try_from(host_addr - host_base).ok()
    }
}

pub fn resolve_guest_backing_store_mapping(
    mapping: &GuestBackingStoreMapping,
    host_addr: u64,
    byte_len: usize,
) -> Option<u32> {
    let delta = usize::try_from(host_addr.checked_sub(mapping.host_addr)?).ok()?;
    let end = delta.checked_add(byte_len)?;
    if end > mapping.byte_len {
        return None;
    }
    let guest_delta = u32::try_from(delta).ok()?;
    mapping.guest_ptr.checked_add(guest_delta)
}

pub fn resolve_guest_backing_store_token(
    env: &NapiEnv,
    guest_env: u32,
    _handle_id: u32,
    backing_store_token: u64,
    host_addr: u64,
    byte_len: usize,
) -> Option<u32> {
    if backing_store_token & JS_BACKING_TOKEN_MARKER != 0 {
        if let Some(mapping) = env
            .guest_data_backing_stores
            .get(&(guest_env, backing_store_token))
            && byte_len <= mapping.byte_len
        {
            return Some(mapping.guest_ptr);
        }
        {
            let base_token = backing_store_token & !JS_BACKING_TOKEN_OFFSET_MASK;
            let byte_offset = (backing_store_token & JS_BACKING_TOKEN_OFFSET_MASK) as usize;
            if let Some(mapping) = env.guest_data_backing_stores.get(&(guest_env, base_token)) {
                let end = byte_offset.checked_add(byte_len)?;
                if end <= mapping.byte_len {
                    return mapping
                        .guest_ptr
                        .checked_add(u32::try_from(byte_offset).ok()?);
                }
            }
        }
        return None;
    }

    resolve_guest_backing_store_mapping(
        env.guest_data_backing_stores
            .get(&(guest_env, backing_store_token))?,
        host_addr,
        byte_len,
    )
}

pub fn resolve_or_copy_host_data_to_guest(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_env: u32,
    handle_id: u32,
    backing_store_token: u64,
    host_addr: u64,
    byte_len: usize,
    covers_full_backing_store: bool,
) -> Option<u32> {
    if backing_store_token != 0
        && let Some(guest_data_ptr) = resolve_guest_backing_store_token(
            env.data(),
            guest_env,
            handle_id,
            backing_store_token,
            host_addr,
            byte_len,
        )
    {
        env.data_mut()
            .guest_data_ptrs
            .insert((guest_env, handle_id), guest_data_ptr);
        return Some(guest_data_ptr);
    }
    if let Some(&guest_data_ptr) = env.data().guest_data_ptrs.get(&(guest_env, handle_id)) {
        return Some(guest_data_ptr);
    }
    if host_addr == 0 {
        return Some(0);
    }
    if let Some(guest_ptr) = host_ptr_to_guest_ptr(env, host_addr) {
        return Some(guest_ptr);
    }
    if byte_len == 0 {
        return Some(0);
    }
    let host_slice = unsafe { std::slice::from_raw_parts(host_addr as *const u8, byte_len) };
    let guest_ptr = allocate_guest_bytes(env, host_slice)?;
    let snapi_env = env.data().resolve_napi_env(guest_env as i32);
    if snapi_env.is_null() {
        forget_guest_allocation(env, guest_ptr);
        return None;
    }
    let mut host_reference_id = 0u32;
    if unsafe { snapi_bridge_create_reference(snapi_env, handle_id, 1, &mut host_reference_id) }
        != 0
    {
        forget_guest_allocation(env, guest_ptr);
        return None;
    }
    if backing_store_token != 0 {
        env.data_mut().guest_data_backing_stores.insert(
            (guest_env, backing_store_token),
            GuestBackingStoreMapping {
                host_addr,
                guest_ptr,
                byte_len,
                covers_full_backing_store,
            },
        );
    }
    env.data_mut()
        .guest_data_ptrs
        .insert((guest_env, handle_id), guest_ptr);
    let owner_id = env.data().current_host_buffer_owner();
    env.data_mut().host_buffer_copies.push(HostBufferCopy {
        owner_id,
        guest_env,
        handle_id,
        host_reference_id,
        backing_store_token,
        guest_ptr,
        byte_len,
        guest_allocation_recyclable: true,
        persistent: false,
        reference_holds: 0,
        // Standard N-API pointers are writable. Synchronization is phase based:
        // publish before host JS runs, refresh before native code resumes.
        needs_flush: true,
    });
    Some(guest_ptr)
}

pub fn read_guest_u32_array(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_ptr: i32,
    count: usize,
) -> Option<Vec<u32>> {
    let bytes = read_guest_bytes(env, guest_ptr, count.checked_mul(4)?)?;
    let mut result = Vec::with_capacity(count);
    for chunk in bytes.chunks_exact(4) {
        result.push(u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    Some(result)
}

pub fn read_guest_c_string(env: &mut FunctionEnvMut<NapiEnv>, guest_ptr: i32) -> Option<Vec<u8>> {
    if guest_ptr < 0 {
        return None;
    }
    let (state, store) = env.data_and_store_mut();
    let memory = state.memory.clone()?;
    let view = memory.view(&store);
    let mut out = Vec::new();
    let mut offset = guest_ptr as u64;
    for _ in 0..super::MAX_GUEST_CSTRING_SCAN {
        let mut b = [0u8; 1];
        view.read(offset, &mut b).ok()?;
        if b[0] == 0 {
            return Some(out);
        }
        out.push(b[0]);
        offset += 1;
    }
    None
}
