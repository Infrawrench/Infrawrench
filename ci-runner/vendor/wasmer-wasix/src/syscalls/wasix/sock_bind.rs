use super::*;
use crate::syscalls::*;

/// ### `sock_bind()`
/// Bind a socket
/// Note: This is similar to `bind` in POSIX using PF_INET
///
/// ## Parameters
///
/// * `fd` - File descriptor of the socket to be bind
/// * `addr` - Address to bind the socket to
#[instrument(level = "trace", skip_all, fields(%sock, addr = field::Empty), ret)]
pub fn sock_bind<M: MemorySize>(
    mut ctx: FunctionEnvMut<'_, WasiEnv>,
    sock: WasiFd,
    addr: WasmPtr<__wasi_addr_port_t, M>,
) -> Result<Errno, WasiError> {
    WasiEnv::do_pending_operations(&mut ctx)?;

    // iwci patch: whether this is an AF_UNIX socket (net/unix.rs).
    let unix = wasi_try_ok!(__sock_actor(&mut ctx, sock, Rights::empty(), |socket, _| Ok(
        socket.unix()
    )));

    let env = ctx.data();
    let memory = unsafe { env.memory_view(&ctx) };

    // iwci patch: a path, for an AF_UNIX socket (net/unix.rs).
    let addr = match wasi_try_ok!(crate::net::unix::read_sock_addr(&memory, addr)) {
        crate::net::unix::SockAddr::Ip(_) if unix.is_some() => return Ok(Errno::Inval),
        crate::net::unix::SockAddr::Ip(addr) => addr,
        crate::net::unix::SockAddr::Unix(_) if unix.is_none() => return Ok(Errno::Inval),
        crate::net::unix::SockAddr::Unix(path) => {
            Span::current().record("addr", path.as_str());
            return sock_bind_unix(&mut ctx, sock, path);
        }
    };
    Span::current().record("addr", format!("{addr:?}"));

    wasi_try_ok!(sock_bind_internal(&mut ctx, sock, addr)?);

    #[cfg(feature = "journal")]
    if ctx.data().enable_journal {
        let effective_addr = match __sock_actor(&mut ctx, sock, Rights::empty(), |socket, _| {
            socket.addr_local()
        }) {
            Ok(effective_addr) => effective_addr,
            Err(err) => {
                tracing::warn!(
                    "failed to determine effective local socket address for journaling; \
                     falling back to requested bind address {:?}: {}",
                    addr,
                    err
                );
                addr
            }
        };
        JournalEffector::save_sock_bind(&mut ctx, sock, effective_addr).map_err(|err| {
            tracing::error!("failed to save sock_bind event - {}", err);
            WasiError::Exit(ExitCode::from(Errno::Fault))
        })?;
    }

    Ok(Errno::Success)
}

/// iwci patch: binds an AF_UNIX socket to `path`: its file first (which
/// must not exist), then a port on the job's loopback, which the file names.
fn sock_bind_unix(
    ctx: &mut FunctionEnvMut<'_, WasiEnv>,
    sock: WasiFd,
    path: String,
) -> Result<Errno, WasiError> {
    let file = {
        let state = ctx.data().state.clone();
        wasi_try_ok!(crate::net::unix::create(&state, &path))
    };
    let bound = sock_bind_internal(ctx, sock, crate::net::unix::loopback(0))?.and_then(|()| {
        __sock_actor(ctx, sock, Rights::empty(), |socket, _| {
            let port = socket.addr_local()?.port();
            socket.set_unix(Some(crate::net::unix::UnixName {
                local: Some(path.clone()),
                peer: None,
            }));
            Ok(port)
        })
    });
    let published = bound.and_then(|port| crate::net::unix::publish(file, port));
    if let Err(err) = published {
        crate::net::unix::remove(&ctx.data().state, &path);
        return Ok(err);
    }
    Ok(Errno::Success)
}

pub(crate) fn sock_bind_internal(
    ctx: &mut FunctionEnvMut<'_, WasiEnv>,
    sock: WasiFd,
    addr: SocketAddr,
) -> Result<Result<(), Errno>, WasiError> {
    let env = ctx.data();
    let net = env.net().clone();

    let tasks = ctx.data().tasks().clone();
    wasi_try_ok_ok!(__sock_upgrade(
        ctx,
        sock,
        Rights::SOCK_BIND,
        move |socket, _| async move { socket.bind(tasks.deref(), net.deref(), addr).await }
    ));

    Ok(Ok(()))
}
