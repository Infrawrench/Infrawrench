//! The lossless tier: damage rectangles → solid fills and zstd'd pixels.
//!
//! The encoder keeps a copy of what the client's canvas holds, not a copy of
//! the last buffer the app rendered. That distinction is the whole design:
//! rectangles whose pixels did not actually change are dropped (toolkits
//! over-report damage constantly), and because `prev` models the client rather
//! than the app, a frame that is never sent must never reach the encoder.
//!
//! So flow control drops happen *before* encoding: while a window is out of
//! in-flight slots the session accumulates damage rectangles and encodes once,
//! later, against the same `prev`. Dropping after encoding would leave the
//! client holding pixels the encoder believes it already has.

use crate::payload::{Codec, PixelPayload, RectEntry, RectOp};
use crate::rect::{CoalesceLimits, Rect, coalesce};

/// A borrowed view of a window's current pixels, in the session's pixel format
/// (4 bytes per pixel). `stride` is the row length in bytes, which `wl_shm`
/// buffers routinely pad beyond `width * 4`.
#[derive(Debug, Clone, Copy)]
pub struct FrameView<'a> {
    pub width: u32,
    pub height: u32,
    pub stride: u32,
    pub pixels: &'a [u8],
}

impl<'a> FrameView<'a> {
    fn row(&self, y: u32) -> &'a [u8] {
        let start = (y * self.stride) as usize;
        &self.pixels[start..start + self.width as usize * 4]
    }

    fn validate(&self) -> Result<(), EncodeError> {
        if self.stride < self.width * 4 {
            return Err(EncodeError::StrideTooSmall {
                stride: self.stride,
                width: self.width,
            });
        }
        let needed = (self.height as usize).saturating_mul(self.stride as usize);
        if self.pixels.len() < needed {
            return Err(EncodeError::BufferTooSmall {
                expected: needed,
                actual: self.pixels.len(),
            });
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy)]
pub struct EncoderConfig {
    pub limits: CoalesceLimits,
    /// zstd level. 1–3 is the useful range here: level 3 is ~2× the cost of
    /// level 1 for a few percent, and we are encoding on someone else's VM.
    pub zstd_level: i32,
    /// False when the client reported no wasm zstd decoder.
    pub allow_zstd: bool,
}

