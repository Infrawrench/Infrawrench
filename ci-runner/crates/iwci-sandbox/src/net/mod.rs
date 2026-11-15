//! The sandbox's way out: a user-space TCP/IP gateway in the runner.
//!
//! A sandboxed job has gVisor's own network stack, whose loopback every
//! process of the job shares (`Bun.serve` on `127.0.0.1` is reached by a
//! `curl` of the same job, and by its services). For anything else the
//! stack gets one network interface (`eth0`, `10.0.2.15/24` and
//! `fd00:6977::15/64`, default routes via `.2`), whose other end is a
//! socket pair to the runner carrying raw IP packets. No host network
//! namespace, device or route is involved.
//!
//! The runner's end is a `smoltcp` interface that accepts packets for any
//! address ("any IP"), so it can stand in for every host on the internet.
//! A TCP connection is made the way a NAT would make it, but decided per
//! connection: the sandbox's SYN is held while the runner asks
//! [`Outside::allows`] about the address it is for and, if allowed, opens
//! a host socket to it ([`Outside::connect`]). Only then is the SYN handed
//! to `smoltcp`, which completes the handshake on a listener made for that
//! one connection; refused or unreachable, it is handed over with no
//! listener, and `smoltcp` answers with a reset, as a closed port would.
//! Bytes are then pumped between the two sockets, half-closes included.
//! `Outside` is the same policy and resolver WASIX jobs go through, so the
//! two kinds of job reach exactly the same places.
//!
//! DNS is the gateway's address, port 53 (UDP): `A` and `AAAA` questions
//! are answered from [`Outside::resolve`], with every answer checked by
//! `Outside::allows` again, so a name never leads inside; `localhost` and
//! the job's services are the loopback. No other UDP, and no ICMP, is
//! offered, as WASIX jobs get none.
//!
//! Everything runs on one thread per sandbox, plus a short-lived one per
//! connection being opened and per name being resolved, so a slow host
//! never holds the others up.

mod dns;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{self, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, Shutdown, SocketAddr, TcpStream};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::thread::JoinHandle;

use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{Device, DeviceCapabilities, Medium, RxToken, TxToken};
use smoltcp::socket::{tcp, udp};
use smoltcp::time::Instant;
use smoltcp::wire::{
    HardwareAddress, IpAddress, IpCidr, IpEndpoint, IpListenEndpoint, IpProtocol, Ipv4Packet,
    Ipv6Packet, TcpPacket,
};

/// Where a sandboxed job's connections may go, and how names resolve:
/// the runner's policy for every job, WASIX or not.
pub trait Outside: Send + Sync {
    /// Whether the job may connect to `ip`.
    fn allows(&self, ip: IpAddr) -> bool;
    /// A host connection to `to`, which `allows` has approved.
    fn connect(&self, to: SocketAddr) -> io::Result<TcpStream>;
    /// The addresses `name` resolves to. Each is checked with `allows`
    /// before the sandbox sees it.
    fn resolve(&self, name: &str) -> io::Result<Vec<IpAddr>>;
}

/// The sandbox's side of the link.
pub const SANDBOX_V4: Ipv4Addr = Ipv4Addr::new(10, 0, 2, 15);
pub const SANDBOX_V6: Ipv6Addr = Ipv6Addr::new(0xfd00, 0x6977, 0, 0, 0, 0, 0, 0x15);
/// The gateway, which is also the DNS server.
pub const GATEWAY_V4: Ipv4Addr = Ipv4Addr::new(10, 0, 2, 2);
pub const GATEWAY_V6: Ipv6Addr = Ipv6Addr::new(0xfd00, 0x6977, 0, 0, 0, 0, 0, 0x2);
pub const PREFIX_V4: u8 = 24;
pub const PREFIX_V6: u8 = 64;
/// The link's MTU: large, since the link is a socket pair in memory.
pub const MTU: usize = 65_000;

/// Each TCP connection's buffers, both ways.
const TCP_BUFFER: usize = 64 * 1024;
/// At most this many connections at once, and this many being opened.
/// They hold memory and descriptors in the runner, not in the sandbox.
const MAX_CONNECTIONS: usize = 256;
const MAX_CONNECTING: usize = 64;
const MAX_RESOLVING: usize = 32;
/// A listener made for a connection whose SYN never arrived again.
const LISTENER_TIMEOUT: smoltcp::time::Duration = smoltcp::time::Duration::from_secs(60);

