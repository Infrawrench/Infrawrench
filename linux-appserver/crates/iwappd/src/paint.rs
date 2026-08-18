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
    /// `wp_viewport.set_source`, in buffer pixels: the part of the buffer that
    /// is the surface's content. `None` is the whole buffer.
    pub src_rect: Option<(u32, u32, u32, u32)>,
    /// `wp_viewport.set_destination`: the surface's size in *logical* pixels,
    /// regardless of how many buffer pixels back it. `None` means the logical
    /// size follows from the buffer and its scale, which is every client that
    /// does not bind the viewporter.
    pub dest_logical: Option<(u32, u32)>,
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
    // The viewport decides the mapping when the client set one. The motivating
    // client is Firefox's software renderer: it draws HiDPI content at full
    // device resolution into a buffer committed at scale **1** and declares the
    // logical size through `wp_viewport` — reading that buffer by its scale
    // alone draws the window magnified by the output scale and cropped to the
    // canvas, which is exactly how it looked. Without a viewport the mapping
    // follows the scales: a surface tree may legally mix buffer scales — a
    // toplevel that took the output's 2 with content in a subsurface that
    // stayed at 1 — and copying those pixels one for one draws the child at
    // half its size in the corner of the window. Either way the source is
    // sampled rather than copied whenever source and destination disagree.
    let (sx0, sy0, sw, sh) = match src.src_rect {
        Some((x, y, w, h)) => (x as i64, y as i64, w as i64, h as i64),
        None => (0, 0, src.width as i64, src.height as i64),
    };
    let src_scale = src.scale.max(1) as i64;
    let dst_scale = canvas_scale.max(1) as i64;
    let (dst_w, dst_h) = match src.dest_logical {
        Some((w, h)) => (w as i64 * dst_scale, h as i64 * dst_scale),
        None => (sw * dst_scale / src_scale, sh * dst_scale / src_scale),
    };
    if sw <= 0 || sh <= 0 || dst_w <= 0 || dst_h <= 0 {
        return;
    }
    // Work out the overlapping rows and columns once, rather than testing every
    // pixel against the canvas edges and against the clip. On a 2× window that
    // inner branch ran a few million times per commit.
    let (clip_x0, clip_y0, clip_x1, clip_y1) = match clip {
        Some(r) => (r.x as i64, r.y as i64, r.right() as i64, r.bottom() as i64),
        None => (0, 0, canvas_w as i64, canvas_h as i64),
    };
    let x0 = (ox as i64).max(0).max(clip_x0);
    let y0 = (oy as i64).max(0).max(clip_y0);
    let x1 = (ox as i64 + dst_w).min(canvas_w as i64).min(clip_x1);
    let y1 = (oy as i64 + dst_h).min(canvas_h as i64).min(clip_y1);
    if x0 >= x1 || y0 >= y1 {
        return;
    }
    let row_bytes = (x1 - x0) as usize * 4;
    // Identity when one buffer pixel lands on one canvas pixel, which is every
    // window that is neither mixed-scale nor viewported — and also Firefox's
    // viewported content on a whole-scale output, where the device-resolution
    // buffer is exactly the destination.
    let identity = dst_w == sw && dst_h == sh;
    // Sampling clamps rather than trusts: a source rectangle is validated at
    // commit, but a stale crop over a just-shrunk buffer must not read out of
    // bounds while the client catches up.
    let max_x = src.width as i64 - 1;
    let max_y = src.height as i64 - 1;

    for y in y0..y1 {
        // Which row of the source this row of the canvas comes from.
        let src_y = if identity {
            (sy0 + (y - oy as i64)).clamp(0, max_y) as usize
        } else {
            (sy0 + (y - oy as i64) * sh / dst_h).clamp(0, max_y) as usize
        };
        let row_start = src_y * src.width as usize * 4;
        let to = (y as usize * canvas_w as usize + x0 as usize) * 4;

        // A surface whose format has no alpha — which is most of them, and
        // every toplevel that fills its own window — is a row copy. Blending it
        // pixel by pixel produces the identical result at roughly ten times the
        // cost.
        if src.opaque && identity {
            let from = row_start + (sx0 + (x0 - ox as i64)).max(0) as usize * 4;
            canvas[to..to + row_bytes].copy_from_slice(&src.pixels[from..from + row_bytes]);
            continue;
        }

        for col in 0..(x1 - x0) as usize {
            let src_x = if identity {
                (sx0 + (x0 - ox as i64) + col as i64).clamp(0, max_x) as usize
            } else {
                (sx0 + (x0 - ox as i64 + col as i64) * sw / dst_w).clamp(0, max_x) as usize
            };
            let from = row_start + src_x * 4;
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

/// The toplevel size in logical pixels, from what the viewer asked for.
///
/// The viewer asks in the device pixels it will paint — its CSS box times its
/// device pixel ratio — and Wayland configures a toplevel in *logical* pixels,
/// so the request divides back down by the ratio, recovering the CSS box. The
/// division must be by the fractional ratio itself, not the whole buffer scale
/// rounded up from it: dividing 1.5× pixels by 2 configures a window a quarter
/// smaller than its box, the application lays out for that smaller window, and
/// the viewer stretches every frame back up — everything drawn a third too
/// large, on any display whose ratio is not whole.
pub fn logical_size(width: u32, height: u32, ratio: f32) -> (i32, i32) {
    let ratio = if ratio.is_finite() && ratio > 1.0 {
        ratio
    } else {
        1.0
    };
    let side = |px: u32| ((px.max(1) as f32 / ratio).round() as i32).max(1);
    (side(width), side(height))
}

/// A rectangle from the box it lives in into the box it is shown in, rounded
/// outwards.
///
/// This is damage crossing from a buffer to the canvas: `from` is the buffer's
/// size, `to` the box the buffer occupies on the canvas — a whole multiple for
/// an ordinary scaled surface, anything at all for a `wp_viewport` mapping.
/// Outwards because covering a pixel that did not change costs a few bytes,
/// and missing one that did leaves it stale on screen forever.
pub fn rescale_to(rect: Rect, from: (u32, u32), to: (u32, u32)) -> Rect {
    if from == to {
        return rect;
    }
    if from.0 == 0 || from.1 == 0 {
        return Rect::new(0, 0, to.0, to.1);
    }
    // The inputs are untrusted (client damage is unclipped until composite),
    // so the arithmetic is 64-bit rather than trusting `u32 * u32` to fit.
    let x = (rect.x as u64 * to.0 as u64 / from.0 as u64) as u32;
    let y = (rect.y as u64 * to.1 as u64 / from.1 as u64) as u32;
    let right = (rect.right() as u64 * to.0 as u64).div_ceil(from.0 as u64);
    let bottom = (rect.bottom() as u64 * to.1 as u64).div_ceil(from.1 as u64);
    Rect::new(
        x,
        y,
        (right.min(u32::MAX as u64) as u32).saturating_sub(x),
        (bottom.min(u32::MAX as u64) as u32).saturating_sub(y),
    )
}

#[cfg(test)]
mod tests {
    use super::{Rect, SurfaceView, Target, blit, logical_size, rescale_to};

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
            src_rect: None,
            dest_logical: None,
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
    fn a_viewported_device_buffer_lands_one_for_one_on_a_scaled_canvas() {
        // The Firefox software-renderer case: content rendered at device
        // resolution into a scale-1 buffer, with `wp_viewport` declaring the
        // logical size. On a 2× canvas that buffer is exactly the destination;
        // reading it by its scale instead drew the window twice as large and
        // cropped it to the canvas.
        let mut pixels = vec![0u8; 8 * 8 * 4];
        let mut target = Target {
            pixels: &mut pixels,
            width: 8,
            height: 8,
            scale: 2,
        };
        let content = bytes(8, 8, [3, 6, 9, 255]);
        let mut view = surface(8, 8, 1, &content);
        view.dest_logical = Some((4, 4));
        blit(&mut target, &view, 0, 0, None);
        assert_eq!(pixel(&pixels, 8, 0, 0), [3, 6, 9, 255]);
        assert_eq!(pixel(&pixels, 8, 7, 7), [3, 6, 9, 255]);
    }

    #[test]
    fn a_viewported_buffer_is_sampled_to_its_declared_size() {
        // A viewport destination smaller than the buffer downsamples it, on a
        // 1× canvas: 8 buffer pixels shown as 2 logical.
        let mut pixels = vec![0u8; 4 * 4 * 4];
        let mut target = Target {
            pixels: &mut pixels,
            width: 4,
            height: 4,
            scale: 1,
        };
        let content = bytes(8, 8, [5, 5, 5, 255]);
        let mut view = surface(8, 8, 1, &content);
        view.dest_logical = Some((2, 2));
        blit(&mut target, &view, 0, 0, None);
        assert_eq!(pixel(&pixels, 4, 1, 1), [5, 5, 5, 255]);
        // The destination bounds the draw, not the buffer.
        assert_eq!(pixel(&pixels, 4, 2, 2), [0, 0, 0, 0]);
    }

    #[test]
    fn a_viewport_source_rectangle_crops_the_buffer() {
        // Left half black-ish, right half white-ish; the source rectangle
        // picks the right half.
        let mut content = bytes(4, 2, [10, 10, 10, 255]);
        for x in 2..4 {
            for y in 0..2 {
                content[(y * 4 + x) * 4..(y * 4 + x) * 4 + 4]
                    .copy_from_slice(&[200, 200, 200, 255]);
            }
        }
        let mut pixels = vec![0u8; 2 * 2 * 4];
        let mut target = Target {
            pixels: &mut pixels,
            width: 2,
            height: 2,
            scale: 1,
        };
        let mut view = surface(4, 2, 1, &content);
        view.src_rect = Some((2, 0, 2, 2));
        view.dest_logical = Some((2, 2));
        blit(&mut target, &view, 0, 0, None);
        assert_eq!(pixel(&pixels, 2, 0, 0), [200, 200, 200, 255]);
        assert_eq!(pixel(&pixels, 2, 1, 1), [200, 200, 200, 255]);
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
    fn a_logical_size_is_the_viewers_css_box_at_any_ratio() {
        // Whole ratios divide exactly.
        assert_eq!(logical_size(1600, 1200, 2.0), (800, 600));
        // A fractional ratio divides by *itself*, not by the whole scale it
        // rounds up to — 1200/1.5 is the 800-pixel box the viewer measured,
        // where 1200/2 would configure a window 25% smaller than its box and
        // the application's layout a third too large once stretched back.
        assert_eq!(logical_size(1200, 900, 1.5), (800, 600));
        assert_eq!(logical_size(1000, 750, 1.25), (800, 600));
        // Ratios at or below 1, and nonsense, pass the pixels through.
        assert_eq!(logical_size(800, 600, 1.0), (800, 600));
        assert_eq!(logical_size(800, 600, 0.0), (800, 600));
        assert_eq!(logical_size(800, 600, f32::NAN), (800, 600));
        // Never zero, whatever was asked.
        assert_eq!(logical_size(0, 1, 3.0), (1, 1));
    }

    #[test]
    fn damage_crossing_a_scale_change_rounds_outwards() {
        // Covering a pixel that did not change costs a few bytes; missing one
        // that did leaves it stale on screen until something else repaints it.
        assert_eq!(
            rescale_to(Rect::new(1, 1, 3, 3), (8, 8), (16, 16)),
            Rect::new(2, 2, 6, 6)
        );
        // Buffer pixels [2, 7) at scale 2 are logical [1, 3.5), which at
        // scale 1 is canvas pixels 1 through 3 — three of them, not four.
        assert_eq!(
            rescale_to(Rect::new(2, 2, 5, 5), (8, 8), (4, 4)),
            Rect::new(1, 1, 3, 3)
        );
        assert_eq!(
            rescale_to(Rect::new(0, 0, 4, 4), (8, 8), (8, 8)),
            Rect::new(0, 0, 4, 4)
        );
    }

    #[test]
    fn damage_crossing_a_viewport_rounds_outwards_too() {
        // A viewported surface's damage arrives in buffer pixels and lands in
        // the box the buffer is shown in, which need not be a whole multiple.
        // Identity when the boxes agree.
        assert_eq!(
            rescale_to(Rect::new(3, 4, 5, 6), (100, 100), (100, 100)),
            Rect::new(3, 4, 5, 6)
        );
        // The Firefox case: a 1600-pixel buffer shown in a 1600-pixel box on a
        // 2× canvas — one for one, no magnification.
        assert_eq!(
            rescale_to(Rect::new(10, 20, 30, 40), (1600, 1200), (1600, 1200)),
            Rect::new(10, 20, 30, 40)
        );
        // Buffer pixels [1, 4) of 3 shown in a box of 2: covers canvas [0, 3)
        // rounded outwards, not [0, 2).
        assert_eq!(
            rescale_to(Rect::new(1, 1, 3, 3), (6, 6), (4, 4)),
            Rect::new(0, 0, 3, 3)
        );
        // A degenerate source box paints the whole destination rather than
        // dividing by zero.
        assert_eq!(
            rescale_to(Rect::new(0, 0, 1, 1), (0, 5), (7, 9)),
            Rect::new(0, 0, 7, 9)
        );
    }
}
