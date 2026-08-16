//! Damage tracking and the tiered pixel encoder.
//!
//! Nothing here knows about Wayland or about the transport: it takes a buffer
//! of pixels plus the rectangles a client said it damaged, and produces the
//! payload of an [`iw_proto::FrameKind::Pixels`] frame. That makes the
//! interesting half of the app server testable on a laptop, which matters
//! because the compositor half only builds on Linux.

mod encoder;
mod payload;
mod rect;
mod tier;

pub use encoder::{
    EncodeError, EncodeMode, EncodedFrame, Encoder, EncoderConfig, EncoderStats, FrameView,
};
pub use payload::{
    Codec, FLAG_KEYFRAME, HEADER_LEN, PayloadError, PixelPayload, RECT_LEN, RectEntry, RectOp,
};
pub use rect::{CoalesceLimits, Rect, coalesce};
pub use tier::{Tier, TierSelector};
