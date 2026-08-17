//! PulseAudio "tagstruct" encoding: every value on the native protocol's
//! control channel is a one-byte type tag followed by big-endian data. This is
//! the subset the server needs — enough to parse what libpulse sends and to
//! write the replies it expects, nothing more.

/// Type tags, from PulseAudio's `tagstruct.h`. The values are ASCII on
/// purpose upstream, which makes hex dumps of the protocol half readable.
pub mod tag {
    pub const STRING: u8 = b't';
    pub const STRING_NULL: u8 = b'N';
    pub const U32: u8 = b'L';
    pub const U8: u8 = b'B';
    pub const U64: u8 = b'R';
    pub const S64: u8 = b'r';
    pub const SAMPLE_SPEC: u8 = b'a';
    pub const ARBITRARY: u8 = b'x';
    pub const BOOLEAN_TRUE: u8 = b'1';
    pub const BOOLEAN_FALSE: u8 = b'0';
    pub const TIMEVAL: u8 = b'T';
    pub const USEC: u8 = b'U';
    pub const CHANNEL_MAP: u8 = b'm';
    pub const CVOLUME: u8 = b'v';
    pub const PROPLIST: u8 = b'P';
    pub const VOLUME: u8 = b'V';
    pub const FORMAT_INFO: u8 = b'f';
}

/// `PA_INVALID_INDEX`: a `u32` index field holding "none".
pub const INVALID_INDEX: u32 = u32::MAX;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum TagError {
    #[error("truncated tagstruct")]
    Truncated,
    #[error("expected tag {expected:#04x}, found {found:#04x}")]
    UnexpectedTag { expected: u8, found: u8 },
    #[error("malformed tagstruct value: {0}")]
    Malformed(&'static str),
}

/// Streaming reader over one command payload.
pub struct TsReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> TsReader<'a> {
    pub fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }

    pub fn is_empty(&self) -> bool {
        self.pos >= self.buf.len()
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], TagError> {
        if self.buf.len() - self.pos < n {
            return Err(TagError::Truncated);
        }
        let out = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(out)
    }

    fn expect_tag(&mut self, expected: u8) -> Result<(), TagError> {
        let found = self.take(1)?[0];
        if found != expected {
            return Err(TagError::UnexpectedTag { expected, found });
        }
        Ok(())
    }

    fn raw_u32(&mut self) -> Result<u32, TagError> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn raw_u64(&mut self) -> Result<u64, TagError> {
        let b = self.take(8)?;
        Ok(u64::from_be_bytes([
            b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
        ]))
    }

    pub fn u8(&mut self) -> Result<u8, TagError> {
        self.expect_tag(tag::U8)?;
        Ok(self.take(1)?[0])
    }

    pub fn u32(&mut self) -> Result<u32, TagError> {
        self.expect_tag(tag::U32)?;
        self.raw_u32()
    }

    pub fn u64(&mut self) -> Result<u64, TagError> {
        self.expect_tag(tag::U64)?;
        self.raw_u64()
    }

    pub fn s64(&mut self) -> Result<i64, TagError> {
        self.expect_tag(tag::S64)?;
        Ok(self.raw_u64()? as i64)
    }

    pub fn usec(&mut self) -> Result<u64, TagError> {
        self.expect_tag(tag::USEC)?;
        self.raw_u64()
    }

    pub fn bool(&mut self) -> Result<bool, TagError> {
        let found = self.take(1)?[0];
        match found {
            tag::BOOLEAN_TRUE => Ok(true),
            tag::BOOLEAN_FALSE => Ok(false),
            _ => Err(TagError::UnexpectedTag {
                expected: tag::BOOLEAN_TRUE,
                found,
            }),
        }
    }

    /// An index field: `INVALID_INDEX` reads as `None`.
    pub fn index(&mut self) -> Result<Option<u32>, TagError> {
        let v = self.u32()?;
        Ok(if v == INVALID_INDEX { None } else { Some(v) })
    }

    /// A `timeval`, kept raw: the latency reply echoes it back untouched.
    pub fn timeval(&mut self) -> Result<(u32, u32), TagError> {
        self.expect_tag(tag::TIMEVAL)?;
        Ok((self.raw_u32()?, self.raw_u32()?))
    }

    /// A string or the null-string tag. Not necessarily UTF-8 upstream; we
    /// only ever log these, so lossy conversion is fine.
    pub fn string(&mut self) -> Result<Option<String>, TagError> {
        let found = self.take(1)?[0];
        match found {
            tag::STRING_NULL => Ok(None),
            tag::STRING => {
                let rest = &self.buf[self.pos..];
                let nul = rest
                    .iter()
                    .position(|&b| b == 0)
                    .ok_or(TagError::Malformed("unterminated string"))?;
                let s = String::from_utf8_lossy(&rest[..nul]).into_owned();
                self.pos += nul + 1;
                Ok(Some(s))
            }
            _ => Err(TagError::UnexpectedTag {
                expected: tag::STRING,
                found,
            }),
        }
    }

    pub fn arbitrary(&mut self) -> Result<&'a [u8], TagError> {
        self.expect_tag(tag::ARBITRARY)?;
        let len = self.raw_u32()? as usize;
        self.take(len)
    }

    /// `format | channels | rate`, all raw after the tag.
    pub fn sample_spec(&mut self) -> Result<(u8, u8, u32), TagError> {
        self.expect_tag(tag::SAMPLE_SPEC)?;
        let format = self.take(1)?[0];
        let channels = self.take(1)?[0];
        let rate = self.raw_u32()?;
        Ok((format, channels, rate))
    }

    /// Positions are irrelevant to a mixer that downmixes by slot; only the
    /// count is kept.
    pub fn channel_map(&mut self) -> Result<u8, TagError> {
        self.expect_tag(tag::CHANNEL_MAP)?;
        let channels = self.take(1)?[0];
        self.take(channels as usize)?;
        Ok(channels)
    }

    /// Per-channel raw volumes.
    pub fn cvolume(&mut self) -> Result<Vec<u32>, TagError> {
        self.expect_tag(tag::CVOLUME)?;
        let channels = self.take(1)?[0];
        let mut volumes = Vec::with_capacity(channels as usize);
        for _ in 0..channels {
            volumes.push(self.raw_u32()?);
        }
        Ok(volumes)
    }

    /// Skips a proplist, returning the value of one key if present. The server
    /// keeps `application.name` for the log and discards the rest.
    pub fn proplist_get(&mut self, want: &str) -> Result<Option<String>, TagError> {
        self.expect_tag(tag::PROPLIST)?;
        let mut found = None;
        while let Some(key) = self.string()? {
            let _declared_len = self.u32()?;
            let value = self.arbitrary()?;
            if key == want {
                let trimmed = value.strip_suffix(&[0]).unwrap_or(value);
                found = Some(String::from_utf8_lossy(trimmed).into_owned());
            }
        }
        Ok(found)
    }

    /// `encoding | proplist`.
    pub fn format_info(&mut self) -> Result<(), TagError> {
        self.expect_tag(tag::FORMAT_INFO)?;
        self.u8()?;
        self.proplist_get("")?;
        Ok(())
    }
}

