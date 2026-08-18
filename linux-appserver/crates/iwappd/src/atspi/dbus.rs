//! A hand-rolled D-Bus client, sized to what AT-SPI needs.
//!
//! Like the PulseAudio server in `crate::pulse`, this exists because the
//! alternative is a dependency tree running on someone else's machine: a
//! full D-Bus crate brings an async runtime along, and everything here fits
//! in the subset of the wire format the accessibility interfaces actually
//! use — fixed integers, strings, object paths, signatures, arrays, structs
//! and variants. No file-descriptor passing, no dict entries.
//!
//! Only little-endian peers are decoded. Every toolkit we can reach runs on
//! the same host as us, and we do not ship big-endian builds; a `B` message
//! is skipped by length rather than misread.

use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

pub const TYPE_METHOD_CALL: u8 = 1;
pub const TYPE_METHOD_RETURN: u8 = 2;
pub const TYPE_ERROR: u8 = 3;
pub const TYPE_SIGNAL: u8 = 4;

/// `NO_REPLY_EXPECTED` — a caller that set it must not be sent a return.
pub const FLAG_NO_REPLY: u8 = 0x1;

const FIELD_PATH: u8 = 1;
const FIELD_INTERFACE: u8 = 2;
const FIELD_MEMBER: u8 = 3;
const FIELD_ERROR_NAME: u8 = 4;
const FIELD_REPLY_SERIAL: u8 = 5;
const FIELD_DESTINATION: u8 = 6;
const FIELD_SENDER: u8 = 7;
const FIELD_SIGNATURE: u8 = 8;

/// Larger than any accessibility tree reply, smaller than a runaway peer.
const MAX_MESSAGE: usize = 8 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum DbusError {
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("bus refused authentication: {0}")]
    Auth(String),
    #[error("malformed message: {0}")]
    Protocol(String),
    #[error("{name}: {message}")]
    Call { name: String, message: String },
    #[error("timed out")]
    Deadline,
}

/// One parsed message, header fields flattened.
#[derive(Debug, Default, Clone)]
pub struct Message {
    pub kind: u8,
    pub flags: u8,
    pub serial: u32,
    pub reply_serial: Option<u32>,
    pub path: Option<String>,
    pub interface: Option<String>,
    pub member: Option<String>,
    pub error_name: Option<String>,
    pub sender: Option<String>,
    pub destination: Option<String>,
    pub signature: String,
    pub body: Vec<u8>,
}

impl Message {
    pub fn reader(&self) -> Reader<'_> {
        Reader::new(&self.body)
    }

    /// The human-readable half of an error reply, when it carries one.
    pub fn error_message(&self) -> String {
        self.reader().string().unwrap_or_default()
    }
}

/// Marshals a body (or a header). Alignment is relative to the start of the
/// buffer, which for a body is what the spec wants: the body begins on an
/// 8-byte boundary of the full message.
#[derive(Default)]
pub struct Writer {
    pub buf: Vec<u8>,
}

impl Writer {
    pub fn align(&mut self, n: usize) {
        while self.buf.len() % n != 0 {
            self.buf.push(0);
        }
    }

    pub fn byte(&mut self, v: u8) {
        self.buf.push(v);
    }

    pub fn u32(&mut self, v: u32) {
        self.align(4);
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    pub fn i32(&mut self, v: i32) {
        self.align(4);
        self.buf.extend_from_slice(&v.to_le_bytes());
    }

    /// `s` and `o` share a layout: aligned u32 length, bytes, NUL.
    pub fn string(&mut self, v: &str) {
        self.u32(v.len() as u32);
        self.buf.extend_from_slice(v.as_bytes());
        self.buf.push(0);
    }

    /// `g`: unaligned u8 length, bytes, NUL.
    pub fn signature(&mut self, v: &str) {
        self.buf.push(v.len() as u8);
        self.buf.extend_from_slice(v.as_bytes());
        self.buf.push(0);
    }

    /// `(so)` — the object reference AT-SPI passes everywhere.
    pub fn name_and_path(&mut self, name: &str, path: &str) {
        self.align(8);
        self.string(name);
        self.string(path);
    }
}

/// Unmarshals against the same rules. Positions are relative to the slice,
/// which must itself start on an 8-byte boundary of the message it came from.
pub struct Reader<'a> {
    data: &'a [u8],
    pub pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(data: &'a [u8]) -> Self {
        Self { data, pos: 0 }
    }

