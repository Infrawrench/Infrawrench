//! The audio server against the real libpulse.
//!
//! The unit tests speak the protocol as this crate understands it; this test
//! speaks it as PulseAudio does, by driving the server with `pactl` and
//! `paplay`. Skips silently where pulseaudio-utils is not installed (CI
//! installs only libxkbcommon-dev), so it runs where a developer has the
//! tools and costs nothing where they do not.
#![cfg(unix)]

use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};

use iw_proto::AudioCodec;
use iwappd::pulse;

fn have(tool: &str) -> bool {
    Command::new(tool)
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

fn test_dir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("iw-pulse-{}-{}", name, std::process::id()))
}

/// A minimal WAV: 44-byte header plus s16le mono samples.
fn write_wav(path: &PathBuf, samples: &[i16], rate: u32) {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes()); // byte rate
    out.extend_from_slice(&2u16.to_le_bytes()); // block align
    out.extend_from_slice(&16u16.to_le_bytes()); // bits
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    std::fs::write(path, out).expect("write wav");
}

#[test]
fn real_libpulse_lists_the_sink_and_plays_through_it() {
    if !have("pactl") || !have("paplay") {
        eprintln!("skipping: pulseaudio-utils not installed");
        return;
    }

    let dir = test_dir("live");
    let runtime = pulse::start(&dir, || {}).expect("start audio server");
    let server = runtime.server_env.clone();

    // Introspection: the real client authenticates, sets its name, and reads
    // the sink list. Any tagstruct we get wrong shows up here as a parse
    // error or a hang.
    let info = Command::new("pactl")
        .args(["--server", &server, "info"])
        .output()
        .expect("run pactl");
    assert!(
        info.status.success(),
        "pactl info failed: {}",
        String::from_utf8_lossy(&info.stderr)
    );
    let stdout = String::from_utf8_lossy(&info.stdout);
    assert!(
        stdout.contains(pulse::SINK_NAME),
        "pactl info should name the default sink, got:\n{stdout}"
    );

    let sinks = Command::new("pactl")
        .args(["--server", &server, "list", "sinks"])
        .output()
        .expect("run pactl");
    assert!(
        sinks.status.success(),
        "pactl list sinks failed: {}",
        String::from_utf8_lossy(&sinks.stderr)
    );
    assert!(String::from_utf8_lossy(&sinks.stdout).contains(pulse::SINK_NAME));

    // Playback: a 250 ms 440 Hz tone at 44.1 kHz mono, so the mixer also
    // exercises resampling and mono upmix. paplay only exits successfully
    // once the stream has drained, which exercises the drain ack too.
    let wav = dir.join("tone.wav");
    let samples: Vec<i16> = (0..11_025)
        .map(|i| {
            let t = i as f32 / 44_100.0;
            ((t * 440.0 * std::f32::consts::TAU).sin() * 12_000.0) as i16
        })
        .collect();
    write_wav(&wav, &samples, 44_100);

    let played = Command::new("paplay")
        .args(["--server", &server])
        .arg(&wav)
        .output()
        .expect("run paplay");
    assert!(
        played.status.success(),
        "paplay failed: {}",
        String::from_utf8_lossy(&played.stderr)
    );

    // The mixer ticks in real time; collect what it produced.
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut pcm = Vec::new();
    let mut resets = 0;
    while Instant::now() < deadline {
        for chunk in runtime.try_iter() {
            if chunk.flags & iw_proto::AUDIO_FLAG_RESET != 0 {
                resets += 1;
            }
            let raw = match chunk.codec {
                AudioCodec::PcmS16 => chunk.data.clone(),
                AudioCodec::ZstdPcmS16 => {
                    zstd::bulk::decompress(&chunk.data, 4 << 20).expect("chunk decompresses")
                }
            };
            for pair in raw.chunks_exact(2) {
                pcm.push(i16::from_le_bytes([pair[0], pair[1]]));
            }
        }
        if !pcm.is_empty() && pcm.len() > 48_000 {
            break;
        }
        std::thread::sleep(Duration::from_millis(20));
    }

    assert!(resets >= 1, "the first chunk should carry the reset flag");
    let peak = pcm.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);
    assert!(
        peak > 8_000,
        "the tone should arrive in the mix at roughly its amplitude, peak was {peak}"
    );

    runtime.shutdown();
    let _ = std::fs::remove_dir_all(&dir);
}
