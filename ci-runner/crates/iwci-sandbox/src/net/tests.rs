//! The gateway against a second `smoltcp` stack playing the sandbox, over
//! a real socket pair, with upstreams on the host's loopback standing in
//! for the internet.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::Arc;
use std::time::Duration;

use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::socket::{tcp, udp};
use smoltcp::time::Instant;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr, IpEndpoint};

use super::*;

/// The test's internet: allowed addresses, each served by a local listener,
/// and names.
struct Fake {
    upstreams: HashMap<SocketAddr, SocketAddr>,
    names: HashMap<String, Vec<IpAddr>>,
}

impl Outside for Fake {
    fn allows(&self, ip: IpAddr) -> bool {
        // As the real policy does for documentation and private ranges,
        // except the test's own "public" addresses.
        self.upstreams.keys().any(|a| a.ip() == ip)
            || ip == IpAddr::V4(Ipv4Addr::new(203, 0, 113, 99))
    }
    fn connect(&self, to: SocketAddr) -> io::Result<TcpStream> {
        let local = self
            .upstreams
            .get(&to)
            .ok_or(io::ErrorKind::ConnectionRefused)?;
        TcpStream::connect_timeout(local, Duration::from_secs(5))
    }
    fn resolve(&self, name: &str) -> io::Result<Vec<IpAddr>> {
        self.names
            .get(name)
            .cloned()
            .ok_or_else(|| io::ErrorKind::NotFound.into())
    }
}

/// An upstream that upper-cases what it reads until EOF, then closes.
fn shouting_upstream() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            std::thread::spawn(move || {
                let mut got = Vec::new();
                let _ = stream.read_to_end(&mut got);
                let _ = stream.write_all(&got.to_ascii_uppercase());
            });
        }
    });
    addr
}

const UP: SocketAddr = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 7)), 80);

fn gateway() -> (Gateway, OwnedFd) {
    let mut upstreams = HashMap::new();
    upstreams.insert(UP, shouting_upstream());
    let mut names = HashMap::new();
    names.insert("upstream.test".to_string(), vec![UP.ip()]);
    names.insert(
        "inside.test".to_string(),
        vec![IpAddr::V4(Ipv4Addr::new(10, 1, 2, 3))],
    );
    Gateway::start(Network {
        outside: Arc::new(Fake { upstreams, names }),
        services: vec!["postgres".into()],
        local: Vec::new(),
    })
    .unwrap()
}

/// The sandbox's stack.
struct Sandbox {
    link: OwnedFd,
    device: Queue,
    iface: Interface,
    sockets: SocketSet<'static>,
}

impl Sandbox {
    fn new(link: OwnedFd) -> Self {
        set_nonblocking(link.as_raw_fd()).unwrap();
        let mut device = Queue::default();
        let mut iface = Interface::new(
            Config::new(HardwareAddress::Ip),
            &mut device,
            Instant::now(),
        );
        iface.update_ip_addrs(|a| {
            let _ = a.push(IpCidr::new(IpAddress::Ipv4(SANDBOX_V4), PREFIX_V4));
        });
        iface
            .routes_mut()
            .add_default_ipv4_route(GATEWAY_V4)
            .unwrap();
        Self {
            link,
            device,
            iface,
            sockets: SocketSet::new(Vec::new()),
        }
    }

