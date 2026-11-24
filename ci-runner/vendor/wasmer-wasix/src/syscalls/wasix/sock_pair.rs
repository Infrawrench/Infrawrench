use virtual_fs::Pipe;
use wasmer::FromToNativeWasmType;

use super::*;
use crate::{
    net::socket::{self, SocketProperties},
    syscalls::*,
};

/// `SOCK_NONBLOCK`, as wasix-libc's `<sys/socket.h>` defines it.
const SOCK_NONBLOCK: i32 = 0x4000;
/// `SOCK_CLOEXEC`, as wasix-libc's `<sys/socket.h>` defines it.
///
/// wasix-libc before v2026-10-02.1 (wasix-org/wasix-libc#143) passes the
/// type `socketpair` is given straight through, these bits included, and
/// applies neither: libuv's `socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC,
/// ...)` read as an unknown type and made a pair any child inherited, so a
/// Node child held every earlier child's stdio pipes open (#1377). Later
/// releases clear the bits and set the flags themselves, which this leaves
/// as they were.
const SOCK_CLOEXEC: i32 = 0x2000;

// FIXME
/// ### `sock_pair()`
/// Create an interconnected socket pair; or at least it's supposed to.
///
/// Currently, this creates a pipe rather than a pair of sockets. Before this
/// syscall was added, wasix-libc would just do pipe2 in its socketpair
/// implementation. Since we fixed pipe2 to return a simplex pipe, that was no
/// longer an option; hence this syscall was added, but the implementation
/// still uses a pipe as the underlying communication mechanism. This is not
/// the correct implementation and needs to be fixed. We hope that the pipe
/// is sufficient for anything that doesn't do socket-specific stuff, such
/// as sending out-of-band packets.
///
/// Note: This is (supposed to be) similar to `socketpair` in POSIX using PF_INET
///
/// Note 2: This requires hacks in `sock_send` and `sock_recv` as well.
///
/// ## Parameters
///
/// * `af` - Address family
/// * `socktype` - Socket type, either datagram or stream, possibly with
///   `SOCK_NONBLOCK` and `SOCK_CLOEXEC` set (see [`SOCK_CLOEXEC`])
/// * `sock_proto` - Socket protocol
///
/// ## Return
///
/// The file descriptor of the socket that has been opened.
#[instrument(level = "trace", skip_all, fields(?af, ?ty, ?pt, sock1 = field::Empty, sock2 = field::Empty), ret)]
pub fn sock_pair<M: MemorySize>(
    mut ctx: FunctionEnvMut<'_, WasiEnv>,
    af: Addressfamily,
    ty: i32,
    pt: SockProto,
    ro_sock1: WasmPtr<WasiFd, M>,
    ro_sock2: WasmPtr<WasiFd, M>,
) -> Result<Errno, WasiError> {
    WasiEnv::do_pending_operations(&mut ctx)?;

    let fs_flags = if ty & SOCK_NONBLOCK != 0 {
        Fdflags::NONBLOCK
    } else {
        Fdflags::empty()
    };
    let fd_flags = if ty & SOCK_CLOEXEC != 0 {
        Fdflagsext::CLOEXEC
    } else {
        Fdflagsext::empty()
    };
    let ty = Socktype::from_native(ty & !(SOCK_NONBLOCK | SOCK_CLOEXEC));

    // only certain combinations are supported
    match pt {
        SockProto::Tcp if ty != Socktype::Stream => {
            return Ok(Errno::Notsup);
        }
        SockProto::Udp if ty != Socktype::Dgram => {
            return Ok(Errno::Notsup);
        }
        _ => {}
    }

    // FIXME: currently, socket properties are ignored outright, since they
    // make no sense for the underlying pipe
    let (fd1, fd2) = wasi_try_ok!(sock_pair_internal(
        &mut ctx, None, None, fs_flags, fd_flags
    ));

    #[cfg(feature = "journal")]
    if ctx.data().enable_journal {
        JournalEffector::save_sock_pair(&mut ctx, fd1, fd2).map_err(|err| {
            tracing::error!("failed to save sock_pair event - {}", err);
            WasiError::Exit(ExitCode::from(Errno::Fault))
        })?;
        // The journal's entry has no flags, so they follow as the calls a
        // C library that applies them itself makes.
        for fd in [fd1, fd2] {
            if !fs_flags.is_empty() {
                JournalEffector::save_fd_set_flags(&mut ctx, fd, fs_flags).map_err(|err| {
                    tracing::error!("failed to save file set flags event - {}", err);
                    WasiError::Exit(ExitCode::from(Errno::Fault))
                })?;
            }
            if !fd_flags.is_empty() {
                JournalEffector::save_fd_set_fdflags(&mut ctx, fd, fd_flags).map_err(|err| {
                    tracing::error!("failed to save file set fd flags event - {}", err);
                    WasiError::Exit(ExitCode::from(Errno::Fault))
                })?;
            }
        }
    }

    let env = ctx.data();
    let (memory, state, inodes) = unsafe { env.get_memory_and_wasi_state_and_inodes(&ctx, 0) };
    wasi_try_mem_ok!(ro_sock1.write(&memory, fd1));
    wasi_try_mem_ok!(ro_sock2.write(&memory, fd2));

    Ok(Errno::Success)
}

pub(crate) fn sock_pair_internal(
    ctx: &mut FunctionEnvMut<'_, WasiEnv>,
    with_fd1: Option<WasiFd>,
    with_fd2: Option<WasiFd>,
    fs_flags: Fdflags,
    fd_flags: Fdflagsext,
) -> Result<(WasiFd, WasiFd), Errno> {
    let env = ctx.data();
    let (memory, state, inodes) = unsafe { env.get_memory_and_wasi_state_and_inodes(&ctx, 0) };
    let (end1, end2) = Pipe::channel();

    // Report a proper socket filetype: callers (e.g. libuv's uv_guess_handle)
    // fstat socketpair fds to classify them, and the default filestat's
    // Unknown filetype makes them unusable as streams.
    let stat = Filestat {
        st_filetype: Filetype::SocketStream,
        ..Filestat::default()
    };
    let inode1 = state.fs.create_inode_with_stat(
        inodes,
        Kind::DuplexPipe { pipe: end1 },
        false,
        "socketpair".into(),
        stat,
    );
    let inode2 = state.fs.create_inode_with_stat(
        inodes,
        Kind::DuplexPipe { pipe: end2 },
        false,
        "socketpair".into(),
        stat,
    );

    let rights = Rights::all_socket();
    let fd1 = if let Some(fd) = with_fd1 {
        state
            .fs
            .with_fd(
                rights,
                rights,
                fs_flags,
                fd_flags,
                0,
                inode1,
                fd,
            )
            .map(|_| fd)?
    } else {
        state.fs.create_fd(
            rights,
            rights,
            fs_flags,
            fd_flags,
            0,
            inode1,
        )?
    };
    let fd2 = if let Some(fd) = with_fd2 {
        state
            .fs
            .with_fd(
                rights,
                rights,
                fs_flags,
                fd_flags,
                0,
                inode2,
                fd,
            )
            .map(|_| fd)?
    } else {
        state.fs.create_fd(
            rights,
            rights,
            fs_flags,
            fd_flags,
            0,
            inode2,
        )?
    };
    Span::current().record("end1", fd1);
    Span::current().record("end2", fd2);

    Ok((fd1, fd2))
}
