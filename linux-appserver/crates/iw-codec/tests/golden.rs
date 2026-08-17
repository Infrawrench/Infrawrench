//! Golden fixtures: the bytes this encoder produces, checked in where the
//! TypeScript client can read them.
//!
//! The two halves of this protocol are written in different languages, so
//! "both sides agree" cannot be a type. It is this: a deterministic frame
//! sequence, its exact bytes on disk, and the canvas those bytes reconstruct.
//! The Rust test fails when the encoder's output drifts from the fixtures; the
//! `appstream-core` test fails when the decoder cannot reproduce the canvas.
//!
//! Regenerate deliberately, never automatically:
//!
//! ```text
//! UPDATE_GOLDEN=1 cargo test -p iw-codec --test golden
//! ```
//!
//! Skips when the fixtures directory is absent, so the Rust workspace stays
//! extractable on its own.

use std::path::{Path, PathBuf};

use iw_codec::{Codec, EncodeMode, Encoder, EncoderConfig, FrameView, PixelPayload, Rect, RectOp};
use iw_proto::{AUDIO_FLAG_RESET, AudioChunk, AudioCodec, FrameKind, SESSION_WINDOW, encode_frame};

const WIDTH: u32 = 64;
const HEIGHT: u32 = 48;
const WINDOW: u32 = 7;

fn fixtures_dir() -> Option<PathBuf> {
    let package = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../plugin-architecture/packages/appstream-core");
    package.is_dir().then(|| package.join("fixtures"))
}

/// A deterministic little animation: a background wash, a moving block, and a
/// cleared band. Between them they exercise every rectangle op the encoder can
/// emit — solid fills, changed pixels, and rectangles that turn out not to have
/// changed at all.
fn render(step: u32, pixels: &mut [u8]) {
    for y in 0..HEIGHT {
        for x in 0..WIDTH {
            let at = ((y * WIDTH + x) * 4) as usize;
            let base = ((x * 3 + y * 5) % 251) as u8;
            pixels[at] = base;
            pixels[at + 1] = base.wrapping_add(60);
            pixels[at + 2] = base.wrapping_add(120);
            pixels[at + 3] = 0xff;
        }
    }
    // A moving 12x12 block.
    let bx = 4 + step * 9;
    for y in 6..18u32 {
        for x in bx..bx + 12 {
            if x >= WIDTH {
                continue;
            }
            let at = ((y * WIDTH + x) * 4) as usize;
            pixels[at..at + 4].copy_from_slice(&[0x20, 0x80, 0xf0, 0xff]);
        }
    }
    // A flat band whose colour changes each step, so the encoder has something
    // it can legitimately send as a solid fill rather than as pixels.
    let shade = 0x11 + step as u8 * 0x20;
    for y in 30..38u32 {
        for x in 0..WIDTH {
            let at = ((y * WIDTH + x) * 4) as usize;
            pixels[at..at + 4].copy_from_slice(&[shade, 0x22, 0x33, 0xff]);
        }
    }
}

/// What one encoding of the fixture sequence produced.
struct Sequence {
    /// The frames as they go on the wire.
    wire: Vec<u8>,
    /// The canvas they reconstruct, in the client's RGBA. `None` for the lossy
    /// tier, whose blob only a JPEG decoder can apply — the reference blit
    /// refuses it on purpose.
    canvas: Option<Vec<u8>>,
    /// Every payload, so a test can assert what the encoder actually chose
    /// rather than trusting that the fixture still covers it.
    payloads: Vec<PixelPayload>,
}

/// Encode the sequence, returning the wire frames and the canvas they build.
fn encode_sequence(config: EncoderConfig, mode: EncodeMode) -> Sequence {
    let mut encoder = Encoder::new(config);
    encoder.set_mode(mode);
    let mut pixels = vec![0u8; (WIDTH * HEIGHT) as usize * 4];
    let mut wire = Vec::new();
    let mut canvas = vec![0u8; (WIDTH * HEIGHT) as usize * 4];
    let mut payloads = Vec::new();
    let lossless = mode == EncodeMode::Lossless;

    for step in 0..4u32 {
        render(step, &mut pixels);
        // Real damage regions rather than the whole canvas: the block that
        // moved, and the band that changed shade. A full-canvas rectangle
        // would coalesce into one and exercise nothing.
        let damage = vec![Rect::new(0, 4, WIDTH, 16), Rect::new(0, 30, WIDTH, 8)];
        let frame = FrameView {
            width: WIDTH,
            height: HEIGHT,
            stride: WIDTH * 4,
            pixels: &pixels,
        };
        if let Some(encoded) = encoder
            .encode(frame, &damage, step == 0)
            .expect("the fixture frames are well formed")
        {
            if lossless {
                encoded
                    .payload
                    .apply(&mut canvas, WIDTH, HEIGHT)
                    .expect("the reference blit accepts what the encoder produced");
            }
            wire.extend_from_slice(&encode_frame(FrameKind::Pixels, WINDOW, &encoded.bytes));
            payloads.push(encoded.payload);
        }
    }

    // The client paints RGBA; the wire carries BGRA. Swapping here rather than
    // in the TypeScript test keeps the fixture in the client's own terms, so a
    // mismatch means a real disagreement and not a byte-order convention.
    let rgba = canvas
        .chunks_exact(4)
        .flat_map(|px| [px[2], px[1], px[0], px[3]])
        .collect();
    Sequence {
        wire,
        canvas: lossless.then_some(rgba),
        payloads,
    }
}

