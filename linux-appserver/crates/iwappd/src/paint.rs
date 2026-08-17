//! Compositing arithmetic: putting one surface's pixels onto a window canvas.
//!
//! No Wayland types and no Linux, deliberately. Everything here is rectangles
//! and bytes, which is the half most likely to be subtly wrong — a scale
//! conversion off by one draws a browser at half size in the corner of its own
//! window — and keeping it out of the compositor module is what lets these
//! tests run on a laptop rather than only on a host with `libxkbcommon` to
//! link against.

use iw_codec::Rect;

/// A surface's committed pixels, as the compositing pass sees them.
pub struct SurfaceView<'a> {
    pub width: u32,
    pub height: u32,
    /// Tightly packed BGRA, `width * height * 4` bytes.
    pub pixels: &'a [u8],
    /// The client's format has no alpha, so this composites by copy.
    pub opaque: bool,
    /// `wl_surface.set_buffer_scale`: buffer pixels per logical pixel.
    pub scale: i32,
}

/// The window canvas a surface is drawn onto.
///
/// Grouped rather than passed as four arguments because they travel together
/// and the scale is only meaningful beside the dimensions.
pub struct Target<'a> {
    pub pixels: &'a mut [u8],
    pub width: u32,
    pub height: u32,
    /// Buffer pixels per logical pixel, which is the root surface's scale.
    pub scale: i32,
}

/// Draw one surface's pixels into the window canvas at `(ox, oy)`, blended.
///
/// Source-over with premultiplied alpha, which is what `wl_shm`'s `Argb8888`
/// carries. A straight copy would be cheaper but wrong in both directions: a
/// client's rounded corners and shadows would get hard edges, and any surface
/// with a transparent region would punch a hole through whatever it covers.
pub fn blit(target: &mut Target<'_>, src: &SurfaceView<'_>, ox: i32, oy: i32, clip: Option<Rect>) {
    let (canvas_w, canvas_h, canvas_scale) = (target.width, target.height, target.scale);
    let canvas = &mut *target.pixels;
    if src.pixels.is_empty() {
        return;
    }
    // A surface tree may legally mix buffer scales — a toplevel that took the
    // output's 2 with content in a subsurface that stayed at 1 is what Firefox
    // does — and copying those pixels one for one draws the child at half its
    // size in the corner of the window. So the source is sampled rather than
    // copied whenever the two disagree.
    let src_scale = src.scale.max(1);
    let dst_scale = canvas_scale.max(1);
    let dst_w = (src.width as i64 * dst_scale as i64 / src_scale as i64) as i32;
    let dst_h = (src.height as i64 * dst_scale as i64 / src_scale as i64) as i32;
    // Work out the overlapping rows and columns once, rather than testing every
    // pixel against the canvas edges and against the clip. On a 2× window that
    // inner branch ran a few million times per commit.
    let (clip_x0, clip_y0, clip_x1, clip_y1) = match clip {
        Some(r) => (r.x as i64, r.y as i64, r.right() as i64, r.bottom() as i64),
        None => (0, 0, canvas_w as i64, canvas_h as i64),
    };
    let x0 = (ox as i64).max(0).max(clip_x0);
    let y0 = (oy as i64).max(0).max(clip_y0);
    let x1 = (ox as i64 + dst_w as i64).min(canvas_w as i64).min(clip_x1);
    let y1 = (oy as i64 + dst_h as i64).min(canvas_h as i64).min(clip_y1);
    if x0 >= x1 || y0 >= y1 {
        return;
    }
    let row_bytes = (x1 - x0) as usize * 4;
    let same_scale = src_scale == dst_scale;

    for y in y0..y1 {
        // Which row of the source this row of the canvas comes from. Identity
        // when the scales agree, which is every window that is not mixed.
        let src_y = if same_scale {
            (y - oy as i64) as usize
        } else {
            ((y - oy as i64) * src_scale as i64 / dst_scale as i64) as usize
        };
        let from = (src_y * src.width as usize + (x0 - ox as i64) as usize) * 4;
        let to = (y as usize * canvas_w as usize + x0 as usize) * 4;

        // A surface whose format has no alpha — which is most of them, and
        // every toplevel that fills its own window — is a row copy. Blending it
        // pixel by pixel produces the identical result at roughly ten times the
        // cost.
        if src.opaque && same_scale {
            canvas[to..to + row_bytes].copy_from_slice(&src.pixels[from..from + row_bytes]);
            continue;
        }

        let row_start = src_y * src.width as usize * 4;
        for col in 0..(x1 - x0) as usize {
            let from = if same_scale {
                from + col * 4
            } else {
                let src_x =
                    ((x0 - ox as i64 + col as i64) * src_scale as i64 / dst_scale as i64) as usize;
                row_start + src_x.min(src.width as usize - 1) * 4
            };
            let to = to + col * 4;
            let alpha = src.pixels[from + 3] as u32;
            if alpha == 255 {
                canvas[to..to + 4].copy_from_slice(&src.pixels[from..from + 4]);
                continue;
            }
            if alpha == 0 {
                continue;
            }
            let inverse = 255 - alpha;
            for channel in 0..4 {
                let source = src.pixels[from + channel] as u32;
                let dest = canvas[to + channel] as u32;
                canvas[to + channel] = (source + dest * inverse / 255).min(255) as u8;
            }
        }
    }
}

