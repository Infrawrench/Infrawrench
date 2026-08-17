//! The PulseAudio server itself: per-connection command handling and the
//! mixer that turns every client's playback stream into one 48 kHz stereo
//! feed.
//!
//! Sans-io on purpose, like `Session`: bytes and a clock come in, reply bytes
//! and mixed PCM come out, and nothing here owns a socket or a thread — the
//! runtime half does. That is what lets the whole protocol exchange run in a
//! unit test on a machine with no audio and no Wayland.

use std::collections::BTreeMap;

use super::tagstruct::{TagError, TsReader, TsWriter};
use super::wire::{
    self, CONTROL_CHANNEL, Descriptor, Packet, PacketDecoder, PacketError, cmd, err, seek,
};

/// Everything mixes to this. 48 kHz stereo s16 is what the browser's
/// `AudioContext` runs at on every platform we ship, and PulseAudio clients
/// resample to the sink's rate happily.
pub const OUT_RATE: u32 = 48_000;
pub const OUT_CHANNELS: u8 = 2;

/// The one sink every stream connects to.
pub const SINK_NAME: &str = "iw_out";
const SINK_DESCRIPTION: &str = "Infrawrench Stream";

/// Highest protocol version whose semantics this server implements; a newer
/// client negotiates down to it. v13 is 2007 — anything older is not libpulse.
const MAX_VERSION: u32 = 35;
const MIN_VERSION: u32 = 13;

/// What `GetPlaybackLatency` reports as the sink's own latency. The honest
/// figure is unknowable from here — it is the SSH link plus the viewer's
/// jitter buffer — so this is a stand-in for the typical total, which lets a
/// video player shift its picture roughly into sync instead of not at all.
const REPORTED_SINK_LATENCY_USEC: u64 = 150_000;

/// `PA_VOLUME_NORM`.
const VOLUME_NORM: u32 = 0x10000;

/// `PA_RATE_MAX`.
const MAX_RATE: u32 = 48_000 * 16;
const MAX_STREAM_CHANNELS: u8 = 32;

/// Buffer attribute defaults, applied where the client passed `-1`. The
/// target is deliberately small: this "sink" has no hardware to feed, and
/// every byte queued here is latency the viewer will hear.
const DEFAULT_TLENGTH: u32 = 200; // milliseconds
const DEFAULT_MAXLENGTH: u32 = 4 * 1024 * 1024;

/// Sample formats we can decode, by their wire code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Format {
    U8,
    S16Le,
    S16Be,
    F32Le,
    F32Be,
    S32Le,
    S32Be,
    S24Le,
    S24Be,
    S24In32Le,
    S24In32Be,
}

impl Format {
    fn from_wire(code: u8) -> Option<Self> {
        Some(match code {
            0 => Self::U8,
            3 => Self::S16Le,
            4 => Self::S16Be,
            5 => Self::F32Le,
            6 => Self::F32Be,
            7 => Self::S32Le,
            8 => Self::S32Be,
            9 => Self::S24Le,
            10 => Self::S24Be,
            11 => Self::S24In32Le,
            12 => Self::S24In32Be,
            // a-law and mu-law are telephony formats nothing desktop emits.
            _ => return None,
        })
    }

    fn bytes(self) -> usize {
        match self {
            Self::U8 => 1,
            Self::S16Le | Self::S16Be => 2,
            Self::S24Le | Self::S24Be => 3,
            _ => 4,
        }
    }

    /// Decode one sample to `[-1, 1]` float.
    fn sample(self, bytes: &[u8]) -> f32 {
        match self {
            Self::U8 => (bytes[0] as f32 - 128.0) / 128.0,
            Self::S16Le => i16::from_le_bytes([bytes[0], bytes[1]]) as f32 / 32768.0,
            Self::S16Be => i16::from_be_bytes([bytes[0], bytes[1]]) as f32 / 32768.0,
            Self::F32Le => f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            Self::F32Be => f32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
            Self::S32Le => {
                i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32 / 2147483648.0
            }
            Self::S32Be => {
                i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32 / 2147483648.0
            }
            Self::S24Le => {
                (i32::from_le_bytes([0, bytes[0], bytes[1], bytes[2]]) >> 8) as f32 / 8388608.0
            }
            Self::S24Be => {
                (i32::from_be_bytes([bytes[0], bytes[1], bytes[2], 0]) >> 8) as f32 / 8388608.0
            }
            Self::S24In32Le => {
                (i32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) << 8 >> 8) as f32
                    / 8388608.0
            }
            Self::S24In32Be => {
                (i32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) << 8 >> 8) as f32
                    / 8388608.0
            }
        }
    }
}

/// Resolved buffer attributes — no `-1` sentinels left.
#[derive(Debug, Clone, Copy)]
struct Attr {
    maxlength: u32,
    tlength: u32,
    prebuf: u32,
    minreq: u32,
}

fn resolve_attr(
    maxlength: u32,
    tlength: u32,
    prebuf: u32,
    minreq: u32,
    bytes_per_second: u32,
) -> Attr {
    let default_tlength = (bytes_per_second / 1000 * DEFAULT_TLENGTH).max(1024);
    let maxlength = if maxlength == u32::MAX || maxlength == 0 {
        DEFAULT_MAXLENGTH
    } else {
        maxlength
    };
    let tlength = if tlength == u32::MAX || tlength == 0 {
        default_tlength
    } else {
        tlength.min(maxlength)
    };
    let minreq = if minreq == u32::MAX || minreq == 0 {
        (tlength / 4).max(1)
    } else {
        minreq.min(tlength)
    };
    // Prebuf of zero is meaningful — manual start control — so only the
    // sentinel gets a default.
    let prebuf = if prebuf == u32::MAX {
        tlength.saturating_sub(minreq).max(1)
    } else {
        prebuf.min(tlength)
    };
    Attr {
        maxlength,
        tlength,
        prebuf,
        minreq,
    }
}

/// One playback stream.
struct Stream {
    /// Globally unique, reported as the stream's sink-input index.
    index: u32,
    /// The owning connection's negotiated protocol version, for events.
    version: u32,
    format: Format,
    channels: u8,
    rate: u32,
    attr: Attr,
    /// Pending PCM, in the stream's own format. A `Vec` drained from the
    /// front: the drain is a memmove of at most `tlength` bytes per tick.
    ring: Vec<u8>,
    /// Fractional read position (in source frames) into `ring`, for the
    /// resampler.
    frac_pos: f64,
    corked: bool,
    /// False while prebuffering: bytes accumulate but nothing is consumed.
    playing: bool,
    drain_seq: Option<u32>,
    /// Bytes asked of the client and not yet received.
    requested: usize,
    write_index: i64,
    read_index: i64,
    playing_for_usec: u64,
    underrun_for_usec: u64,
    /// Linear gain from the stream's cvolume.
    volume: f32,
    muted: bool,
}

impl Stream {
    fn frame_bytes(&self) -> usize {
        self.format.bytes() * self.channels as usize
    }