    fn need(&self, n: usize) -> Result<(), DbusError> {
        if self.pos + n > self.data.len() {
            return Err(DbusError::Protocol(format!(
                "truncated at {} of {}",
                self.pos,
                self.data.len()
            )));
        }
        Ok(())
    }

    pub fn align(&mut self, n: usize) -> Result<(), DbusError> {
        while self.pos % n != 0 {
            self.need(1)?;
            self.pos += 1;
        }
        Ok(())
    }

    pub fn byte(&mut self) -> Result<u8, DbusError> {
        self.need(1)?;
        let v = self.data[self.pos];
        self.pos += 1;
        Ok(v)
    }

    pub fn u32(&mut self) -> Result<u32, DbusError> {
        self.align(4)?;
        self.need(4)?;
        let v = u32::from_le_bytes(self.data[self.pos..self.pos + 4].try_into().unwrap());
        self.pos += 4;
        Ok(v)
    }

    pub fn i32(&mut self) -> Result<i32, DbusError> {
        Ok(self.u32()? as i32)
    }

    pub fn f64(&mut self) -> Result<f64, DbusError> {
        self.align(8)?;
        self.need(8)?;
        let v = f64::from_le_bytes(self.data[self.pos..self.pos + 8].try_into().unwrap());
        self.pos += 8;
        Ok(v)
    }

    pub fn string(&mut self) -> Result<String, DbusError> {
        let len = self.u32()? as usize;
        self.need(len + 1)?;
        let text = std::str::from_utf8(&self.data[self.pos..self.pos + len])
            .map_err(|_| DbusError::Protocol("string is not utf-8".into()))?
            .to_owned();
        self.pos += len + 1;
        Ok(text)
    }

    pub fn signature(&mut self) -> Result<String, DbusError> {
        let len = self.byte()? as usize;
        self.need(len + 1)?;
        let text = std::str::from_utf8(&self.data[self.pos..self.pos + len])
            .map_err(|_| DbusError::Protocol("signature is not utf-8".into()))?
            .to_owned();
        self.pos += len + 1;
        Ok(text)
    }

    /// Position just past the array whose length header is next. The caller
    /// aligns to the element type before this per the spec: the length counts
    /// element bytes only, starting after that padding.
    pub fn enter_array(&mut self, element_alignment: usize) -> Result<usize, DbusError> {
        let len = self.u32()? as usize;
        self.align(element_alignment)?;
        let end = self.pos + len;
        if end > self.data.len() {
            return Err(DbusError::Protocol("array overruns message".into()));
        }
        Ok(end)
    }

    /// Structs align to 8 regardless of their contents.
    pub fn enter_struct(&mut self) -> Result<(), DbusError> {
        self.align(8)
    }

    /// Reads `(so)` — the object reference AT-SPI passes everywhere.
    pub fn name_and_path(&mut self) -> Result<(String, String), DbusError> {
        self.enter_struct()?;
        Ok((self.string()?, self.string()?))
    }
}

/// A method call about to be sent.
pub struct MethodCall<'a> {
    pub destination: &'a str,
    pub path: &'a str,
    pub interface: &'a str,
    pub member: &'a str,
    pub signature: &'a str,
    pub body: &'a [u8],
}

fn header_field_string(w: &mut Writer, code: u8, signature: &str, value: &str) {
    w.align(8);
    w.byte(code);
    w.signature(signature);
    w.string(value);
}

fn finish_message(mut header: Writer, fields_start: usize, body: &[u8]) -> Vec<u8> {
    let fields_len = (header.buf.len() - fields_start) as u32;
    header.buf[fields_start - 4..fields_start].copy_from_slice(&fields_len.to_le_bytes());
    header.align(8);
    header.buf.extend_from_slice(body);
    header.buf
}

