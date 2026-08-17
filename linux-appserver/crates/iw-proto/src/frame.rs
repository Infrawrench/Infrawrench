//! Frame envelope: length prefix, kind byte, window id, opaque payload.

use crate::ProtocolError;

/// Bytes of header that live inside `len` (kind + window id).
const HEADER_LEN: u32 = 5;

/// Hard ceiling on a single frame. A 4K window of BGRA pixels is ~33 MB
/// uncompressed and we never send one uncompressed, so anything past this is a
/// desynchronised stream rather than a legitimate frame — fail loudly instead
/// of allocating on a peer's say-so.
pub const MAX_FRAME_LEN: u32 = 64 * 1024 * 1024;

/// What a frame's payload is. The high bit marks host → client so a stray
/// frame going the wrong way is obvious in a hex dump.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum FrameKind {
    /// JSON [`crate::ClientMessage`].
    ControlClient = 0x01,
    /// Packed [`crate::InputEvent`] batch, window-scoped.
    Input = 0x02,
    /// Clipboard payload client → host: `u16 mime_len | mime | bytes`.
    ClipboardClient = 0x03,
    /// JSON [`crate::ServerMessage`].
    ControlServer = 0x81,
    /// Encoded pixels for the frame's window (see `iw-codec`).
    Pixels = 0x82,
    /// Clipboard payload host → client, same layout as [`Self::ClipboardClient`].
    ClipboardServer = 0x83,
    /// Mixed session audio host → client (see [`crate::AudioChunk`]). Only
    /// sent to a client whose caps said `audio`, because an unknown kind is a
    /// protocol error on the other end, not a skipped frame.
    Audio = 0x84,
}

impl FrameKind {
    fn from_u8(value: u8) -> Result<Self, ProtocolError> {
        Ok(match value {
            0x01 => Self::ControlClient,
            0x02 => Self::Input,
            0x03 => Self::ClipboardClient,
            0x81 => Self::ControlServer,
            0x82 => Self::Pixels,
            0x83 => Self::ClipboardServer,
            0x84 => Self::Audio,
            other => return Err(ProtocolError::UnknownKind(other)),
        })
    }
}

/// One decoded frame. `payload` is owned because the decoder's buffer is
/// reused across frames and a borrow would pin it for the frame's lifetime.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: FrameKind,
    pub window_id: u32,
    pub payload: Vec<u8>,
}

/// Serialise a frame onto the wire.
pub fn encode_frame(kind: FrameKind, window_id: u32, payload: &[u8]) -> Vec<u8> {
    let len = HEADER_LEN as usize + payload.len();
    let mut out = Vec::with_capacity(4 + len);
    out.extend_from_slice(&(len as u32).to_le_bytes());
    out.push(kind as u8);
    out.extend_from_slice(&window_id.to_le_bytes());
    out.extend_from_slice(payload);
    out
}

/// Incremental frame decoder. Feed it whatever the transport hands you —
/// SSH gives us arbitrary chunk boundaries, often mid-header — and pull whole
/// frames out until it returns `None`.
#[derive(Debug, Default)]
pub struct FrameDecoder {
    buf: Vec<u8>,
    /// Read cursor into `buf`; the buffer is compacted lazily so a busy stream
    /// does not memmove on every frame.
    start: usize,
}

