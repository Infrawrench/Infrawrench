//! Each job's network: a private loopback, and the public internet.
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
//! resolves to the loopback, and so does the name of each of the job's
//! services (`postgres`), as a service's host name does on other CI
//! runners; nothing on the host is asked or changed. A listener on `::` takes IPv4 connections too,
//! as a dual-stack socket does: that is where Node listens when it is given
//! no host, and its tests then connect to `127.0.0.1`.
//!
//! Outbound connections to the public internet go through a host socket
//! (wasmer's `LocalNetworking`), when the runtime has one: a job can fetch
//! from a registry or call an API. Only public unicast addresses qualify
//! (`public`): never the host's loopback, which is where the runner's own
//! API listens, nor private, link-local (cloud metadata at 169.254.169.254),
//! shared, multicast, documentation or reserved ranges, in IPv4, IPv6 or
//! IPv4 inside IPv6. The check is on the address actually connected to, so
//! a name that resolves to an internal address cannot be used to reach it;
//! names resolve through the host, and internal answers are dropped. A job
//! cannot listen on a host socket, so nothing outside reaches into it. UDP
//! is not offered.

use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use wasmer_wasix::virtual_net::{
    InterestHandler, IpCidr, LoopbackNetworking, NetworkError, VirtualIoSource, VirtualNetworking,
    VirtualTcpBoundSocket, VirtualTcpListener, VirtualTcpSocket,
};

/// Host networking for a job's outbound connections, shared by every job,
/// with the host's own addresses, which a job may not connect to even when
/// they are public: from the host itself they skip any outside firewall.
#[derive(Debug)]
pub(crate) struct OutsideNet {
    net: Arc<dyn VirtualNetworking + Send + Sync>,
    own: HashSet<IpAddr>,
}

pub(crate) type Outside = Arc<OutsideNet>;

impl OutsideNet {
    pub(crate) fn new(net: Arc<dyn VirtualNetworking + Send + Sync>, own: HashSet<IpAddr>) -> Self {
        Self { net, own }
    }

    fn allows(&self, ip: IpAddr) -> bool {
        let canonical = match ip {
            IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(ip, IpAddr::V4),
            v4 => v4,
        };
        public(canonical) && !self.own.contains(&canonical)
    }
}

/// The addresses on the host's own interfaces.
pub(crate) fn host_addresses() -> HashSet<IpAddr> {
    let mut out = HashSet::new();
    #[cfg(unix)]
    // SAFETY: getifaddrs fills a list we only read and then free; each
    // entry's address is read according to its declared family.
    unsafe {
        let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
        if libc::getifaddrs(&mut list) != 0 {
            return out;
        }
        let mut at = list;
        while !at.is_null() {
            let addr = (*at).ifa_addr;
            if !addr.is_null() {
                match i32::from((*addr).sa_family) {
                    libc::AF_INET => {
                        let sin = &*(addr as *const libc::sockaddr_in);
                        out.insert(IpAddr::V4(Ipv4Addr::from(u32::from_be(
                            sin.sin_addr.s_addr,
                        ))));
                    }
                    libc::AF_INET6 => {
                        let sin6 = &*(addr as *const libc::sockaddr_in6);
                        out.insert(IpAddr::V6(Ipv6Addr::from(sin6.sin6_addr.s6_addr)));
                    }
                    _ => {}
                }
            }
            at = (*at).ifa_next;
        }
        libc::freeifaddrs(list);
    }
    out
}

type Result<T> = std::result::Result<T, NetworkError>;

#[derive(Debug, Clone, Default)]
pub(crate) struct JobNetwork {
    inner: LoopbackNetworking,
    listening: Arc<Mutex<Listening>>,
    /// The public internet, when the runtime offers it.
    outside: Option<Outside>,
    /// The job's services' names, which resolve to the IPv4 loopback.
    services: Arc<[String]>,
}

