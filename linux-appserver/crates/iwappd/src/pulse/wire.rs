//! The pstream packet layer: a 20-byte big-endian descriptor in front of
//! either a control tagstruct (channel `-1`) or a memblock of stream data
//! (channel = the stream the bytes belong to).

use super::tagstruct::TsWriter;

/// Descriptor size: length, channel, offset (hi+lo), flags — five `u32`s.
pub const DESCRIPTOR_LEN: usize = 20;

/// Control packets carry this channel.
pub const CONTROL_CHANNEL: u32 = u32::MAX;

/// A descriptor length past this is a desynchronised stream, not a packet:
/// `MAX_MEMBLOCKQ_LENGTH` upstream is 4 MiB and control packets are tiny.
pub const MAX_PACKET_LEN: u32 = 4 * 1024 * 1024 + 64;

/// The low byte of a memblock descriptor's flags word is the seek mode.
pub mod seek {
    pub const RELATIVE: u32 = 0;
    pub const ABSOLUTE: u32 = 1;
    pub const RELATIVE_ON_READ: u32 = 2;
    pub const RELATIVE_END: u32 = 3;
}

/// Command opcodes, from `native-common.h`. Only the ones the server matches
/// on; everything else falls through to a NotImplemented error reply.
pub mod cmd {
    pub const ERROR: u32 = 0;
    pub const REPLY: u32 = 2;
    pub const CREATE_PLAYBACK_STREAM: u32 = 3;
    pub const DELETE_PLAYBACK_STREAM: u32 = 4;
    pub const CREATE_RECORD_STREAM: u32 = 5;
    pub const DELETE_RECORD_STREAM: u32 = 6;
    pub const EXIT: u32 = 7;
    pub const AUTH: u32 = 8;
    pub const SET_CLIENT_NAME: u32 = 9;
    pub const LOOKUP_SINK: u32 = 10;
    pub const DRAIN_PLAYBACK_STREAM: u32 = 12;
    pub const STAT: u32 = 13;
    pub const GET_PLAYBACK_LATENCY: u32 = 14;
    pub const GET_SERVER_INFO: u32 = 20;
    pub const GET_SINK_INFO: u32 = 21;
    pub const GET_SINK_INFO_LIST: u32 = 22;
    pub const GET_SOURCE_INFO: u32 = 23;
    pub const GET_SOURCE_INFO_LIST: u32 = 24;
    pub const GET_MODULE_INFO_LIST: u32 = 26;
    pub const GET_CLIENT_INFO_LIST: u32 = 28;
    pub const GET_SINK_INPUT_INFO_LIST: u32 = 30;
    pub const GET_SOURCE_OUTPUT_INFO_LIST: u32 = 32;
    pub const GET_SAMPLE_INFO_LIST: u32 = 34;
    pub const SUBSCRIBE: u32 = 35;
    pub const SET_SINK_INPUT_VOLUME: u32 = 37;
    pub const CORK_PLAYBACK_STREAM: u32 = 41;
    pub const FLUSH_PLAYBACK_STREAM: u32 = 42;
    pub const TRIGGER_PLAYBACK_STREAM: u32 = 43;
    pub const SET_PLAYBACK_STREAM_NAME: u32 = 46;
    pub const PREBUF_PLAYBACK_STREAM: u32 = 60;
    pub const REQUEST: u32 = 61;
    pub const OVERFLOW: u32 = 62;
    pub const UNDERFLOW: u32 = 63;
    pub const SET_SINK_INPUT_MUTE: u32 = 69;
    pub const SET_PLAYBACK_STREAM_BUFFER_ATTR: u32 = 72;
    pub const UPDATE_PLAYBACK_STREAM_SAMPLE_RATE: u32 = 74;
    pub const UPDATE_PLAYBACK_STREAM_PROPLIST: u32 = 81;
    pub const UPDATE_CLIENT_PROPLIST: u32 = 82;
    pub const REMOVE_PLAYBACK_STREAM_PROPLIST: u32 = 84;
    pub const STARTED: u32 = 86;
    pub const GET_CARD_INFO_LIST: u32 = 89;
}

/// `PA_ERR_*` codes for error replies.
pub mod err {
    pub const ACCESS_DENIED: u32 = 1;
    pub const INVALID: u32 = 3;
    pub const NO_ENTITY: u32 = 5;
    pub const PROTOCOL: u32 = 7;
    pub const VERSION: u32 = 17;
    pub const NOT_SUPPORTED: u32 = 19;
    pub const NOT_IMPLEMENTED: u32 = 23;
}

/// One parsed descriptor.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Descriptor {
    pub length: u32,
    pub channel: u32,
    pub offset: i64,
    pub flags: u32,
}

pub fn decode_descriptor(bytes: &[u8; DESCRIPTOR_LEN]) -> Descriptor {
    let word = |i: usize| u32::from_be_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    let offset = ((word(8) as u64) << 32 | word(12) as u64) as i64;
    Descriptor {
        length: word(0),
        channel: word(4),
        offset,
        flags: word(16),
    }
}

