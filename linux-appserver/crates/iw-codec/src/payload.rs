//! The pixel payload: what sits inside an [`iw_proto::FrameKind::Pixels`]
//! frame.
//!
//! The header is fixed-layout binary and the rectangle table is a flat array,
//! so the browser can parse it with a `DataView` before handing the blob to
//! wasm — no allocation per rectangle on the hot path.
//!
//! ```text
//! u8  codec        u8  flags        u16 rectCount
//! u32 seq          u16 width        u16 height
//! rect[rectCount]: u16 x, u16 y, u16 w, u16 h, u8 op, u32 solid
//! blob[..]
//! ```

use crate::rect::Rect;

/// Bytes before the rectangle table.
pub const HEADER_LEN: usize = 12;
/// Bytes per rectangle table entry.
pub const RECT_LEN: usize = 13;

/// Encoding of `blob`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Codec {
    /// Rectangle pixels, uncompressed. Only used when the client has no zstd.
    RawRects = 0,
    /// Rectangle pixels, one zstd frame for the concatenation.
    ZstdRects = 1,
    /// A VP9 frame covering the whole window (tier 2).
    Vp9 = 2,
    /// Per-rectangle WebP images, each `u32` length-prefixed (tier 3).
    WebpTiles = 3,
}

impl Codec {
    fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => Self::RawRects,
            1 => Self::ZstdRects,
            2 => Self::Vp9,
            3 => Self::WebpTiles,
            _ => return None,
        })
    }
}

/// What to do with a rectangle.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum RectOp {
    /// Pixels for it are in the blob, in table order.
    Pixels = 0,
    /// Fill it with `solid` — a cleared background, a blanked video area, the
    /// dominant case in a window that just got resized.
    Solid = 1,
}

impl RectOp {
    fn from_u8(v: u8) -> Option<Self> {
        Some(match v {
            0 => Self::Pixels,
            1 => Self::Solid,
            _ => return None,
        })
    }
}

