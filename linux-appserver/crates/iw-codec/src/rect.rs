//! Damage rectangles and the coalescing that keeps them useful.
//!
//! A toolkit reports damage in whatever granularity suits it — GTK will happily
//! hand us forty little rectangles for one blinking cursor and a redrawn
//! toolbar. Forty rectangles cost forty headers, forty zstd frames' worth of
//! ramp-up and forty canvas blits, so we merge until the count is sane and the
//! merged area is not much larger than the union we started with.

/// A rectangle in window-buffer pixels. Right and bottom edges are exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl Rect {
    pub const fn new(x: u32, y: u32, w: u32, h: u32) -> Self {
        Self { x, y, w, h }
    }

    pub const fn area(&self) -> u64 {
        self.w as u64 * self.h as u64
    }

    pub const fn is_empty(&self) -> bool {
        self.w == 0 || self.h == 0
    }

    pub const fn right(&self) -> u32 {
        self.x + self.w
    }

    pub const fn bottom(&self) -> u32 {
        self.y + self.h
    }

    /// Smallest rectangle containing both.
    pub fn union(&self, other: &Rect) -> Rect {
        if self.is_empty() {
            return *other;
        }
        if other.is_empty() {
            return *self;
        }
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        let right = self.right().max(other.right());
        let bottom = self.bottom().max(other.bottom());
        Rect::new(x, y, right - x, bottom - y)
    }

    pub fn intersects(&self, other: &Rect) -> bool {
        self.x < other.right()
            && other.x < self.right()
            && self.y < other.bottom()
            && other.y < self.bottom()
    }

    /// Clamp to a canvas, returning `None` when nothing is left. A client can
    /// and does report damage outside its own buffer during a resize.
    pub fn clip(&self, width: u32, height: u32) -> Option<Rect> {
        if self.x >= width || self.y >= height || self.is_empty() {
            return None;
        }
        let right = self.right().min(width);
        let bottom = self.bottom().min(height);
        Some(Rect::new(self.x, self.y, right - self.x, bottom - self.y))
    }
}

/// How aggressively to merge. Defaults are tuned for a text-heavy window,
/// where over-merging costs far more bytes than an extra rectangle header.
#[derive(Debug, Clone, Copy)]
pub struct CoalesceLimits {
    /// Merge until at most this many rectangles remain.
    pub max_rects: usize,
    /// Once the damaged area passes this fraction of the canvas, send the
    /// whole canvas — the per-rect overhead has stopped paying for itself.
    pub full_frame_coverage: f32,
}

impl Default for CoalesceLimits {
    fn default() -> Self {
        Self {
            max_rects: 16,
            full_frame_coverage: 0.6,
        }
    }
}

/// Clip, drop empties, merge overlapping and near-adjacent rectangles, then
/// merge by cheapest area growth until the count fits. Returns rectangles in
/// top-to-bottom order, which is also the order they are written into the
/// payload — a decoder walking them writes the canvas roughly in raster order.
pub fn coalesce(input: &[Rect], width: u32, height: u32, limits: CoalesceLimits) -> Vec<Rect> {
    let canvas = Rect::new(0, 0, width, height);
    let mut rects: Vec<Rect> = input.iter().filter_map(|r| r.clip(width, height)).collect();
    if rects.is_empty() {
        return Vec::new();
    }

    // Pass 1: absorb anything that overlaps or touches. Repeats until stable
    // because merging two rectangles can bring a third into contact.
    let mut merged = true;
    while merged {
        merged = false;
        let mut out: Vec<Rect> = Vec::with_capacity(rects.len());
        for rect in rects.drain(..) {
            let mut current = rect;
            let mut i = 0;
            while i < out.len() {
                if touches(&current, &out[i]) {
                    current = current.union(&out.swap_remove(i));
                    merged = true;
                } else {
                    i += 1;
                }
            }
            out.push(current);
        }
        rects = out;
    }

    // Pass 2: bring the count down. Each step picks the pair whose union wastes
    // the least — a naive "merge the first two" turns a top toolbar and a
    // bottom status bar into the whole window.
    while rects.len() > limits.max_rects {
        let mut best: Option<(usize, usize, u64)> = None;
        for i in 0..rects.len() {
            for j in i + 1..rects.len() {
                let waste = rects[i].union(&rects[j]).area() - rects[i].area() - rects[j].area();
                if best.is_none_or(|(_, _, w)| waste < w) {
                    best = Some((i, j, waste));
                }
            }
        }
        let Some((i, j, _)) = best else { break };
        let merged = rects[i].union(&rects[j]);
        rects.swap_remove(j);
        rects[i] = merged;
    }

    let damaged: u64 = rects.iter().map(Rect::area).sum();
    if canvas.area() > 0
        && damaged as f64 >= canvas.area() as f64 * limits.full_frame_coverage as f64
    {
        return vec![canvas];
    }

    rects.sort_by_key(|r| (r.y, r.x));
    rects
}

