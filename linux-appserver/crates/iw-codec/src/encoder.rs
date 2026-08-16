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
    /// False when the client cannot apply [`RectOp::Delta`].
    pub allow_delta: bool,
    /// False when the client cannot decode JPEG, which also pins the encoder
    /// to the lossless mode however much the window is moving.
    pub allow_jpeg: bool,
    /// Starting quality for the lossy mode, 1–100. 72 is where a moving window
    /// stops looking soft on text that happens to be inside it.
    pub jpeg_quality: u8,
    /// Bytes a lossy frame should aim to fit in.
    ///
    /// This is the difference between a window that moves and one that lurches.
    /// A full 2× window at quality 72 encodes to well over a megabyte, and
    /// nothing carries a megabyte per frame over SSH: the frames queue, each
    /// one arrives late, and the session feels laggy no matter how fast the
    /// host encoded them. So quality tracks a byte budget rather than staying
    /// where it was set — the same trade every video call makes, for the same
    /// reason.
    pub target_frame_bytes: usize,
}

impl Default for EncoderConfig {
    fn default() -> Self {
        Self {
            limits: CoalesceLimits::default(),
            zstd_level: 2,
            allow_zstd: true,
            allow_delta: true,
            allow_jpeg: true,
            jpeg_quality: 72,
            // A quarter of a megabyte a frame is ~60 Mbit at 30fps: more than
            // a modest link, less than a good one, and the loop moves off it in
            // either direction within a second.
            target_frame_bytes: 256 * 1024,
        }
    }
}

/// How the next frame should be encoded. The tier selector owns this decision;
/// the encoder just obeys it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncodeMode {
    /// Exact pixels — solid fills, deltas, and zstd.
    Lossless,
    /// JPEG tiles. Cheap for a window in motion, and wrong for still text,
    /// which is why leaving this mode forces a keyframe.
    Lossy,
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
    #[error("jpeg: {0}")]
    Jpeg(String),
    #[error("a jpeg worker panicked")]
    JpegPanic,
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
    /// Rectangles sent as a difference from what the client already held.
    pub rects_delta: u32,
    /// Rectangles sent as JPEG.
    pub rects_lossy: u32,
    pub encoded_bytes: u64,
}

pub struct Encoder {
    config: EncoderConfig,
    /// What we believe the client's canvas holds, tightly packed `width * 4`.
    prev: Vec<u8>,
    prev_dims: (u32, u32),
    /// One flag per [`LOSSY_TILE`]-sized tile: the client's copy of this tile
    /// came from a JPEG, so `prev` is what the *encoder* rendered and not what
    /// the client actually has.
    ///
    /// It is not what the client has because the two ends decode JPEG with
    /// different implementations, and they disagree by a unit or two per
    /// channel. That is invisible on its own and fatal to a difference: a delta
    /// against a reference the client does not share leaves permanent
    /// artefacts. So a lossy tile is always re-sent whole, and clearing the
    /// flag is what makes the region exact again.
    lossy_tiles: Vec<bool>,
    tiles_across: u32,
    mode: EncodeMode,
    /// Where the byte-budget loop has settled. Starts at the configured
    /// quality and moves with what the frames actually cost.
    quality: u8,
    seq: u32,
    stats: EncoderStats,
}

/// Side of a lossy-tracking tile, in pixels. Small enough that a moving video
/// in a corner does not mark the text beside it, large enough that the grid for
/// a 4K window is a few thousand bools.
const LOSSY_TILE: u32 = 64;

/// A delta is only worth sending when most of its bytes came out zero — that is
/// the whole reason it compresses better than the pixels. A rectangle that
/// genuinely changed everywhere (a photo, a video frame) deltas to noise, which
/// zstd handles *worse* than the original.
const DELTA_ZERO_FRACTION: f32 = 0.55;

/// Above this many bytes of pixels, compression time starts to dominate the
/// frame and the level drops. Around a quarter of a 1080p window.
const LARGE_PAYLOAD: usize = 2 * 1024 * 1024;

/// Pixels per JPEG band. Small enough that a full window splits several ways,
/// large enough that the per-image header and the thread are noise beside it.
const JPEG_BAND_BYTES: usize = 512 * 1024;