fn message_prefix(kind: u8, flags: u8, body_len: usize, serial: u32) -> (Writer, usize) {
    let mut w = Writer::default();
    w.byte(b'l');
    w.byte(kind);
    w.byte(flags);
    w.byte(1);
    w.u32(body_len as u32);
    w.u32(serial);
    // Field-array length, patched in finish_message once the fields exist.
    w.u32(0);
    let fields_start = w.buf.len();
    (w, fields_start)
}

pub fn encode_method_call(serial: u32, call: &MethodCall<'_>) -> Vec<u8> {
    let (mut w, fields_start) = message_prefix(TYPE_METHOD_CALL, 0, call.body.len(), serial);
    header_field_string(&mut w, FIELD_PATH, "o", call.path);
    header_field_string(&mut w, FIELD_INTERFACE, "s", call.interface);
    header_field_string(&mut w, FIELD_MEMBER, "s", call.member);
    header_field_string(&mut w, FIELD_DESTINATION, "s", call.destination);
    if !call.signature.is_empty() {
        w.align(8);
        w.byte(FIELD_SIGNATURE);
        w.signature("g");
        w.signature(call.signature);
    }
    finish_message(w, fields_start, call.body)
}

pub fn encode_method_return(
    serial: u32,
    reply_to: u32,
    destination: &str,
    signature: &str,
    body: &[u8],
) -> Vec<u8> {
    let (mut w, fields_start) =
        message_prefix(TYPE_METHOD_RETURN, FLAG_NO_REPLY, body.len(), serial);
    w.align(8);
    w.byte(FIELD_REPLY_SERIAL);
    w.signature("u");
    w.u32(reply_to);
    header_field_string(&mut w, FIELD_DESTINATION, "s", destination);
    if !signature.is_empty() {
        w.align(8);
        w.byte(FIELD_SIGNATURE);
        w.signature("g");
        w.signature(signature);
    }
    finish_message(w, fields_start, body)
}

pub fn encode_error(
    serial: u32,
    reply_to: u32,
    destination: &str,
    error_name: &str,
    text: &str,
) -> Vec<u8> {
    let mut body = Writer::default();
    body.string(text);
    let (mut w, fields_start) = message_prefix(TYPE_ERROR, FLAG_NO_REPLY, body.buf.len(), serial);
    header_field_string(&mut w, FIELD_ERROR_NAME, "s", error_name);
    w.align(8);
    w.byte(FIELD_REPLY_SERIAL);
    w.signature("u");
    w.u32(reply_to);
    header_field_string(&mut w, FIELD_DESTINATION, "s", destination);
    w.align(8);
    w.byte(FIELD_SIGNATURE);
    w.signature("g");
    w.signature("s");
    finish_message(w, fields_start, &body.buf)
}

