use super::*;
use crate::syscalls::*;

/// ### `getcwd()`
/// Returns the current working directory
/// If the path exceeds the size of the buffer then this function
/// will return ERANGE
#[instrument(level = "trace", skip_all, fields(path = field::Empty, max_path_len = field::Empty), ret)]
pub fn getcwd<M: MemorySize>(
    ctx: FunctionEnvMut<'_, WasiEnv>,
    path: WasmPtr<u8, M>,
    path_len: WasmPtr<M::Offset, M>,
) -> Errno {
    let env = ctx.data();
    let (memory, mut state, inodes) = unsafe { env.get_memory_and_wasi_state_and_inodes(&ctx, 0) };

    let max_path_len64: u64 = wasi_try_mem!(path_len.read(&memory)).into();
    Span::current().record("max_path_len", max_path_len64);

    let (_, cur_dir) = wasi_try!(state.fs.get_current_dir(inodes, crate::VIRTUAL_ROOT_FD));
    Span::current().record("path", cur_dir.as_str());

    let cur_dir_len = cur_dir.len();
    // iwci patch: the path needs room for its terminating NUL, as POSIX's
    // `getcwd` does (ERANGE unless `size` exceeds the length), and a buffer
    // too small is told the size that holds both. wasix-libc's
    // `getcwd(NULL, 0)` asks for the size and allocates exactly what it is
    // told; told the length, it got a buffer the path filled to its last
    // byte, written without a NUL, so the string ran on into the
    // allocator's padding. A path whose length is 12 mod 16 met the next
    // chunk's header there: bash, whose `$PWD` comes from it, said
    // `/app/packages/provider-utils3`, and a command it ran by a relative
    // path was not found (`pnpm -r exec` in vercel/ai).
    if cur_dir_len as u64 >= max_path_len64 {
        wasi_try_mem!(path_len.write(&memory, wasi_try!(to_offset::<M>(cur_dir_len + 1))));
        return Errno::Range;
    }
    wasi_try_mem!(path_len.write(&memory, wasi_try!(to_offset::<M>(cur_dir_len))));

    if path.is_null() {
        return Errno::Inval;
    }

    let path_slice = wasi_try_mem!(path.slice(&memory, wasi_try!(to_offset::<M>(cur_dir_len))));
    wasi_try_mem!(path_slice.write_slice(cur_dir.as_bytes()));
    let path_nul = wasi_try_mem!(path.add_offset(wasi_try!(to_offset::<M>(cur_dir_len))));
    wasi_try_mem!(path_nul.write(&memory, 0));
    Errno::Success
}
