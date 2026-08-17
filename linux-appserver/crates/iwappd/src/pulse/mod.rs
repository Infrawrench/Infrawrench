//! A PulseAudio server for the applications this compositor runs.
//!
//! A headless cloud VM has no sound card and usually no sound server, so an
//! application that wants to play audio finds nothing — libpulse connects to
//! `$PULSE_SERVER`, and nothing is listening. This module is what listens:
//! enough of the PulseAudio native protocol to accept playback streams, mix
//! them, and hand the result to the session as [`iw_proto::AudioChunk`]s. The
//! same call as bundling the compositor instead of requiring an X server —
//! the host needs nothing installed, and libpulse is the one audio client
//! library everything links (including PipeWire's, which is what apps on a
//! modern desktop actually mean by "pulse").
//!
//! Deliberate scope limits: playback only (a record stream is refused — the
//! viewer offers no microphone), shared memory refused during the handshake
//! so every sample crosses the socket, and one sink whose format is the
//! transport's own 48 kHz stereo s16.

pub mod server;
pub mod tagstruct;
pub mod wire;

#[cfg(unix)]
mod runtime;
#[cfg(unix)]
pub use runtime::{PulseRuntime, start};

pub use server::{AudioState, Connection, MixOutput, OUT_CHANNELS, OUT_RATE, SINK_NAME};