/// What the job is listening on.
#[derive(Debug, Default)]
struct Listening {
    /// Addresses something in the job is listening on, normalised.
    addrs: HashSet<SocketAddr>,
    /// Ports with a listener on `::` that was not made IPv6-only. Such a
    /// socket is dual-stack: it also takes connections to the IPv4 loopback,
    /// unless an IPv4 listener has that port.
    dual_stack: HashSet<u16>,
}

/// Where a connection goes.
enum Route {
    /// The job's own listener, at the address the inner loopback knows it by.
    Loopback(SocketAddr),
    Outside(Arc<dyn VirtualNetworking + Send + Sync>),
}

impl JobNetwork {
    pub(crate) fn new(outside: Option<Outside>) -> Self {
        Self {
            outside,
            ..Self::default()
        }
    }

    /// Answers each of `names` (a job's services) with `127.0.0.1`, where
    /// they listen. IPv4 only, as a service's own address is on other CI
    /// runners: a client that tried `::1` first would find nothing there
    /// when the service listens on `127.0.0.1`.
    pub(crate) fn with_services(mut self, names: &[String]) -> Self {
        self.services = names.iter().map(|n| n.to_ascii_lowercase()).collect();
        self
    }

    fn register(
        &self,
        listener: Box<dyn VirtualTcpListener + Sync>,
        dual_stack: bool,
    ) -> Result<Box<dyn VirtualTcpListener + Sync>> {
        let addr = normalise(listener.addr_local()?);
        {
            let mut listening = self.listening.lock().expect("listener set");
            listening.addrs.insert(addr);
            if dual_stack {
                listening.dual_stack.insert(addr.port());
            }
        }
        Ok(Box::new(Listener {
            inner: listener,
            addr,
            dual_stack,
            listening: self.listening.clone(),
        }))
    }

    fn route(&self, peer: SocketAddr) -> Result<Route> {
        if peer.ip().is_loopback() {
            return Ok(Route::Loopback(self.listener_for(peer)?));
        }
        match &self.outside {
            Some(outside) if outside.allows(peer.ip()) => Ok(Route::Outside(outside.net.clone())),
            _ => Err(NetworkError::NetworkUnreachable),
        }
    }

    /// The listener a connection to the loopback address `peer` reaches:
    /// the one on that address, or for the IPv4 loopback a dual-stack one on
    /// the same port.
    fn listener_for(&self, peer: SocketAddr) -> Result<SocketAddr> {
        self.listening
            .lock()
            .expect("listener set")
            .listener_for(peer)
            .ok_or(NetworkError::ConnectionRefused)
    }

    /// What the job listens on, for `/proc/iwci/tcp` (services.rs).
    pub(crate) fn listeners(&self) -> Listeners {
        Listeners(self.listening.clone())
    }
}

impl Listening {
    /// See [`JobNetwork::listener_for`].
    fn listener_for(&self, peer: SocketAddr) -> Option<SocketAddr> {
        let peer = normalise(peer);
        if self.addrs.contains(&peer) {
            return Some(peer);
        }
        if peer.ip() == IpAddr::V4(Ipv4Addr::LOCALHOST) && self.dual_stack.contains(&peer.port()) {
            return Some(SocketAddr::new(Ipv6Addr::LOCALHOST.into(), peer.port()));
        }
        None
    }
}

/// A read-only view of what a job listens on, shared with its
/// [`JobNetwork`].
#[derive(Debug, Clone, Default)]
pub(crate) struct Listeners(Arc<Mutex<Listening>>);

impl Listeners {
    /// Whether a connection to `peer` would reach a listener in the job: a
    /// loopback address something listens on, as a connect would route it.
    /// Nothing is connected to find out.
    pub(crate) fn reaches(&self, peer: SocketAddr) -> bool {
        peer.ip().is_loopback()
            && self
                .0
                .lock()
                .expect("listener set")
                .listener_for(peer)
                .is_some()
    }

    /// The addresses something listens on, sorted.
    pub(crate) fn addrs(&self) -> Vec<SocketAddr> {
        let mut addrs: Vec<_> = self
            .0
            .lock()
            .expect("listener set")
            .addrs
            .iter()
            .copied()
            .collect();
        addrs.sort();
        addrs
    }
}