    fn buffered(&self) -> usize {
        self.ring.len()
    }

    /// Whether accumulated bytes satisfy prebuf and playback should start.
    fn prebuf_satisfied(&self) -> bool {
        self.buffered() as u32 >= self.attr.prebuf
    }
}

/// All streams across all connections, plus the outgoing chunk sequence.
/// Shared between the per-connection readers and the mixer tick.
pub struct AudioState {
    streams: BTreeMap<(u64, u32), Stream>,
    next_stream_index: u32,
    /// True while the mixer is emitting chunks; the first chunk after a quiet
    /// spell carries the reset flag.
    running: bool,
    pub seq: u32,
}

impl Default for AudioState {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioState {
    pub fn new() -> Self {
        Self {
            streams: BTreeMap::new(),
            next_stream_index: 0,
            running: false,
            seq: 0,
        }
    }

    pub fn stream_count(&self) -> usize {
        self.streams.len()
    }

    /// Drop everything a disconnected client owned.
    pub fn remove_connection(&mut self, conn: u64) {
        self.streams.retain(|(owner, _), _| *owner != conn);
    }

    /// One mixer tick: consume up to `frames` output frames from every
    /// playing stream, mix, and produce the packets the streams' clients are
    /// owed (requests for more data, started/underflow events, drain acks).
    pub fn mix(&mut self, frames: usize) -> MixOutput {
        let mut packets = Vec::new();

        let any_uncorked = self.streams.values().any(|s| !s.corked);
        if !any_uncorked {
            self.running = false;
            // Even while quiet, corked streams still want filling so an
            // uncork can start instantly.
            self.pump_requests(&mut packets);
            return MixOutput {
                pcm: Vec::new(),
                packets,
                reset: false,
            };
        }

        let mut acc = vec![0f32; frames * OUT_CHANNELS as usize];
        let tick_usec = frames as u64 * 1_000_000 / OUT_RATE as u64;

        for (&(conn, channel), stream) in self.streams.iter_mut() {
            if stream.corked || !stream.playing {
                continue;
            }

            let produced = mix_stream(stream, &mut acc, frames);
            let consumed_usec = produced as u64 * 1_000_000 / OUT_RATE as u64;
            stream.playing_for_usec += consumed_usec;

            if produced < frames {
                // Ran dry mid-tick.
                if let Some(seq) = stream.drain_seq.take() {
                    packets.push((conn, wire::ack_packet(seq)));
                    stream.playing = false;
                } else {
                    stream.underrun_for_usec += tick_usec - consumed_usec;
                    let mut payload = TsWriter::new();
                    payload.put_u32(channel);
                    if stream.version >= 23 {
                        payload.put_s64(stream.write_index);
                    }
                    packets.push((conn, wire::event_packet(cmd::UNDERFLOW, payload)));
                    if stream.attr.prebuf > 0 {
                        // Classic prebuffering: pause until the client has
                        // refilled, then send Started again.
                        stream.playing = false;
                    }
                }
            }
        }

        self.pump_requests(&mut packets);

        let reset = !self.running;
        self.running = true;
        // Scale by 32768 so an s16 sample that came in untouched goes out
        // untouched; the clamp is what saturates an over-full mix.
        let pcm = acc
            .into_iter()
            .map(|s| (s * 32768.0).round().clamp(-32768.0, 32767.0) as i16)
            .collect();
        MixOutput {
            pcm,
            packets,
            reset,
        }
    }

    /// Ask clients for whatever keeps each stream's buffer at its target.
    fn pump_requests(&mut self, packets: &mut Vec<(u64, Vec<u8>)>) {
        for (&(conn, channel), stream) in self.streams.iter_mut() {
            if stream.drain_seq.is_some() {
                continue;
            }
            let missing =
                (stream.attr.tlength as usize).saturating_sub(stream.buffered() + stream.requested);
            if missing >= stream.attr.minreq as usize {
                stream.requested += missing;
                let mut payload = TsWriter::new();
                payload.put_u32(channel);
                payload.put_u32(missing as u32);
                packets.push((conn, wire::event_packet(cmd::REQUEST, payload)));
            }
        }
    }
}

/// Resample-and-mix one stream into the accumulator; returns produced frames.
fn mix_stream(stream: &mut Stream, acc: &mut [f32], frames: usize) -> usize {
    let frame_bytes = stream.frame_bytes();
    let avail_frames = stream.ring.len() / frame_bytes;
    let ratio = stream.rate as f64 / OUT_RATE as f64;
    let gain = if stream.muted { 0.0 } else { stream.volume };
    let channels = stream.channels as usize;
    let sample_bytes = stream.format.bytes();

    let mut produced = 0;
    for i in 0..frames {
        let src = stream.frac_pos + i as f64 * ratio;
        let i0 = src as usize;
        if i0 >= avail_frames {
            break;
        }
        // The successor frame may not have arrived yet; holding the last one
        // flat lets a drain finish instead of leaving a frame stuck forever.
        let i1 = (i0 + 1).min(avail_frames - 1);
        let t = (src - i0 as f64) as f32;

        let mut left = 0f32;
        let mut right = 0f32;
        for c in 0..channels {
            let s0 = stream
                .format
                .sample(&stream.ring[(i0 * channels + c) * sample_bytes..]);
            let s1 = stream
                .format
                .sample(&stream.ring[(i1 * channels + c) * sample_bytes..]);
            let s = s0 + (s1 - s0) * t;
            // Slot-based downmix: mono feeds both sides, a stereo pair maps
            // straight through, anything past that splits evenly at half
            // gain. Surround content in a streamed app window is rare enough
            // that faithful coefficients are not worth the table.
            if channels == 1 {
                left += s;
                right += s;
            } else if c % 2 == 0 {
                left += if c < 2 { s } else { s * 0.5 };
            } else {
                right += if c < 2 { s } else { s * 0.5 };
            }
        }
        acc[i * 2] += left * gain;
        acc[i * 2 + 1] += right * gain;
        produced += 1;
    }

    let end_pos = stream.frac_pos + produced as f64 * ratio;
    let consumed_frames = (end_pos as usize).min(avail_frames);
    stream.frac_pos = end_pos - consumed_frames as f64;
    let consumed_bytes = consumed_frames * frame_bytes;
    stream.ring.drain(..consumed_bytes);
    stream.read_index += consumed_bytes as i64;
    produced
}

/// What a mixer tick produced.
pub struct MixOutput {
    /// Interleaved stereo s16, `frames * 2` long — or empty when no stream
    /// is uncorked and the chunk stream should stop.
    pub pcm: Vec<i16>,
    /// Packets owed to clients, keyed by connection id.
    pub packets: Vec<(u64, Vec<u8>)>,
    /// True when this is the first chunk after quiet: the viewer should
    /// restart its clock rather than treat the gap as an underrun.
    pub reset: bool,
}

/// Per-connection protocol state. Owned by the connection's reader; every
/// mutation of shared stream state goes through `&mut AudioState`.
pub struct Connection {
    id: u64,
    decoder: PacketDecoder,
    version: u32,
    authed: bool,
    next_channel: u32,
    /// For the log line when an application connects.
    pub app_name: Option<String>,
}

/// The wall clock, `(seconds, microseconds)` since the epoch, threaded in by
/// the runtime so latency replies can carry real timestamps without this
/// module owning time.
pub type WallClock = (u32, u32);

impl Connection {
    pub fn new(id: u64) -> Self {
        Self {
            id,
            decoder: PacketDecoder::new(),
            version: MAX_VERSION,
            authed: false,
            next_channel: 0,
            app_name: None,
        }
    }