fn check(dir: &Path, name: &str, actual: &[u8]) {
    let path = dir.join(name);
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(dir).expect("create fixtures dir");
        std::fs::write(&path, actual).expect("write fixture");
        return;
    }
    let expected = std::fs::read(&path).unwrap_or_else(|_| {
        panic!(
            "missing fixture {}; regenerate with UPDATE_GOLDEN=1 cargo test -p iw-codec --test golden",
            path.display()
        )
    });
    assert_eq!(
        expected.len(),
        actual.len(),
        "{name} changed length: the wire format moved, and @infrawrench/appstream-core has to move with it"
    );
    assert!(
        expected == actual,
        "{name} changed: the wire format moved, and @infrawrench/appstream-core has to move with it"
    );
}

/// Like [`check`], but comparing the *shape* of the frames rather than their
/// bytes: same frame count, same codec, same rectangle table.
///
/// The lossy tier's exact bytes depend on the CPU the host happens to have —
/// `jpeg-encoder` picks an AVX2 path at runtime — so pinning them would mean a
/// fixture that only reproduces on the machine that wrote it. What has to agree
/// across the two languages is the framing, and the checked-in file is what the
/// TypeScript test reads to verify it.
fn check_same_shape(dir: &Path, name: &str, actual: &[u8]) {
    let path = dir.join(name);
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        std::fs::create_dir_all(dir).expect("create fixtures dir");
        std::fs::write(&path, actual).expect("write fixture");
        return;
    }
    let expected = std::fs::read(&path).unwrap_or_else(|_| {
        panic!(
            "missing fixture {}; regenerate with UPDATE_GOLDEN=1 cargo test -p iw-codec --test golden",
            path.display()
        )
    });
    assert_eq!(
        shape_of(&expected),
        shape_of(actual),
        "{name} changed shape: the wire format moved, and @infrawrench/appstream-core has to move with it"
    );
}

/// One rectangle's position, size and op — the parts a decoder acts on.
type RectShape = (u32, u32, u32, u32, u8);

/// One payload's codec, keyframe flag and rectangle table.
type FrameShape = (u8, bool, Vec<RectShape>);

/// Every frame's shape — everything about a payload except the compressed
/// bytes themselves.
fn shape_of(wire: &[u8]) -> Vec<FrameShape> {
    let mut decoder = iw_proto::FrameDecoder::new();
    decoder.push(wire);
    let mut shapes = Vec::new();
    while let Some(frame) = decoder
        .next_frame()
        .expect("fixture frames are well formed")
    {
        let payload = PixelPayload::decode(&frame.payload).expect("fixture payloads decode");
        shapes.push((
            payload.codec as u8,
            payload.keyframe,
            payload
                .rects
                .iter()
                .map(|e| (e.rect.x, e.rect.y, e.rect.w, e.rect.h, e.op as u8))
                .collect(),
        ));
    }
    shapes
}