/// Parse one message off the front of `buf`. `Ok(None)` when more bytes are
/// needed; the `usize` is how many bytes the message consumed.
pub fn parse_message(buf: &[u8]) -> Result<Option<(Message, usize)>, DbusError> {
    if buf.len() < 16 {
        return Ok(None);
    }
    let big_endian = match buf[0] {
        b'l' => false,
        b'B' => true,
        other => {
            return Err(DbusError::Protocol(format!(
                "bad endianness byte {other:#x}"
            )));
        }
    };
    let read_u32 = |bytes: &[u8]| -> u32 {
        let raw: [u8; 4] = bytes.try_into().unwrap();
        if big_endian {
            u32::from_be_bytes(raw)
        } else {
            u32::from_le_bytes(raw)
        }
    };
    let body_len = read_u32(&buf[4..8]) as usize;
    let serial = read_u32(&buf[8..12]);
    let fields_len = read_u32(&buf[12..16]) as usize;
    let header_end = (16 + fields_len).div_ceil(8) * 8;
    let total = header_end + body_len;
    if total > MAX_MESSAGE {
        return Err(DbusError::Protocol(format!("{total} byte message")));
    }
    if buf.len() < total {
        return Ok(None);
    }
    if big_endian {
        // Skipped rather than misread; see the module comment.
        return Ok(Some((
            Message {
                kind: 0,
                ..Message::default()
            },
            total,
        )));
    }

    let mut message = Message {
        kind: buf[1],
        flags: buf[2],
        serial,
        body: buf[header_end..total].to_vec(),
        ..Message::default()
    };

    let mut r = Reader::new(&buf[..16 + fields_len]);
    r.pos = 16;
    while r.pos < 16 + fields_len {
        r.align(8)?;
        if r.pos >= 16 + fields_len {
            break;
        }
        let code = r.byte()?;
        let signature = r.signature()?;
        match (code, signature.as_str()) {
            (FIELD_PATH, "o") => message.path = Some(r.string()?),
            (FIELD_INTERFACE, "s") => message.interface = Some(r.string()?),
            (FIELD_MEMBER, "s") => message.member = Some(r.string()?),
            (FIELD_ERROR_NAME, "s") => message.error_name = Some(r.string()?),
            (FIELD_REPLY_SERIAL, "u") => message.reply_serial = Some(r.u32()?),
            (FIELD_DESTINATION, "s") => message.destination = Some(r.string()?),
            (FIELD_SENDER, "s") => message.sender = Some(r.string()?),
            (FIELD_SIGNATURE, "g") => message.signature = r.signature()?,
            // UNIX_FDS or a future field: skip by its signature. Only the
            // fixed-width and string-ish cases exist in headers today.
            (_, "u") => {
                r.u32()?;
            }
            (_, "s") | (_, "o") => {
                r.string()?;
            }
            (_, "g") => {
                r.signature()?;
            }
            (_, other) => {
                return Err(DbusError::Protocol(format!(
                    "unexpected header field {code} of type {other}"
                )));
            }
        }
    }

    Ok(Some((message, total)))
}

/// A connected, authenticated bus connection.
pub struct Connection {
    stream: UnixStream,
    inbox: Vec<u8>,
    next_serial: u32,
    /// Our unique name, once `Hello` has been answered.
    pub unique_name: String,
}

impl Connection {
    /// Dial a `unix:` bus address, authenticate, and say Hello.
    pub fn connect(address: &str) -> Result<Self, DbusError> {
        let stream = dial(address)?;
        let mut connection = Self {
            stream,
            inbox: Vec::new(),
            next_serial: 1,
            unique_name: String::new(),
        };
        connection.authenticate()?;
        let reply = connection.call(
            &MethodCall {
                destination: "org.freedesktop.DBus",
                path: "/org/freedesktop/DBus",
                interface: "org.freedesktop.DBus",
                member: "Hello",
                signature: "",
                body: &[],
            },
            std::time::Instant::now() + Duration::from_secs(5),
            &mut |_| {},
        )?;
        connection.unique_name = reply.reader().string()?;
        Ok(connection)
    }

    fn authenticate(&mut self) -> Result<(), DbusError> {
        let uid = crate::launch_env::current_uid().to_string();
        let hex: String = uid.bytes().map(|b| format!("{b:02x}")).collect();
        self.stream
            .write_all(format!("\0AUTH EXTERNAL {hex}\r\n").as_bytes())?;
        let line = self.read_auth_line()?;
        if !line.starts_with("OK") {
            return Err(DbusError::Auth(line));
        }
        self.stream.write_all(b"BEGIN\r\n")?;
        Ok(())
    }

    fn read_auth_line(&mut self) -> Result<String, DbusError> {
        self.stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        let mut line = Vec::new();
        let mut byte = [0u8; 1];
        loop {
            let n = self.stream.read(&mut byte)?;
            if n == 0 {
                return Err(DbusError::Auth("bus closed during auth".into()));
            }
            if byte[0] == b'\n' {
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return Ok(String::from_utf8_lossy(&line).into_owned());
            }
            line.push(byte[0]);
            if line.len() > 4096 {
                return Err(DbusError::Auth("oversized auth line".into()));
            }
        }
    }