    /// Feed received bytes; returns the packets to write back. A
    /// `PacketError` means the byte stream itself is broken and the
    /// connection should be dropped.
    pub fn feed(
        &mut self,
        state: &mut AudioState,
        bytes: &[u8],
        wall: WallClock,
    ) -> Result<Vec<Vec<u8>>, PacketError> {
        self.decoder.push(bytes);
        let mut out = Vec::new();
        while let Some(packet) = self.decoder.next_packet()? {
            if packet.descriptor.channel == CONTROL_CHANNEL {
                self.handle_control(state, &packet, wall, &mut out);
            } else {
                self.handle_data(state, &packet, &mut out);
            }
        }
        Ok(out)
    }

    fn handle_control(
        &mut self,
        state: &mut AudioState,
        packet: &Packet,
        wall: WallClock,
        out: &mut Vec<Vec<u8>>,
    ) {
        let mut r = TsReader::new(&packet.payload);
        let (command, seq) = match (r.u32(), r.u32()) {
            (Ok(command), Ok(seq)) => (command, seq),
            _ => return, // not even a command header; nothing to reply to
        };

        if !self.authed && command != cmd::AUTH {
            out.push(wire::error_packet(seq, err::ACCESS_DENIED));
            return;
        }

        match self.dispatch(state, command, seq, &mut r, wall) {
            Ok(replies) => out.extend(replies),
            Err(_) => out.push(wire::error_packet(seq, err::PROTOCOL)),
        }
    }

