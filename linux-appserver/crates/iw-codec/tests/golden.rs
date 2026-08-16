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

use iw_codec::{Encoder, EncoderConfig, FrameView, Rect};
use iw_proto::{FrameKind, encode_frame};

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

/// Encode the sequence, returning the wire frames and the canvas they build.
fn encode_sequence(allow_zstd: bool) -> (Vec<u8>, Vec<u8>) {
    let mut encoder = Encoder::new(EncoderConfig {
        allow_zstd,
        ..EncoderConfig::default()
    });
    let mut pixels = vec![0u8; (WIDTH * HEIGHT) as usize * 4];
    let mut wire = Vec::new();
    let mut canvas = vec![0u8; (WIDTH * HEIGHT) as usize * 4];

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
            encoded
                .payload
                .apply(&mut canvas, WIDTH, HEIGHT)
                .expect("the reference blit accepts what the encoder produced");
            wire.extend_from_slice(&encode_frame(FrameKind::Pixels, WINDOW, &encoded.bytes));
        }
    }

    // The client paints RGBA; the wire carries BGRA. Swapping here rather than
    // in the TypeScript test keeps the fixture in the client's own terms, so a
    // mismatch means a real disagreement and not a byte-order convention.
    let rgba = canvas
        .chunks_exact(4)
        .flat_map(|px| [px[2], px[1], px[0], px[3]])
        .collect();
    (wire, rgba)
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

#[test]
fn golden_fixtures_match() {
    let Some(dir) = fixtures_dir() else {
        eprintln!("appstream-core is not present; skipping the cross-language fixtures");
        return;
    };

    let (raw_wire, raw_canvas) = encode_sequence(false);
    check(&dir, "raw-frames.bin", &raw_wire);
    check(&dir, "raw-canvas.rgba", &raw_canvas);

    let (zstd_wire, zstd_canvas) = encode_sequence(true);
    check(&dir, "zstd-frames.bin", &zstd_wire);
    // Both encodings must reconstruct the same picture: the compression tier is
    // a transport detail, not a difference the viewer can see.
    assert_eq!(
        raw_canvas, zstd_canvas,
        "the zstd and raw tiers disagree about what the window looks like"
    );

    let meta = format!(
        "{{\n  \"width\": {WIDTH},\n  \"height\": {HEIGHT},\n  \"windowId\": {WINDOW}\n}}\n"
    );
    check(&dir, "meta.json", meta.as_bytes());
}