    pub fn send_raw(&mut self, bytes: &[u8]) -> Result<(), DbusError> {
        self.stream.write_all(bytes)?;
        Ok(())
    }

    pub fn take_serial(&mut self) -> u32 {
        let serial = self.next_serial;
        self.next_serial = self.next_serial.wrapping_add(1).max(1);
        serial
    }

    /// Send a call without waiting for its reply. Returns the serial.
    pub fn send_call(&mut self, call: &MethodCall<'_>) -> Result<u32, DbusError> {
        let serial = self.take_serial();
        let bytes = encode_method_call(serial, call);
        self.send_raw(&bytes)?;
        Ok(serial)
    }

    /// Send a call and wait for its reply, handing every *other* inbound
    /// message to `sideline` — incoming method calls (an application embedding
    /// itself mid-walk) must keep being answered or its toolkit stalls.
    pub fn call(
        &mut self,
        call: &MethodCall<'_>,
        deadline: std::time::Instant,
        sideline: &mut dyn FnMut(&Message),
    ) -> Result<Message, DbusError> {
        let serial = self.send_call(call)?;
        loop {
            let now = std::time::Instant::now();
            if now >= deadline {
                return Err(DbusError::Deadline);
            }
            let Some(message) = self.read_message(deadline - now)? else {
                continue;
            };
            if message.reply_serial == Some(serial) {
                if message.kind == TYPE_ERROR {
                    return Err(DbusError::Call {
                        name: message.error_name.clone().unwrap_or_default(),
                        message: message.error_message(),
                    });
                }
                return Ok(message);
            }
            sideline(&message);
        }
    }

    /// One message, or `None` if nothing complete arrived within `wait`.
    pub fn read_message(&mut self, wait: Duration) -> Result<Option<Message>, DbusError> {
        loop {
            match parse_message(&self.inbox)? {
                Some((message, used)) => {
                    self.inbox.drain(..used);
                    // kind 0 is a skipped foreign-endian message.
                    if message.kind == 0 {
                        continue;
                    }
                    return Ok(Some(message));
                }
                None => {
                    self.stream
                        .set_read_timeout(Some(wait.max(Duration::from_millis(1))))?;
                    let mut chunk = [0u8; 16 * 1024];
                    match self.stream.read(&mut chunk) {
                        Ok(0) => {
                            return Err(DbusError::Io(std::io::Error::new(
                                std::io::ErrorKind::UnexpectedEof,
                                "bus closed",
                            )));
                        }
                        Ok(n) => {
                            self.inbox.extend_from_slice(&chunk[..n]);
                            continue;
                        }
                        Err(err)
                            if err.kind() == std::io::ErrorKind::WouldBlock
                                || err.kind() == std::io::ErrorKind::TimedOut =>
                        {
                            return Ok(None);
                        }
                        Err(err) => return Err(err.into()),
                    }
                }
            }
        }
    }
}