/// However big the window, this many bands. A customer's VM is not ours to
/// fill, and past a handful the split stops helping anyway.
const MAX_JPEG_BANDS: usize = 8;

/// The quality the byte budget will not push below. Under this, text inside a
/// moving window stops being legible and starts being a smear — at which point
/// the window is cheap and useless rather than expensive and useful.
const MIN_JPEG_QUALITY: u8 = 35;

impl Encoder {
    pub fn new(config: EncoderConfig) -> Self {
        Self {
            config,
            prev: Vec::new(),
            prev_dims: (0, 0),
            lossy_tiles: Vec::new(),
            tiles_across: 0,
            mode: EncodeMode::Lossless,
            quality: config.jpeg_quality,
            seq: 0,
            stats: EncoderStats::default(),
        }
    }

    pub fn stats(&self) -> EncoderStats {
        self.stats
    }

    pub fn mode(&self) -> EncodeMode {
        self.mode
    }

    /// Choose how the next frame is encoded.
    ///
    /// Returns true when the caller must force a keyframe. Coming *back* from
    /// lossy is exactly that case: everything on screen is a JPEG of itself,
    /// and only a full lossless frame makes the text sharp again. Going the
    /// other way needs nothing — a JPEG tile stands alone.
    pub fn set_mode(&mut self, mode: EncodeMode) -> bool {
        let leaving_lossy = self.mode == EncodeMode::Lossy && mode == EncodeMode::Lossless;
        self.mode = mode;
        leaving_lossy && self.lossy_tiles.iter().any(|&t| t)
    }

    /// Forget the client's canvas, so the next frame is a keyframe. Called on
    /// attach and reattach — a client that just joined has nothing.
    pub fn invalidate(&mut self) {
        self.prev.clear();
        self.prev_dims = (0, 0);
        self.lossy_tiles.clear();
        self.tiles_across = 0;
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
            self.tiles_across = frame.width.div_ceil(LOSSY_TILE);
            let tiles = (self.tiles_across * frame.height.div_ceil(LOSSY_TILE)) as usize;
            self.lossy_tiles = vec![false; tiles];
        }
        let lossy = self.mode == EncodeMode::Lossy && self.config.allow_jpeg;

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
        // Each rectangle's own JPEG, length-prefixed, when this is a lossy
        // frame. Kept apart from `pixels` because the two never mix in one
        // payload — the codec byte describes the whole blob.
        let mut tiles: Vec<u8> = Vec::new();
        for rect in rects {
            if !keyframe && !self.rect_changed(&frame, rect) {
                self.stats.rects_dropped_unchanged += 1;
                continue;
            }
            // A flat rectangle is a solid fill in either mode: it is 13 bytes
            // against a JPEG's several hundred, and it is exact.
            if let Some(colour) = solid_colour(&frame, rect) {
                entries.push(RectEntry {
                    rect,
                    op: RectOp::Solid,
                    solid: colour,
                });
                continue;
            }

            if lossy {
                // A large rectangle is cut into horizontal bands and the bands
                // are encoded at the same time. JPEG is the most expensive
                // thing this encoder does by an order of magnitude, the bands
                // are independent, and the wire already carries one image per
                // rectangle — so the parallelism costs nothing but the split.
                //
                // The split is by size rather than by core count, so the frames
                // a given window produces are the same on every host.
                let bands = bands_of(rect);
                let quality = self.quality;
                let encoded = std::thread::scope(|scope| {
                    let handles: Vec<_> = bands
                        .iter()
                        .map(|band| scope.spawn(move || encode_jpeg(&frame, *band, quality)))
                        .collect();
                    handles
                        .into_iter()
                        .map(|handle| handle.join().unwrap_or(Err(EncodeError::JpegPanic)))
                        .collect::<Vec<_>>()
                });
                for (band, jpeg) in bands.iter().zip(encoded) {
                    let jpeg = jpeg?;
                    tiles.extend_from_slice(&(jpeg.len() as u32).to_le_bytes());
                    tiles.extend_from_slice(&jpeg);
                    entries.push(RectEntry {
                        rect: *band,
                        op: RectOp::Pixels,
                        solid: 0,
                    });
                    self.stats.rects_lossy += 1;
                }
                continue;
            }

            let row_bytes = rect.w as usize * 4;
            let at = pixels.len();
            pixels.reserve(row_bytes * rect.h as usize);
            for y in rect.y..rect.bottom() {
                let row = frame.row(y);
                let start = rect.x as usize * 4;
                pixels.extend_from_slice(&row[start..start + row_bytes]);
            }
            // Interframe: subtract what the client already holds, in place, and
            // keep it only if it went mostly to zero. A keyframe has no
            // reference to subtract from, and a tile the client holds as JPEG
            // has one the client does not share.
            let op = if !keyframe
                && self.config.allow_delta
                && self.config.allow_zstd
                && !self.rect_is_lossy(rect)
                && self.subtract_prev(&mut pixels[at..], rect, frame.width)
            {
                self.stats.rects_delta += 1;
                RectOp::Delta
            } else {
                RectOp::Pixels
            };
            entries.push(RectEntry { rect, op, solid: 0 });
        }