/// Blank a rectangle of the canvas.
///
/// Compositing is source-over, so a region has to start empty or the previous
/// frame shows through anything translucent drawn over it.
pub fn clear_region(canvas: &mut [u8], canvas_w: u32, region: Rect) {
    let row_bytes = region.w as usize * 4;
    for y in region.y..region.bottom() {
        let at = (y as usize * canvas_w as usize + region.x as usize) * 4;
        if at + row_bytes <= canvas.len() {
            canvas[at..at + row_bytes].fill(0);
        }
    }
}

/// A rectangle from one buffer scale into another, rounded outwards.
///
/// Outwards because this is damage: covering a pixel that did not change costs
/// a few bytes, and missing one that did leaves it stale on screen forever.
pub fn rescale(rect: Rect, from: i32, to: i32) -> Rect {
    if from == to {
        return rect;
    }
    let (from, to) = (from.max(1) as u32, to.max(1) as u32);
    let x = rect.x * to / from;
    let y = rect.y * to / from;
    Rect::new(
        x,
        y,
        (rect.right() * to).div_ceil(from) - x,
        (rect.bottom() * to).div_ceil(from) - y,
    )
}

#[cfg(test)]
mod tests {
    use super::{Rect, SurfaceView, Target, blit, rescale};

    fn bytes(width: u32, height: u32, colour: [u8; 4]) -> Vec<u8> {
        colour
            .iter()
            .copied()
            .cycle()
            .take((width * height * 4) as usize)
            .collect()
    }

