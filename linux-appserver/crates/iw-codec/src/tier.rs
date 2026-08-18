//! Which encoding tier a window should be on.
//!
//! One codec is wrong for this workload. A terminal is nearly static text
//! where lossy compression looks like a smeared mess; a video player redraws
//! everything at 30 Hz and lossless costs more bandwidth than we have. So the
//! selector watches how much of the window each frame actually redraws and
//! moves between tiers — with hysteresis, because flipping tiers costs a
//! keyframe and a codec reset, and a window that sits on the threshold would
//! otherwise thrash.

use iw_proto::{ClientCaps, ServerCaps};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// Damage rectangles, zstd. Crisp text, and cheap when little changes.
    Lossless,
    /// VP9 over the whole window. Cheap when everything changes.
    Video,
    /// JPEG tiles, decoded by the browser with no shipped decoder.
    ///
    /// Two jobs. It is where a window in motion goes when the client has no
    /// VP9 decoder — which today is every client, since nothing encodes VP9
    /// yet — and it is the static fallback for a client with no zstd.
    Image,
}

/// Coverage at which a window is considered to be in motion.
const ENTER_VIDEO: f32 = 0.35;
/// Coverage it must drop below to come back — the gap is the hysteresis.
const LEAVE_VIDEO: f32 = 0.15;
/// Weight of the newest frame in the moving average. Low enough that one
/// full-window repaint (opening a menu) does not flip a text editor to video.
const ALPHA: f32 = 0.2;

#[derive(Debug, Clone, Copy)]
pub struct TierSelector {
    motion: f32,
    current: Tier,
}

impl TierSelector {
    /// Start on the best tier the two ends can agree on for static content.
    pub fn new(client: &ClientCaps, server: &ServerCaps) -> Self {
        let mut selector = Self {
            motion: 0.0,
            current: Tier::Lossless,
        };
        // No zstd and no JPEG: raw rectangles still work, they just cost more.
        // Lossless is the honest answer.
        selector.current = selector.static_tier(client, server);
        selector
    }

    pub fn motion(&self) -> f32 {
        self.motion
    }

    pub fn current(&self) -> Tier {
        self.current
    }

    /// Feed in the coverage of the frame just encoded and get the tier for the
    /// next one.
    pub fn observe(&mut self, coverage: f32, client: &ClientCaps, server: &ServerCaps) -> Tier {
        self.motion = self.motion * (1.0 - ALPHA) + coverage.clamp(0.0, 1.0) * ALPHA;

        // Caps are re-read every frame rather than trusted from construction:
        // a client can lose its VideoDecoder mid-session when the browser's
        // GPU process restarts, and it tells us by flipping the flag.
        let moving = match self.motion_tier(client, server) {
            Some(tier) => tier,
            // Nothing lossy is available at either end, so motion is just
            // expensive lossless frames. Say so rather than pretending.
            None => {
                self.current = self.static_tier(client, server);
                return self.current;
            }
        };
        // The threshold depends on which side of it we are already on — that
        // gap is the hysteresis, and without it a window sitting on the line
        // would change tier, and pay for a keyframe, every frame.
        let threshold = if self.current == moving {
            LEAVE_VIDEO
        } else {
            ENTER_VIDEO
        };
        self.current = if self.motion >= threshold {
            moving
        } else {
            self.static_tier(client, server)
        };
        self.current
    }

    /// Where a window in motion goes, if anywhere.
    fn motion_tier(&self, client: &ClientCaps, server: &ServerCaps) -> Option<Tier> {
        if client.vp9 && server.vp9 {
            // One frame for the whole window beats a JPEG per rectangle, when
            // both ends can do it.
            Some(Tier::Video)
        } else if client.jpeg && server.jpeg {
            Some(Tier::Image)
        } else {
            None
        }
    }