    /// Runs the stack until `done` or five seconds pass.
    fn run_until(&mut self, mut done: impl FnMut(&mut SocketSet<'static>) -> bool) -> bool {
        let until = std::time::Instant::now() + Duration::from_secs(5);
        let mut buf = vec![0u8; MTU + 64];
        while std::time::Instant::now() < until {
            while let Ok(Some(n)) = recv(self.link.as_raw_fd(), &mut buf) {
                self.device.rx.push_back(buf[..n].to_vec());
            }
            self.iface
                .poll(Instant::now(), &mut self.device, &mut self.sockets);
            while let Some(p) = self.device.tx.pop_front() {
                // SAFETY: sending a buffer we own on a socket we own.
                unsafe { libc::send(self.link.as_raw_fd(), p.as_ptr().cast(), p.len(), 0) };
            }
            if done(&mut self.sockets) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        false
    }

    fn connect(&mut self, to: SocketAddr, local_port: u16) -> SocketHandle {
        let mut socket = tcp::Socket::new(
            tcp::SocketBuffer::new(vec![0; 65536]),
            tcp::SocketBuffer::new(vec![0; 65536]),
        );
        socket
            .connect(
                self.iface.context(),
                (IpAddress::from(to.ip()), to.port()),
                local_port,
            )
            .unwrap();
        self.sockets.add(socket)
    }

    /// Sends `data`, closes, and reads to the end: what came back, or
    /// `None` if the connection was refused or reset.
    fn exchange(&mut self, to: SocketAddr, local_port: u16, data: &[u8]) -> Option<Vec<u8>> {
        let h = self.connect(to, local_port);
        let mut sent = 0;
        let mut closed = false;
        let mut got = Vec::new();
        let mut established = false;
        let ok = self.run_until(|sockets| {
            let s = sockets.get_mut::<tcp::Socket>(h);
            if s.state() == tcp::State::Established {
                established = true;
            }
            while sent < data.len() && s.can_send() {
                sent += s.send_slice(&data[sent..]).unwrap();
            }
            if sent == data.len() && established && !closed {
                s.close();
                closed = true;
            }
            while s.can_recv() {
                s.recv(|b| {
                    got.extend_from_slice(b);
                    (b.len(), ())
                })
                .unwrap();
            }
            matches!(s.state(), tcp::State::Closed | tcp::State::TimeWait)
        });
        assert!(ok, "the connection to {to} never finished");
        established.then_some(got)
    }

    fn lookup(&mut self, name: &str, qtype: u16) -> Vec<u8> {
        let mut socket = udp::Socket::new(
            udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 4], vec![0; 4096]),
            udp::PacketBuffer::new(vec![udp::PacketMetadata::EMPTY; 4], vec![0; 4096]),
        );
        socket.bind(5353).unwrap();
        let h = self.sockets.add(socket);
        let mut q = vec![0x42, 0x42, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0];
        for label in name.split('.') {
            q.push(label.len() as u8);
            q.extend_from_slice(label.as_bytes());
        }
        q.extend_from_slice(&[0, (qtype >> 8) as u8, qtype as u8, 0, 1]);
        let to = IpEndpoint::new(IpAddress::Ipv4(GATEWAY_V4), 53);
        self.sockets
            .get_mut::<udp::Socket>(h)
            .send_slice(&q, to)
            .unwrap();
        let mut reply = Vec::new();
        assert!(self.run_until(|sockets| {
            if let Ok((data, _)) = sockets.get_mut::<udp::Socket>(h).recv() {
                reply = data.to_vec();
                return true;
            }
            false
        }));
        self.sockets.remove(h);
        reply
    }
}

fn rcode(reply: &[u8]) -> u8 {
    reply[3] & 0xf
}

fn last_a(reply: &[u8]) -> [u8; 4] {
    reply[reply.len() - 4..].try_into().unwrap()
}

#[test]
fn an_allowed_connection_carries_bytes_both_ways_and_closes() {
    let (_gateway, link) = gateway();
    let mut sandbox = Sandbox::new(link);
    let got = sandbox.exchange(UP, 40000, b"hello, upstream").unwrap();
    assert_eq!(got, b"HELLO, UPSTREAM");
    // A lot of data, both ways, through several windows of the buffers.
    let big: Vec<u8> = (0..2_000_000u32).map(|i| b'a' + (i % 26) as u8).collect();
    let got = sandbox.exchange(UP, 40001, &big).unwrap();
    assert_eq!(got.len(), big.len());
    assert_eq!(got, big.to_ascii_uppercase());
}

#[test]
fn refused_addresses_and_closed_ports_are_reset() {
    let (_gateway, link) = gateway();
    let mut sandbox = Sandbox::new(link);
    // Not allowed: never connected anywhere.
    let inside = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(10, 1, 2, 3)), 80);
    assert_eq!(sandbox.exchange(inside, 40010, b"x"), None);
    let gateway_itself = SocketAddr::new(IpAddr::V4(GATEWAY_V4), 22);
    assert_eq!(sandbox.exchange(gateway_itself, 40011, b"x"), None);
    // Allowed, but nothing listens there.
    let closed = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(203, 0, 113, 99)), 81);
    assert_eq!(sandbox.exchange(closed, 40012, b"x"), None);
    // And the allowed one still works afterwards.
    assert_eq!(sandbox.exchange(UP, 40013, b"ok").unwrap(), b"OK");
}