/// Overlapping, or close enough that the gap between them costs less than a
/// second rectangle's worth of framing and blit setup.
fn touches(a: &Rect, b: &Rect) -> bool {
    const SLACK: u32 = 8;
    let grown = Rect::new(
        a.x.saturating_sub(SLACK),
        a.y.saturating_sub(SLACK),
        a.w + SLACK * 2,
        a.h + SLACK * 2,
    );
    grown.intersects(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clips_damage_reported_outside_the_buffer() {
        assert_eq!(
            Rect::new(90, 90, 40, 40).clip(100, 100),
            Some(Rect::new(90, 90, 10, 10))
        );
        assert_eq!(Rect::new(100, 0, 10, 10).clip(100, 100), None);
        assert_eq!(Rect::new(0, 0, 0, 10).clip(100, 100), None);
    }

    #[test]
    fn merges_overlapping_damage() {
        let out = coalesce(
            &[Rect::new(0, 0, 50, 50), Rect::new(25, 25, 50, 50)],
            200,
            200,
            CoalesceLimits::default(),
        );
        assert_eq!(out, vec![Rect::new(0, 0, 75, 75)]);
    }

    #[test]
    fn merges_transitively() {
        // Three rectangles in a chain: A touches B, B touches C, A misses C.
        let out = coalesce(
            &[
                Rect::new(0, 0, 20, 20),
                Rect::new(20, 0, 20, 20),
                Rect::new(40, 0, 20, 20),
            ],
            200,
            200,
            CoalesceLimits::default(),
        );
        assert_eq!(out, vec![Rect::new(0, 0, 60, 20)]);
    }

    #[test]
    fn keeps_distant_damage_apart() {
        let limits = CoalesceLimits::default();
        let out = coalesce(
            &[Rect::new(0, 0, 20, 20), Rect::new(400, 400, 20, 20)],
            800,
            800,
            limits,
        );
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn merging_to_the_limit_picks_the_cheapest_pair() {
        // A toolbar at the top, a status bar at the bottom, and two adjacent
        // blobs in the middle. Squeezed to three, the two blobs must be what
        // merges — merging toolbar and status bar would cover the window.
        let limits = CoalesceLimits {
            max_rects: 3,
            ..CoalesceLimits::default()
        };
        let out = coalesce(
            &[
                Rect::new(0, 0, 800, 10),
                Rect::new(100, 400, 20, 20),
                Rect::new(160, 400, 20, 20),
                Rect::new(0, 790, 800, 10),
            ],
            800,
            800,
            limits,
        );
        assert_eq!(out.len(), 3);
        assert!(out.contains(&Rect::new(100, 400, 80, 20)));
        assert!(out.contains(&Rect::new(0, 0, 800, 10)));
        assert!(out.contains(&Rect::new(0, 790, 800, 10)));
    }

    #[test]
    fn heavy_damage_collapses_to_the_full_canvas() {
        let out = coalesce(
            &[Rect::new(0, 0, 100, 90)],
            100,
            100,
            CoalesceLimits::default(),
        );
        assert_eq!(out, vec![Rect::new(0, 0, 100, 100)]);
    }

    #[test]
    fn no_damage_encodes_nothing() {
        assert!(coalesce(&[], 100, 100, CoalesceLimits::default()).is_empty());
        assert!(
            coalesce(
                &[Rect::new(0, 0, 0, 0)],
                100,
                100,
                CoalesceLimits::default()
            )
            .is_empty()
        );
    }

    #[test]
    fn output_is_in_raster_order() {
        let out = coalesce(
            &[
                Rect::new(500, 500, 10, 10),
                Rect::new(10, 10, 10, 10),
                Rect::new(300, 10, 10, 10),
            ],
            800,
            800,
            CoalesceLimits::default(),
        );
        let keys: Vec<(u32, u32)> = out.iter().map(|r| (r.y, r.x)).collect();
        let mut sorted = keys.clone();
        sorted.sort();
        assert_eq!(keys, sorted);
    }
}