    fn dispatch(
        &mut self,
        state: &mut AudioState,
        command: u32,
        seq: u32,
        r: &mut TsReader<'_>,
        wall: WallClock,
    ) -> Result<Vec<Vec<u8>>, TagError> {
        Ok(match command {
            cmd::AUTH => {
                let flags_and_version = r.u32()?;
                let _cookie = r.arbitrary()?;
                let client_version = flags_and_version & wire::VERSION_MASK;
                if client_version < MIN_VERSION {
                    return Ok(vec![wire::error_packet(seq, err::VERSION)]);
                }
                self.version = client_version.min(MAX_VERSION);
                self.authed = true;
                let mut reply = TsWriter::new();
                // No SHM and no memfd bits: every sample crosses the socket,
                // which costs a copy and saves implementing shared-memory
                // block management for streams this small.
                reply.put_u32(self.version);
                vec![wire::reply_packet(seq, reply)]
            }
            cmd::SET_CLIENT_NAME => {
                self.app_name = r.proplist_get("application.name")?;
                let mut reply = TsWriter::new();
                reply.put_u32(self.id as u32);
                vec![wire::reply_packet(seq, reply)]
            }
            cmd::CREATE_PLAYBACK_STREAM => self.create_playback_stream(state, seq, r)?,
            cmd::DELETE_PLAYBACK_STREAM => {
                let channel = r.u32()?;
                if state.streams.remove(&(self.id, channel)).is_some() {
                    vec![wire::ack_packet(seq)]
                } else {
                    vec![wire::error_packet(seq, err::NO_ENTITY)]
                }
            }
            cmd::DRAIN_PLAYBACK_STREAM => {
                let channel = r.u32()?;
                match state.streams.get_mut(&(self.id, channel)) {
                    Some(stream) if stream.buffered() == 0 => vec![wire::ack_packet(seq)],
                    Some(stream) => {
                        stream.drain_seq = Some(seq);
                        // Draining plays out whatever prebuffering was
                        // still waiting for.
                        stream.playing = true;
                        vec![]
                    }
                    None => vec![wire::error_packet(seq, err::NO_ENTITY)],
                }
            }
            cmd::CORK_PLAYBACK_STREAM => {
                let channel = r.index()?.ok_or(TagError::Malformed("channel"))?;
                let cork = r.bool()?;
                let mut replies = vec![];
                match state.streams.get_mut(&(self.id, channel)) {
                    Some(stream) => {
                        stream.corked = cork;
                        if !cork && !stream.playing && stream.prebuf_satisfied() {
                            stream.playing = true;
                            replies.push(started_event(channel));
                        }
                        replies.push(wire::ack_packet(seq));
                    }
                    None => replies.push(wire::error_packet(seq, err::NO_ENTITY)),
                }
                replies
            }
            cmd::FLUSH_PLAYBACK_STREAM => {
                let channel = r.u32()?;
                match state.streams.get_mut(&(self.id, channel)) {
                    Some(stream) => {
                        stream.ring.clear();
                        stream.frac_pos = 0.0;
                        stream.read_index = stream.write_index;
                        if stream.attr.prebuf > 0 {
                            stream.playing = false;
                        }
                        vec![wire::ack_packet(seq)]
                    }
                    None => vec![wire::error_packet(seq, err::NO_ENTITY)],
                }
            }
            cmd::TRIGGER_PLAYBACK_STREAM | cmd::PREBUF_PLAYBACK_STREAM => {
                let channel = r.u32()?;
                match state.streams.get_mut(&(self.id, channel)) {
                    Some(stream) => {
                        let mut replies = vec![];
                        if command == cmd::TRIGGER_PLAYBACK_STREAM && !stream.playing {
                            stream.playing = true;
                            replies.push(started_event(channel));
                        }
                        replies.push(wire::ack_packet(seq));
                        replies
                    }
                    None => vec![wire::error_packet(seq, err::NO_ENTITY)],
                }
            }
            cmd::GET_PLAYBACK_LATENCY => {
                let channel = r.u32()?;
                let (echo_secs, echo_usecs) = r.timeval()?;
                match state.streams.get(&(self.id, channel)) {
                    Some(stream) => {
                        let mut reply = TsWriter::new();
                        reply.put_usec(REPORTED_SINK_LATENCY_USEC);
                        reply.put_usec(0);
                        reply.put_bool(stream.playing && !stream.corked);
                        reply.put_timeval(echo_secs, echo_usecs);
                        reply.put_timeval(wall.0, wall.1);
                        reply.put_s64(stream.write_index);
                        reply.put_s64(stream.read_index);
                        reply.put_u64(stream.underrun_for_usec);
                        reply.put_u64(stream.playing_for_usec);
                        vec![wire::reply_packet(seq, reply)]
                    }
                    None => vec![wire::error_packet(seq, err::NO_ENTITY)],
                }
            }
            cmd::SET_PLAYBACK_STREAM_BUFFER_ATTR => {
                let channel = r.u32()?;
                let maxlength = r.u32()?;
                let tlength = r.u32()?;
                let prebuf = r.u32()?;
                let minreq = r.u32()?;
                // adjust_latency (v13+) and early_requests (v14+) follow;
                // both are about hardware buffers this sink does not have.
                match state.streams.get_mut(&(self.id, channel)) {
                    Some(stream) => {
                        let bytes_per_second = stream.frame_bytes() as u32 * stream.rate;
                        stream.attr =
                            resolve_attr(maxlength, tlength, prebuf, minreq, bytes_per_second);
                        let mut reply = TsWriter::new();
                        reply.put_u32(stream.attr.maxlength);
                        reply.put_u32(stream.attr.tlength);
                        reply.put_u32(stream.attr.prebuf);
                        reply.put_u32(stream.attr.minreq);
                        reply.put_usec(REPORTED_SINK_LATENCY_USEC);
                        vec![wire::reply_packet(seq, reply)]
                    }
                    None => vec![wire::error_packet(seq, err::NO_ENTITY)],
                }
            }
            cmd::UPDATE_PLAYBACK_STREAM_SAMPLE_RATE => {
                let channel = r.u32()?;
                let rate = r.u32()?;
                match state.streams.get_mut(&(self.id, channel)) {
                    Some(stream) if rate > 0 && rate <= MAX_RATE => {
                        stream.rate = rate;
                        vec![wire::ack_packet(seq)]
                    }
                    Some(_) => vec![wire::error_packet(seq, err::INVALID)],
                    None => vec![wire::error_packet(seq, err::NO_ENTITY)],
                }
            }
            cmd::SET_PLAYBACK_STREAM_NAME => {
                r.u32()?;
                r.string()?;
                vec![wire::ack_packet(seq)]
            }
            cmd::UPDATE_PLAYBACK_STREAM_PROPLIST => {
                r.u32()?;
                r.u32()?;
                r.proplist_get("")?;
                vec![wire::ack_packet(seq)]
            }
            cmd::REMOVE_PLAYBACK_STREAM_PROPLIST => {
                r.u32()?;
                vec![wire::ack_packet(seq)]
            }
            cmd::UPDATE_CLIENT_PROPLIST => {
                r.u32()?;
                r.proplist_get("")?;
                vec![wire::ack_packet(seq)]
            }
            cmd::SET_SINK_INPUT_VOLUME => {
                let index = r.u32()?;
                let volumes = r.cvolume()?;
                match state.streams.values_mut().find(|s| s.index == index) {
                    Some(stream) => {
                        stream.volume = volume_to_linear(&volumes);
                        vec![wire::ack_packet(seq)]
                    }
                    None => vec![wire::error_packet(seq, err::NO_ENTITY)],
                }
            }
            cmd::SET_SINK_INPUT_MUTE => {
                let index = r.u32()?;
                let muted = r.bool()?;
                match state.streams.values_mut().find(|s| s.index == index) {
                    Some(stream) => {
                        stream.muted = muted;
                        vec![wire::ack_packet(seq)]
                    }
                    None => vec![wire::error_packet(seq, err::NO_ENTITY)],
                }
            }
            cmd::GET_SERVER_INFO => {
                let mut reply = TsWriter::new();
                reply.put_string(Some("pulseaudio"));
                reply.put_string(Some("15.0"));
                reply.put_string(Some("user"));
                reply.put_string(Some("iwappd"));
                reply.put_sample_spec(3 /* s16le */, OUT_CHANNELS, OUT_RATE);
                reply.put_string(Some(SINK_NAME));
                reply.put_string(Some("iw_out.monitor"));
                reply.put_u32(0x4977_0001); // server cookie, arbitrary but stable
                if self.version >= 15 {
                    reply.put_channel_map(OUT_CHANNELS);
                }
                vec![wire::reply_packet(seq, reply)]
            }
            cmd::GET_SINK_INFO => {
                let index = r.index()?;
                let name = r.string()?;
                let ours = matches!(
                    (index, name.as_deref()),
                    (Some(0), _) | (None, Some(SINK_NAME)) | (None, Some("@DEFAULT_SINK@"))
                );
                if ours {
                    let mut reply = TsWriter::new();
                    write_sink_info(&mut reply, self.version);
                    vec![wire::reply_packet(seq, reply)]
                } else {
                    vec![wire::error_packet(seq, err::NO_ENTITY)]
                }
            }
            cmd::GET_SINK_INFO_LIST => {
                let mut reply = TsWriter::new();
                write_sink_info(&mut reply, self.version);
                vec![wire::reply_packet(seq, reply)]
            }
            cmd::GET_SOURCE_INFO => {
                r.index()?;
                r.string()?;
                vec![wire::error_packet(seq, err::NO_ENTITY)]
            }
            cmd::LOOKUP_SINK => {
                let name = r.string()?;
                match name.as_deref() {
                    Some(SINK_NAME) | Some("@DEFAULT_SINK@") => {
                        let mut reply = TsWriter::new();
                        reply.put_u32(0);
                        vec![wire::reply_packet(seq, reply)]
                    }
                    _ => vec![wire::error_packet(seq, err::NO_ENTITY)],
                }
            }
            // Lists we legitimately have nothing in: an empty reply payload
            // is the wire encoding of an empty list.
            cmd::GET_SOURCE_INFO_LIST
            | cmd::GET_MODULE_INFO_LIST
            | cmd::GET_CLIENT_INFO_LIST
            | cmd::GET_SINK_INPUT_INFO_LIST
            | cmd::GET_SOURCE_OUTPUT_INFO_LIST
            | cmd::GET_SAMPLE_INFO_LIST
            | cmd::GET_CARD_INFO_LIST => {
                vec![wire::reply_packet(seq, TsWriter::new())]
            }
            cmd::STAT => {
                let mut reply = TsWriter::new();
                for _ in 0..5 {
                    reply.put_u32(0);
                }
                vec![wire::reply_packet(seq, reply)]
            }
            // Subscriptions are accepted and never fire: the sink topology
            // cannot change under anyone.
            cmd::SUBSCRIBE => {
                r.u32()?;
                vec![wire::ack_packet(seq)]
            }
            // Recording needs a capture device the viewer does not offer.
            cmd::CREATE_RECORD_STREAM | cmd::DELETE_RECORD_STREAM => {
                vec![wire::error_packet(seq, err::NOT_SUPPORTED)]
            }
            // pactl exit must not take the session's windows with it.
            cmd::EXIT => vec![wire::ack_packet(seq)],
            _ => vec![wire::error_packet(seq, err::NOT_IMPLEMENTED)],
        })
    }

