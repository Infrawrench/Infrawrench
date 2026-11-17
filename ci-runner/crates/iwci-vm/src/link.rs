//! A machine's one network link, and how it reaches the runner's gateway.
//!
//! QEMU sends the machine's Ethernet frames over a Unix stream socket
//! (`-netdev stream`, QEMU 7.2 and later), each as a 4-byte big-endian
//! length and the frame (QEMU's `net/stream_data.c`). The runner's gateway
//! (`iwci_sandbox::net`, the one a gVisor sandbox's network goes through)
//! takes raw IP packets. Between the two sits this: it answers the
//! machine's ARP requests for any address on its link with the gateway's
//! MAC, passes IPv4 packets on, and wraps what the gateway sends back in
//! an Ethernet header addressed to the machine. IPv6 is not offered (the
//! machine is started with it off), and nothing but ARP and IPv4 crosses.
//!
//! So a machine reaches what any job reaches, through the same policy
//! (`Outside::allows`, on the address actually connected to): the public
//! internet, never the host, its loopback or a private address.

use std::io::{self, Read, Write};

use iwci_vm_proto::{GATEWAY_MAC, GUEST_IPV4, GUEST_MAC};

const ETHERTYPE_IPV4: u16 = 0x0800;
const ETHERTYPE_ARP: u16 = 0x0806;
/// The largest frame either way: an MTU of 65,000 (the gateway's) plus
/// the Ethernet header, rounded up.
pub const MAX_FRAME: usize = 65_536 + 14;

/// Reads one frame of QEMU's stream, or `None` at its end.
pub fn read_frame(r: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    let mut got = 0;
    while got < 4 {
        match r.read(&mut len[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    let len = u32::from_be_bytes(len) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("a frame of {len} bytes"),
        ));
    }
    let mut frame = vec![0u8; len];
    r.read_exact(&mut frame)?;
    Ok(Some(frame))
}

/// Writes one frame to QEMU's stream.
pub fn write_frame(w: &mut impl Write, frame: &[u8]) -> io::Result<()> {
    let mut out = Vec::with_capacity(frame.len() + 4);
    out.extend_from_slice(&(frame.len() as u32).to_be_bytes());
    out.extend_from_slice(frame);
    w.write_all(&out)
}

/// What to do with a frame from the machine.
#[derive(Debug, PartialEq, Eq)]
pub enum FromGuest<'a> {
    /// An IPv4 packet for the gateway.
    Packet(&'a [u8]),
    /// A frame to send straight back (an ARP reply).
    Reply(Vec<u8>),
    Drop,
}

fn ethertype(frame: &[u8]) -> Option<u16> {
    (frame.len() >= 14).then(|| u16::from_be_bytes([frame[12], frame[13]]))
}

/// Decides what a frame from the machine is.
pub fn from_guest(frame: &[u8]) -> FromGuest<'_> {
    match ethertype(frame) {
        Some(ETHERTYPE_IPV4) if frame.len() > 14 + 20 => FromGuest::Packet(&frame[14..]),
        Some(ETHERTYPE_ARP) => arp_reply(&frame[14..]).map_or(FromGuest::Drop, FromGuest::Reply),
        _ => FromGuest::Drop,
    }
}

/// An ARP reply to a request for any IPv4 address but the machine's own
/// (a machine probing for a duplicate of its address must hear nothing):
/// on this link everything is the gateway.
fn arp_reply(arp: &[u8]) -> Option<Vec<u8>> {
    // Ethernet + IPv4 ARP is 28 bytes: htype 1, ptype 0x0800, hlen 6,
    // plen 4, op, sender MAC and IP, target MAC and IP.
    if arp.len() < 28
        || arp[0..2] != [0, 1]
        || arp[2..4] != [0x08, 0x00]
        || arp[4] != 6
        || arp[5] != 4
        || arp[6..8] != [0, 1]
    {
        return None;
    }
    let sender_mac = &arp[8..14];
    let sender_ip = &arp[14..18];
    let target_ip = &arp[24..28];
    if target_ip == GUEST_IPV4 || target_ip == sender_ip {
        return None;
    }
    let mut out = Vec::with_capacity(42);
    out.extend_from_slice(sender_mac);
    out.extend_from_slice(&GATEWAY_MAC);
    out.extend_from_slice(&ETHERTYPE_ARP.to_be_bytes());
    out.extend_from_slice(&[0, 1, 0x08, 0x00, 6, 4, 0, 2]);
    out.extend_from_slice(&GATEWAY_MAC);
    out.extend_from_slice(target_ip);
    out.extend_from_slice(sender_mac);
    out.extend_from_slice(sender_ip);
    Some(out)
}

/// A packet from the gateway as a frame for the machine, or `None` for
/// anything that is not IPv4.
pub fn to_guest(packet: &[u8]) -> Option<Vec<u8>> {
    if packet.first().map(|b| b >> 4) != Some(4) {
        return None;
    }
    let mut frame = Vec::with_capacity(packet.len() + 14);
    frame.extend_from_slice(&GUEST_MAC);
    frame.extend_from_slice(&GATEWAY_MAC);
    frame.extend_from_slice(&ETHERTYPE_IPV4.to_be_bytes());
    frame.extend_from_slice(packet);
    Some(frame)
}

/// The two pumps between QEMU's stream and the gateway's packet socket.
#[cfg(target_os = "linux")]
pub mod bridge {
    use std::io;
    use std::os::fd::{AsRawFd, OwnedFd};
    use std::os::unix::net::UnixStream;
    use std::sync::{Arc, Mutex};
    use std::thread::JoinHandle;

    use super::{FromGuest, from_guest, read_frame, to_guest, write_frame};