/// What a sandbox's network is given.
#[derive(Clone)]
pub struct Network {
    pub outside: Arc<dyn Outside>,
    /// The job's services' names, which resolve to the IPv4 loopback.
    pub services: Vec<String>,
}

/// A running gateway. Stopping it (or dropping it) ends every connection.
pub struct Gateway {
    stop: Arc<AtomicBool>,
    wake: Arc<OwnedFd>,
    thread: Option<JoinHandle<()>>,
}

impl Gateway {
    /// Starts a gateway for `network`; the descriptor is the sandbox's end
    /// of the link (`SOCK_SEQPACKET`, one IP packet per message).
    pub fn start(network: Network) -> io::Result<(Gateway, OwnedFd)> {
        let (ours, theirs) = crate::lisafs::seqpacket_pair()?;
        set_nonblocking(ours.as_raw_fd())?;
        let (wake_r, wake_w) = pipe()?;
        let wake = Arc::new(wake_w);
        let stop = Arc::new(AtomicBool::new(false));
        let mut state = State::new(network, ours, wake_r, wake.clone(), stop.clone());
        let thread = std::thread::Builder::new()
            .name("iwci-sandbox-net".into())
            .spawn(move || state.run())?;
        Ok((
            Gateway {
                stop,
                wake,
                thread: Some(thread),
            },
            theirs,
        ))
    }

    /// Ends the gateway and every connection through it.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        poke(&self.wake);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for Gateway {
    fn drop(&mut self) {
        self.stop();
    }
}

/// A connection, by the sandbox's end and the address it asked for.
type Key = (SocketAddr, SocketAddr);

enum Event {
    Connected(Key, io::Result<TcpStream>),
    Resolved(IpEndpoint, Vec<u8>),
}

struct Conn {
    host: TcpStream,
    /// Read from the sandbox, not yet written to the host.
    to_host: Vec<u8>,
    host_eof: bool,
    host_shut: bool,
}

struct Listener {
    handle: SocketHandle,
    key: Key,
    since: Instant,
}

struct State {
    network: Network,
    link: OwnedFd,
    wake_r: OwnedFd,
    wake: Arc<OwnedFd>,
    stop: Arc<AtomicBool>,
    events: mpsc::Receiver<Event>,
    send: mpsc::Sender<Event>,
    device: Queue,
    iface: Interface,
    sockets: SocketSet<'static>,
    dns: SocketHandle,
    /// SYNs held while their host connection is opened.
    held: HashMap<Key, Vec<u8>>,
    /// Host connections opened, waiting for `smoltcp` to accept.
    ready: HashMap<Key, TcpStream>,
    listeners: Vec<Listener>,
    conns: HashMap<SocketHandle, Conn>,
    /// Every connection with a socket of its own (listening or past it).
    known: HashSet<Key>,
    resolving: Arc<AtomicUsize>,
}