impl Default for EncoderConfig {
    fn default() -> Self {
        Self {
            limits: CoalesceLimits::default(),
            zstd_level: 2,
            allow_zstd: true,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum EncodeError {
    #[error("stride {stride} cannot hold {width} pixels")]
    StrideTooSmall { stride: u32, width: u32 },
    #[error("pixel buffer is {actual} bytes, expected at least {expected}")]
    BufferTooSmall { expected: usize, actual: usize },
    #[error("window is {0}x{1}; this protocol addresses at most 65535 in each axis")]
    WindowTooLarge(u32, u32),
    #[error("zstd: {0}")]
    Zstd(String),
}

/// A frame ready to hand to the transport.
#[derive(Debug, Clone)]
pub struct EncodedFrame {
    pub payload: PixelPayload,
    /// Serialised payload — the body of an `iw_proto::FrameKind::Pixels` frame.
    pub bytes: Vec<u8>,
    /// Fraction of the window this frame redraws, before compression. Feeds
    /// tier selection.
    pub coverage: f32,
}

#[derive(Debug, Default, Clone, Copy)]
pub struct EncoderStats {
    pub frames_sent: u32,
    pub frames_skipped: u32,
    pub rects_dropped_unchanged: u32,
    pub encoded_bytes: u64,
}

pub struct Encoder {
    config: EncoderConfig,
    /// What we believe the client's canvas holds, tightly packed `width * 4`.
    prev: Vec<u8>,
    prev_dims: (u32, u32),
    seq: u32,
    stats: EncoderStats,
}

impl Encoder {
    pub fn new(config: EncoderConfig) -> Self {
        Self {
            config,
            prev: Vec::new(),
            prev_dims: (0, 0),
            seq: 0,
            stats: EncoderStats::default(),
        }
    }

    pub fn stats(&self) -> EncoderStats {
        self.stats
    }

    /// Forget the client's canvas, so the next frame is a keyframe. Called on
    /// attach and reattach — a client that just joined has nothing.
    pub fn invalidate(&mut self) {
        self.prev.clear();
        self.prev_dims = (0, 0);
    }

    /// Encode the damaged parts of `frame`. Returns `None` when nothing the
    /// client can see actually changed, which is the common outcome for an
    /// app that redraws on a timer.
    pub fn encode(
        &mut self,
        frame: FrameView<'_>,
        damage: &[Rect],
        force_keyframe: bool,
    ) -> Result<Option<EncodedFrame>, EncodeError> {
        frame.validate()?;
        if frame.width > u16::MAX as u32 || frame.height > u16::MAX as u32 {
            return Err(EncodeError::WindowTooLarge(frame.width, frame.height));
        }

        let dims_changed = self.prev_dims != (frame.width, frame.height);
        let keyframe = force_keyframe || self.prev.is_empty() || dims_changed;
        if keyframe {
            self.prev = vec![0u8; (frame.width * frame.height) as usize * 4];
            self.prev_dims = (frame.width, frame.height);
        }

        let rects = if keyframe {
            vec![Rect::new(0, 0, frame.width, frame.height)]
        } else {
            coalesce(damage, frame.width, frame.height, self.config.limits)
        };
        if rects.is_empty() {
            self.stats.frames_skipped += 1;
            return Ok(None);
        }

        let mut entries: Vec<RectEntry> = Vec::with_capacity(rects.len());
        let mut pixels: Vec<u8> = Vec::new();
        for rect in rects {
            if !keyframe && !self.rect_changed(&frame, rect) {
                self.stats.rects_dropped_unchanged += 1;
                continue;
            }
            match solid_colour(&frame, rect) {
                Some(colour) => entries.push(RectEntry {
                    rect,
                    op: RectOp::Solid,
                    solid: colour,
                }),
                None => {
                    let row_bytes = rect.w as usize * 4;
                    pixels.reserve(row_bytes * rect.h as usize);
                    for y in rect.y..rect.bottom() {
                        let row = frame.row(y);
                        let start = rect.x as usize * 4;
                        pixels.extend_from_slice(&row[start..start + row_bytes]);
                    }
                    entries.push(RectEntry {
                        rect,
                        op: RectOp::Pixels,
                        solid: 0,
                    });
                }
            }
        }

        if entries.is_empty() {
            self.stats.frames_skipped += 1;
            return Ok(None);
        }

        let (codec, blob) = if self.config.allow_zstd && !pixels.is_empty() {
            let compressed = zstd::bulk::compress(&pixels, self.config.zstd_level)
                .map_err(|e| EncodeError::Zstd(e.to_string()))?;
            (Codec::ZstdRects, compressed)
        } else if pixels.is_empty() {
            // All solids: there is nothing to compress, and claiming zstd
            // would make the client decompress an empty blob.
            (Codec::RawRects, Vec::new())
        } else {
            (Codec::RawRects, pixels.clone())
        };

        self.seq = self.seq.wrapping_add(1);
        let payload = PixelPayload {
            codec,
            keyframe,
            seq: self.seq,
            width: frame.width,
            height: frame.height,
            rects: entries,
            blob,
        };

        let damaged: u64 = payload.rects.iter().map(|e| e.rect.area()).sum();
        let coverage = damaged as f32 / (frame.width as f32 * frame.height as f32).max(1.0);

        self.commit(&frame, &payload);

        let bytes = payload.encode();
        self.stats.frames_sent += 1;
        self.stats.encoded_bytes += bytes.len() as u64;
        Ok(Some(EncodedFrame {
            payload,
            bytes,
            coverage,
        }))
    }

    /// Does this rectangle differ from what the client holds?
    fn rect_changed(&self, frame: &FrameView<'_>, rect: Rect) -> bool {
        let row_bytes = rect.w as usize * 4;
        for y in rect.y..rect.bottom() {
            let src = &frame.row(y)[rect.x as usize * 4..][..row_bytes];
            let dst_start = (y * frame.width + rect.x) as usize * 4;
            if src != &self.prev[dst_start..dst_start + row_bytes] {
                return true;
            }
        }
        false
    }

    /// Bring our model of the client's canvas up to date with what we just
    /// encoded — only the rectangles we actually sent.
    fn commit(&mut self, frame: &FrameView<'_>, payload: &PixelPayload) {
        for entry in &payload.rects {
            let r = entry.rect;
            let row_bytes = r.w as usize * 4;
            for y in r.y..r.bottom() {
                let dst = (y * frame.width + r.x) as usize * 4;
                match entry.op {
                    RectOp::Solid => {
                        let colour = entry.solid.to_le_bytes();
                        for px in 0..r.w as usize {
                            self.prev[dst + px * 4..dst + px * 4 + 4].copy_from_slice(&colour);
                        }
                    }
                    RectOp::Pixels => {
                        let src = &frame.row(y)[r.x as usize * 4..][..row_bytes];
                        self.prev[dst..dst + row_bytes].copy_from_slice(src);
                    }
                }
            }
        }
    }
}

/// The rectangle's colour if every pixel in it is the same, else `None`.
fn solid_colour(frame: &FrameView<'_>, rect: Rect) -> Option<u32> {
    let first_row = frame.row(rect.y);
    let start = rect.x as usize * 4;
    let colour: [u8; 4] = first_row[start..start + 4].try_into().ok()?;
    for y in rect.y..rect.bottom() {
        let row = &frame.row(y)[start..start + rect.w as usize * 4];
        if !row.chunks_exact(4).all(|px| px == colour) {
            return None;
        }
    }
    Some(u32::from_le_bytes(colour))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::payload::Codec;

    /// A window whose pixels are a deterministic function of position, so a
    /// changed region is obvious and compression is not trivially perfect.
    fn noise(width: u32, height: u32) -> Vec<u8> {
        (0..width * height)
            .flat_map(|i| {
                let v = (i.wrapping_mul(2654435761) >> 16) as u8;
                [v, v.wrapping_add(31), v.wrapping_add(97), 255]
            })
            .collect()
    }

    fn view(pixels: &[u8], width: u32, height: u32) -> FrameView<'_> {
        FrameView {
            width,
            height,
            stride: width * 4,
            pixels,
        }
    }

    #[test]
    fn first_frame_is_a_keyframe_covering_the_window() {
        let px = noise(64, 64);
        let mut enc = Encoder::new(EncoderConfig::default());
        let frame = enc.encode(view(&px, 64, 64), &[], false).unwrap().unwrap();
        assert!(frame.payload.keyframe);
        assert_eq!(frame.payload.rects.len(), 1);
        assert_eq!(frame.payload.rects[0].rect, Rect::new(0, 0, 64, 64));
        assert_eq!(frame.coverage, 1.0);
    }

    #[test]
    fn an_unchanged_frame_encodes_nothing() {
        let px = noise(64, 64);
        let mut enc = Encoder::new(EncoderConfig::default());
        enc.encode(view(&px, 64, 64), &[], false).unwrap().unwrap();
        let again = enc
            .encode(view(&px, 64, 64), &[Rect::new(0, 0, 64, 64)], false)
            .unwrap();
        assert!(again.is_none(), "over-reported damage must not cost bytes");
        assert_eq!(enc.stats().frames_skipped, 1);
        assert_eq!(enc.stats().rects_dropped_unchanged, 1);
    }

    #[test]
    fn only_the_changed_rectangle_is_sent() {
        let mut px = noise(128, 128);
        let mut enc = Encoder::new(EncoderConfig::default());
        enc.encode(view(&px, 128, 128), &[], false).unwrap();

        for y in 10..20u32 {
            for x in 10..20u32 {
                let at = ((y * 128 + x) * 4) as usize;
                px[at..at + 4].copy_from_slice(&[1, 2, 3, 255]);
            }
        }
        let frame = enc
            .encode(view(&px, 128, 128), &[Rect::new(8, 8, 20, 20)], false)
            .unwrap()
            .unwrap();
        assert!(!frame.payload.keyframe);
        assert_eq!(frame.payload.rects.len(), 1);
        assert_eq!(frame.payload.rects[0].rect, Rect::new(8, 8, 20, 20));
        assert!(frame.coverage < 0.03);
    }

    #[test]
    fn a_flat_region_becomes_a_solid_fill_with_no_blob() {
        let px = vec![0u8; 64 * 64 * 4];
        let mut enc = Encoder::new(EncoderConfig::default());
        let frame = enc.encode(view(&px, 64, 64), &[], false).unwrap().unwrap();
        assert_eq!(frame.payload.rects[0].op, RectOp::Solid);
        assert_eq!(frame.payload.rects[0].solid, 0);
        assert!(frame.payload.blob.is_empty());
        assert_eq!(frame.payload.codec, Codec::RawRects);
        // 12 byte header + one 13 byte rect. A cleared window is 25 bytes.
        assert_eq!(frame.bytes.len(), 25);
    }

    #[test]
    fn a_resize_forces_a_keyframe() {
        let small = noise(32, 32);
        let large = noise(64, 64);
        let mut enc = Encoder::new(EncoderConfig::default());
        enc.encode(view(&small, 32, 32), &[], false).unwrap();
        let frame = enc
            .encode(view(&large, 64, 64), &[], false)
            .unwrap()
            .unwrap();
        assert!(frame.payload.keyframe);
        assert_eq!(frame.payload.width, 64);
    }

    #[test]
    fn invalidate_forces_the_next_frame_to_stand_alone() {
        let px = noise(32, 32);
        let mut enc = Encoder::new(EncoderConfig::default());
        enc.encode(view(&px, 32, 32), &[], false).unwrap();
        enc.invalidate();
        let frame = enc.encode(view(&px, 32, 32), &[], false).unwrap().unwrap();
        assert!(frame.payload.keyframe);
    }

    #[test]
    fn a_padded_stride_is_honoured() {
        // wl_shm buffers are routinely padded; reading width*4 per row from a
        // padded buffer shears the image by a few pixels per row.
        let width = 10u32;
        let height = 4u32;
        let stride = 64u32;
        let mut pixels = vec![0u8; (stride * height) as usize];
        for y in 0..height {
            for x in 0..width {
                let at = (y * stride + x * 4) as usize;
                pixels[at..at + 4].copy_from_slice(&[x as u8, y as u8, 0, 255]);
            }
        }
        let mut enc = Encoder::new(EncoderConfig::default());
        let frame = enc
            .encode(
                FrameView {
                    width,
                    height,
                    stride,
                    pixels: &pixels,
                },
                &[],
                false,
            )
            .unwrap()
            .unwrap();

        let mut canvas = vec![0u8; (width * height) as usize * 4];
        frame.payload.apply(&mut canvas, width, height).unwrap();
        for y in 0..height {
            for x in 0..width {
                let at = ((y * width + x) * 4) as usize;
                assert_eq!(&canvas[at..at + 4], &[x as u8, y as u8, 0, 255]);
            }
        }
    }

    #[test]
    fn a_sequence_of_frames_reconstructs_exactly() {
        // The property that matters: applying every frame in order to a blank
        // canvas gives what the app rendered, with no drift.
        let width = 96u32;
        let height = 96u32;
        let mut px = noise(width, height);
        let mut enc = Encoder::new(EncoderConfig::default());
        let mut canvas = vec![0u8; (width * height) as usize * 4];

        for step in 0..12u32 {
            let y0 = (step * 7) % (height - 8);
            for y in y0..y0 + 8 {
                for x in 0..width {
                    let at = ((y * width + x) * 4) as usize;
                    px[at..at + 4].copy_from_slice(&[step as u8, x as u8, y as u8, 255]);
                }
            }
            let damage = Rect::new(0, y0, width, 8);
            if let Some(frame) = enc
                .encode(view(&px, width, height), &[damage], false)
                .unwrap()
            {
                frame.payload.apply(&mut canvas, width, height).unwrap();
            }
        }
        assert_eq!(canvas, px);
    }

    #[test]
    fn without_zstd_the_pixels_go_raw() {
        let px = noise(32, 32);
        let mut enc = Encoder::new(EncoderConfig {
            allow_zstd: false,
            ..EncoderConfig::default()
        });
        let frame = enc.encode(view(&px, 32, 32), &[], false).unwrap().unwrap();
        assert_eq!(frame.payload.codec, Codec::RawRects);
        assert_eq!(frame.payload.blob.len(), 32 * 32 * 4);
    }

    #[test]
    fn rejects_a_buffer_that_cannot_hold_the_window() {
        let px = vec![0u8; 16];
        let mut enc = Encoder::new(EncoderConfig::default());
        assert!(matches!(
            enc.encode(view(&px, 64, 64), &[], false),
            Err(EncodeError::BufferTooSmall { .. })
        ));
    }

    #[test]
    fn rejects_a_stride_narrower_than_the_window() {
        let px = vec![0u8; 4096];
        let mut enc = Encoder::new(EncoderConfig::default());
        assert!(matches!(
            enc.encode(
                FrameView {
                    width: 32,
                    height: 8,
                    stride: 64,
                    pixels: &px
                },
                &[],
                false
            ),
            Err(EncodeError::StrideTooSmall { .. })
        ));
    }
}