/// Writer that appends tagged values to a buffer.
#[derive(Default)]
pub struct TsWriter {
    buf: Vec<u8>,
}

impl TsWriter {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.buf
    }

    pub fn put_u8(&mut self, v: u8) {
        self.buf.push(tag::U8);
        self.buf.push(v);
    }

    pub fn put_u32(&mut self, v: u32) {
        self.buf.push(tag::U32);
        self.buf.extend_from_slice(&v.to_be_bytes());
    }

    pub fn put_u64(&mut self, v: u64) {
        self.buf.push(tag::U64);
        self.buf.extend_from_slice(&v.to_be_bytes());
    }

    pub fn put_s64(&mut self, v: i64) {
        self.buf.push(tag::S64);
        self.buf.extend_from_slice(&v.to_be_bytes());
    }

    pub fn put_usec(&mut self, v: u64) {
        self.buf.push(tag::USEC);
        self.buf.extend_from_slice(&v.to_be_bytes());
    }

    pub fn put_bool(&mut self, v: bool) {
        self.buf.push(if v {
            tag::BOOLEAN_TRUE
        } else {
            tag::BOOLEAN_FALSE
        });
    }

    pub fn put_index(&mut self, v: Option<u32>) {
        self.put_u32(v.unwrap_or(INVALID_INDEX));
    }

    pub fn put_timeval(&mut self, secs: u32, usecs: u32) {
        self.buf.push(tag::TIMEVAL);
        self.buf.extend_from_slice(&secs.to_be_bytes());
        self.buf.extend_from_slice(&usecs.to_be_bytes());
    }

    pub fn put_string(&mut self, v: Option<&str>) {
        match v {
            None => self.buf.push(tag::STRING_NULL),
            Some(s) => {
                self.buf.push(tag::STRING);
                self.buf.extend_from_slice(s.as_bytes());
                self.buf.push(0);
            }
        }
    }

    pub fn put_arbitrary(&mut self, v: &[u8]) {
        self.buf.push(tag::ARBITRARY);
        self.buf.extend_from_slice(&(v.len() as u32).to_be_bytes());
        self.buf.extend_from_slice(v);
    }

    pub fn put_sample_spec(&mut self, format: u8, channels: u8, rate: u32) {
        self.buf.push(tag::SAMPLE_SPEC);
        self.buf.push(format);
        self.buf.push(channels);
        self.buf.extend_from_slice(&rate.to_be_bytes());
    }

    /// A stereo (or mono) map in the standard positions.
    pub fn put_channel_map(&mut self, channels: u8) {
        self.buf.push(tag::CHANNEL_MAP);
        self.buf.push(channels);
        if channels == 1 {
            self.buf.push(0); // mono
        } else {
            for pos in 0..channels {
                // front-left = 1, front-right = 2, then aux slots.
                self.buf.push(if pos < 2 { pos + 1 } else { 10 + pos });
            }
        }
    }

    pub fn put_cvolume(&mut self, volumes: &[u32]) {
        self.buf.push(tag::CVOLUME);
        self.buf.push(volumes.len() as u8);
        for v in volumes {
            self.buf.extend_from_slice(&v.to_be_bytes());
        }
    }

    pub fn put_volume(&mut self, v: u32) {
        self.buf.push(tag::VOLUME);
        self.buf.extend_from_slice(&v.to_be_bytes());
    }

    /// Proplist from string pairs; every value is a nul-terminated string, per
    /// the upstream convention.
    pub fn put_proplist(&mut self, entries: &[(&str, &str)]) {
        self.buf.push(tag::PROPLIST);
        let mut scratch = TsWriter::new();
        for (key, value) in entries {
            scratch.put_string(Some(key));
            let mut bytes = value.as_bytes().to_vec();
            bytes.push(0);
            scratch.put_u32(bytes.len() as u32);
            scratch.put_arbitrary(&bytes);
        }
        scratch.put_string(None);
        self.buf.extend_from_slice(&scratch.buf);
    }

    /// A PCM `FormatInfo` with an empty proplist.
    pub fn put_format_info_pcm(&mut self) {
        self.buf.push(tag::FORMAT_INFO);
        self.put_u8(1); // PA_ENCODING_PCM
        self.put_proplist(&[]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalars_round_trip() {
        let mut w = TsWriter::new();
        w.put_u8(7);
        w.put_u32(0xdead_beef);
        w.put_u64(1 << 40);
        w.put_s64(-42);
        w.put_usec(123_456);
        w.put_bool(true);
        w.put_bool(false);
        w.put_index(None);
        w.put_timeval(10, 20);
        w.put_string(Some("hello"));
        w.put_string(None);
        w.put_arbitrary(&[1, 2, 3]);
        w.put_sample_spec(3, 2, 48_000);

        let bytes = w.into_bytes();
        let mut r = TsReader::new(&bytes);
        assert_eq!(r.u8().unwrap(), 7);
        assert_eq!(r.u32().unwrap(), 0xdead_beef);
        assert_eq!(r.u64().unwrap(), 1 << 40);
        assert_eq!(r.s64().unwrap(), -42);
        assert_eq!(r.usec().unwrap(), 123_456);
        assert!(r.bool().unwrap());
        assert!(!r.bool().unwrap());
        assert_eq!(r.index().unwrap(), None);
        assert_eq!(r.timeval().unwrap(), (10, 20));
        assert_eq!(r.string().unwrap().as_deref(), Some("hello"));
        assert_eq!(r.string().unwrap(), None);
        assert_eq!(r.arbitrary().unwrap(), &[1, 2, 3]);
        assert_eq!(r.sample_spec().unwrap(), (3, 2, 48_000));
        assert!(r.is_empty());
    }

    #[test]
    fn proplists_yield_the_requested_key() {
        let mut w = TsWriter::new();
        w.put_proplist(&[("application.name", "Firefox"), ("media.role", "video")]);
        let bytes = w.into_bytes();
        let mut r = TsReader::new(&bytes);
        assert_eq!(
            r.proplist_get("application.name").unwrap().as_deref(),
            Some("Firefox")
        );
        assert!(r.is_empty());
    }

    #[test]
    fn cvolume_and_channel_map_round_trip() {
        let mut w = TsWriter::new();
        w.put_channel_map(2);
        w.put_cvolume(&[0x10000, 0x8000]);
        let bytes = w.into_bytes();
        let mut r = TsReader::new(&bytes);
        assert_eq!(r.channel_map().unwrap(), 2);
        assert_eq!(r.cvolume().unwrap(), vec![0x10000, 0x8000]);
    }

    #[test]
    fn truncation_is_an_error_not_a_panic() {
        let mut w = TsWriter::new();
        w.put_u32(1);
        let bytes = w.into_bytes();
        let mut r = TsReader::new(&bytes[..3]);
        assert_eq!(r.u32(), Err(TagError::Truncated));
    }

    #[test]
    fn a_wrong_tag_names_both_sides() {
        let mut w = TsWriter::new();
        w.put_bool(true);
        let bytes = w.into_bytes();
        let mut r = TsReader::new(&bytes);
        assert_eq!(
            r.u32(),
            Err(TagError::UnexpectedTag {
                expected: tag::U32,
                found: tag::BOOLEAN_TRUE
            })
        );
    }
}