/// Connect to the socket a `unix:` bus address names.
fn dial(address: &str) -> Result<UnixStream, DbusError> {
    // Addresses can list alternatives separated by `;`; each is
    // `transport:key=value,key=value`.
    for candidate in address.split(';') {
        let Some(rest) = candidate.strip_prefix("unix:") else {
            continue;
        };
        for pair in rest.split(',') {
            if let Some(path) = pair.strip_prefix("path=") {
                return Ok(UnixStream::connect(path)?);
            }
            #[cfg(target_os = "linux")]
            if let Some(name) = pair.strip_prefix("abstract=") {
                use std::os::linux::net::SocketAddrExt;
                let addr = std::os::unix::net::SocketAddr::from_abstract_name(name.as_bytes())?;
                return Ok(UnixStream::connect_addr(&addr)?);
            }
        }
    }
    Err(DbusError::Protocol(format!(
        "no dialable unix transport in bus address {address:?}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_method_call_round_trips_through_the_parser() {
        let mut body = Writer::default();
        body.string("org.a11y.atspi.Accessible");
        body.string("Name");
        let bytes = encode_method_call(
            7,
            &MethodCall {
                destination: ":1.42",
                path: "/org/a11y/atspi/accessible/root",
                interface: "org.freedesktop.DBus.Properties",
                member: "Get",
                signature: "ss",
                body: &body.buf,
            },
        );
        let (message, used) = parse_message(&bytes).unwrap().unwrap();
        assert_eq!(used, bytes.len());
        assert_eq!(message.kind, TYPE_METHOD_CALL);
        assert_eq!(message.serial, 7);
        assert_eq!(message.destination.as_deref(), Some(":1.42"));
        assert_eq!(
            message.path.as_deref(),
            Some("/org/a11y/atspi/accessible/root")
        );
        assert_eq!(message.member.as_deref(), Some("Get"));
        assert_eq!(message.signature, "ss");
        let mut r = message.reader();
        assert_eq!(r.string().unwrap(), "org.a11y.atspi.Accessible");
        assert_eq!(r.string().unwrap(), "Name");
    }

    #[test]
    fn a_return_and_an_error_round_trip() {
        let mut body = Writer::default();
        body.name_and_path("org.a11y.atspi.Registry", "/org/a11y/atspi/accessible/root");
        let bytes = encode_method_return(3, 9, ":1.7", "(so)", &body.buf);
        let (message, _) = parse_message(&bytes).unwrap().unwrap();
        assert_eq!(message.kind, TYPE_METHOD_RETURN);
        assert_eq!(message.reply_serial, Some(9));
        let mut r = message.reader();
        let (name, path) = r.name_and_path().unwrap();
        assert_eq!(name, "org.a11y.atspi.Registry");
        assert_eq!(path, "/org/a11y/atspi/accessible/root");

        let bytes = encode_error(
            4,
            9,
            ":1.7",
            "org.freedesktop.DBus.Error.UnknownMethod",
            "no",
        );
        let (message, _) = parse_message(&bytes).unwrap().unwrap();
        assert_eq!(message.kind, TYPE_ERROR);
        assert_eq!(
            message.error_name.as_deref(),
            Some("org.freedesktop.DBus.Error.UnknownMethod")
        );
        assert_eq!(message.error_message(), "no");
    }

    #[test]
    fn partial_and_foreign_endian_messages_are_handled() {
        let bytes = encode_method_call(
            1,
            &MethodCall {
                destination: "d",
                path: "/p",
                interface: "i.f",
                member: "M",
                signature: "",
                body: &[],
            },
        );
        assert!(parse_message(&bytes[..10]).unwrap().is_none());
        assert!(parse_message(&bytes[..bytes.len() - 1]).unwrap().is_none());

        // A big-endian copy is skipped whole, not misread.
        let mut be = bytes.clone();
        be[0] = b'B';
        be[4..8].reverse();
        be[8..12].reverse();
        be[12..16].reverse();
        let (skipped, used) = parse_message(&be).unwrap().unwrap();
        assert_eq!(skipped.kind, 0);
        assert_eq!(used, bytes.len());
    }

    #[test]
    fn arrays_align_their_elements_after_the_length() {
        // a(so): the length is at 4-alignment, the first struct at 8. Written
        // by hand to pin the padding rules the reader assumes.
        let mut w = Writer::default();
        w.byte(0); // force interesting alignment
        w.align(4);
        let len_at = w.buf.len();
        w.u32(0);
        w.align(8);
        let start = w.buf.len();
        w.align(8);
        w.string(":1.9");
        w.string("/root");
        let array_len = (w.buf.len() - start) as u32;
        w.buf[len_at..len_at + 4].copy_from_slice(&array_len.to_le_bytes());

        let mut r = Reader::new(&w.buf);
        r.byte().unwrap();
        let end = r.enter_array(8).unwrap();
        let (name, path) = r.name_and_path().unwrap();
        assert_eq!((name.as_str(), path.as_str()), (":1.9", "/root"));
        assert_eq!(r.pos, end);
    }
}