    fn create_playback_stream(
        &mut self,
        state: &mut AudioState,
        seq: u32,
        r: &mut TsReader<'_>,
    ) -> Result<Vec<Vec<u8>>, TagError> {
        let (format_code, mut channels, mut rate) = r.sample_spec()?;
        r.channel_map()?;
        r.index()?; // sink index — there is only one sink
        r.string()?; // sink name
        let maxlength = r.u32()?;
        let start_corked = r.bool()?;
        let tlength = r.u32()?;
        let prebuf = r.u32()?;
        let minreq = r.u32()?;
        let _sync_id = r.u32()?;
        let cvolume = r.cvolume()?;

        let _no_remap = r.bool()?;
        let _no_remix = r.bool()?;
        let fix_format = r.bool()?;
        let fix_rate = r.bool()?;
        let fix_channels = r.bool()?;
        let _no_move = r.bool()?;
        let _variable_rate = r.bool()?;

        let muted = r.bool()?;
        let _adjust_latency = r.bool()?;
        let _props = r.proplist_get("")?;

        let mut volume_set = true;
        if self.version >= 14 {
            volume_set = r.bool()?;
            let _early_requests = r.bool()?;
        }
        let mut muted_set = true;
        if self.version >= 15 {
            muted_set = r.bool()?;
            let _no_inhibit_auto_suspend = r.bool()?;
            let _fail_on_suspend = r.bool()?;
        }
        if self.version >= 17 {
            let _relative_volume = r.bool()?;
        }
        if self.version >= 18 {
            let _passthrough = r.bool()?;
        }
        if self.version >= 21 {
            let n_formats = r.u8()?;
            for _ in 0..n_formats {
                r.format_info()?;
            }
        }

        let mut format = match Format::from_wire(format_code) {
            Some(f) => f,
            None => return Ok(vec![wire::error_packet(seq, err::NOT_SUPPORTED)]),
        };
        if fix_format {
            format = Format::S16Le;
        }
        if fix_rate {
            rate = OUT_RATE;
        }
        if fix_channels {
            channels = OUT_CHANNELS;
        }
        if channels == 0 || channels > MAX_STREAM_CHANNELS || rate == 0 || rate > MAX_RATE {
            return Ok(vec![wire::error_packet(seq, err::INVALID)]);
        }

        let bytes_per_second = format.bytes() as u32 * channels as u32 * rate;
        let attr = resolve_attr(maxlength, tlength, prebuf, minreq, bytes_per_second);

        let channel = self.next_channel;
        self.next_channel += 1;
        let index = state.next_stream_index;
        state.next_stream_index += 1;

        let stream = Stream {
            index,
            version: self.version,
            format,
            channels,
            rate,
            attr,
            ring: Vec::new(),
            frac_pos: 0.0,
            corked: start_corked,
            playing: attr.prebuf == 0,
            drain_seq: None,
            requested: attr.tlength as usize,
            write_index: 0,
            read_index: 0,
            playing_for_usec: 0,
            underrun_for_usec: 0,
            volume: if volume_set {
                volume_to_linear(&cvolume)
            } else {
                1.0
            },
            muted: muted_set && muted,
        };

        let mut reply = TsWriter::new();
        reply.put_u32(channel);
        reply.put_u32(index);
        reply.put_u32(stream.attr.tlength); // requested bytes: fill the target
        reply.put_u32(stream.attr.maxlength);
        reply.put_u32(stream.attr.tlength);
        reply.put_u32(stream.attr.prebuf);
        reply.put_u32(stream.attr.minreq);
        reply.put_sample_spec(format_code_of(format), channels, rate);
        reply.put_channel_map(channels);
        reply.put_u32(0); // sink index
        reply.put_string(Some(SINK_NAME));
        reply.put_bool(false); // not suspended
        reply.put_usec(REPORTED_SINK_LATENCY_USEC);
        if self.version >= 21 {
            reply.put_format_info_pcm();
        }

        state.streams.insert((self.id, channel), stream);
        Ok(vec![wire::reply_packet(seq, reply)])
    }

    /// A memblock: PCM for one stream, possibly with a seek.
    fn handle_data(&mut self, state: &mut AudioState, packet: &Packet, out: &mut Vec<Vec<u8>>) {
        let Descriptor {
            channel,
            offset,
            flags,
            ..
        } = packet.descriptor;
        let Some(stream) = state.streams.get_mut(&(self.id, channel)) else {
            return; // data for a deleted stream races its teardown; drop it
        };

        // Seek before write. `write_index` is the byte position the next
        // sample lands at; a rewind drops tail bytes we have not played yet,
        // a forward seek inserts silence.
        let target = match flags & 0xff {
            seek::RELATIVE => stream.write_index + offset,
            seek::ABSOLUTE => offset,
            seek::RELATIVE_ON_READ => stream.read_index + offset,
            seek::RELATIVE_END => stream.write_index + offset,
            _ => stream.write_index,
        };
        if target < stream.write_index {
            // Rewind: drop unplayed tail bytes. Clamped to what is still in
            // the ring — bytes already mixed cannot be taken back.
            let rewind = ((stream.write_index - target) as usize).min(stream.ring.len());
            stream.ring.truncate(stream.ring.len() - rewind);
            stream.write_index -= rewind as i64;
        } else if target > stream.write_index {
            let gap = (target - stream.write_index) as usize;
            // A forward seek is silence the client chose to skip writing.
            let capped = gap.min(stream.attr.maxlength as usize);
            stream.ring.extend(std::iter::repeat_n(0u8, capped));
            stream.write_index = target;
        }

        // Append, respecting maxlength.
        let space = (stream.attr.maxlength as usize).saturating_sub(stream.ring.len());
        let data = &packet.payload;
        let (fits, overflow) = data.split_at(data.len().min(space));
        stream.ring.extend_from_slice(fits);
        stream.write_index += fits.len() as i64;
        stream.requested = stream.requested.saturating_sub(data.len());
        if !overflow.is_empty() {
            let mut payload = TsWriter::new();
            payload.put_u32(channel);
            out.push(wire::event_packet(cmd::OVERFLOW, payload));
        }

        if !stream.playing && stream.drain_seq.is_none() && stream.prebuf_satisfied() {
            stream.playing = true;
            out.push(started_event(channel));
        }
    }
}

fn started_event(channel: u32) -> Vec<u8> {
    let mut payload = TsWriter::new();
    payload.put_u32(channel);
    wire::event_packet(cmd::STARTED, payload)
}

fn format_code_of(format: Format) -> u8 {
    match format {
        Format::U8 => 0,
        Format::S16Le => 3,
        Format::S16Be => 4,
        Format::F32Le => 5,
        Format::F32Be => 6,
        Format::S32Le => 7,
        Format::S32Be => 8,
        Format::S24Le => 9,
        Format::S24Be => 10,
        Format::S24In32Le => 11,
        Format::S24In32Be => 12,
    }
}

/// PulseAudio volumes are cubic: `linear = (raw / NORM)³`.
fn volume_to_linear(volumes: &[u32]) -> f32 {
    if volumes.is_empty() {
        return 1.0;
    }
    let avg = volumes.iter().map(|&v| v as f64).sum::<f64>() / volumes.len() as f64;
    let f = (avg / VOLUME_NORM as f64) as f32;
    (f * f * f).clamp(0.0, 4.0)
}

/// The sink, at whatever protocol version the client negotiated.
fn write_sink_info(w: &mut TsWriter, version: u32) {
    w.put_u32(0); // index
    w.put_string(Some(SINK_NAME));
    w.put_string(Some(SINK_DESCRIPTION));
    w.put_sample_spec(3 /* s16le */, OUT_CHANNELS, OUT_RATE);
    w.put_channel_map(OUT_CHANNELS);
    w.put_index(None); // owner module
    w.put_cvolume(&[VOLUME_NORM; OUT_CHANNELS as usize]);
    w.put_bool(false); // muted
    w.put_index(None); // monitor source
    w.put_string(None); // monitor source name
    w.put_usec(REPORTED_SINK_LATENCY_USEC); // actual latency
    w.put_string(Some("iwappd")); // driver
    w.put_u32(0x0002); // flags: LATENCY
    w.put_proplist(&[("device.description", SINK_DESCRIPTION)]);
    w.put_usec(REPORTED_SINK_LATENCY_USEC); // configured latency
    if version >= 15 {
        w.put_volume(VOLUME_NORM); // base volume
        w.put_u32(0); // state: running
        w.put_u32(0); // volume steps: arbitrary
        w.put_index(None); // card
    }
    if version >= 16 {
        w.put_u32(0); // no ports
        w.put_string(None); // no active port
    }
    if version >= 21 {
        w.put_u8(1);
        w.put_format_info_pcm();
    }
}

#[cfg(test)]
mod tests {
    use super::super::wire::{DESCRIPTOR_LEN, control_packet};
    use super::*;