/// First frame of a window, or the first after a reattach: it depends on no
/// prior state, so a client that joined late can start from it.
pub const FLAG_KEYFRAME: u8 = 1 << 0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RectEntry {
    pub rect: Rect,
    pub op: RectOp,
    /// Fill colour for [`RectOp::Solid`], in the session's pixel format.
    pub solid: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PixelPayload {
    pub codec: Codec,
    pub keyframe: bool,
    pub seq: u32,
    pub width: u32,
    pub height: u32,
    pub rects: Vec<RectEntry>,
    pub blob: Vec<u8>,
}

#[derive(Debug, thiserror::Error)]
pub enum PayloadError {
    #[error("payload is {0} bytes, shorter than the {HEADER_LEN} byte header")]
    TooShort(usize),
    #[error("unknown codec {0}")]
    UnknownCodec(u8),
    #[error("unknown rect op {0}")]
    UnknownOp(u8),
    #[error("rect table claims {0} rects, which the {1} byte payload cannot hold")]
    TruncatedRectTable(usize, usize),
    #[error("blob is {actual} bytes, expected {expected}")]
    BlobSize { expected: usize, actual: usize },
    #[error("zstd: {0}")]
    Zstd(String),
    #[error("rect {0:?} does not fit in a {1}x{2} canvas")]
    RectOutOfBounds(Rect, u32, u32),
}

impl PixelPayload {
    pub fn encode(&self) -> Vec<u8> {
        let mut out =
            Vec::with_capacity(HEADER_LEN + self.rects.len() * RECT_LEN + self.blob.len());
        out.push(self.codec as u8);
        out.push(if self.keyframe { FLAG_KEYFRAME } else { 0 });
        out.extend_from_slice(&(self.rects.len() as u16).to_le_bytes());
        out.extend_from_slice(&self.seq.to_le_bytes());
        out.extend_from_slice(&(self.width as u16).to_le_bytes());
        out.extend_from_slice(&(self.height as u16).to_le_bytes());
        for entry in &self.rects {
            out.extend_from_slice(&(entry.rect.x as u16).to_le_bytes());
            out.extend_from_slice(&(entry.rect.y as u16).to_le_bytes());
            out.extend_from_slice(&(entry.rect.w as u16).to_le_bytes());
            out.extend_from_slice(&(entry.rect.h as u16).to_le_bytes());
            out.push(entry.op as u8);
            out.extend_from_slice(&entry.solid.to_le_bytes());
        }
        out.extend_from_slice(&self.blob);
        out
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, PayloadError> {
        if bytes.len() < HEADER_LEN {
            return Err(PayloadError::TooShort(bytes.len()));
        }
        let codec = Codec::from_u8(bytes[0]).ok_or(PayloadError::UnknownCodec(bytes[0]))?;
        let keyframe = bytes[1] & FLAG_KEYFRAME != 0;
        let rect_count = u16::from_le_bytes([bytes[2], bytes[3]]) as usize;
        let seq = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
        let width = u16::from_le_bytes([bytes[8], bytes[9]]) as u32;
        let height = u16::from_le_bytes([bytes[10], bytes[11]]) as u32;

        let table_end = HEADER_LEN + rect_count * RECT_LEN;
        if bytes.len() < table_end {
            return Err(PayloadError::TruncatedRectTable(rect_count, bytes.len()));
        }

        let mut rects = Vec::with_capacity(rect_count);
        for i in 0..rect_count {
            let at = HEADER_LEN + i * RECT_LEN;
            let u16_at = |o: usize| u16::from_le_bytes([bytes[at + o], bytes[at + o + 1]]) as u32;
            let op =
                RectOp::from_u8(bytes[at + 8]).ok_or(PayloadError::UnknownOp(bytes[at + 8]))?;
            rects.push(RectEntry {
                rect: Rect::new(u16_at(0), u16_at(2), u16_at(4), u16_at(6)),
                op,
                solid: u32::from_le_bytes([
                    bytes[at + 9],
                    bytes[at + 10],
                    bytes[at + 11],
                    bytes[at + 12],
                ]),
            });
        }

        Ok(Self {
            codec,
            keyframe,
            seq,
            width,
            height,
            rects,
            blob: bytes[table_end..].to_vec(),
        })
    }

    /// Total pixel bytes the blob must decompress to for the [`RectOp::Pixels`]
    /// rectangles in this payload.
    pub fn expected_pixel_bytes(&self) -> usize {
        self.rects
            .iter()
            .filter(|e| e.op == RectOp::Pixels)
            .map(|e| e.rect.area() as usize * 4)
            .sum()
    }

    /// Apply this payload to a canvas of `width * height * 4` bytes.
    ///
    /// This is the reference implementation of the client-side blit — the wasm
    /// decoder mirrors it, and the cross-language golden test asserts the two
    /// agree byte for byte.
    pub fn apply(
        &self,
        canvas: &mut [u8],
        canvas_width: u32,
        canvas_height: u32,
    ) -> Result<(), PayloadError> {
        let pixels = match self.codec {
            Codec::RawRects => self.blob.clone(),
            Codec::ZstdRects => {
                let expected = self.expected_pixel_bytes();
                zstd::bulk::decompress(&self.blob, expected.max(1))
                    .map_err(|e| PayloadError::Zstd(e.to_string()))?
            }
            Codec::Vp9 | Codec::WebpTiles => {
                // Those tiers are decoded by the browser (WebCodecs /
                // createImageBitmap), never here. The reference blit only
                // covers what the wasm module is responsible for.
                return Err(PayloadError::Zstd(format!(
                    "codec {:?} is decoded by the host, not this blit",
                    self.codec
                )));
            }
        };

        let expected = self.expected_pixel_bytes();
        if pixels.len() != expected {
            return Err(PayloadError::BlobSize {
                expected,
                actual: pixels.len(),
            });
        }

        let mut at = 0usize;
        for entry in &self.rects {
            let r = entry.rect;
            if r.right() > canvas_width || r.bottom() > canvas_height {
                return Err(PayloadError::RectOutOfBounds(
                    r,
                    canvas_width,
                    canvas_height,
                ));
            }
            match entry.op {
                RectOp::Solid => {
                    let color = entry.solid.to_le_bytes();
                    for row in 0..r.h {
                        let start = ((r.y + row) * canvas_width + r.x) as usize * 4;
                        for px in 0..r.w as usize {
                            canvas[start + px * 4..start + px * 4 + 4].copy_from_slice(&color);
                        }
                    }
                }
                RectOp::Pixels => {
                    let row_bytes = r.w as usize * 4;
                    for row in 0..r.h {
                        let dst = ((r.y + row) * canvas_width + r.x) as usize * 4;
                        canvas[dst..dst + row_bytes].copy_from_slice(&pixels[at..at + row_bytes]);
                        at += row_bytes;
                    }
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> PixelPayload {
        PixelPayload {
            codec: Codec::RawRects,
            keyframe: true,
            seq: 42,
            width: 4,
            height: 4,
            rects: vec![
                RectEntry {
                    rect: Rect::new(0, 0, 2, 2),
                    op: RectOp::Pixels,
                    solid: 0,
                },
                RectEntry {
                    rect: Rect::new(2, 2, 2, 2),
                    op: RectOp::Solid,
                    solid: 0xff00_00ff,
                },
            ],
            blob: vec![7u8; 2 * 2 * 4],
        }
    }

    #[test]
    fn header_layout_is_fixed() {
        let bytes = payload().encode();
        assert_eq!(bytes[0], Codec::RawRects as u8);
        assert_eq!(bytes[1], FLAG_KEYFRAME);
        assert_eq!(u16::from_le_bytes([bytes[2], bytes[3]]), 2);
        assert_eq!(bytes.len(), HEADER_LEN + 2 * RECT_LEN + 16);
    }

    #[test]
    fn round_trips() {
        let p = payload();
        assert_eq!(PixelPayload::decode(&p.encode()).unwrap(), p);
    }

    #[test]
    fn applies_pixels_and_solids_to_a_canvas() {
        let mut canvas = vec![0u8; 4 * 4 * 4];
        payload().apply(&mut canvas, 4, 4).unwrap();
        // Top-left 2x2 got the blob's 7s.
        assert_eq!(&canvas[0..8], &[7u8; 8]);
        // Bottom-right 2x2 got the solid, little-endian.
        let last = canvas.len() - 4;
        assert_eq!(&canvas[last..], &0xff00_00ffu32.to_le_bytes());
        // Untouched region stayed zero.
        assert_eq!(&canvas[8..16], &[0u8; 8]);
    }

    #[test]
    fn round_trips_through_zstd() {
        let raw = vec![9u8; 32 * 32 * 4];
        let p = PixelPayload {
            codec: Codec::ZstdRects,
            keyframe: true,
            seq: 1,
            width: 32,
            height: 32,
            rects: vec![RectEntry {
                rect: Rect::new(0, 0, 32, 32),
                op: RectOp::Pixels,
                solid: 0,
            }],
            blob: zstd::bulk::compress(&raw, 3).unwrap(),
        };
        assert!(
            p.blob.len() < raw.len() / 10,
            "flat colour should compress hard"
        );
        let mut canvas = vec![0u8; 32 * 32 * 4];
        PixelPayload::decode(&p.encode())
            .unwrap()
            .apply(&mut canvas, 32, 32)
            .unwrap();
        assert_eq!(canvas, raw);
    }

    #[test]
    fn rejects_a_truncated_rect_table() {
        let bytes = payload().encode();
        let err = PixelPayload::decode(&bytes[..HEADER_LEN + 4]).unwrap_err();
        assert!(matches!(err, PayloadError::TruncatedRectTable(2, _)));
    }

    #[test]
    fn rejects_a_blob_that_does_not_match_the_table() {
        let mut p = payload();
        p.blob.truncate(4);
        let mut canvas = vec![0u8; 64];
        assert!(matches!(
            p.apply(&mut canvas, 4, 4),
            Err(PayloadError::BlobSize { .. })
        ));
    }

    #[test]
    fn rejects_a_rect_outside_the_canvas() {
        // A resize race can land a frame sized for the old buffer; refuse it
        // rather than writing past the canvas.
        let mut p = payload();
        p.rects[0].rect = Rect::new(3, 3, 2, 2);
        p.blob = vec![0u8; 2 * 2 * 4];
        let mut canvas = vec![0u8; 64];
        assert!(matches!(
            p.apply(&mut canvas, 4, 4),
            Err(PayloadError::RectOutOfBounds(..))
        ));
    }

    #[test]
    fn rejects_an_unknown_codec() {
        let mut bytes = payload().encode();
        bytes[0] = 200;
        assert!(matches!(
            PixelPayload::decode(&bytes),
            Err(PayloadError::UnknownCodec(200))
        ));
    }
}