        if entries.is_empty() {
            self.stats.frames_skipped += 1;
            return Ok(None);
        }

        let (codec, blob) = if !tiles.is_empty() {
            (Codec::JpegTiles, tiles)
        } else if self.config.allow_zstd && !pixels.is_empty() {
            let compressed = zstd::bulk::compress(&pixels, zstd_level(&self.config, pixels.len()))
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
        if lossy {
            self.retarget_quality(bytes.len());
        }
        self.stats.frames_sent += 1;
        self.stats.encoded_bytes += bytes.len() as u64;
        Ok(Some(EncodedFrame {
            payload,
            bytes,
            coverage,
        }))
    }

    /// Move the lossy quality towards the frame-size budget.
    ///
    /// Down fast and up slow, deliberately. Overshooting the budget means
    /// frames queueing on a link that cannot carry them, which the user feels
    /// immediately; undershooting means a slightly softer picture, which they
    /// mostly do not. The floor is where text inside a moving window is still
    /// legible rather than a smear.
    fn retarget_quality(&mut self, frame_bytes: usize) {
        let target = self.config.target_frame_bytes.max(1);
        if frame_bytes > target {
            self.quality = self.quality.saturating_sub(6).max(MIN_JPEG_QUALITY);
        } else if frame_bytes < target / 2 {
            self.quality = (self.quality + 2).min(self.config.jpeg_quality);
        }
    }

    /// The lossy quality this window has settled on, for tests and telemetry.
    pub fn quality(&self) -> u8 {
        self.quality
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

    /// Replace `slice` — a rectangle's pixels, row-major — with the difference
    /// from what the client holds, and say whether that was worth doing.
    ///
    /// Leaves the slice untouched when it was not: the caller then sends the
    /// pixels themselves, so the work is one pass over a rectangle we were
    /// about to compress anyway.
    fn subtract_prev(&self, slice: &mut [u8], rect: Rect, canvas_width: u32) -> bool {
        let row_bytes = rect.w as usize * 4;
        let mut zeros = 0usize;
        for row in 0..rect.h {
            let src = ((rect.y + row) * canvas_width + rect.x) as usize * 4;
            let dst = row as usize * row_bytes;
            zeros += crate::simd::delta_in_place(
                &mut slice[dst..dst + row_bytes],
                &self.prev[src..src + row_bytes],
            );
        }
        let total = row_bytes * rect.h as usize;
        if zeros as f32 >= total as f32 * DELTA_ZERO_FRACTION {
            return true;
        }
        // Not worth it — put the pixels back. Undoing costs one more pass and
        // keeps the caller's code linear; the alternative is a second copy of
        // every rectangle we were only ever going to send one way.
        for row in 0..rect.h {
            let src = ((rect.y + row) * canvas_width + rect.x) as usize * 4;
            let dst = row as usize * row_bytes;
            crate::simd::undelta_in_place(
                &mut slice[dst..dst + row_bytes],
                &self.prev[src..src + row_bytes],
            );
        }
        false
    }

    /// Does the client hold any part of this rectangle as a JPEG?
    fn rect_is_lossy(&self, rect: Rect) -> bool {
        self.tiles(rect, false)
            .any(|index| self.lossy_tiles.get(index).copied().unwrap_or(false))
    }

    /// Tile indices for a rectangle. `contained` restricts them to tiles that
    /// lie wholly inside it, which is the difference between "this rectangle
    /// touched lossy pixels" (any overlap) and "this rectangle made these tiles
    /// exact" (full cover only).
    fn tiles(&self, rect: Rect, contained: bool) -> impl Iterator<Item = usize> + '_ {
        let (x0, y0, x1, y1) = if contained {
            (
                rect.x.div_ceil(LOSSY_TILE),
                rect.y.div_ceil(LOSSY_TILE),
                rect.right() / LOSSY_TILE,
                rect.bottom() / LOSSY_TILE,
            )
        } else {
            (
                rect.x / LOSSY_TILE,
                rect.y / LOSSY_TILE,
                rect.right().div_ceil(LOSSY_TILE),
                rect.bottom().div_ceil(LOSSY_TILE),
            )
        };
        let across = self.tiles_across;
        (y0..y1).flat_map(move |ty| (x0..x1).map(move |tx| (ty * across + tx) as usize))
    }

