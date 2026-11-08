//! Each job's network: a private loopback and nothing else.
//!
//! Test suites start servers on `127.0.0.1` and connect to them, so a job
//! needs a loopback. It must not be the host's: a job must not reach
//! anything listening on the runner's own localhost, and a port a job
//! listens on must not appear on the host. So the loopback is in memory,
//! one per job, shared by every process of that job (a script's
//! `server & curl localhost:8080` works) and invisible to every other job.
//! No host socket is ever opened.
//!
//! It wraps wasmer's `LoopbackNetworking`, which is in memory but not
//! usable alone: it has no `connect_tcp` (the path a plain `connect()`
//! takes), it accepts a listener on any address, and a connect to an
//! address with no listener is handed to whichever listener exists, so a
//! closed port or `8.8.8.8:53` would reach some other server of the job.
//! Here a listener may only be on a loopback address (or the unspecified
//! one, which means the loopback), and a connection only goes to a loopback
//! address something in the job is listening on. Anything else is refused,
//! exactly as an unreachable network or a closed port would be. `localhost`
//! resolves to the loopback; there is no DNS, so every other name fails.
//! UDP is not offered.

use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use wasmer_wasix::virtual_net::{
    InterestHandler, IpCidr, LoopbackNetworking, NetworkError, VirtualIoSource, VirtualNetworking,
    VirtualTcpBoundSocket, VirtualTcpListener, VirtualTcpSocket,
};

type Result<T> = std::result::Result<T, NetworkError>;

#[derive(Debug, Clone, Default)]
pub(crate) struct JobNetwork {
    inner: LoopbackNetworking,
    /// Addresses something in the job is listening on, normalised.
    listening: Arc<Mutex<HashSet<SocketAddr>>>,
}

impl JobNetwork {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    fn register(
        &self,
        listener: Box<dyn VirtualTcpListener + Sync>,
    ) -> Result<Box<dyn VirtualTcpListener + Sync>> {
        let addr = normalise(listener.addr_local()?);
        self.listening.lock().expect("listener set").insert(addr);
        Ok(Box::new(Listener {
            inner: listener,
            addr,
            listening: self.listening.clone(),
        }))
    }

    fn check_peer(&self, peer: SocketAddr) -> Result<()> {
        if !peer.ip().is_loopback() {
            return Err(NetworkError::NetworkUnreachable);
        }
        if !self
            .listening
            .lock()
            .expect("listener set")
            .contains(&normalise(peer))
        {
            return Err(NetworkError::ConnectionRefused);
        }
        Ok(())
    }
}

/// The unspecified address means the loopback here, as the inner loopback
/// treats it.
fn normalise(addr: SocketAddr) -> SocketAddr {
    match addr.ip() {
        IpAddr::V4(ip) if ip.is_unspecified() => {
            SocketAddr::new(Ipv4Addr::LOCALHOST.into(), addr.port())
        }
        IpAddr::V6(ip) if ip.is_unspecified() => {
            SocketAddr::new(Ipv6Addr::LOCALHOST.into(), addr.port())
        }
        _ => addr,
    }
}

fn bindable(ip: IpAddr) -> bool {
    ip.is_loopback() || ip.is_unspecified()
}

#[async_trait::async_trait]
impl VirtualNetworking for JobNetwork {
    async fn dhcp_acquire(&self) -> Result<Vec<IpAddr>> {
        self.inner.dhcp_acquire().await
    }

    async fn ip_list(&self) -> Result<Vec<IpCidr>> {
        self.inner.ip_list().await
    }

    async fn listen_tcp(
        &self,
        addr: SocketAddr,
        only_v6: bool,
        reuse_port: bool,
        reuse_addr: bool,
    ) -> Result<Box<dyn VirtualTcpListener + Sync>> {
        if !bindable(addr.ip()) {
            return Err(NetworkError::AddressNotAvailable);
        }
        let listener = self
            .inner
            .listen_tcp(addr, only_v6, reuse_port, reuse_addr)
            .await?;
        self.register(listener)
    }

    async fn bind_tcp(
        &self,
        addr: SocketAddr,
        only_v6: bool,
        reuse_port: bool,
        reuse_addr: bool,
    ) -> Result<Box<dyn VirtualTcpBoundSocket + Sync>> {
        if !bindable(addr.ip()) {
            return Err(NetworkError::AddressNotAvailable);
        }
        let inner = self
            .inner
            .bind_tcp(addr, only_v6, reuse_port, reuse_addr)
            .await?;
        Ok(Box::new(Bound {
            inner,
            network: self.clone(),
        }))
    }