impl State {
    fn new(
        network: Network,
        link: OwnedFd,
        wake_r: OwnedFd,
        wake: Arc<OwnedFd>,
        stop: Arc<AtomicBool>,
    ) -> Self {
        let mut device = Queue::default();
        let mut iface = Interface::new(
            Config::new(HardwareAddress::Ip),
            &mut device,
            Instant::now(),
        );
        iface.update_ip_addrs(|addrs| {
            let _ = addrs.push(IpCidr::new(IpAddress::Ipv4(GATEWAY_V4), PREFIX_V4));
            let _ = addrs.push(IpCidr::new(IpAddress::Ipv6(GATEWAY_V6), PREFIX_V6));
        });
        // Standing in for every address: SYNs and DNS queries to anywhere
        // reach it.
        iface.set_any_ip(true);
        let mut sockets = SocketSet::new(Vec::new());
        let mut udp = udp::Socket::new(
            udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 64], vec![0; 64 * 1024]),
            udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 64], vec![0; 64 * 1024]),
        );
        let _ = udp.bind(IpListenEndpoint {
            addr: Some(IpAddress::Ipv4(GATEWAY_V4)),
            port: 53,
        });
        let dns = sockets.add(udp);
        let (send, events) = mpsc::channel();
        Self {
            network,
            link,
            wake_r,
            wake,
            stop,
            events,
            send,
            device,
            iface,
            sockets,
            dns,
            held: HashMap::new(),
            ready: HashMap::new(),
            listeners: Vec::new(),
            conns: HashMap::new(),
            known: HashSet::new(),
            resolving: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn run(&mut self) {
        let mut frame = vec![0u8; MTU + 64];
        while !self.stop.load(Ordering::SeqCst) {
            let timeout = self
                .iface
                .poll_delay(Instant::now(), &self.sockets)
                .map_or(1000, |d| d.total_millis().min(1000) as i32);
            if self.wait(timeout).is_err() {
                break;
            }
            drain(self.wake_r.as_raw_fd());
            // Packets from the sandbox.
            loop {
                match recv(self.link.as_raw_fd(), &mut frame) {
                    Ok(Some(n)) => self.on_packet(frame[..n].to_vec()),
                    Ok(None) => break,
                    // The sandbox is gone.
                    Err(_) => return,
                }
            }
            while let Ok(event) = self.events.try_recv() {
                self.on_event(event);
            }
            self.iface
                .poll(Instant::now(), &mut self.device, &mut self.sockets);
            self.accept();
            self.pump();
            self.answer_dns();
            self.iface
                .poll(Instant::now(), &mut self.device, &mut self.sockets);
            if self.flush().is_err() {
                return;
            }
        }
    }

    /// Waits for anything to do, up to `timeout` milliseconds.
    fn wait(&self, timeout: i32) -> io::Result<()> {
        let mut fds = vec![
            libc::pollfd {
                fd: self.link.as_raw_fd(),
                events: libc::POLLIN
                    | if self.device.tx.is_empty() {
                        0
                    } else {
                        libc::POLLOUT
                    },
                revents: 0,
            },
            libc::pollfd {
                fd: self.wake_r.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        for (handle, conn) in &self.conns {
            let socket = self.sockets.get::<tcp::Socket>(*handle);
            if socket.state() == tcp::State::SynReceived {
                continue;
            }
            let mut events = 0;
            if !conn.host_eof && socket.can_send() {
                events |= libc::POLLIN;
            }
            if !conn.to_host.is_empty() {
                events |= libc::POLLOUT;
            }
            if events != 0 {
                fds.push(libc::pollfd {
                    fd: conn.host.as_raw_fd(),
                    events,
                    revents: 0,
                });
            }
        }
        // SAFETY: `fds` is a valid array of pollfds for the call.
        let r = unsafe { libc::poll(fds.as_mut_ptr(), fds.len() as libc::nfds_t, timeout) };
        if r < 0 {
            let err = io::Error::last_os_error();
            if err.kind() != io::ErrorKind::Interrupted {
                return Err(err);
            }
        }
        if fds[0].revents & (libc::POLLHUP | libc::POLLERR) != 0
            && fds[0].revents & libc::POLLIN == 0
        {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        Ok(())
    }

    /// One packet from the sandbox: a new connection's SYN is held while
    /// the host end is opened; everything else goes to `smoltcp`.
    fn on_packet(&mut self, packet: Vec<u8>) {
        let Some(key) = syn_key(&packet) else {
            self.device.rx.push_back(packet);
            return;
        };
        if self.known.contains(&key) {
            // A retransmitted SYN, which its socket answers.
            self.device.rx.push_back(packet);
            return;
        }
        if self.held.contains_key(&key) {
            return;
        }
        let dst = key.1;
        let refused = !self.network.outside.allows(dst.ip())
            || self.held.len() >= MAX_CONNECTING
            || self.conns.len() + self.listeners.len() >= MAX_CONNECTIONS;
        if refused {
            // No listener: `smoltcp` answers with a reset.
            self.device.rx.push_back(packet);
            return;
        }
        self.held.insert(key, packet);
        let outside = self.network.outside.clone();
        let send = self.send.clone();
        let wake = self.wake.clone();
        let spawned = std::thread::Builder::new()
            .name("iwci-sandbox-connect".into())
            .spawn(move || {
                let result = outside.connect(dst);
                let _ = send.send(Event::Connected(key, result));
                poke(&wake);
            });
        if spawned.is_err()
            && let Some(packet) = self.held.remove(&key)
        {
            self.device.rx.push_back(packet);
        }
    }

    fn on_event(&mut self, event: Event) {
        match event {
            Event::Connected(key, result) => {
                let Some(packet) = self.held.remove(&key) else {
                    return;
                };
                if let Ok(stream) = result
                    && stream.set_nonblocking(true).is_ok()
                {
                    let _ = stream.set_nodelay(true);
                    let mut socket = tcp::Socket::new(
                        tcp::SocketBuffer::new(vec![0; TCP_BUFFER]),
                        tcp::SocketBuffer::new(vec![0; TCP_BUFFER]),
                    );
                    if socket
                        .listen(IpListenEndpoint {
                            addr: Some(key.1.ip().into()),
                            port: key.1.port(),
                        })
                        .is_ok()
                    {
                        let handle = self.sockets.add(socket);
                        self.listeners.push(Listener {
                            handle,
                            key,
                            since: Instant::now(),
                        });
                        self.ready.insert(key, stream);
                        self.known.insert(key);
                    }
                }
                self.device.rx.push_back(packet);
            }
            Event::Resolved(to, reply) => {
                let socket = self.sockets.get_mut::<udp::Socket>(self.dns);
                let _ = socket.send_slice(&reply, to);
            }
        }
    }

    /// Listeners `smoltcp` has handed a connection to become connections,
    /// joined to the host end opened for them.
    fn accept(&mut self) {
        let now = Instant::now();
        let mut keep = Vec::new();
        for listener in std::mem::take(&mut self.listeners) {
            let socket = self.sockets.get_mut::<tcp::Socket>(listener.handle);
            if socket.state() == tcp::State::Listen {
                if now - listener.since < LISTENER_TIMEOUT {
                    keep.push(listener);
                } else {
                    self.sockets.remove(listener.handle);
                    self.ready.remove(&listener.key);
                    self.known.remove(&listener.key);
                }
                continue;
            }
            // Which connection it took: two connections to one address
            // may each be taken by the other's listener, so the host end
            // is found by what was accepted, not by whom it was made for.
            let key = match (socket.remote_endpoint(), socket.local_endpoint()) {
                (Some(remote), Some(local)) => (endpoint(remote), endpoint(local)),
                _ => listener.key,
            };
            match self.ready.remove(&key) {
                Some(host) => {
                    self.conns.insert(
                        listener.handle,
                        Conn {
                            host,
                            to_host: Vec::new(),
                            host_eof: false,
                            host_shut: false,
                        },
                    );
                }
                None => {
                    socket.abort();
                    self.known.remove(&listener.key);
                }
            }
        }
        self.listeners = keep;
    }

    /// Moves bytes both ways on every connection, and retires finished ones.
    fn pump(&mut self) {
        let mut buf = vec![0u8; TCP_BUFFER];
        let mut done = Vec::new();
        for (handle, conn) in &mut self.conns {
            let socket = self.sockets.get_mut::<tcp::Socket>(*handle);
            if socket.state() == tcp::State::SynReceived {
                // Neither way is open until the handshake is done.
                continue;
            }
            // Sandbox to host.
            while conn.to_host.len() < TCP_BUFFER && socket.can_recv() {
                match socket.recv_slice(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => conn.to_host.extend_from_slice(&buf[..n]),
                }
            }
            while !conn.to_host.is_empty() {
                match conn.host.write(&conn.to_host) {
                    Ok(0) => break,
                    Ok(n) => {
                        conn.to_host.drain(..n);
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                    Err(_) => {
                        socket.abort();
                        conn.to_host.clear();
                        break;
                    }
                }
            }
            if !socket.may_recv() && conn.to_host.is_empty() && !conn.host_shut {
                let _ = conn.host.shutdown(Shutdown::Write);
                conn.host_shut = true;
            }
            // Host to sandbox.
            while !conn.host_eof && socket.can_send() {
                let room = socket.send_capacity() - socket.send_queue();
                match conn.host.read(&mut buf[..room.min(TCP_BUFFER)]) {
                    Ok(0) => {
                        conn.host_eof = true;
                        socket.close();
                    }
                    Ok(n) => {
                        let _ = socket.send_slice(&buf[..n]);
                    }
                    Err(e) if e.kind() == io::ErrorKind::WouldBlock => break,
                    Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                    Err(_) => {
                        conn.host_eof = true;
                        socket.abort();
                    }
                }
            }
            if matches!(socket.state(), tcp::State::Closed | tcp::State::TimeWait) {
                done.push(*handle);
            }
        }
        for handle in done {
            if let Some(conn) = self.conns.remove(&handle) {
                drop(conn);
            }
            let socket = self.sockets.remove(handle);
            if let smoltcp::socket::Socket::Tcp(socket) = socket
                && let (Some(remote), Some(local)) =
                    (socket.remote_endpoint(), socket.local_endpoint())
            {
                self.known.remove(&(endpoint(remote), endpoint(local)));
            }
        }
    }

    fn answer_dns(&mut self) {
        loop {
            let socket = self.sockets.get_mut::<udp::Socket>(self.dns);
            let (query, from) = match socket.recv() {
                Ok((data, meta)) => (data.to_vec(), meta.endpoint),
                Err(_) => return,
            };
            let Some(q) = dns::parse(&query) else {
                continue;
            };
            if let Some(addrs) = self.local_name(&q.name) {
                let reply = dns::answer(&q, true, &addrs);
                let socket = self.sockets.get_mut::<udp::Socket>(self.dns);
                let _ = socket.send_slice(&reply, from);
                continue;
            }
            if self.resolving.load(Ordering::SeqCst) >= MAX_RESOLVING {
                // The client retries.
                continue;
            }
            self.resolving.fetch_add(1, Ordering::SeqCst);
            let outside = self.network.outside.clone();
            let send = self.send.clone();
            let wake = self.wake.clone();
            let resolving = self.resolving.clone();
            let spawned = std::thread::Builder::new()
                .name("iwci-sandbox-dns".into())
                .spawn(move || {
                    let addrs: Vec<IpAddr> = outside
                        .resolve(&q.name)
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|ip| outside.allows(*ip))
                        .collect();
                    let reply = dns::answer(&q, !addrs.is_empty(), &addrs);
                    let _ = send.send(Event::Resolved(from, reply));
                    resolving.fetch_sub(1, Ordering::SeqCst);
                    poke(&wake);
                });
            if spawned.is_err() {
                self.resolving.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }

    /// The loopback names: `localhost` and the job's services.
    fn local_name(&self, name: &str) -> Option<Vec<IpAddr>> {
        if name == "localhost" {
            return Some(vec![Ipv4Addr::LOCALHOST.into(), Ipv6Addr::LOCALHOST.into()]);
        }
        self.network
            .services
            .iter()
            .any(|s| s.eq_ignore_ascii_case(name))
            .then(|| vec![Ipv4Addr::LOCALHOST.into()])
    }

    /// Sends what `smoltcp` queued for the sandbox.
    fn flush(&mut self) -> io::Result<()> {
        while let Some(packet) = self.device.tx.front() {
            // SAFETY: sending a buffer we own on a socket we own.
            let n = unsafe {
                libc::send(
                    self.link.as_raw_fd(),
                    packet.as_ptr().cast(),
                    packet.len(),
                    libc::MSG_DONTWAIT | libc::MSG_NOSIGNAL,
                )
            };
            if n < 0 {
                let err = io::Error::last_os_error();
                match err.kind() {
                    io::ErrorKind::WouldBlock => return Ok(()),
                    io::ErrorKind::Interrupted => continue,
                    _ => return Err(err),
                }
            }
            self.device.tx.pop_front();
        }
        Ok(())
    }
}

fn endpoint(e: IpEndpoint) -> SocketAddr {
    SocketAddr::new(e.addr.into(), e.port)
}

/// The connection a packet opens, if it is a TCP SYN (without ACK).
fn syn_key(packet: &[u8]) -> Option<Key> {
    let version = packet.first()? >> 4;
    let (src, dst, payload): (IpAddr, IpAddr, &[u8]) = match version {
        4 => {
            let ip = Ipv4Packet::new_checked(packet).ok()?;
            if ip.next_header() != IpProtocol::Tcp || ip.more_frags() || ip.frag_offset() != 0 {
                return None;
            }
            let header = ip.header_len() as usize;
            let total = (ip.total_len() as usize).min(packet.len());
            (
                ip.src_addr().into(),
                ip.dst_addr().into(),
                packet.get(header..total)?,
            )
        }
        6 => {
            let ip = Ipv6Packet::new_checked(packet).ok()?;
            if ip.next_header() != IpProtocol::Tcp {
                return None;
            }
            let end = (40 + ip.payload_len() as usize).min(packet.len());
            (
                ip.src_addr().into(),
                ip.dst_addr().into(),
                packet.get(40..end)?,
            )
        }
        _ => return None,
    };
    let tcp = TcpPacket::new_checked(payload).ok()?;
    if !tcp.syn() || tcp.ack() {
        return None;
    }
    Some((
        SocketAddr::new(src, tcp.src_port()),
        SocketAddr::new(dst, tcp.dst_port()),
    ))
}

/// `smoltcp`'s device: packets queued both ways, moved to and from the
/// link by the loop.
#[derive(Default)]
struct Queue {
    rx: VecDeque<Vec<u8>>,
    tx: VecDeque<Vec<u8>>,
}

struct Rx(Vec<u8>);
struct Tx<'a>(&'a mut VecDeque<Vec<u8>>);

impl RxToken for Rx {
    fn consume<R, F>(self, f: F) -> R
    where
        F: FnOnce(&[u8]) -> R,
    {
        f(&self.0)
    }
}

impl TxToken for Tx<'_> {
    fn consume<R, F>(self, len: usize, f: F) -> R
    where
        F: FnOnce(&mut [u8]) -> R,
    {
        let mut packet = vec![0u8; len];
        let r = f(&mut packet);
        self.0.push_back(packet);
        r
    }
}

impl Device for Queue {
    type RxToken<'a> = Rx;
    type TxToken<'a> = Tx<'a>;

    fn receive(&mut self, _: Instant) -> Option<(Self::RxToken<'_>, Self::TxToken<'_>)> {
        let packet = self.rx.pop_front()?;
        Some((Rx(packet), Tx(&mut self.tx)))
    }

    fn transmit(&mut self, _: Instant) -> Option<Self::TxToken<'_>> {
        // Back pressure: the loop sends these before taking more.
        (self.tx.len() < 4096).then_some(Tx(&mut self.tx))
    }

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ip;
        caps.max_transmission_unit = MTU;
        caps
    }
}

/// One packet off the link, if there is one waiting.
fn recv(fd: RawFd, buf: &mut [u8]) -> io::Result<Option<usize>> {
    loop {
        // SAFETY: receiving into a buffer we own.
        let n = unsafe { libc::recv(fd, buf.as_mut_ptr().cast(), buf.len(), libc::MSG_DONTWAIT) };
        if n > 0 {
            return Ok(Some(n as usize));
        }
        if n == 0 {
            return Err(io::ErrorKind::UnexpectedEof.into());
        }
        let err = io::Error::last_os_error();
        match err.kind() {
            io::ErrorKind::WouldBlock => return Ok(None),
            io::ErrorKind::Interrupted => continue,
            _ => return Err(err),
        }
    }
}

fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    let mut fds = [0 as RawFd; 2];
    // SAFETY: `fds` has room for both ends.
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: just created and ours.
    Ok(unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) })
}

fn poke(wake: &OwnedFd) {
    // SAFETY: writing one byte from our stack to a pipe we own; a full
    // pipe already wakes the loop.
    unsafe { libc::write(wake.as_raw_fd(), [1u8].as_ptr().cast(), 1) };
}

fn drain(fd: RawFd) {
    let mut buf = [0u8; 256];
    // SAFETY: reading into a buffer we own from a non-blocking pipe.
    while unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) } > 0 {}
}

fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    // SAFETY: plain fcntls on a descriptor we own.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFL);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}