    const WALL: WallClock = (1_000, 500);

    /// Reads packets a test client received, split into (command, seq,
    /// payload-reader-bytes) triples.
    fn parse_control(packets: &[Vec<u8>]) -> Vec<(u32, u32, Vec<u8>)> {
        packets
            .iter()
            .map(|bytes| {
                let mut r = TsReader::new(&bytes[DESCRIPTOR_LEN..]);
                let command = r.u32().unwrap();
                let seq = r.u32().unwrap();
                let rest = bytes[DESCRIPTOR_LEN + 10..].to_vec();
                (command, seq, rest)
            })
            .collect()
    }

    fn auth_packet(seq: u32, version: u32) -> Vec<u8> {
        let mut w = TsWriter::new();
        w.put_u32(version);
        w.put_arbitrary(&[0u8; 256]);
        control_packet(cmd::AUTH, seq, &w.into_bytes())
    }

    fn name_packet(seq: u32) -> Vec<u8> {
        let mut w = TsWriter::new();
        w.put_proplist(&[("application.name", "Test App")]);
        control_packet(cmd::SET_CLIENT_NAME, seq, &w.into_bytes())
    }

    fn create_stream_packet(seq: u32, rate: u32, channels: u8, prebuf: u32) -> Vec<u8> {
        let mut w = TsWriter::new();
        w.put_sample_spec(3, channels, rate); // s16le
        w.put_channel_map(channels);
        w.put_index(None);
        w.put_string(Some("@DEFAULT_SINK@"));
        w.put_u32(u32::MAX); // maxlength
        w.put_bool(false); // start corked
        w.put_u32(u32::MAX); // tlength
        w.put_u32(prebuf);
        w.put_u32(u32::MAX); // minreq
        w.put_u32(0); // sync id
        w.put_cvolume(&[VOLUME_NORM, VOLUME_NORM]);
        for _ in 0..7 {
            w.put_bool(false); // no_remap … variable_rate
        }
        w.put_bool(false); // muted
        w.put_bool(false); // adjust_latency
        w.put_proplist(&[]);
        w.put_bool(true); // volume_set (v14)
        w.put_bool(false); // early_requests
        w.put_bool(false); // muted_set (v15)
        w.put_bool(false); // no_inhibit
        w.put_bool(false); // fail_on_suspend
        w.put_bool(false); // relative_volume (v17)
        w.put_bool(false); // passthrough (v18)
        w.put_u8(0); // formats (v21)
        control_packet(cmd::CREATE_PLAYBACK_STREAM, seq, &w.into_bytes())
    }