    async fn connect_tcp(
        &self,
        addr: SocketAddr,
        peer: SocketAddr,
    ) -> Result<Box<dyn VirtualTcpSocket + Sync>> {
        self.check_peer(peer)?;
        // A connect without an explicit bind gets an ephemeral port on the
        // loopback of the peer's family.
        let local = if bindable(addr.ip()) && addr.is_ipv4() == peer.is_ipv4() {
            addr
        } else if peer.is_ipv4() {
            SocketAddr::new(Ipv4Addr::LOCALHOST.into(), 0)
        } else {
            SocketAddr::new(Ipv6Addr::LOCALHOST.into(), 0)
        };
        let mut bound = self.bind_tcp(local, false, false, false).await?;
        bound.connect(peer)
    }

    async fn resolve(
        &self,
        host: &str,
        _port: Option<u16>,
        _dns_server: Option<IpAddr>,
    ) -> Result<Vec<IpAddr>> {
        let host = host.trim_end_matches('.');
        if host.eq_ignore_ascii_case("localhost") {
            return Ok(vec![Ipv4Addr::LOCALHOST.into(), Ipv6Addr::LOCALHOST.into()]);
        }
        match host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
        {
            Ok(ip) if ip.is_loopback() => Ok(vec![ip]),
            _ => Err(NetworkError::HostUnreachable),
        }
    }
}

#[derive(Debug)]
struct Bound {
    inner: Box<dyn VirtualTcpBoundSocket + Sync>,
    network: JobNetwork,
}

impl VirtualTcpBoundSocket for Bound {
    fn addr_local(&self) -> Result<SocketAddr> {
        self.inner.addr_local()
    }

    fn listen(&mut self) -> Result<Box<dyn VirtualTcpListener + Sync>> {
        let listener = self.inner.listen()?;
        self.network.register(listener)
    }

    fn connect(&mut self, peer: SocketAddr) -> Result<Box<dyn VirtualTcpSocket + Sync>> {
        self.network.check_peer(peer)?;
        self.inner.connect(peer)
    }

    fn set_ttl(&mut self, ttl: u32) -> Result<()> {
        self.inner.set_ttl(ttl)
    }

    fn ttl(&self) -> Result<u32> {
        self.inner.ttl()
    }
}

/// A listener that leaves the set when it closes, so a later connect to
/// its port is refused rather than handed to another listener.
#[derive(Debug)]
struct Listener {
    inner: Box<dyn VirtualTcpListener + Sync>,
    addr: SocketAddr,
    listening: Arc<Mutex<HashSet<SocketAddr>>>,
}

impl Drop for Listener {
    fn drop(&mut self) {
        self.listening
            .lock()
            .expect("listener set")
            .remove(&self.addr);
    }
}

impl VirtualIoSource for Listener {
    fn remove_handler(&mut self) {
        self.inner.remove_handler();
    }

    fn poll_read_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<usize>> {
        self.inner.poll_read_ready(cx)
    }

    fn poll_write_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<usize>> {
        self.inner.poll_write_ready(cx)
    }
}

impl VirtualTcpListener for Listener {
    fn try_accept(&mut self) -> Result<(Box<dyn VirtualTcpSocket + Sync>, SocketAddr)> {
        self.inner.try_accept()
    }

    fn set_handler(&mut self, handler: Box<dyn InterestHandler + Send + Sync>) -> Result<()> {
        self.inner.set_handler(handler)
    }

    fn addr_local(&self) -> Result<SocketAddr> {
        self.inner.addr_local()
    }

    fn set_ttl(&mut self, ttl: u8) -> Result<()> {
        self.inner.set_ttl(ttl)
    }