    /// Pumps frames until either side ends. `link` is the gateway's end
    /// of its packet socket (`SOCK_SEQPACKET`, one IP packet per message).
    pub fn start(stream: UnixStream, link: OwnedFd) -> io::Result<Vec<JoinHandle<()>>> {
        let link = Arc::new(link);
        let writer = Arc::new(Mutex::new(stream.try_clone()?));
        let mut reader = stream;
        let out = link.clone();
        let replies = writer.clone();
        let up = std::thread::Builder::new()
            .name("iwci-vm-net-up".into())
            .spawn(move || {
                while let Ok(Some(frame)) = read_frame(&mut reader) {
                    match from_guest(&frame) {
                        FromGuest::Packet(packet) => {
                            // SAFETY: a write of a buffer we own to a
                            // socket we hold open.
                            let n = unsafe {
                                libc::send(
                                    out.as_raw_fd(),
                                    packet.as_ptr().cast(),
                                    packet.len(),
                                    libc::MSG_NOSIGNAL,
                                )
                            };
                            if n < 0
                                && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted
                                && io::Error::last_os_error().raw_os_error() != Some(libc::ENOBUFS)
                            {
                                break;
                            }
                        }
                        FromGuest::Reply(reply) => {
                            let mut w = replies.lock().unwrap_or_else(|e| e.into_inner());
                            if write_frame(&mut *w, &reply).is_err() {
                                break;
                            }
                        }
                        FromGuest::Drop => {}
                    }
                }
                // The machine is gone: let the other pump see the end too.
                let w = replies.lock().unwrap_or_else(|e| e.into_inner());
                let _ = w.shutdown(std::net::Shutdown::Both);
            })?;
        let down = std::thread::Builder::new()
            .name("iwci-vm-net-down".into())
            .spawn(move || {
                let mut buf = vec![0u8; super::MAX_FRAME];
                loop {
                    // SAFETY: a read into a buffer we own from a socket we
                    // hold open.
                    let n = unsafe {
                        libc::recv(link.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len(), 0)
                    };
                    if n < 0 {
                        if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                            continue;
                        }
                        break;
                    }
                    if n == 0 {
                        break;
                    }
                    let Some(frame) = to_guest(&buf[..n as usize]) else {
                        continue;
                    };
                    let mut w = writer.lock().unwrap_or_else(|e| e.into_inner());
                    if write_frame(&mut *w, &frame).is_err() {
                        break;
                    }
                }
            })?;
        Ok(vec![up, down])
    }

    /// For a machine whose network is off but whose saved state has a
    /// network device: takes its frames and sends nothing back.
    pub fn sink(stream: UnixStream) -> io::Result<JoinHandle<()>> {
        std::thread::Builder::new()
            .name("iwci-vm-net-sink".into())
            .spawn(move || {
                let mut reader = stream;
                while let Ok(Some(_)) = read_frame(&mut reader) {}
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn arp_request(target: [u8; 4]) -> Vec<u8> {
        let mut f = vec![0xff; 6];
        f.extend_from_slice(&GUEST_MAC);
        f.extend_from_slice(&ETHERTYPE_ARP.to_be_bytes());
        f.extend_from_slice(&[0, 1, 0x08, 0x00, 6, 4, 0, 1]);
        f.extend_from_slice(&GUEST_MAC);
        f.extend_from_slice(&GUEST_IPV4);
        f.extend_from_slice(&[0; 6]);
        f.extend_from_slice(&target);
        f
    }

    #[test]
    fn answers_arp_for_the_gateway_and_any_neighbour_but_not_itself() {
        let FromGuest::Reply(reply) = from_guest(&arp_request([10, 0, 2, 2])) else {
            panic!("no reply");
        };
        assert_eq!(&reply[0..6], &GUEST_MAC);
        assert_eq!(&reply[6..12], &GATEWAY_MAC);
        assert_eq!(&reply[20..22], &[0, 2]);
        assert_eq!(&reply[22..28], &GATEWAY_MAC);
        assert_eq!(&reply[28..32], &[10, 0, 2, 2]);
        assert_eq!(&reply[32..38], &GUEST_MAC);
        assert_eq!(&reply[38..42], &GUEST_IPV4);
        assert!(matches!(
            from_guest(&arp_request([10, 0, 2, 9])),
            FromGuest::Reply(_)
        ));
        // A duplicate address probe for its own address hears nothing.
        assert_eq!(from_guest(&arp_request(GUEST_IPV4)), FromGuest::Drop);
    }

    #[test]
    fn passes_ipv4_and_drops_the_rest() {
        let mut ip = vec![0x45u8; 40];
        ip[0] = 0x45;
        let frame = to_guest(&ip).unwrap();
        assert_eq!(&frame[0..6], &GUEST_MAC);
        assert_eq!(from_guest(&frame), FromGuest::Packet(&ip[..]));
        assert_eq!(to_guest(&[0x60; 40]), None);
        let mut v6 = frame.clone();
        v6[12..14].copy_from_slice(&0x86ddu16.to_be_bytes());
        assert_eq!(from_guest(&v6), FromGuest::Drop);
        assert_eq!(from_guest(&[0; 10]), FromGuest::Drop);
    }

    #[test]
    fn stream_frames_are_length_prefixed_big_endian() {
        let mut wire = Vec::new();
        write_frame(&mut wire, b"abc").unwrap();
        assert_eq!(wire, [0, 0, 0, 3, b'a', b'b', b'c']);
        let mut r = wire.as_slice();
        assert_eq!(read_frame(&mut r).unwrap(), Some(b"abc".to_vec()));
        assert_eq!(read_frame(&mut r).unwrap(), None);
        assert!(read_frame(&mut [0u8, 0xff, 0xff, 0xff].as_slice()).is_err());
    }
}