/// Whether a socket bound to `addr` takes IPv4 connections as well: one on
/// the IPv6 unspecified address that was not made IPv6-only.
fn dual_stack(addr: SocketAddr, only_v6: bool) -> bool {
    !only_v6 && matches!(addr.ip(), IpAddr::V6(ip) if ip.is_unspecified())
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

/// A public unicast address: the only kind a job may connect to outside its
/// loopback.
pub(crate) fn public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => public_v4(ip),
        IpAddr::V6(ip) => {
            // IPv4 inside IPv6 (mapped, and NAT64's well-known prefix) is
            // judged as the IPv4 address it carries.
            if let Some(v4) = ip.to_ipv4_mapped() {
                return public_v4(v4);
            }
            let s = ip.segments();
            if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
                return public_v4(Ipv4Addr::new(
                    (s[6] >> 8) as u8,
                    s[6] as u8,
                    (s[7] >> 8) as u8,
                    s[7] as u8,
                ));
            }
            !(ip.is_unspecified()
                || ip.is_loopback()
                || ip.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // unique local, fc00::/7
                || (s[0] & 0xffc0) == 0xfe80 // link-local, fe80::/10
                || (s[0] & 0xffc0) == 0xfec0 // site-local, fec0::/10
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentation
                || (s[0] == 0x2001 && s[1] < 0x0200) // IETF protocol assignments, Teredo
                || s[0] == 0x2002 // 6to4, which embeds an IPv4 address
                || s[0..6] == [0, 0, 0, 0, 0, 0]) // IPv4-compatible
        }
    }
}

fn public_v4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _] = ip.octets();
    !(ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local() // 169.254.0.0/16, cloud metadata
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        || a == 0
        || (a == 100 && (64..128).contains(&b)) // shared address space, 100.64.0.0/10
        || (a == 192 && b == 0 && c == 0) // IETF protocol assignments
        || (a == 198 && (b == 18 || b == 19)) // benchmarking
        || a >= 240) // reserved
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
        self.register(listener, dual_stack(addr, only_v6))
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
            dual_stack: dual_stack(addr, only_v6),
            network: self.clone(),
        }))
    }

    async fn connect_tcp(
        &self,
        addr: SocketAddr,
        peer: SocketAddr,
    ) -> Result<Box<dyn VirtualTcpSocket + Sync>> {
        if let Route::Outside(outside) = self.route(peer)? {
            return outside.connect_tcp(addr, peer).await;
        }
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
        port: Option<u16>,
        dns_server: Option<IpAddr>,
    ) -> Result<Vec<IpAddr>> {
        let host = host.trim_end_matches('.');
        if host.eq_ignore_ascii_case("localhost") {
            return Ok(vec![Ipv4Addr::LOCALHOST.into(), Ipv6Addr::LOCALHOST.into()]);
        }
        if self
            .services
            .iter()
            .any(|name| host.eq_ignore_ascii_case(name))
        {
            return Ok(vec![Ipv4Addr::LOCALHOST.into()]);
        }
        match host
            .trim_start_matches('[')
            .trim_end_matches(']')
            .parse::<IpAddr>()
        {
            Ok(ip) if ip.is_loopback() => return Ok(vec![ip]),
            Ok(ip) if self.outside.as_ref().is_some_and(|o| o.allows(ip)) => return Ok(vec![ip]),
            Ok(_) => return Err(NetworkError::HostUnreachable),
            Err(_) => {}
        }
        let Some(outside) = &self.outside else {
            return Err(NetworkError::HostUnreachable);
        };
        // Through the host's resolver; answers that are not public are
        // dropped, so a name cannot lead a job to an internal address.
        let addrs: Vec<IpAddr> = outside
            .net
            .resolve(host, port, dns_server)
            .await?
            .into_iter()
            .filter(|ip| outside.allows(*ip))
            .collect();
        if addrs.is_empty() {
            return Err(NetworkError::HostUnreachable);
        }
        Ok(addrs)
    }
}