#[test]
fn several_connections_to_one_address_at_once_each_get_their_own_upstream() {
    let (_gateway, link) = gateway();
    let mut sandbox = Sandbox::new(link);
    let handles: Vec<SocketHandle> = (0..8).map(|i| sandbox.connect(UP, 41000 + i)).collect();
    let mut sent = vec![false; handles.len()];
    let mut got: Vec<Vec<u8>> = vec![Vec::new(); handles.len()];
    assert!(sandbox.run_until(|sockets| {
        let mut finished = 0;
        for (i, h) in handles.iter().enumerate() {
            let s = sockets.get_mut::<tcp::Socket>(*h);
            if s.can_send() && !sent[i] {
                s.send_slice(format!("conn {i}").as_bytes()).unwrap();
                s.close();
                sent[i] = true;
            }
            while s.can_recv() {
                s.recv(|b| {
                    got[i].extend_from_slice(b);
                    (b.len(), ())
                })
                .unwrap();
            }
            if matches!(s.state(), tcp::State::Closed | tcp::State::TimeWait) {
                finished += 1;
            }
        }
        finished == handles.len()
    }));
    for (i, g) in got.iter().enumerate() {
        assert_eq!(g, format!("CONN {i}").as_bytes());
    }
}

#[test]
fn names_resolve_to_allowed_addresses_and_the_loopback_only() {
    let (_gateway, link) = gateway();
    let mut sandbox = Sandbox::new(link);
    let up = sandbox.lookup("upstream.test", 1);
    assert_eq!((rcode(&up), last_a(&up)), (0, [203, 0, 113, 7]));
    // A name that resolves to an address the job may not reach is no
    // name at all.
    assert_eq!(rcode(&sandbox.lookup("inside.test", 1)), 3);
    assert_eq!(rcode(&sandbox.lookup("nowhere.test", 1)), 3);
    let local = sandbox.lookup("localhost", 1);
    assert_eq!((rcode(&local), last_a(&local)), (0, [127, 0, 0, 1]));
    let service = sandbox.lookup("postgres", 1);
    assert_eq!((rcode(&service), last_a(&service)), (0, [127, 0, 0, 1]));
    // No AAAA for an IPv4-only name, but the name exists.
    let v6 = sandbox.lookup("upstream.test", 28);
    assert_eq!((rcode(&v6), v6[7]), (0, 0));
}

#[test]
fn a_stopped_gateway_lets_its_thread_go() {
    let (mut gateway, link) = gateway();
    gateway.stop();
    drop(link);
}

/// One of the gateway's own ports goes to the runner's Unix socket for it,
/// and only that port, and only on the gateway's address: the same port
/// anywhere else is the internet's, and the gateway's other ports stay
/// closed.
#[test]
fn the_gateways_own_ports_reach_the_runners_sockets_and_nothing_else() {
    let dir = std::env::temp_dir().join(format!("iwci-net-local-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("cache.sock");
    let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { return };
            std::thread::spawn(move || {
                let mut got = Vec::new();
                let _ = stream.read_to_end(&mut got);
                let mut reply = b"local:".to_vec();
                reply.extend_from_slice(&got);
                let _ = stream.write_all(&reply);
            });
        }
    });
    let mut upstreams = HashMap::new();
    upstreams.insert(UP, shouting_upstream());
    let (_gateway, link) = Gateway::start(Network {
        outside: Arc::new(Fake {
            upstreams,
            names: HashMap::new(),
        }),
        services: Vec::new(),
        local: vec![(9119, path)],
    })
    .unwrap();
    let mut sandbox = Sandbox::new(link);
    let own = SocketAddr::new(IpAddr::V4(GATEWAY_V4), 9119);
    assert_eq!(sandbox.exchange(own, 42000, b"hi").unwrap(), b"local:hi");
    // Another port of the gateway is closed.
    let other = SocketAddr::new(IpAddr::V4(GATEWAY_V4), 9120);
    assert_eq!(sandbox.exchange(other, 42001, b"hi"), None);
    // The same port elsewhere is refused (not allowed) or the internet's.
    let elsewhere = SocketAddr::new(IpAddr::V4(Ipv4Addr::new(10, 1, 2, 3)), 9119);
    assert_eq!(sandbox.exchange(elsewhere, 42002, b"hi"), None);
    assert_eq!(sandbox.exchange(UP, 42003, b"up").unwrap(), b"UP");
    let _ = std::fs::remove_dir_all(dir);
}