#[test]
fn golden_fixtures_match() {
    let Some(dir) = fixtures_dir() else {
        eprintln!("appstream-core is not present; skipping the cross-language fixtures");
        return;
    };

    // No zstd: raw rectangles, and no deltas either — a difference is only
    // worth anything to a client that can then decompress it.
    let raw = encode_sequence(
        EncoderConfig {
            allow_zstd: false,
            allow_delta: false,
            ..EncoderConfig::default()
        },
        EncodeMode::Lossless,
    );
    let raw_canvas = raw.canvas.clone().expect("the lossless tier builds one");
    check(&dir, "raw-frames.bin", &raw.wire);
    check(&dir, "raw-canvas.rgba", &raw_canvas);
    assert!(
        raw.payloads.iter().all(|p| p.codec == Codec::RawRects),
        "the raw fixture stopped covering the uncompressed tier"
    );

    let zstd = encode_sequence(EncoderConfig::default(), EncodeMode::Lossless);
    check(&dir, "zstd-frames.bin", &zstd.wire);
    // Both encodings must reconstruct the same picture: the compression tier is
    // a transport detail, not a difference the viewer can see.
    assert_eq!(
        Some(raw_canvas.clone()),
        zstd.canvas,
        "the zstd and raw tiers disagree about what the window looks like"
    );
    // The fixture is the only place the delta op is pinned across languages, so
    // it has to actually contain one.
    assert!(
        zstd.payloads
            .iter()
            .any(|p| p.rects.iter().any(|r| r.op == RectOp::Delta)),
        "the zstd fixture no longer exercises interframe compression"
    );

    // The lossy tier. There is no canvas fixture for it — the pixels depend on
    // whichever JPEG decoder the client happens to have, which is the reason
    // the encoder never deltas against one — so what is pinned is the framing:
    // a length-prefixed image per rectangle, in table order.
    let jpeg = encode_sequence(EncoderConfig::default(), EncodeMode::Lossy);
    check_same_shape(&dir, "jpeg-frames.bin", &jpeg.wire);
    assert!(
        jpeg.payloads
            .iter()
            .any(|p| p.codec == Codec::JpegTiles && !p.blob.is_empty()),
        "the jpeg fixture no longer exercises the lossy tier"
    );

    let meta = format!(
        "{{\n  \"width\": {WIDTH},\n  \"height\": {HEIGHT},\n  \"windowId\": {WINDOW}\n}}\n"
    );
    check(&dir, "meta.json", meta.as_bytes());
}

/// Deterministic interleaved stereo s16 for the audio fixture: a ramp on the
/// left, a faster ramp on the right, wrapped so every value fits.
fn audio_pcm(frames: usize, offset: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(frames * 4);
    for i in 0..frames {
        let at = (offset + i) as i32;
        let left = ((at * 37) % 2048 - 1024) as i16;
        let right = ((at * 91) % 4096 - 2048) as i16;
        out.extend_from_slice(&left.to_le_bytes());
        out.extend_from_slice(&right.to_le_bytes());
    }
    out
}

/// The audio wire format, pinned the same way as the pixels: three chunks —
/// zstd with the reset flag, raw, and compressed silence — plus the PCM they
/// decode back to. The TypeScript test replays the frames and must land on
/// exactly that PCM.
#[test]
fn audio_fixtures_match() {
    let Some(dir) = fixtures_dir() else {
        eprintln!("appstream-core is not present; skipping the cross-language fixtures");
        return;
    };

    let first = audio_pcm(480, 0);
    let second = audio_pcm(480, 480);
    let silence = vec![0u8; 480 * 4];

    let chunks = [
        AudioChunk {
            codec: AudioCodec::ZstdPcmS16,
            channels: 2,
            flags: AUDIO_FLAG_RESET,
            seq: 0,
            sample_rate: 48_000,
            data: zstd::bulk::compress(&first, 1).expect("pcm compresses"),
        },
        AudioChunk {
            codec: AudioCodec::PcmS16,
            channels: 2,
            flags: 0,
            seq: 1,
            sample_rate: 48_000,
            data: second.clone(),
        },
        AudioChunk {
            codec: AudioCodec::ZstdPcmS16,
            channels: 2,
            flags: 0,
            seq: 2,
            sample_rate: 48_000,
            data: zstd::bulk::compress(&silence, 1).expect("silence compresses"),
        },
    ];

    let mut wire = Vec::new();
    for chunk in &chunks {
        wire.extend_from_slice(&encode_frame(
            FrameKind::Audio,
            SESSION_WINDOW,
            &chunk.encode(),
        ));
    }
    check(&dir, "audio-frames.bin", &wire);

    let mut pcm = Vec::new();
    pcm.extend_from_slice(&first);
    pcm.extend_from_slice(&second);
    pcm.extend_from_slice(&silence);
    check(&dir, "audio-pcm.s16", &pcm);

    // The fixture has to keep covering both codecs and the reset flag, or it
    // would quietly pin less than it claims to.
    assert!(chunks.iter().any(|c| c.codec == AudioCodec::PcmS16));
    assert!(chunks.iter().any(|c| c.codec == AudioCodec::ZstdPcmS16));
    assert!(chunks[0].flags & AUDIO_FLAG_RESET != 0);
}