    fn memblock(channel: u32, data: &[u8]) -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&(data.len() as u32).to_be_bytes());
        bytes.extend_from_slice(&channel.to_be_bytes());
        bytes.extend_from_slice(&0u64.to_be_bytes());
        bytes.extend_from_slice(&seek::RELATIVE.to_be_bytes());
        bytes.extend_from_slice(data);
        bytes
    }

    fn handshake(conn: &mut Connection, state: &mut AudioState) {
        let out = conn.feed(state, &auth_packet(0, 35), WALL).unwrap();
        let parsed = parse_control(&out);
        assert_eq!(parsed[0].0, cmd::REPLY);
        let out = conn.feed(state, &name_packet(1), WALL).unwrap();
        assert_eq!(parse_control(&out)[0].0, cmd::REPLY);
    }

    /// s16le stereo frames of a constant sample value.
    fn pcm(frames: usize, value: i16) -> Vec<u8> {
        let mut out = Vec::with_capacity(frames * 4);
        for _ in 0..frames * 2 {
            out.extend_from_slice(&value.to_le_bytes());
        }
        out
    }

    #[test]
    fn commands_before_auth_are_denied() {
        let mut state = AudioState::new();
        let mut conn = Connection::new(1);
        let out = conn
            .feed(
                &mut state,
                &control_packet(cmd::GET_SERVER_INFO, 9, &[]),
                WALL,
            )
            .unwrap();
        let parsed = parse_control(&out);
        assert_eq!(parsed[0].0, cmd::ERROR);
        assert_eq!(parsed[0].1, 9);
    }

    #[test]
    fn the_handshake_negotiates_down_and_refuses_shm() {
        let mut state = AudioState::new();
        let mut conn = Connection::new(1);
        let mut w = TsWriter::new();
        w.put_u32(wire::FLAG_SHM | wire::FLAG_MEMFD | 36);
        w.put_arbitrary(&[]);
        let out = conn
            .feed(
                &mut state,
                &control_packet(cmd::AUTH, 0, &w.into_bytes()),
                WALL,
            )
            .unwrap();
        let parsed = parse_control(&out);
        let mut r = TsReader::new(&parsed[0].2);
        let negotiated = r.u32().unwrap();
        assert_eq!(negotiated, 35, "no shm/memfd bits, version capped");
    }

    #[test]
    fn an_ancient_client_is_refused_by_version() {
        let mut state = AudioState::new();
        let mut conn = Connection::new(1);
        let out = conn.feed(&mut state, &auth_packet(0, 8), WALL).unwrap();
        let parsed = parse_control(&out);
        assert_eq!(parsed[0].0, cmd::ERROR);
    }

    #[test]
    fn a_stream_prebuffers_starts_and_mixes() {
        let mut state = AudioState::new();
        let mut conn = Connection::new(1);
        handshake(&mut conn, &mut state);

        let out = conn
            .feed(
                &mut state,
                &create_stream_packet(2, 48_000, 2, u32::MAX),
                WALL,
            )
            .unwrap();
        let parsed = parse_control(&out);
        assert_eq!(parsed[0].0, cmd::REPLY);
        let mut r = TsReader::new(&parsed[0].2);
        let channel = r.u32().unwrap();
        let _index = r.u32().unwrap();
        let requested = r.u32().unwrap();
        assert!(requested > 0, "the create reply asks for data immediately");

        // Nothing plays before prebuf is met — the chunk stream starts (and
        // takes the reset flag) but carries silence.
        let quiet = state.mix(480);
        assert!(quiet.reset);
        assert!(quiet.pcm.iter().all(|&s| s == 0));

        // Send a full target worth of a constant tone.
        let out = conn
            .feed(&mut state, &memblock(channel, &pcm(9_600, 1000)), WALL)
            .unwrap();
        let events = parse_control(&out);
        assert!(
            events
                .iter()
                .any(|(command, _, _)| *command == cmd::STARTED),
            "prebuf satisfied should emit Started"
        );

        let mixed = state.mix(480);
        assert!(!mixed.reset, "the chunk stream is already running");
        assert_eq!(mixed.pcm.len(), 960);
        assert!(
            mixed.pcm.iter().all(|&s| s == 1000),
            "s16 passes through untouched"
        );
    }

    #[test]
    fn two_streams_sum_and_saturate() {
        let mut state = AudioState::new();
        let mut conn = Connection::new(1);
        handshake(&mut conn, &mut state);

        for seq in [2, 3] {
            let out = conn
                .feed(&mut state, &create_stream_packet(seq, 48_000, 2, 0), WALL)
                .unwrap();
            let parsed = parse_control(&out);
            let mut r = TsReader::new(&parsed[0].2);
            let channel = r.u32().unwrap();
            conn.feed(&mut state, &memblock(channel, &pcm(960, 20_000)), WALL)
                .unwrap();
        }

        let mixed = state.mix(480);
        assert!(
            mixed.pcm.iter().all(|&s| s == 32767),
            "two 20k streams clip at full scale, not wrap"
        );
    }

    #[test]
    fn a_mono_44100_stream_is_resampled_to_both_channels() {
        let mut state = AudioState::new();
        let mut conn = Connection::new(1);
        handshake(&mut conn, &mut state);

        let mut w = TsWriter::new();
        w.put_sample_spec(3, 1, 44_100);
        w.put_channel_map(1);
        w.put_index(None);
        w.put_string(None);
        w.put_u32(u32::MAX);
        w.put_bool(false);
        w.put_u32(u32::MAX);
        w.put_u32(0); // prebuf 0: start immediately
        w.put_u32(u32::MAX);
        w.put_u32(0);
        w.put_cvolume(&[VOLUME_NORM]);
        for _ in 0..7 {
            w.put_bool(false);
        }
        w.put_bool(false);
        w.put_bool(false);
        w.put_proplist(&[]);
        w.put_bool(true);
        w.put_bool(false);
        w.put_bool(false);
        w.put_bool(false);
        w.put_bool(false);
        w.put_bool(false);
        w.put_bool(false);
        w.put_u8(0);
        let out = conn
            .feed(
                &mut state,
                &control_packet(cmd::CREATE_PLAYBACK_STREAM, 2, &w.into_bytes()),
                WALL,
            )
            .unwrap();
        let parsed = parse_control(&out);
        assert_eq!(parsed[0].0, cmd::REPLY);
        let mut r = TsReader::new(&parsed[0].2);
        let channel = r.u32().unwrap();

        // One second of mono s16 at 44.1k, constant value.
        let mut data = Vec::new();
        for _ in 0..44_100 {
            data.extend_from_slice(&4000i16.to_le_bytes());
        }
        conn.feed(&mut state, &memblock(channel, &data), WALL)
            .unwrap();

        let mixed = state.mix(480);
        assert_eq!(mixed.pcm.len(), 960);
        // Constant input resamples to the same constant, on both channels.
        assert!(mixed.pcm.iter().all(|&s| (s - 4000).abs() <= 1));
    }

    #[test]
    fn underrun_reverts_to_prebuffering_and_reports_it() {
        let mut state = AudioState::new();
        let mut conn = Connection::new(1);
        handshake(&mut conn, &mut state);

        let out = conn
            .feed(
                &mut state,
                &create_stream_packet(2, 48_000, 2, u32::MAX),
                WALL,
            )
            .unwrap();
        let parsed = parse_control(&out);
        let mut r = TsReader::new(&parsed[0].2);
        let channel = r.u32().unwrap();

        // Enough to start, not enough to survive the playback that follows.
        conn.feed(&mut state, &memblock(channel, &pcm(9_600, 100)), WALL)
            .unwrap();
        let mut underflows = 0;
        for _ in 0..30 {
            for (_, bytes) in state.mix(480).packets {
                if parse_control(std::slice::from_ref(&bytes))[0].0 == cmd::UNDERFLOW {
                    underflows += 1;
                }
            }
        }
        assert_eq!(
            underflows, 1,
            "one underflow, then prebuffering — not one per tick"
        );
    }

    #[test]
    fn requests_keep_the_buffer_topped_up() {
        let mut state = AudioState::new();
        let mut conn = Connection::new(1);
        handshake(&mut conn, &mut state);

        let out = conn
            .feed(&mut state, &create_stream_packet(2, 48_000, 2, 0), WALL)
            .unwrap();
        let parsed = parse_control(&out);
        let mut r = TsReader::new(&parsed[0].2);
        let channel = r.u32().unwrap();

        conn.feed(&mut state, &memblock(channel, &pcm(9_600, 5)), WALL)
            .unwrap();
        // Play half the buffer down; a Request should appear.
        let mut requested = 0u32;
        for _ in 0..60 {
            for (_, bytes) in state.mix(480).packets {
                let parsed = parse_control(std::slice::from_ref(&bytes));
                if parsed[0].0 == cmd::REQUEST {
                    let mut r = TsReader::new(&parsed[0].2);
                    assert_eq!(r.u32().unwrap(), channel);
                    requested += r.u32().unwrap();
                }
            }
        }
        assert!(requested > 0, "the mixer should request refills");
    }

    #[test]
    fn drain_acks_when_the_buffer_empties() {
        let mut state = AudioState::new();
        let mut conn = Connection::new(1);
        handshake(&mut conn, &mut state);

        let out = conn
            .feed(&mut state, &create_stream_packet(2, 48_000, 2, 0), WALL)
            .unwrap();
        let parsed = parse_control(&out);
        let mut r = TsReader::new(&parsed[0].2);
        let channel = r.u32().unwrap();

        conn.feed(&mut state, &memblock(channel, &pcm(480, 7)), WALL)
            .unwrap();
        let mut w = TsWriter::new();
        w.put_u32(channel);
        let out = conn
            .feed(
                &mut state,
                &control_packet(cmd::DRAIN_PLAYBACK_STREAM, 8, &w.into_bytes()),
                WALL,
            )
            .unwrap();
        assert!(out.is_empty(), "drain ack waits for the buffer");

        let mut acked = false;
        for _ in 0..5 {
            for (_, bytes) in state.mix(480).packets {
                let parsed = parse_control(std::slice::from_ref(&bytes));
                if parsed[0].0 == cmd::REPLY && parsed[0].1 == 8 {
                    acked = true;
                }
            }
        }
        assert!(acked, "drain acked once the ring emptied");
    }

    #[test]
    fn cork_silences_without_ending_the_stream() {
        let mut state = AudioState::new();
        let mut conn = Connection::new(1);
        handshake(&mut conn, &mut state);

        let out = conn
            .feed(&mut state, &create_stream_packet(2, 48_000, 2, 0), WALL)
            .unwrap();
        let parsed = parse_control(&out);
        let mut r = TsReader::new(&parsed[0].2);
        let channel = r.u32().unwrap();
        conn.feed(&mut state, &memblock(channel, &pcm(4_800, 123)), WALL)
            .unwrap();

        let mut w = TsWriter::new();
        w.put_u32(channel);
        w.put_bool(true);
        conn.feed(
            &mut state,
            &control_packet(cmd::CORK_PLAYBACK_STREAM, 5, &w.into_bytes()),
            WALL,
        )
        .unwrap();

        let corked = state.mix(480);
        assert!(corked.pcm.is_empty(), "everything corked: no chunk at all");

        let mut w = TsWriter::new();
        w.put_u32(channel);
        w.put_bool(false);
        conn.feed(
            &mut state,
            &control_packet(cmd::CORK_PLAYBACK_STREAM, 6, &w.into_bytes()),
            WALL,
        )
        .unwrap();
        let resumed = state.mix(480);
        assert!(resumed.pcm.iter().all(|&s| s == 123));
    }

    #[test]
    fn stream_volume_scales_the_mix() {
        let mut state = AudioState::new();
        let mut conn = Connection::new(1);
        handshake(&mut conn, &mut state);

        let out = conn
            .feed(&mut state, &create_stream_packet(2, 48_000, 2, 0), WALL)
            .unwrap();
        let parsed = parse_control(&out);
        let mut r = TsReader::new(&parsed[0].2);
        let channel = r.u32().unwrap();
        let index = r.u32().unwrap();
        conn.feed(&mut state, &memblock(channel, &pcm(4_800, 10_000)), WALL)
            .unwrap();

        // Half volume on the cubic scale is (0.5)^3 = 1/8 linear.
        let mut w = TsWriter::new();
        w.put_u32(index);
        w.put_cvolume(&[VOLUME_NORM / 2, VOLUME_NORM / 2]);
        conn.feed(
            &mut state,
            &control_packet(cmd::SET_SINK_INPUT_VOLUME, 5, &w.into_bytes()),
            WALL,
        )
        .unwrap();

        let mixed = state.mix(480);
        assert!(mixed.pcm.iter().all(|&s| (s - 1_250).abs() <= 2));
    }

    #[test]
    fn latency_query_echoes_the_timestamp_and_reports_indices() {
        let mut state = AudioState::new();
        let mut conn = Connection::new(1);
        handshake(&mut conn, &mut state);

        let out = conn
            .feed(&mut state, &create_stream_packet(2, 48_000, 2, 0), WALL)
            .unwrap();
        let parsed = parse_control(&out);
        let mut r = TsReader::new(&parsed[0].2);
        let channel = r.u32().unwrap();
        conn.feed(&mut state, &memblock(channel, &pcm(960, 1)), WALL)
            .unwrap();
        state.mix(480);

        let mut w = TsWriter::new();
        w.put_u32(channel);
        w.put_timeval(11, 22);
        let out = conn
            .feed(
                &mut state,
                &control_packet(cmd::GET_PLAYBACK_LATENCY, 9, &w.into_bytes()),
                WALL,
            )
            .unwrap();
        let parsed = parse_control(&out);
        let mut r = TsReader::new(&parsed[0].2);
        assert_eq!(r.usec().unwrap(), REPORTED_SINK_LATENCY_USEC);
        assert_eq!(r.usec().unwrap(), 0);
        assert!(r.bool().unwrap());
        assert_eq!(r.timeval().unwrap(), (11, 22), "client timestamp echoed");
        assert_eq!(r.timeval().unwrap(), WALL);
        assert_eq!(r.s64().unwrap(), 960 * 4, "write index in bytes");
        assert_eq!(r.s64().unwrap(), 480 * 4, "read index in bytes");
    }

    #[test]
    fn introspection_replies_do_not_error() {
        let mut state = AudioState::new();
        let mut conn = Connection::new(1);
        handshake(&mut conn, &mut state);

        for command in [
            cmd::GET_SERVER_INFO,
            cmd::GET_SINK_INFO_LIST,
            cmd::GET_SOURCE_INFO_LIST,
            cmd::GET_CLIENT_INFO_LIST,
            cmd::GET_SINK_INPUT_INFO_LIST,
            cmd::STAT,
        ] {
            let out = conn
                .feed(&mut state, &control_packet(command, 50, &[]), WALL)
                .unwrap();
            let parsed = parse_control(&out);
            assert_eq!(parsed[0].0, cmd::REPLY, "command {command} should reply");
        }
    }

    #[test]
    fn record_streams_are_politely_refused() {
        let mut state = AudioState::new();
        let mut conn = Connection::new(1);
        handshake(&mut conn, &mut state);
        let out = conn
            .feed(
                &mut state,
                &control_packet(cmd::CREATE_RECORD_STREAM, 3, &[]),
                WALL,
            )
            .unwrap();
        let parsed = parse_control(&out);
        assert_eq!(parsed[0].0, cmd::ERROR);
    }

    #[test]
    fn disconnect_removes_the_connections_streams() {
        let mut state = AudioState::new();
        let mut conn = Connection::new(1);
        handshake(&mut conn, &mut state);
        conn.feed(&mut state, &create_stream_packet(2, 48_000, 2, 0), WALL)
            .unwrap();
        assert_eq!(state.stream_count(), 1);
        state.remove_connection(1);
        assert_eq!(state.stream_count(), 0);
    }

    #[test]
    fn an_unknown_command_gets_not_implemented_not_a_hang() {
        let mut state = AudioState::new();
        let mut conn = Connection::new(1);
        handshake(&mut conn, &mut state);
        let out = conn
            .feed(&mut state, &control_packet(104, 77, &[1, 2, 3]), WALL)
            .unwrap();
        let parsed = parse_control(&out);
        assert_eq!(parsed[0].0, cmd::ERROR);
        assert_eq!(parsed[0].1, 77);
    }
}