impl FrameDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append received bytes.
    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    /// Bytes received but not yet consumed by a complete frame.
    pub fn buffered(&self) -> usize {
        self.buf.len() - self.start
    }

    /// Pull the next complete frame, if one has arrived.
    pub fn next_frame(&mut self) -> Result<Option<Frame>, ProtocolError> {
        let available = self.buffered();
        if available < 4 {
            return Ok(None);
        }
        let len_bytes: [u8; 4] = self.buf[self.start..self.start + 4]
            .try_into()
            .expect("slice is exactly 4 bytes");
        let len = u32::from_le_bytes(len_bytes);
        if len > MAX_FRAME_LEN {
            return Err(ProtocolError::FrameTooLarge(len));
        }
        if len < HEADER_LEN {
            return Err(ProtocolError::FrameTooShort(len, HEADER_LEN));
        }
        if available < 4 + len as usize {
            return Ok(None);
        }

        let body = self.start + 4;
        let kind = FrameKind::from_u8(self.buf[body])?;
        let window_id = u32::from_le_bytes(
            self.buf[body + 1..body + 5]
                .try_into()
                .expect("slice is exactly 4 bytes"),
        );
        let payload = self.buf[body + HEADER_LEN as usize..body + len as usize].to_vec();

        self.start = body + len as usize;
        self.compact();

        Ok(Some(Frame {
            kind,
            window_id,
            payload,
        }))
    }

    /// Drop consumed bytes once they dominate the buffer. Doing this eagerly
    /// would memmove the tail on every frame; doing it never would grow the
    /// buffer without bound on a long-lived session.
    fn compact(&mut self) {
        if self.start == self.buf.len() {
            self.buf.clear();
            self.start = 0;
        } else if self.start > 64 * 1024 && self.start * 2 > self.buf.len() {
            self.buf.drain(..self.start);
            self.start = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_a_frame() {
        let bytes = encode_frame(FrameKind::Pixels, 7, b"pixels");
        let mut dec = FrameDecoder::new();
        dec.push(&bytes);
        let frame = dec.next_frame().unwrap().unwrap();
        assert_eq!(frame.kind, FrameKind::Pixels);
        assert_eq!(frame.window_id, 7);
        assert_eq!(frame.payload, b"pixels");
        assert!(dec.next_frame().unwrap().is_none());
    }

    #[test]
    fn reassembles_across_arbitrary_chunk_boundaries() {
        let mut stream = Vec::new();
        for i in 0..8u32 {
            stream.extend_from_slice(&encode_frame(
                FrameKind::ControlClient,
                i,
                &vec![i as u8; i as usize * 37],
            ));
        }

        // One byte at a time is the pathological case the SSH channel can
        // actually produce when a frame straddles a window update.
        let mut dec = FrameDecoder::new();
        let mut seen = Vec::new();
        for byte in &stream {
            dec.push(std::slice::from_ref(byte));
            while let Some(frame) = dec.next_frame().unwrap() {
                seen.push(frame);
            }
        }
        assert_eq!(seen.len(), 8);
        for (i, frame) in seen.iter().enumerate() {
            assert_eq!(frame.window_id, i as u32);
            assert_eq!(frame.payload.len(), i * 37);
        }
    }

    #[test]
    fn empty_payload_is_a_valid_frame() {
        let bytes = encode_frame(FrameKind::ControlServer, 0, b"");
        assert_eq!(bytes.len(), 9);
        let mut dec = FrameDecoder::new();
        dec.push(&bytes);
        let frame = dec.next_frame().unwrap().unwrap();
        assert!(frame.payload.is_empty());
    }

    #[test]
    fn rejects_an_oversized_length() {
        let mut dec = FrameDecoder::new();
        dec.push(&(MAX_FRAME_LEN + 1).to_le_bytes());
        assert!(matches!(
            dec.next_frame(),
            Err(ProtocolError::FrameTooLarge(_))
        ));
    }

    #[test]
    fn rejects_a_length_that_cannot_hold_the_header() {
        let mut dec = FrameDecoder::new();
        dec.push(&4u32.to_le_bytes());
        dec.push(&[0x01, 0, 0, 0]);
        assert!(matches!(
            dec.next_frame(),
            Err(ProtocolError::FrameTooShort(4, 5))
        ));
    }

    #[test]
    fn rejects_an_unknown_kind() {
        let mut dec = FrameDecoder::new();
        dec.push(&5u32.to_le_bytes());
        dec.push(&[0x7f, 0, 0, 0, 0]);
        assert!(matches!(
            dec.next_frame(),
            Err(ProtocolError::UnknownKind(0x7f))
        ));
    }

    #[test]
    fn compacts_the_buffer_on_a_long_stream() {
        let mut dec = FrameDecoder::new();
        let frame = encode_frame(FrameKind::Pixels, 1, &vec![0u8; 4096]);
        for _ in 0..1000 {
            dec.push(&frame);
            dec.next_frame().unwrap().unwrap();
        }
        assert_eq!(dec.buffered(), 0);
        assert!(
            dec.buf.capacity() < 1000 * frame.len(),
            "consumed bytes should not accumulate"
        );
    }
}
