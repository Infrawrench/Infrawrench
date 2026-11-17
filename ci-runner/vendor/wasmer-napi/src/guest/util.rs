// ============================================================
// Guest memory helpers
// ============================================================

use wasmer::{AsStoreMut, FunctionEnvMut};

use crate::NapiEnv;

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
    // A guest cannot legitimately reference more bytes than its own linear
    // memory holds, so reject a length that exceeds it before allocating. This
    // bounds the host copy to memory the guest was already charged for and
    // stops a bogus guest-supplied length from allocating gigabytes here (the
    // subsequent bounds-checked read would fail, but only after the `vec!`).
    if len as u64 > view.data_size() {
        return None;
    }
    let mut out = vec![0u8; len];
    view.read(guest_ptr as u64, &mut out).ok()?;
    Some(out)
}

/// Live size of the guest's linear memory in bytes, or 0 if it has none. Used
/// to bound host allocations sized by a guest-supplied length: a guest can
/// never reference more than its own memory holds.
pub fn guest_data_size(env: &mut FunctionEnvMut<NapiEnv>) -> u64 {
    let Some(memory) = env.data().memory.clone() else {
        return 0;
    };
    let (_, store) = env.data_and_store_mut();
    memory.view(&store).data_size()
}

/// Allocate `len` bytes of guest memory, passing the import's store directly so
/// the heap can claim more from the guest when its arena is short.
///
/// V8 allocator hooks can recover a store only inside an explicitly guarded
/// reentrant bridge; ordinary imports already have the store and should not
/// publish and rediscover it through runtime TLS.
pub fn alloc_guest(
    env: &mut FunctionEnvMut<NapiEnv>,
    heap: &crate::guest_heap::GuestHeap,
    len: usize,
    zero: bool,
) -> Option<u32> {
    let mut store = env.as_store_mut();
    heap.alloc_with_store(&mut store, len, zero)
}

pub fn allocate_guest_bytes(env: &mut FunctionEnvMut<NapiEnv>, data: &[u8]) -> Option<u32> {
    let heap = env.data().guest_heap.clone()?;
    let guest_ptr = alloc_guest(env, &heap, data.len(), false)?;
    if !write_guest_bytes(env, guest_ptr, data) {
        heap.free_offset(guest_ptr);
        return None;
    }
    Some(guest_ptr)
}

pub fn host_ptr_to_guest_ptr(env: &mut FunctionEnvMut<NapiEnv>, host_addr: u64) -> Option<u32> {
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

pub fn read_guest_u32_array(
    env: &mut FunctionEnvMut<NapiEnv>,
    guest_ptr: i32,
    count: usize,
) -> Option<Vec<u32>> {
    // Guard the byte-length multiply against overflow; the read below is then
    // clamped to the guest's memory size by `read_guest_bytes`.
    let byte_len = count.checked_mul(4)?;
    let bytes = read_guest_bytes(env, guest_ptr, byte_len)?;
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
    scan_c_string(view.data_size(), guest_ptr as u64, |offset, buf| {
        view.read(offset, buf).is_ok()
    })
}

/// iwci patch (#996): the bytes of the NUL-terminated string at `start` in a
/// memory of `size` bytes, read a chunk at a time with `read`, where they
/// were read a byte (and a bounds-checked read, and a push) at a time. Every
/// N-API call that names a property or a function passes one. `None` for a
/// string that runs past the end of memory or past
/// `MAX_GUEST_CSTRING_SCAN` bytes, as before.
fn scan_c_string(
    size: u64,
    start: u64,
    mut read: impl FnMut(u64, &mut [u8]) -> bool,
) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    let mut chunk = [0u8; 256];
    while out.len() < super::MAX_GUEST_CSTRING_SCAN {
        let offset = start + out.len() as u64;
        if offset >= size {
            return None;
        }
        let want = (size - offset)
            .min(chunk.len() as u64)
            .min((super::MAX_GUEST_CSTRING_SCAN - out.len()) as u64) as usize;
        if !read(offset, &mut chunk[..want]) {
            return None;
        }
        if let Some(end) = chunk[..want].iter().position(|&b| b == 0) {
            out.extend_from_slice(&chunk[..end]);
            return Some(out);
        }
        out.extend_from_slice(&chunk[..want]);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::scan_c_string;
    use super::super::MAX_GUEST_CSTRING_SCAN;

    /// What the byte-at-a-time loop returned.
    fn bytewise(memory: &[u8], start: u64) -> Option<Vec<u8>> {
        let mut out = Vec::new();
        let mut offset = start;
        for _ in 0..MAX_GUEST_CSTRING_SCAN {
            let b = *memory.get(usize::try_from(offset).ok()?)?;
            if b == 0 {
                return Some(out);
            }
            out.push(b);
            offset += 1;
        }
        None
    }

    fn chunked(memory: &[u8], start: u64) -> Option<Vec<u8>> {
        scan_c_string(memory.len() as u64, start, |offset, buf| {
            let at = offset as usize;
            match memory.get(at..at + buf.len()) {
                Some(src) => {
                    buf.copy_from_slice(src);
                    true
                }
                None => false,
            }
        })
    }

    #[test]
    fn a_c_string_reads_the_same_a_chunk_at_a_time() {
        let mut memory = vec![b'x'; 3 * MAX_GUEST_CSTRING_SCAN];
        // From 1001, the next terminator is past the limit.
        for at in [0, 1, 255, 256, 257, 1000, 70_000, 135_000] {
            memory[at] = 0;
        }
        let starts = [
            0,
            1,
            2,
            200,
            255,
            256,
            258,
            999,
            1001,
            1001 + MAX_GUEST_CSTRING_SCAN as u64 - 1,
            70_001,
            135_001,
            memory.len() as u64 - 10,
            memory.len() as u64 - 1,
            memory.len() as u64,
            memory.len() as u64 + 5,
        ];
        for start in starts {
            assert_eq!(chunked(&memory, start), bytewise(&memory, start), "from {start}");
        }
        // Terminated exactly at the limit, and one byte past it.
        let mut memory = vec![b'y'; MAX_GUEST_CSTRING_SCAN + 1];
        memory[MAX_GUEST_CSTRING_SCAN - 1] = 0;
        assert_eq!(chunked(&memory, 0).map(|s| s.len()), Some(MAX_GUEST_CSTRING_SCAN - 1));
        let mut memory = vec![b'y'; MAX_GUEST_CSTRING_SCAN + 1];
        memory[MAX_GUEST_CSTRING_SCAN] = 0;
        assert_eq!(chunked(&memory, 0), None);
        assert_eq!(bytewise(&memory, 0), None);
        // A read that fails is no string.
        assert_eq!(scan_c_string(10, 0, |_, _| false), None);
    }
}
