use super::*;
use crate::syscalls::*;

/// ### `sock_addr_peer()`
/// Returns the remote address to which the socket is connected to.
///
/// Note: This is similar to `getpeername` in POSIX
///
/// When successful, the contents of the output buffer consist of an IP address,
/// either IP4 or IP6.
///
/// ## Parameters
///
/// * `fd` - Socket that the address is bound to
#[instrument(level = "trace", skip_all, fields(%sock, addr = field::Empty), ret)]
pub fn sock_addr_peer<M: MemorySize>(
    mut ctx: FunctionEnvMut<'_, WasiEnv>,
    sock: WasiFd,
    ro_addr: WasmPtr<__wasi_addr_port_t, M>,
) -> Errno {
    // iwci patch: an AF_UNIX socket answers with the path it connected to,
    // or unnamed (net/unix.rs); unconnected, it fails as any socket does.
    let unix = wasi_try!(__sock_actor(&mut ctx, sock, Rights::empty(), |socket, _| Ok(
        socket.unix()
    )));
    let addr = wasi_try!(__sock_actor(
        &mut ctx,
        sock,
        Rights::empty(),
        |socket, _| socket.addr_peer()
    ));
    if let Some(name) = unix {
        let memory = unsafe { ctx.data().memory_view(&ctx) };
        let path = name.peer.unwrap_or_default();
        wasi_try!(crate::net::unix::write_unix_addr(&memory, ro_addr, &path));
        return Errno::Success;
    }
    Span::current().record("addr", format!("{addr:?}"));

    let env = ctx.data();
    let memory = unsafe { env.memory_view(&ctx) };
    wasi_try!(crate::net::write_ip_port(
        &memory,
        ro_addr,
        addr.ip(),
        addr.port()
    ));
    Errno::Success
}
