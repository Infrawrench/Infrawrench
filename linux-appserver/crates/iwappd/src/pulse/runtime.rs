//! The threaded half of the audio server: a unix socket applications connect
//! to, a reader thread per connection, and a mixer thread that ticks in real
//! time. Everything protocol-shaped lives in [`super::server`]; this file
//! only shuttles bytes and time.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::os::unix::fs::DirBuilderExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use iw_proto::{AUDIO_FLAG_RESET, AudioChunk, AudioCodec};

use super::server::{AudioState, Connection, OUT_CHANNELS, OUT_RATE};

/// Mixer tick. 10 ms is small enough that the chunk cadence, not the tick,
/// bounds latency, and large enough that a tick costs more mixing than waking.
const TICK: Duration = Duration::from_millis(10);

/// After a stall (suspended laptop, blocked thread) this many frames of
/// backlog are simply dropped rather than burst at the client, which could
/// never play them on time anyway.
const MAX_FRAMES_PER_TICK: usize = OUT_RATE as usize / 10;

/// Compression level for chunks. Level 1: silence and speech shrink a lot,
/// music does not shrink at any level, and the mixer runs 100 times a second.
const ZSTD_LEVEL: i32 = 1;

struct Shared {
    state: AudioState,
    /// Write halves, so the mixer can send requests and events to clients
    /// from outside their reader threads.
    writers: HashMap<u64, Arc<Mutex<UnixStream>>>,
}

/// A running audio server. Dropping it does not stop the threads — call
/// [`PulseRuntime::shutdown`], or let process exit take them (they hold no
/// state worth flushing).
pub struct PulseRuntime {
    /// The value for the child's `PULSE_SERVER`, `unix:` prefix included.
    pub server_env: String,
    socket_path: PathBuf,
    rx: mpsc::Receiver<AudioChunk>,
    stop: Arc<AtomicBool>,
}

impl PulseRuntime {
    /// Mixed chunks ready to forward, non-blocking.
    pub fn try_iter(&self) -> mpsc::TryIter<'_, AudioChunk> {
        self.rx.try_iter()
    }

    /// Stop accepting and remove the socket. Reader and mixer threads notice
    /// the flag on their next turn; none of them owns durable state.
    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        // Unblock the accept loop with a throwaway connection.
        let _ = UnixStream::connect(&self.socket_path);
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

fn wall_now() -> (u32, u32) {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => (d.as_secs() as u32, d.subsec_micros()),
        Err(_) => (0, 0),
    }
}

/// Bind the socket and start the threads. `dir` is created 0700 — Wayland's
/// rule about group-writable runtime directories is a good rule here too.
/// `waker` is called after each chunk lands so the serve loop picks it up
/// mid-turn instead of on its next timeout.
pub fn start(dir: &Path, waker: impl Fn() + Send + 'static) -> std::io::Result<PulseRuntime> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true).mode(0o700);
    builder.create(dir)?;
    let socket_path = dir.join("native");
    let _ = std::fs::remove_file(&socket_path);
    let listener = UnixListener::bind(&socket_path)?;

    let shared = Arc::new(Mutex::new(Shared {
        state: AudioState::new(),
        writers: HashMap::new(),
    }));
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, rx) = mpsc::channel();

    {
        let shared = Arc::clone(&shared);
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || accept_loop(listener, shared, stop));
    }
    {
        let shared = Arc::clone(&shared);
        let stop = Arc::clone(&stop);
        std::thread::spawn(move || mixer_loop(shared, stop, tx, waker));
    }

    Ok(PulseRuntime {
        server_env: format!("unix:{}", socket_path.display()),
        socket_path,
        rx,
        stop,
    })
}

fn accept_loop(listener: UnixListener, shared: Arc<Mutex<Shared>>, stop: Arc<AtomicBool>) {
    let mut next_id: u64 = 1;
    for stream in listener.incoming() {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let Ok(stream) = stream else { continue };
        let id = next_id;
        next_id += 1;

        let writer = match stream.try_clone() {
            Ok(clone) => Arc::new(Mutex::new(clone)),
            Err(_) => continue,
        };
        shared
            .lock()
            .unwrap()
            .writers
            .insert(id, Arc::clone(&writer));

        let shared = Arc::clone(&shared);
        std::thread::spawn(move || {
            reader_loop(id, stream, writer, &shared);
            let mut guard = shared.lock().unwrap();
            guard.state.remove_connection(id);
            guard.writers.remove(&id);
        });
    }
}

fn reader_loop(
    id: u64,
    mut stream: UnixStream,
    writer: Arc<Mutex<UnixStream>>,
    shared: &Arc<Mutex<Shared>>,
) {
    let mut conn = Connection::new(id);
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = match stream.read(&mut buf) {
            Ok(0) | Err(_) => return,
            Ok(n) => n,
        };
        let replies = {
            let mut guard = shared.lock().unwrap();
            match conn.feed(&mut guard.state, &buf[..n], wall_now()) {
                Ok(replies) => replies,
                // A desynchronised byte stream: drop the client, keep serving.
                Err(_) => return,
            }
        };
        if !replies.is_empty() {
            let mut w = writer.lock().unwrap();
            for reply in replies {
                if w.write_all(&reply).is_err() {
                    return;
                }
            }
        }
    }
}

fn mixer_loop(
    shared: Arc<Mutex<Shared>>,
    stop: Arc<AtomicBool>,
    tx: mpsc::Sender<AudioChunk>,
    waker: impl Fn(),
) {
    let mut last = Instant::now();
    let mut owed_frames = 0f64;

    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(TICK);
        let now = Instant::now();
        owed_frames += now.duration_since(last).as_secs_f64() * OUT_RATE as f64;
        last = now;

        let frames = (owed_frames as usize).min(MAX_FRAMES_PER_TICK);
        // A stall longer than the cap is dropped time, not a burst.
        owed_frames = (owed_frames - frames as f64).min(MAX_FRAMES_PER_TICK as f64);
        if frames == 0 {
            continue;
        }

        let (output, seq) = {
            let mut guard = shared.lock().unwrap();
            let output = guard.state.mix(frames);
            let seq = guard.state.seq;
            if !output.pcm.is_empty() {
                guard.state.seq = guard.state.seq.wrapping_add(1);
            }

            for (conn, packet) in &output.packets {
                if let Some(writer) = guard.writers.get(conn).cloned() {
                    // A dead client's write fails here and its reader thread
                    // cleans up; nothing to do about it in the mixer.
                    let _ = writer.lock().unwrap().write_all(packet);
                }
            }
            (output, seq)
        };

        if output.pcm.is_empty() {
            continue;
        }

        let mut raw = Vec::with_capacity(output.pcm.len() * 2);
        for sample in &output.pcm {
            raw.extend_from_slice(&sample.to_le_bytes());
        }
        let (codec, data) = match zstd::bulk::compress(&raw, ZSTD_LEVEL) {
            Ok(compressed) if compressed.len() < raw.len() => (AudioCodec::ZstdPcmS16, compressed),
            _ => (AudioCodec::PcmS16, raw),
        };

        let chunk = AudioChunk {
            codec,
            channels: OUT_CHANNELS,
            flags: if output.reset { AUDIO_FLAG_RESET } else { 0 },
            seq,
            sample_rate: OUT_RATE,
            data,
        };
        if tx.send(chunk).is_err() {
            return; // serve loop is gone
        }
        waker();
    }
}