    fn static_tier(&self, client: &ClientCaps, server: &ServerCaps) -> Tier {
        if client.zstd {
            Tier::Lossless
        } else if client.jpeg && server.jpeg {
            Tier::Image
        } else {
            Tier::Lossless
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both ends agreeing. `vp9` is the only cap either side is missing in
    /// practice — nothing encodes it yet — so it is the interesting axis.
    fn caps(vp9: bool, zstd: bool, jpeg: bool) -> (ClientCaps, ServerCaps) {
        (
            ClientCaps {
                vp9,
                zstd,
                jpeg,
                webp: false,
                delta: true,
                audio: false,
                max_frame_bytes: 16 << 20,
            },
            ServerCaps {
                vp9,
                webp: false,
                jpeg,
                xwayland: false,
                audio: false,
                runtime_dir: true,
                a11y: false,
            },
        )
    }

    #[test]
    fn a_typing_window_stays_lossless() {
        let (client, server) = caps(true, true, true);
        let mut sel = TierSelector::new(&client, &server);
        for _ in 0..60 {
            assert_eq!(sel.observe(0.01, &client, &server), Tier::Lossless);
        }
    }

    #[test]
    fn sustained_full_redraws_move_to_video() {
        let (client, server) = caps(true, true, true);
        let mut sel = TierSelector::new(&client, &server);
        let mut tier = Tier::Lossless;
        for _ in 0..20 {
            tier = sel.observe(1.0, &client, &server);
        }
        assert_eq!(tier, Tier::Video);
    }

    #[test]
    fn one_full_repaint_does_not_flip_a_text_window() {
        // Opening a menu repaints everything once. That must not switch an
        // editor to a video codec for the next thing the user types.
        let (client, server) = caps(true, true, true);
        let mut sel = TierSelector::new(&client, &server);
        for _ in 0..10 {
            sel.observe(0.01, &client, &server);
        }
        assert_eq!(sel.observe(1.0, &client, &server), Tier::Lossless);
    }

    #[test]
    fn video_holds_through_a_quiet_frame_then_returns() {
        let (client, server) = caps(true, true, true);
        let mut sel = TierSelector::new(&client, &server);
        for _ in 0..30 {
            sel.observe(1.0, &client, &server);
        }
        assert_eq!(sel.current(), Tier::Video);
        // A single still frame in a video is not the end of the video.
        assert_eq!(sel.observe(0.0, &client, &server), Tier::Video);
        for _ in 0..30 {
            sel.observe(0.0, &client, &server);
        }
        assert_eq!(sel.current(), Tier::Lossless);
    }

    #[test]
    fn without_vp9_motion_falls_to_jpeg_rather_than_staying_lossless() {
        // The case that actually ships: no VP9 encoder exists, so a window in
        // motion has to reach the lossy tier through JPEG or not at all.
        let (client, server) = caps(false, true, true);
        let mut sel = TierSelector::new(&client, &server);
        let mut tier = Tier::Lossless;
        for _ in 0..20 {
            tier = sel.observe(1.0, &client, &server);
        }
        assert_eq!(tier, Tier::Image);
    }

    #[test]
    fn with_nothing_lossy_at_either_end_motion_stays_lossless() {
        let (client, server) = caps(false, true, false);
        let mut sel = TierSelector::new(&client, &server);
        for _ in 0..50 {
            assert_eq!(sel.observe(1.0, &client, &server), Tier::Lossless);
        }
    }

    #[test]
    fn a_client_without_wasm_gets_images() {
        let (client, server) = caps(false, false, true);
        let mut sel = TierSelector::new(&client, &server);
        assert_eq!(sel.current(), Tier::Image);
        assert_eq!(sel.observe(0.5, &client, &server), Tier::Image);
    }

    #[test]
    fn typing_after_a_video_comes_back_to_crisp_text() {
        // The round trip that matters to a user: watch something, stop, and the
        // window has to stop being a JPEG of itself.
        let (client, server) = caps(false, true, true);
        let mut sel = TierSelector::new(&client, &server);
        for _ in 0..20 {
            sel.observe(1.0, &client, &server);
        }
        assert_eq!(sel.current(), Tier::Image);
        for _ in 0..20 {
            sel.observe(0.005, &client, &server);
        }
        assert_eq!(sel.current(), Tier::Lossless);
    }

    #[test]
    fn losing_the_video_decoder_mid_session_falls_to_the_next_lossy_tier() {
        // A browser whose GPU process restarted loses its VideoDecoder. The
        // window is still moving, so it belongs on JPEG rather than back on
        // lossless frames it cannot afford.
        let (mut client, server) = caps(true, true, true);
        let mut sel = TierSelector::new(&client, &server);
        for _ in 0..30 {
            sel.observe(1.0, &client, &server);
        }
        assert_eq!(sel.current(), Tier::Video);
        client.vp9 = false;
        assert_eq!(sel.observe(1.0, &client, &server), Tier::Image);
    }

    #[test]
    fn losing_every_lossy_tier_mid_session_falls_back_to_lossless() {
        let (mut client, server) = caps(true, true, true);
        let mut sel = TierSelector::new(&client, &server);
        for _ in 0..30 {
            sel.observe(1.0, &client, &server);
        }
        client.vp9 = false;
        client.jpeg = false;
        assert_eq!(sel.observe(1.0, &client, &server), Tier::Lossless);
    }
}
