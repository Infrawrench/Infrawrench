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
    /// WebP tiles, decoded by the browser with no shipped decoder. The
    /// fallback when the client has no wasm and no WebCodecs.
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
        Self {
            motion: 0.0,
            current: if client.zstd {
                Tier::Lossless
            } else if client.webp && server.webp {
                Tier::Image
            } else {
                // No wasm, no WebP encoder on the host: raw rectangles still
                // work, they just cost more. Lossless is the honest answer.
                Tier::Lossless
            },
        }
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
        let video_possible = client.vp9 && server.vp9;
        self.current = if self.current == Tier::Video {
            if video_possible && self.motion >= LEAVE_VIDEO {
                Tier::Video
            } else {
                self.static_tier(client, server)
            }
        } else if video_possible && self.motion > ENTER_VIDEO {
            Tier::Video
        } else {
            self.static_tier(client, server)
        };
        self.current
    }

    fn static_tier(&self, client: &ClientCaps, server: &ServerCaps) -> Tier {
        if client.zstd {
            Tier::Lossless
        } else if client.webp && server.webp {
            Tier::Image
        } else {
            Tier::Lossless
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(vp9: bool, zstd: bool, webp: bool) -> (ClientCaps, ServerCaps) {
        (
            ClientCaps {
                vp9,
                zstd,
                webp,
                max_frame_bytes: 16 << 20,
            },
            ServerCaps {
                vp9,
                webp,
                xwayland: false,
                audio: false,
                runtime_dir: true,
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
    fn without_vp9_motion_never_reaches_video() {
        let (client, server) = caps(false, true, true);
        let mut sel = TierSelector::new(&client, &server);
        for _ in 0..50 {
            assert_eq!(sel.observe(1.0, &client, &server), Tier::Lossless);
        }
    }

    #[test]
    fn a_client_without_wasm_gets_images() {
        let (mut client, server) = caps(false, false, true);
        client.webp = true;
        let mut sel = TierSelector::new(&client, &server);
        assert_eq!(sel.current(), Tier::Image);
        assert_eq!(sel.observe(0.5, &client, &server), Tier::Image);
    }

    #[test]
    fn losing_the_video_decoder_mid_session_falls_back() {
        let (mut client, server) = caps(true, true, true);
        let mut sel = TierSelector::new(&client, &server);
        for _ in 0..30 {
            sel.observe(1.0, &client, &server);
        }
        assert_eq!(sel.current(), Tier::Video);
        client.vp9 = false;
        assert_eq!(sel.observe(1.0, &client, &server), Tier::Lossless);
    }
}