/// A complete control packet: descriptor plus `command | seq | payload`.
pub fn control_packet(command: u32, seq: u32, payload: &[u8]) -> Vec<u8> {
    let mut head = TsWriter::new();
    head.put_u32(command);
    head.put_u32(seq);
    let head = head.into_bytes();

    let length = (head.len() + payload.len()) as u32;
    let mut out = Vec::with_capacity(DESCRIPTOR_LEN + length as usize);
    out.extend_from_slice(&length.to_be_bytes());
    out.extend_from_slice(&CONTROL_CHANNEL.to_be_bytes());
    out.extend_from_slice(&0u64.to_be_bytes());
    out.extend_from_slice(&0u32.to_be_bytes());
    out.extend_from_slice(&head);
    out.extend_from_slice(payload);
    out
}

/// A reply packet with a tagstruct payload.
pub fn reply_packet(seq: u32, payload: TsWriter) -> Vec<u8> {
    control_packet(cmd::REPLY, seq, &payload.into_bytes())
}

/// An empty reply — PulseAudio's ack.
pub fn ack_packet(seq: u32) -> Vec<u8> {
    control_packet(cmd::REPLY, seq, &[])
}

/// An error reply.
pub fn error_packet(seq: u32, code: u32) -> Vec<u8> {
    let mut payload = TsWriter::new();
    payload.put_u32(code);
    control_packet(cmd::ERROR, seq, &payload.into_bytes())
}

/// A server-initiated event (Request, Started, Underflow…). These carry the
/// invalid sequence number because nothing acks them.
pub fn event_packet(command: u32, payload: TsWriter) -> Vec<u8> {
    control_packet(command, u32::MAX, &payload.into_bytes())
}

/// Incremental packet decoder mirroring `iw_proto::FrameDecoder`, for the
/// arbitrary chunk boundaries a `read()` on the socket produces.
#[derive(Default)]
pub struct PacketDecoder {
    buf: Vec<u8>,
    start: usize,
}

/// One decoded packet, descriptor plus payload.
pub struct Packet {
    pub descriptor: Descriptor,
    pub payload: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum PacketError {
    #[error("packet length {0} exceeds the {MAX_PACKET_LEN} byte limit")]
    TooLarge(u32),
}

impl PacketDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
    }

    pub fn next_packet(&mut self) -> Result<Option<Packet>, PacketError> {
        let available = self.buf.len() - self.start;
        if available < DESCRIPTOR_LEN {
            return Ok(None);
        }
        let head: &[u8; DESCRIPTOR_LEN] = self.buf[self.start..self.start + DESCRIPTOR_LEN]
            .try_into()
            .expect("slice is exactly DESCRIPTOR_LEN");
        let descriptor = decode_descriptor(head);
        if descriptor.length > MAX_PACKET_LEN {
            return Err(PacketError::TooLarge(descriptor.length));
        }
        if available < DESCRIPTOR_LEN + descriptor.length as usize {
            return Ok(None);
        }
        let body = self.start + DESCRIPTOR_LEN;
        let payload = self.buf[body..body + descriptor.length as usize].to_vec();
        self.start = body + descriptor.length as usize;
        if self.start == self.buf.len() {
            self.buf.clear();
            self.start = 0;
        } else if self.start > 64 * 1024 && self.start * 2 > self.buf.len() {
            self.buf.drain(..self.start);
            self.start = 0;
        }
        Ok(Some(Packet {
            descriptor,
            payload,
        }))
    }
}

/// The auth exchange packs the protocol version and two feature bits into one
/// `u32`.
pub const VERSION_MASK: u32 = 0x0000_ffff;
pub const FLAG_SHM: u32 = 0x8000_0000;
pub const FLAG_MEMFD: u32 = 0x4000_0000;

#[cfg(test)]
mod tests {
    use super::super::tagstruct::tag;
    use super::*;

    #[test]
    fn descriptors_round_trip_through_the_decoder() {
        let packet = control_packet(cmd::AUTH, 5, &[tag::U32, 0, 0, 0, 35]);
        let mut dec = PacketDecoder::new();
        // Byte at a time: sockets fragment.
        let mut seen = Vec::new();
        for byte in &packet {
            dec.push(std::slice::from_ref(byte));
            while let Some(p) = dec.next_packet().unwrap() {
                seen.push(p);
            }
        }
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].descriptor.channel, CONTROL_CHANNEL);
        assert_eq!(seen[0].payload.len(), 15);
    }

    #[test]
    fn a_memblock_descriptor_carries_channel_offset_and_flags() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&8u32.to_be_bytes());
        bytes.extend_from_slice(&3u32.to_be_bytes());
        bytes.extend_from_slice(&(-4i64 as u64).to_be_bytes());
        bytes.extend_from_slice(&seek::RELATIVE.to_be_bytes());
        bytes.extend_from_slice(&[0u8; 8]);

        let mut dec = PacketDecoder::new();
        dec.push(&bytes);
        let p = dec.next_packet().unwrap().unwrap();
        assert_eq!(p.descriptor.channel, 3);
        assert_eq!(p.descriptor.offset, -4);
        assert_eq!(p.descriptor.flags, seek::RELATIVE);
        assert_eq!(p.payload.len(), 8);
    }

    #[test]
    fn an_oversized_length_is_an_error() {
        let mut dec = PacketDecoder::new();
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(MAX_PACKET_LEN + 1).to_be_bytes());
        bytes.extend_from_slice(&[0u8; 16]);
        dec.push(&bytes);
        assert!(dec.next_packet().is_err());
    }
}
