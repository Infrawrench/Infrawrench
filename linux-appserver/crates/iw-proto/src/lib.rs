//! The wire protocol spoken between an Infrawrench client (Electron main, the
//! web server, or the CLI) and `iwappd` running on the remote host.
//!
//! The transport is whatever byte stream carries us — in production the stdio
//! of an SSH exec channel — so everything here is framing over an unreliable
//! chunking, never over message boundaries the transport might not preserve.
//!
//! ```text
//! u32 len | u8 kind | u32 windowId | payload[len - 5]
//! ```
//!
//! `len` counts the bytes after itself, so a frame with an empty payload is
//! `05 00 00 00` plus the kind and window id. Control traffic is JSON
//! ([`ClientMessage`] / [`ServerMessage`]); pixels, input and clipboard blobs
//! are binary because they are hot or large.

mod audio;
mod frame;
mod input;
mod messages;

pub use audio::{AUDIO_FLAG_RESET, AUDIO_HEADER_LEN, AudioChunk, AudioCodec};
pub use frame::{Frame, FrameDecoder, FrameKind, MAX_FRAME_LEN, encode_frame};
pub use input::{
    ButtonState, InputEvent, PointerButton, decode_input_batch, encode_input_batch, fixed_from_px,
    v120_from_axis,
};
pub use messages::{
    AppEntry, ClientCaps, ClientMessage, ClipboardBlob, CursorImage, ErrorCode, PixelFormat,
    ServerCaps, ServerMessage, WindowCloseReason,
};

/// Protocol version. Bumped whenever a frame layout or a required field
/// changes; the client refuses a session whose `Welcome.protocol` it does not
/// know, and a host with an older binary is replaced rather than negotiated
/// down (see the delivery notes in the README).
pub const PROTOCOL_VERSION: u32 = 1;

/// The session-level window id. Frames that are about the session rather than
/// a particular window (app lists, clipboard, errors) carry this.
pub const SESSION_WINDOW: u32 = 0;

/// Errors from decoding a frame or its payload.
#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("frame length {0} exceeds the {MAX_FRAME_LEN} byte limit")]
    FrameTooLarge(u32),
    #[error("frame length {0} is shorter than the {1} byte header")]
    FrameTooShort(u32, u32),
    #[error("unknown frame kind {0:#04x}")]
    UnknownKind(u8),
    #[error("truncated payload: expected {expected} bytes, got {actual}")]
    Truncated { expected: usize, actual: usize },
    #[error("invalid input event kind {0}")]
    UnknownInputEvent(u8),
    #[error("unknown audio codec {0}")]
    UnknownAudioCodec(u8),
    #[error("malformed control message: {0}")]
    Json(#[from] serde_json::Error),
    #[error("invalid utf-8 in {field}")]
    Utf8 { field: &'static str },
}