    fn mark_lossy(&mut self, rect: Rect, lossy: bool) {
        let indices: Vec<usize> = self.tiles(rect, !lossy).collect();
        for index in indices {
            if let Some(tile) = self.lossy_tiles.get_mut(index) {
                *tile = lossy;
            }
        }
    }

    /// Bring our model of the client's canvas up to date with what we just
    /// encoded — only the rectangles we actually sent.
    fn commit(&mut self, frame: &FrameView<'_>, payload: &PixelPayload) {
        let lossy_frame = payload.codec.is_tiled_image();
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
                    // Both carry the same pixels — a delta *is* those pixels,
                    // expressed against what the client had — so the model of
                    // the client's canvas ends up in the same place.
                    RectOp::Pixels | RectOp::Delta => {
                        let src = &frame.row(y)[r.x as usize * 4..][..row_bytes];
                        self.prev[dst..dst + row_bytes].copy_from_slice(src);
                    }
                }
            }
            // A JPEG rectangle leaves the client holding an approximation of
            // `prev`; anything else leaves it holding `prev` exactly. A solid
            // fill counts as exact either way, which is why it is checked per
            // rectangle rather than per frame.
            self.mark_lossy(r, lossy_frame && entry.op != RectOp::Solid);
        }
    }
}

/// How hard to compress a payload of this size.
///
/// Compression is the single most expensive thing the encoder does, and its
/// cost is linear in the input while the *gain* from a higher level is not: on
/// a megabyte-scale keyframe, level 1 against level 2 is a few percent of size
/// against nearly half the time. A keyframe is exactly the frame the user is
/// waiting on — a window opening, a resize settling — so the big ones trade the
/// percent for the milliseconds and the small ones, where the whole thing is
/// sub-millisecond either way, keep the ratio.
fn zstd_level(config: &EncoderConfig, bytes: usize) -> i32 {
    if bytes >= LARGE_PAYLOAD {
        config.zstd_level.min(1)
    } else {
        config.zstd_level
    }
}

/// One rectangle of a frame as a baseline JPEG, appended to `out`.
///
/// The rectangle is copied into `scratch` row by row because the encoder wants
/// a tightly packed image and the frame is a window with a stride. It is copied
/// as-is: `jpeg-encoder` takes BGRA directly and ignores the alpha, so the
/// per-pixel channel shuffle this used to do — a full pass over every pixel of
/// every lossy frame, into a fresh allocation — buys nothing.
fn encode_jpeg(frame: &FrameView<'_>, rect: Rect, quality: u8) -> Result<Vec<u8>, EncodeError> {
    let row_bytes = rect.w as usize * 4;
    let mut packed = Vec::with_capacity(row_bytes * rect.h as usize);
    for y in rect.y..rect.bottom() {
        packed.extend_from_slice(&frame.row(y)[rect.x as usize * 4..][..row_bytes]);
    }
    let mut out = Vec::new();
    jpeg_encoder::Encoder::new(&mut out, quality.clamp(1, 100))
        .encode(
            &packed,
            u16::try_from(rect.w).map_err(|_| EncodeError::WindowTooLarge(rect.w, rect.h))?,
            u16::try_from(rect.h).map_err(|_| EncodeError::WindowTooLarge(rect.w, rect.h))?,
            jpeg_encoder::ColorType::Bgra,
        )
        .map_err(|e| EncodeError::Jpeg(e.to_string()))?;
    Ok(out)
}