    fn ttl(&self) -> Result<u8> {
        self.inner.ttl()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::executor::block_on;
    use std::mem::MaybeUninit;

    fn addr(s: &str) -> SocketAddr {
        s.parse().unwrap()
    }

    fn any_v4() -> SocketAddr {
        addr("0.0.0.0:0")
    }

    /// Sends `data` from `from` and reads it at `to`. The in-memory pair is
    /// synchronous, so a single try each way is enough.
    fn round_trip(
        from: &mut dyn VirtualTcpSocket,
        to: &mut dyn VirtualTcpSocket,
        data: &[u8],
    ) -> Vec<u8> {
        assert_eq!(from.try_send(data).unwrap(), data.len());
        let mut buf = vec![MaybeUninit::<u8>::uninit(); 64];
        let n = to.try_recv(&mut buf, false).unwrap();
        buf[..n]
            .iter()
            .map(|b| unsafe { b.assume_init() })
            .collect()
    }

    #[test]
    fn a_job_reaches_its_own_listener_on_the_loopback() {
        let net = JobNetwork::new();
        let mut listener =
            block_on(net.listen_tcp(addr("127.0.0.1:8080"), false, false, false)).unwrap();
        let mut client = block_on(net.connect_tcp(any_v4(), addr("127.0.0.1:8080"))).unwrap();
        let (mut server, _) = listener.try_accept().unwrap();
        assert_eq!(
            round_trip(client.as_mut(), server.as_mut(), b"ping"),
            b"ping"
        );
        assert_eq!(
            round_trip(server.as_mut(), client.as_mut(), b"pong"),
            b"pong"
        );

        // Listening on every interface means the loopback.
        let _all = block_on(net.listen_tcp(addr("0.0.0.0:9000"), false, false, false)).unwrap();
        assert!(block_on(net.connect_tcp(any_v4(), addr("127.0.0.1:9000"))).is_ok());
    }

    #[test]
    fn closed_ports_and_other_addresses_are_refused_not_routed_to_another_listener() {
        let net = JobNetwork::new();
        let _listener =
            block_on(net.listen_tcp(addr("127.0.0.1:8080"), false, false, false)).unwrap();
        assert!(matches!(
            block_on(net.connect_tcp(any_v4(), addr("127.0.0.1:8081"))),
            Err(NetworkError::ConnectionRefused)
        ));
        for outside in [
            "8.8.8.8:53",
            "10.0.0.1:8080",
            "192.168.1.1:80",
            "[2001:db8::1]:443",
        ] {
            assert!(
                matches!(
                    block_on(net.connect_tcp(any_v4(), addr(outside))),
                    Err(NetworkError::NetworkUnreachable)
                ),
                "{outside}"
            );
        }
        // The same through an explicitly bound socket.
        let mut bound = block_on(net.bind_tcp(addr("127.0.0.1:0"), false, false, false)).unwrap();
        assert!(matches!(
            bound.connect(addr("10.0.0.1:8080")),
            Err(NetworkError::NetworkUnreachable)
        ));
        // A listener that closes takes its port with it.
        drop(_listener);
        assert!(matches!(
            block_on(net.connect_tcp(any_v4(), addr("127.0.0.1:8080"))),
            Err(NetworkError::ConnectionRefused)
        ));
    }

    #[test]
    fn listeners_are_loopback_only() {
        let net = JobNetwork::new();
        for not_ours in ["192.168.1.5:80", "10.0.0.1:0", "8.8.8.8:53"] {
            assert!(
                matches!(
                    block_on(net.listen_tcp(addr(not_ours), false, false, false)),
                    Err(NetworkError::AddressNotAvailable)
                ),
                "{not_ours}"
            );
        }
        assert!(block_on(net.listen_tcp(addr("[::1]:7000"), false, false, false)).is_ok());
    }

    #[test]
    fn two_jobs_cannot_see_each_other() {
        let a = JobNetwork::new();
        let b = JobNetwork::new();
        let _listener =
            block_on(a.listen_tcp(addr("127.0.0.1:8080"), false, false, false)).unwrap();
        assert!(matches!(
            block_on(b.connect_tcp(any_v4(), addr("127.0.0.1:8080"))),
            Err(NetworkError::ConnectionRefused)
        ));
        // And both may use the same port.
        assert!(block_on(b.listen_tcp(addr("127.0.0.1:8080"), false, false, false)).is_ok());
    }

    #[test]
    fn the_host_loopback_is_neither_reachable_nor_used() {
        // A real server on the host's loopback: the job cannot reach it.
        let host = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let host_port = host.local_addr().unwrap().port();
        host.set_nonblocking(true).unwrap();
        let net = JobNetwork::new();
        assert!(
            block_on(net.connect_tcp(
                any_v4(),
                SocketAddr::new(Ipv4Addr::LOCALHOST.into(), host_port)
            ))
            .is_err()
        );
        assert!(host.accept().is_err(), "nothing reached the host listener");

        // A free host port that the job listens on stays closed on the host.
        let free = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let _listener = block_on(net.listen_tcp(free, false, false, false)).unwrap();
        assert!(
            std::net::TcpStream::connect_timeout(&free, std::time::Duration::from_millis(200))
                .is_err()
        );
    }

    #[test]
    fn only_localhost_resolves() {
        let net = JobNetwork::new();
        let ips = block_on(net.resolve("localhost", None, None)).unwrap();
        assert!(ips.contains(&IpAddr::from(Ipv4Addr::LOCALHOST)));
        assert!(block_on(net.resolve("LOCALHOST.", None, None)).is_ok());
        assert_eq!(
            block_on(net.resolve("127.0.0.1", None, None)).unwrap(),
            vec![IpAddr::from(Ipv4Addr::LOCALHOST)]
        );
        for name in [
            "example.com",
            "registry.npmjs.org",
            "8.8.8.8",
            "metadata.google.internal",
        ] {
            assert!(block_on(net.resolve(name, None, None)).is_err(), "{name}");
        }
        assert!(block_on(net.bind_udp(addr("127.0.0.1:0"), false, false)).is_err());
    }
}
