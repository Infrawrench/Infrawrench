//! Audio chunk payload: the session's mixed playback audio, host → client.
//!
//! ```text
//! u8 codec | u8 channels | u16 flags | u32 seq | u32 sampleRate | data
//! ```
//!
//! Little-endian, like the frame envelope. `data` is interleaved signed 16-bit
//! little-endian PCM, either raw or zstd-compressed per `codec`. One chunk is
//! a few milliseconds of audio; the client schedules chunks back to back and
//! resynchronises on a gap in `seq` or on [`AUDIO_FLAG_RESET`].

use crate::ProtocolError;

/// Bytes before `data`.
pub const AUDIO_HEADER_LEN: usize = 12;

/// The stream (re)started: the first chunk after silence, a rate change, or a
/// mixer restart. The client drops whatever it had scheduled and starts fresh
/// rather than treating the discontinuity as an underrun.
pub const AUDIO_FLAG_RESET: u16 = 1 << 0;

/// How `AudioChunk::data` is encoded. A `u8` on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum AudioCodec {
    /// Interleaved s16le PCM, uncompressed.
    PcmS16 = 0,
    /// Interleaved s16le PCM, zstd-compressed. Music barely compresses but
    /// silence and speech do, and both ends already carry zstd for pixels.
    ZstdPcmS16 = 1,
}

impl AudioCodec {
    fn from_u8(value: u8) -> Result<Self, ProtocolError> {
        Ok(match value {
            0 => Self::PcmS16,
            1 => Self::ZstdPcmS16,
            other => return Err(ProtocolError::UnknownAudioCodec(other)),
        })
    }
}

/// One chunk of mixed session audio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AudioChunk {
    pub codec: AudioCodec,
    /// Interleaved channel count, 1 or 2 in practice.
    pub channels: u8,
    pub flags: u16,
    /// Increments per chunk; a gap means the link dropped or stalled and the
    /// client should resync instead of stretching what it has.
    pub seq: u32,
    pub sample_rate: u32,
    pub data: Vec<u8>,
}

impl AudioChunk {
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(AUDIO_HEADER_LEN + self.data.len());
        out.push(self.codec as u8);
        out.push(self.channels);
        out.extend_from_slice(&self.flags.to_le_bytes());
        out.extend_from_slice(&self.seq.to_le_bytes());
        out.extend_from_slice(&self.sample_rate.to_le_bytes());
        out.extend_from_slice(&self.data);
        out
    }

    pub fn decode(payload: &[u8]) -> Result<Self, ProtocolError> {
        if payload.len() < AUDIO_HEADER_LEN {
            return Err(ProtocolError::Truncated {
                expected: AUDIO_HEADER_LEN,
                actual: payload.len(),
            });
        }
        Ok(Self {
            codec: AudioCodec::from_u8(payload[0])?,
            channels: payload[1],
            flags: u16::from_le_bytes([payload[2], payload[3]]),
            seq: u32::from_le_bytes([payload[4], payload[5], payload[6], payload[7]]),
            sample_rate: u32::from_le_bytes([payload[8], payload[9], payload[10], payload[11]]),
            data: payload[AUDIO_HEADER_LEN..].to_vec(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_round_trip() {
        let chunk = AudioChunk {
            codec: AudioCodec::ZstdPcmS16,
            channels: 2,
            flags: AUDIO_FLAG_RESET,
            seq: 41,
            sample_rate: 48_000,
            data: vec![1, 2, 3, 4],
        };
        assert_eq!(AudioChunk::decode(&chunk.encode()).unwrap(), chunk);
    }

    #[test]
    fn an_empty_data_chunk_is_valid() {
        let chunk = AudioChunk {
            codec: AudioCodec::PcmS16,
            channels: 1,
            flags: 0,
            seq: 0,
            sample_rate: 44_100,
            data: vec![],
        };
        let bytes = chunk.encode();
        assert_eq!(bytes.len(), AUDIO_HEADER_LEN);
        assert_eq!(AudioChunk::decode(&bytes).unwrap(), chunk);
    }

    #[test]
    fn a_truncated_header_is_an_error_not_a_panic() {
        assert!(matches!(
            AudioChunk::decode(&[0, 2, 0, 0]),
            Err(ProtocolError::Truncated { .. })
        ));
    }

    #[test]
    fn an_unknown_codec_is_rejected() {
        let mut bytes = AudioChunk {
            codec: AudioCodec::PcmS16,
            channels: 2,
            flags: 0,
            seq: 0,
            sample_rate: 48_000,
            data: vec![],
        }
        .encode();
        bytes[0] = 9;
        assert!(matches!(
            AudioChunk::decode(&bytes),
            Err(ProtocolError::UnknownAudioCodec(9))
        ));
    }
}