#[derive(Debug)]
struct Bound {
    inner: Box<dyn VirtualTcpBoundSocket + Sync>,
    /// Whether a listener made from this socket takes IPv4 as well.
    dual_stack: bool,
    network: JobNetwork,
}

impl VirtualTcpBoundSocket for Bound {
    fn addr_local(&self) -> Result<SocketAddr> {
        self.inner.addr_local()
    }

    fn listen(&mut self) -> Result<Box<dyn VirtualTcpListener + Sync>> {
        let listener = self.inner.listen()?;
        self.network.register(listener, self.dual_stack)
    }

    fn connect(&mut self, peer: SocketAddr) -> Result<Box<dyn VirtualTcpSocket + Sync>> {
        match self.network.route(peer)? {
            Route::Loopback(listener) => self.inner.connect(listener),
            // A socket bound first (to the loopback) and then connected
            // outside leaves by a host socket of its own. The host connect
            // does not wait on anything, so blocking on it is immediate.
            Route::Outside(outside) => {
                let any = if peer.is_ipv4() {
                    SocketAddr::new(Ipv4Addr::UNSPECIFIED.into(), 0)
                } else {
                    SocketAddr::new(Ipv6Addr::UNSPECIFIED.into(), 0)
                };
                futures::executor::block_on(outside.connect_tcp(any, peer))
            }
        }
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
    dual_stack: bool,
    listening: Arc<Mutex<Listening>>,
}

impl Drop for Listener {
    fn drop(&mut self) {
        let mut listening = self.listening.lock().expect("listener set");
        listening.addrs.remove(&self.addr);
        if self.dual_stack {
            listening.dual_stack.remove(&self.addr.port());
        }
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
        let net = JobNetwork::new(None);
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
        let net = JobNetwork::new(None);
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
    fn a_closed_listener_frees_its_port_for_the_next_one() {
        // A suite that starts and stops a server on a fixed port, or a
        // service restarted within a job (#1009): wasmer's loopback kept
        // every listener's port until the job ended.
        let net = JobNetwork::new(None);
        for at in ["127.0.0.1:5555", "0.0.0.0:5555", "[::]:5555"] {
            for _ in 0..3 {
                let listener = block_on(net.listen_tcp(addr(at), false, false, false)).unwrap();
                assert!(
                    matches!(
                        block_on(net.bind_tcp(addr(at), false, false, false)),
                        Err(NetworkError::AddressInUse)
                    ),
                    "{at}"
                );
                drop(listener);
                // Again through a socket bound first, as libuv listens.
                let mut bound = block_on(net.bind_tcp(addr(at), false, false, false))
                    .unwrap_or_else(|e| panic!("{at}: {e:?}"));
                let mut listener = bound.listen().unwrap();
                let mut client =
                    block_on(net.connect_tcp(any_v4(), addr("127.0.0.1:5555"))).unwrap();
                let (mut server, _) = listener.try_accept().unwrap();
                assert_eq!(
                    round_trip(client.as_mut(), server.as_mut(), b"ping"),
                    b"ping",
                    "{at}"
                );
            }
        }
    }

    #[test]
    fn a_listener_on_the_ipv6_unspecified_address_takes_ipv4_too() {
        // Where Node listens when it is given no host; its callers then
        // connect to 127.0.0.1.
        let net = JobNetwork::new(None);
        let mut listener =
            block_on(net.listen_tcp(addr("[::]:8080"), false, false, false)).unwrap();
        for peer in ["127.0.0.1:8080", "[::1]:8080"] {
            let mut client = block_on(net.connect_tcp(any_v4(), addr(peer))).unwrap();
            let (mut server, _) = listener.try_accept().unwrap();
            assert_eq!(
                round_trip(client.as_mut(), server.as_mut(), b"ping"),
                b"ping",
                "{peer}"
            );
        }
        // The same through a socket bound first, as libuv makes its
        // listeners and its connections.
        let mut bound = block_on(net.bind_tcp(addr("[::]:9000"), false, false, false)).unwrap();
        let mut listener = bound.listen().unwrap();
        let mut from = block_on(net.bind_tcp(addr("127.0.0.1:0"), false, false, false)).unwrap();
        let mut client = from.connect(addr("127.0.0.1:9000")).unwrap();
        let (mut server, _) = listener.try_accept().unwrap();
        assert_eq!(
            round_trip(client.as_mut(), server.as_mut(), b"ping"),
            b"ping"
        );

        // A closed port is still refused, and the port goes with the listener.
        assert!(matches!(
            block_on(net.connect_tcp(any_v4(), addr("127.0.0.1:8081"))),
            Err(NetworkError::ConnectionRefused)
        ));
        drop(listener);
        assert!(matches!(
            block_on(net.connect_tcp(any_v4(), addr("127.0.0.1:9000"))),
            Err(NetworkError::ConnectionRefused)
        ));
    }

    #[test]
    fn only_a_dual_stack_listener_crosses_families() {
        let net = JobNetwork::new(None);
        // IPv6-only, the IPv6 loopback itself, and IPv4 listeners do not.
        let _only_v6 = block_on(net.listen_tcp(addr("[::]:7001"), true, false, false)).unwrap();
        let _v6_loopback =
            block_on(net.listen_tcp(addr("[::1]:7002"), false, false, false)).unwrap();
        for port in [7001, 7002] {
            assert!(
                matches!(
                    block_on(
                        net.connect_tcp(
                            any_v4(),
                            SocketAddr::new(Ipv4Addr::LOCALHOST.into(), port)
                        )
                    ),
                    Err(NetworkError::ConnectionRefused)
                ),
                "{port}"
            );
        }
        let _v4 = block_on(net.listen_tcp(addr("0.0.0.0:7003"), false, false, false)).unwrap();
        assert!(matches!(
            block_on(net.connect_tcp(addr("[::]:0"), addr("[::1]:7003"))),
            Err(NetworkError::ConnectionRefused)
        ));

        // An IPv4 listener on the port of a dual-stack one keeps its own
        // connections.
        let mut dual = block_on(net.listen_tcp(addr("[::]:7004"), false, false, false)).unwrap();
        let mut v4 = block_on(net.listen_tcp(addr("127.0.0.1:7004"), false, false, false)).unwrap();
        let _client = block_on(net.connect_tcp(any_v4(), addr("127.0.0.1:7004"))).unwrap();
        assert!(v4.try_accept().is_ok());
        assert!(dual.try_accept().is_err());
    }

    #[test]
    fn listeners_are_loopback_only() {
        let net = JobNetwork::new(None);
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
        let a = JobNetwork::new(None);
        let b = JobNetwork::new(None);
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
        let net = JobNetwork::new(None);
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
        let net = JobNetwork::new(None);
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

    #[test]
    fn a_services_name_resolves_to_the_loopback_and_nothing_else_changes() {
        let net = JobNetwork::new(None).with_services(&["postgres".into(), "api-1".into()]);
        for name in ["postgres", "POSTGRES.", "api-1"] {
            assert_eq!(
                block_on(net.resolve(name, None, None)).unwrap(),
                vec![IpAddr::from(Ipv4Addr::LOCALHOST)],
                "{name}"
            );
        }
        // Only the names themselves: not a domain under them, nor another.
        for name in ["postgres.example.com", "api", "redis"] {
            assert!(block_on(net.resolve(name, None, None)).is_err(), "{name}");
        }
        // A job without services resolves none of those names.
        assert!(block_on(JobNetwork::new(None).resolve("postgres", None, None)).is_err());
    }

    #[test]
    fn only_public_unicast_addresses_count_as_outside() {
        for ok in [
            "1.1.1.1",
            "104.16.0.1",
            "2606:4700::1111",
            "::ffff:8.8.8.8",
            "64:ff9b::808:808",
        ] {
            assert!(public(ok.parse().unwrap()), "{ok} is public");
        }
        for no in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.1",
            "192.0.2.1",
            "198.18.0.1",
            "240.0.0.1",
            "::1",
            "::",
            "fc00::1",
            "fd12::1",
            "fe80::1",
            "ff02::1",
            "2001:db8::1",
            "::ffff:127.0.0.1",
            "::ffff:169.254.169.254",
            "64:ff9b::a00:1",
            "2002:7f00:1::1",
        ] {
            assert!(!public(no.parse().unwrap()), "{no} is not public");
        }
    }

    /// Records what reaches the outside and answers a fixed resolution,
    /// so these tests never touch a real network.
    #[derive(Debug, Default)]
    struct FakeOutside {
        connects: Mutex<Vec<SocketAddr>>,
    }

    #[async_trait::async_trait]
    impl VirtualNetworking for FakeOutside {
        async fn connect_tcp(
            &self,
            _addr: SocketAddr,
            peer: SocketAddr,
        ) -> Result<Box<dyn VirtualTcpSocket + Sync>> {
            self.connects.lock().unwrap().push(peer);
            Err(NetworkError::ConnectionRefused)
        }

        async fn resolve(
            &self,
            host: &str,
            _port: Option<u16>,
            _dns_server: Option<IpAddr>,
        ) -> Result<Vec<IpAddr>> {
            Ok(match host {
                "example.com" => vec![
                    "93.184.215.14".parse().unwrap(),
                    "10.0.0.1".parse().unwrap(),
                ],
                _ => vec!["169.254.169.254".parse().unwrap()],
            })
        }
    }

    #[test]
    fn public_addresses_go_outside_and_internal_ones_never_do() {
        let fake = Arc::new(FakeOutside::default());
        let net = JobNetwork::new(Some(Arc::new(OutsideNet::new(
            fake.clone(),
            HashSet::new(),
        ))));
        let public_peer = addr("93.184.215.14:443");
        let err = futures::executor::block_on(net.connect_tcp(any_v4(), public_peer)).unwrap_err();
        assert_eq!(
            err,
            NetworkError::ConnectionRefused,
            "handed to the outside network"
        );
        for internal in ["10.0.0.1:443", "169.254.169.254:80", "192.168.0.1:22"] {
            let err =
                futures::executor::block_on(net.connect_tcp(any_v4(), addr(internal))).unwrap_err();
            assert_eq!(err, NetworkError::NetworkUnreachable, "{internal}");
        }
        assert_eq!(*fake.connects.lock().unwrap(), vec![public_peer]);
    }

    #[test]
    fn names_resolve_outside_to_public_addresses_only() {
        let net = JobNetwork::new(Some(Arc::new(OutsideNet::new(
            Arc::new(FakeOutside::default()),
            HashSet::new(),
        ))));
        let resolved = futures::executor::block_on(net.resolve("example.com", None, None)).unwrap();
        assert_eq!(resolved, vec!["93.184.215.14".parse::<IpAddr>().unwrap()]);
        // A name that only points inside does not resolve at all.
        assert_eq!(
            futures::executor::block_on(net.resolve("metadata.internal", None, None)).unwrap_err(),
            NetworkError::HostUnreachable
        );
        // Without the outside, names other than localhost never resolve.
        assert_eq!(
            futures::executor::block_on(JobNetwork::new(None).resolve("example.com", None, None))
                .unwrap_err(),
            NetworkError::HostUnreachable
        );
    }

    #[test]
    fn the_hosts_own_addresses_are_refused_even_when_public() {
        let fake = Arc::new(FakeOutside::default());
        let own: HashSet<IpAddr> = ["87.86.80.94".parse().unwrap()].into();
        let net = JobNetwork::new(Some(Arc::new(OutsideNet::new(fake.clone(), own))));
        for peer in ["87.86.80.94:22", "[::ffff:87.86.80.94]:22"] {
            let err =
                futures::executor::block_on(net.connect_tcp(any_v4(), addr(peer))).unwrap_err();
            assert_eq!(err, NetworkError::NetworkUnreachable, "{peer}");
        }
        assert!(fake.connects.lock().unwrap().is_empty());
    }

    #[test]
    fn host_addresses_include_the_loopback() {
        // Every host with a network stack has one; the list is what the
        // runtime refuses on top of the public-address rule.
        assert!(host_addresses().iter().any(|ip| ip.is_loopback()));
    }
}