    /// A surface of one flat colour, at a given buffer scale.
    fn surface(width: u32, height: u32, scale: i32, pixels: &[u8]) -> SurfaceView<'_> {
        SurfaceView {
            width,
            height,
            pixels,
            opaque: true,
            scale,
        }
    }

    fn pixel(canvas: &[u8], width: u32, x: u32, y: u32) -> [u8; 4] {
        let at = ((y * width + x) * 4) as usize;
        canvas[at..at + 4].try_into().unwrap()
    }

    #[test]
    fn a_child_at_the_canvas_scale_is_copied_one_for_one() {
        let mut pixels = vec![0u8; 8 * 8 * 4];
        let mut target = Target {
            pixels: &mut pixels,
            width: 8,
            height: 8,
            scale: 1,
        };
        blit(
            &mut target,
            &surface(4, 4, 1, &bytes(4, 4, [1, 2, 3, 255])),
            0,
            0,
            None,
        );
        assert_eq!(pixel(&pixels, 8, 3, 3), [1, 2, 3, 255]);
        // And nothing outside it.
        assert_eq!(pixel(&pixels, 8, 4, 4), [0, 0, 0, 0]);
    }

    #[test]
    fn a_child_at_half_the_canvas_scale_is_drawn_at_full_size() {
        // The Firefox case: the toplevel took the output's 2, the content
        // subsurface stayed at 1. Copying those pixels one for one drew the
        // page at half size in the corner of the window.
        let mut pixels = vec![0u8; 8 * 8 * 4];
        let mut target = Target {
            pixels: &mut pixels,
            width: 8,
            height: 8,
            scale: 2,
        };
        blit(
            &mut target,
            &surface(4, 4, 1, &bytes(4, 4, [9, 8, 7, 255])),
            0,
            0,
            None,
        );
        // Four logical pixels at scale 2 fill eight.
        assert_eq!(pixel(&pixels, 8, 7, 7), [9, 8, 7, 255]);
        assert_eq!(pixel(&pixels, 8, 0, 0), [9, 8, 7, 255]);
    }

    #[test]
    fn a_child_above_the_canvas_scale_is_sampled_down() {
        let mut pixels = vec![0u8; 4 * 4 * 4];
        let mut target = Target {
            pixels: &mut pixels,
            width: 4,
            height: 4,
            scale: 1,
        };
        blit(
            &mut target,
            &surface(8, 8, 2, &bytes(8, 8, [4, 5, 6, 255])),
            0,
            0,
            None,
        );
        assert_eq!(pixel(&pixels, 4, 3, 3), [4, 5, 6, 255]);
    }

    #[test]
    fn a_scaled_child_still_respects_its_offset_and_the_clip() {
        let mut pixels = vec![0u8; 8 * 8 * 4];
        let mut target = Target {
            pixels: &mut pixels,
            width: 8,
            height: 8,
            scale: 2,
        };
        blit(
            &mut target,
            &surface(2, 2, 1, &bytes(2, 2, [1, 1, 1, 255])),
            4,
            4,
            Some(Rect::new(4, 4, 4, 4)),
        );
        assert_eq!(pixel(&pixels, 8, 4, 4), [1, 1, 1, 255]);
        assert_eq!(pixel(&pixels, 8, 7, 7), [1, 1, 1, 255]);
        // Outside the clip, untouched.
        assert_eq!(pixel(&pixels, 8, 3, 3), [0, 0, 0, 0]);
    }

    #[test]
    fn a_child_larger_than_the_canvas_is_clipped_rather_than_overflowing() {
        let mut pixels = vec![0u8; 4 * 4 * 4];
        let mut target = Target {
            pixels: &mut pixels,
            width: 4,
            height: 4,
            scale: 2,
        };
        blit(
            &mut target,
            &surface(8, 8, 1, &bytes(8, 8, [2, 2, 2, 255])),
            0,
            0,
            None,
        );
        assert_eq!(pixel(&pixels, 4, 3, 3), [2, 2, 2, 255]);
    }

    #[test]
    fn damage_crossing_a_scale_change_rounds_outwards() {
        // Covering a pixel that did not change costs a few bytes; missing one
        // that did leaves it stale on screen until something else repaints it.
        assert_eq!(rescale(Rect::new(1, 1, 3, 3), 1, 2), Rect::new(2, 2, 6, 6));
        // Buffer pixels [2, 7) at scale 2 are logical [1, 3.5), which at
        // scale 1 is canvas pixels 1 through 3 — three of them, not four.
        assert_eq!(rescale(Rect::new(2, 2, 5, 5), 2, 1), Rect::new(1, 1, 3, 3));
        assert_eq!(rescale(Rect::new(0, 0, 4, 4), 2, 2), Rect::new(0, 0, 4, 4));
    }
}