/// Cut a rectangle into horizontal bands small enough to be worth encoding
/// side by side.
///
/// Bands are whole numbers of rows and never narrower than a JPEG's own 8-row
/// unit; a rectangle that is already small comes back as itself, because a
/// thread costs more than it would save.
fn bands_of(rect: Rect) -> Vec<Rect> {
    let bytes = rect.area() as usize * 4;
    if bytes <= JPEG_BAND_BYTES || rect.h < 16 {
        return vec![rect];
    }
    let wanted = (bytes / JPEG_BAND_BYTES).clamp(2, MAX_JPEG_BANDS) as u32;
    // Round the band height up to a multiple of 8 so no band starts mid-block,
    // which would cost quality at every seam.
    let rows = (rect.h.div_ceil(wanted)).next_multiple_of(8).max(8);
    let mut bands = Vec::new();
    let mut y = rect.y;
    while y < rect.bottom() {
        let h = rows.min(rect.bottom() - y);
        bands.push(Rect::new(rect.x, y, rect.w, h));
        y += h;
    }
    bands
}

/// The rectangle's colour if every pixel in it is the same, else `None`.
fn solid_colour(frame: &FrameView<'_>, rect: Rect) -> Option<u32> {
    let first_row = frame.row(rect.y);
    let start = rect.x as usize * 4;
    let colour: [u8; 4] = first_row[start..start + 4].try_into().ok()?;
    for y in rect.y..rect.bottom() {
        let row = &frame.row(y)[start..start + rect.w as usize * 4];
        if !crate::simd::is_uniform(row, colour) {
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

    /// Change one small square inside a much larger damage rectangle — the
    /// shape every toolkit produces when a single widget redraws.
    fn poke(px: &mut [u8], width: u32, at: Rect, value: u8) {
        for y in at.y..at.bottom() {
            for x in at.x..at.right() {
                let i = ((y * width + x) * 4) as usize;
                px[i..i + 4].copy_from_slice(&[value, value, value, 255]);
            }
        }
    }

    #[test]
    fn a_mostly_unchanged_rectangle_is_sent_as_a_difference() {
        let mut px = noise(128, 128);
        let mut enc = Encoder::new(EncoderConfig::default());
        enc.encode(view(&px, 128, 128), &[], false).unwrap();

        poke(&mut px, 128, Rect::new(20, 20, 8, 8), 0x40);
        let frame = enc
            .encode(view(&px, 128, 128), &[Rect::new(0, 0, 128, 64)], false)
            .unwrap()
            .unwrap();
        assert_eq!(frame.payload.rects[0].op, RectOp::Delta);
        assert_eq!(enc.stats().rects_delta, 1);
    }

    #[test]
    fn a_delta_reconstructs_the_rectangle_exactly() {
        // Wrapping arithmetic in both directions: the encoder subtracts, the
        // client adds, and every byte value has to survive the round trip.
        let width = 96u32;
        let mut px = noise(width, width);
        let mut enc = Encoder::new(EncoderConfig::default());
        let mut canvas = vec![0u8; (width * width) as usize * 4];
        let first = enc.encode(view(&px, width, width), &[], false).unwrap();
        first
            .unwrap()
            .payload
            .apply(&mut canvas, width, width)
            .unwrap();

        for step in 0..6u8 {
            poke(
                &mut px,
                width,
                Rect::new(10, 10 + step as u32 * 6, 6, 6),
                step,
            );
            let frame = enc
                .encode(
                    view(&px, width, width),
                    &[Rect::new(0, 0, width, 64)],
                    false,
                )
                .unwrap()
                .unwrap();
            frame.payload.apply(&mut canvas, width, width).unwrap();
        }
        assert_eq!(canvas, px, "a delta must reconstruct its rectangle exactly");
        assert!(enc.stats().rects_delta > 0);
    }

    #[test]
    fn a_rectangle_that_changed_everywhere_is_sent_whole() {
        // A delta of unrelated pixels is noise, and noise compresses worse than
        // the pixels it came from.
        let a = noise(64, 64);
        let b: Vec<u8> = a
            .chunks_exact(4)
            .flat_map(|px| [px[0] ^ 0x5a, px[1] ^ 0xa5, px[2] ^ 0x3c, 255])
            .collect();
        let mut enc = Encoder::new(EncoderConfig::default());
        enc.encode(view(&a, 64, 64), &[], false).unwrap();
        let frame = enc
            .encode(view(&b, 64, 64), &[Rect::new(0, 0, 64, 64)], false)
            .unwrap()
            .unwrap();
        assert_eq!(frame.payload.rects[0].op, RectOp::Pixels);
        assert_eq!(enc.stats().rects_delta, 0);
    }

    #[test]
    fn the_lossy_mode_sends_one_jpeg_per_rectangle() {
        let px = noise(64, 64);
        let mut enc = Encoder::new(EncoderConfig::default());
        enc.set_mode(EncodeMode::Lossy);
        let frame = enc.encode(view(&px, 64, 64), &[], false).unwrap().unwrap();
        assert_eq!(frame.payload.codec, Codec::JpegTiles);
        // u32 length prefix, then a JPEG: SOI … EOI.
        let len = u32::from_le_bytes(frame.payload.blob[..4].try_into().unwrap()) as usize;
        let tile = &frame.payload.blob[4..4 + len];
        assert_eq!(&tile[..2], &[0xff, 0xd8]);
        assert_eq!(&tile[len - 2..], &[0xff, 0xd9]);
        assert_eq!(frame.payload.blob.len(), 4 + len);
    }

    #[test]
    fn a_lossy_region_is_never_deltad_against() {
        // The client's copy of a JPEG rectangle is whatever *its* decoder
        // produced, which is not what we hold. A difference against it would
        // leave permanent artefacts.
        let mut px = noise(64, 64);
        let mut enc = Encoder::new(EncoderConfig::default());
        enc.set_mode(EncodeMode::Lossy);
        enc.encode(view(&px, 64, 64), &[], false).unwrap();

        // Back to lossless without the keyframe the session would normally
        // force, so the next frame is the interesting one.
        enc.set_mode(EncodeMode::Lossless);
        poke(&mut px, 64, Rect::new(4, 4, 4, 4), 0x11);
        let frame = enc
            .encode(view(&px, 64, 64), &[Rect::new(0, 0, 64, 32)], false)
            .unwrap()
            .unwrap();
        assert_eq!(frame.payload.rects[0].op, RectOp::Pixels);
    }

    #[test]
    fn coming_back_from_lossy_asks_for_a_keyframe() {
        // Everything on screen is a JPEG of itself; only a full lossless frame
        // makes the text crisp again.
        let px = noise(64, 64);
        let mut enc = Encoder::new(EncoderConfig::default());
        enc.set_mode(EncodeMode::Lossy);
        enc.encode(view(&px, 64, 64), &[], false).unwrap();
        assert!(enc.set_mode(EncodeMode::Lossless));
        // And not twice: once the window is exact again there is nothing to
        // repair.
        enc.encode(view(&px, 64, 64), &[], true).unwrap();
        enc.set_mode(EncodeMode::Lossy);
        assert!(!enc.set_mode(EncodeMode::Lossless));
    }

    #[test]
    fn a_client_without_the_delta_op_gets_whole_pixels() {
        let mut px = noise(64, 64);
        let mut enc = Encoder::new(EncoderConfig {
            allow_delta: false,
            ..EncoderConfig::default()
        });
        enc.encode(view(&px, 64, 64), &[], false).unwrap();
        poke(&mut px, 64, Rect::new(4, 4, 4, 4), 0x11);
        let frame = enc
            .encode(view(&px, 64, 64), &[Rect::new(0, 0, 64, 32)], false)
            .unwrap()
            .unwrap();
        assert_eq!(frame.payload.rects[0].op, RectOp::Pixels);
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
