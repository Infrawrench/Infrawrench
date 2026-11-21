//! The wire between the runner and `iwci-guest`, the agent inside a job's
//! virtual machine.
//!
//! A `platform: linux` or `platform: windows` job runs in a virtual machine
//! the runner starts for it. The runner talks to the agent over one byte
//! stream (a virtio-serial port, [`AGENT_PORT`]) in frames: a kind byte, a
//! little-endian `u32` length and that many bytes ([`write_frame`],
//! [`read_frame`]). Control messages are JSON ([`HostMsg`], [`GuestMsg`]);
//! file trees travel as tar archives cut into [`Kind::Data`] frames and
//! ended by one [`Kind::DataEnd`] ([`DataWriter`], [`DataReader`]); a
//! script's output comes as [`Kind::Stdout`] and [`Kind::Stderr`] frames.
//!
//! One conversation, in order:
//!
//! 1. The agent sends [`GuestMsg::Hello`] as soon as the port opens.
//! 2. [`HostMsg::Setup`]: the clock, the host name and the network. The
//!    agent answers [`GuestMsg::Ready`].
//! 3. [`HostMsg::Put`] and a tar archive: the files the job starts with
//!    that the machine does not have yet (on Linux the job's own files on
//!    top of the workspace image; on Windows the whole tree). The agent
//!    answers [`GuestMsg::Done`].
//! 4. [`HostMsg::Exec`]: the job's script. Output frames, then
//!    [`GuestMsg::Exited`].
//! 5. [`HostMsg::Collect`]: what the job left under some paths.
//!    [`GuestMsg::Collected`] (the paths it deleted), a tar archive (what
//!    it added or changed), then [`GuestMsg::Done`].
//!
//! Paths are always the job's Unix paths (`/app/src/main.rs`), relative to
//! `/` inside a tar archive. The Windows agent maps them onto the system
//! drive ([`windows_path`]), so a pipeline names the same paths on every
//! platform.
//!
//! Any [`GuestMsg::Error`] ends the request it answers; the runner then
//! fails the job with its message and stops the machine.

use std::io::{self, Read, Write};

pub mod gitignore;

use serde::{Deserialize, Serialize};

/// Bumped when a message or a frame changes shape. A runner refuses an
/// agent of another protocol, saying so, rather than misread it.
pub const PROTOCOL: u32 = 1;

/// The virtio-serial port's name: `/sys/class/virtio-ports/*/name` on
/// Linux, `\\.\Global\<name>` on Windows.
pub const AGENT_PORT: &str = "org.infrawrench.iwci.agent";

/// The most one frame carries. Data and output are cut to fit.
pub const MAX_FRAME: usize = 1 << 20;

/// Each side of the machine's one network link, as the runner's gateway
/// has them (the same addresses a gVisor sandbox gets).
pub const GUEST_IPV4: [u8; 4] = [10, 0, 2, 15];
pub const GATEWAY_IPV4: [u8; 4] = [10, 0, 2, 2];
pub const PREFIX_V4: u8 = 24;
/// Locally administered, fixed: every machine is alone on its link.
pub const GUEST_MAC: [u8; 6] = [0x52, 0x54, 0x00, 0x12, 0x34, 0x56];
pub const GATEWAY_MAC: [u8; 6] = [0x52, 0x55, 0x0a, 0x00, 0x02, 0x02];

/// What a frame holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    /// One JSON [`HostMsg`] or [`GuestMsg`].
    Message = 1,
    /// A piece of the archive being sent.
    Data = 2,
    /// The archive being sent is complete.
    DataEnd = 3,
    /// A piece of the running script's standard output.
    Stdout = 4,
    /// A piece of its standard error.
    Stderr = 5,
}

impl Kind {
    fn of(byte: u8) -> Option<Kind> {
        Some(match byte {
            1 => Kind::Message,
            2 => Kind::Data,
            3 => Kind::DataEnd,
            4 => Kind::Stdout,
            5 => Kind::Stderr,
            _ => return None,
        })
    }
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

/// Writes one frame. `payload` is at most [`MAX_FRAME`] bytes.
pub fn write_frame(w: &mut (impl Write + ?Sized), kind: Kind, payload: &[u8]) -> io::Result<()> {
    if payload.len() > MAX_FRAME {
        return Err(invalid(format!(
            "a frame of {} bytes is over the {MAX_FRAME}-byte limit",
            payload.len()
        )));
    }
    let mut head = [0u8; 5];
    head[0] = kind as u8;
    head[1..].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    w.write_all(&head)?;
    w.write_all(payload)?;
    w.flush()
}

/// Reads one frame, or `None` when the stream ends between frames.
pub fn read_frame(r: &mut (impl Read + ?Sized)) -> io::Result<Option<(Kind, Vec<u8>)>> {
    let mut head = [0u8; 5];
    let mut got = 0;
    while got < head.len() {
        match r.read(&mut head[got..]) {
            Ok(0) if got == 0 => return Ok(None),
            Ok(0) => return Err(io::ErrorKind::UnexpectedEof.into()),
            Ok(n) => got += n,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    let kind = Kind::of(head[0]).ok_or_else(|| invalid(format!("frame kind {}", head[0])))?;
    let len = u32::from_le_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if len > MAX_FRAME {
        return Err(invalid(format!(
            "a frame of {len} bytes is over the {MAX_FRAME}-byte limit"
        )));
    }
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    Ok(Some((kind, payload)))
}

/// Writes `message` as a [`Kind::Message`] frame.
pub fn send<M: Serialize>(w: &mut (impl Write + ?Sized), message: &M) -> io::Result<()> {
    let bytes = serde_json::to_vec(message).map_err(|e| invalid(e.to_string()))?;
    write_frame(w, Kind::Message, &bytes)
}

/// Reads frames until a message, which it decodes. Anything else in
/// between is a protocol error, and so is the stream ending.
pub fn receive<M: for<'de> Deserialize<'de>>(r: &mut (impl Read + ?Sized)) -> io::Result<M> {
    match read_frame(r)? {
        Some((Kind::Message, bytes)) => decode(&bytes),
        Some((kind, _)) => Err(invalid(format!("expected a message, got {kind:?}"))),
        None => Err(io::ErrorKind::UnexpectedEof.into()),
    }
}

/// Decodes a [`Kind::Message`] frame's payload.
pub fn decode<M: for<'de> Deserialize<'de>>(bytes: &[u8]) -> io::Result<M> {
    serde_json::from_slice(bytes).map_err(|e| invalid(format!("a message: {e}")))
}

/// A [`Write`] that sends what is written as [`Kind::Data`] frames, and
/// [`Kind::DataEnd`] on [`DataWriter::finish`]. Nothing is buffered beyond
/// one frame.
pub struct DataWriter<'w, W: Write + ?Sized> {
    w: &'w mut W,
    buf: Vec<u8>,
    sent: u64,
}

impl<'w, W: Write + ?Sized> DataWriter<'w, W> {
    pub fn new(w: &'w mut W) -> Self {
        DataWriter {
            w,
            buf: Vec::with_capacity(MAX_FRAME),
            sent: 0,
        }
    }

    fn flush_frame(&mut self) -> io::Result<()> {
        if !self.buf.is_empty() {
            write_frame(self.w, Kind::Data, &self.buf)?;
            self.sent += self.buf.len() as u64;
            self.buf.clear();
        }
        Ok(())
    }

    /// Sends what is left and ends the archive. Returns the bytes sent.
    pub fn finish(mut self) -> io::Result<u64> {
        self.flush_frame()?;
        write_frame(self.w, Kind::DataEnd, &[])?;
        Ok(self.sent)
    }
}

impl<W: Write + ?Sized> Write for DataWriter<'_, W> {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let room = MAX_FRAME - self.buf.len();
        let n = data.len().min(room);
        self.buf.extend_from_slice(&data[..n]);
        if self.buf.len() == MAX_FRAME {
            self.flush_frame()?;
        }
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// A [`Read`] over [`Kind::Data`] frames that ends at [`Kind::DataEnd`].
/// A frame of another kind in the middle is an error. Reading the rest
/// with [`DataReader::drain`] leaves the stream at the next frame.
pub struct DataReader<'r, R: Read + ?Sized> {
    r: &'r mut R,
    buf: Vec<u8>,
    at: usize,
    done: bool,
    received: u64,
}

impl<'r, R: Read + ?Sized> DataReader<'r, R> {
    pub fn new(r: &'r mut R) -> Self {
        DataReader {
            r,
            buf: Vec::new(),
            at: 0,
            done: false,
            received: 0,
        }
    }

    /// Reads to the end of the archive, discarding it, so the stream is
    /// left at the frame after [`Kind::DataEnd`]. Returns the bytes
    /// received in all.
    pub fn drain(mut self) -> io::Result<u64> {
        io::copy(&mut self, &mut io::sink())?;
        Ok(self.received)
    }

    /// The bytes received so far.
    pub fn received(&self) -> u64 {
        self.received
    }
}

impl<R: Read + ?Sized> Read for DataReader<'_, R> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        while self.at == self.buf.len() {
            if self.done {
                return Ok(0);
            }
            match read_frame(self.r)? {
                Some((Kind::Data, payload)) => {
                    self.received += payload.len() as u64;
                    self.buf = payload;
                    self.at = 0;
                }
                Some((Kind::DataEnd, _)) => self.done = true,
                Some((kind, _)) => {
                    return Err(invalid(format!("expected archive data, got {kind:?}")));
                }
                None => return Err(io::ErrorKind::UnexpectedEof.into()),
            }
        }
        let n = out.len().min(self.buf.len() - self.at);
        out[..n].copy_from_slice(&self.buf[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}

/// What the runner asks of the agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum HostMsg {
    Setup(Setup),
    /// A tar archive follows: write it into the machine's file system.
    Put,
    Exec(Exec),
    Collect(Collect),
    /// Flush the file systems and power off. The runner stops the machine
    /// itself if it is still there a few seconds later.
    Shutdown,
}

/// What the machine is told before anything runs.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct Setup {
    /// The runner's [`PROTOCOL`].
    pub protocol: u32,
    /// The time now, in milliseconds since the Unix epoch. A machine
    /// restored from a saved state wakes with the clock it was saved with.
    pub time_ms: u64,
    pub hostname: String,
    /// The link's addresses, or `None` for a job with `network: false`,
    /// whose machine has no network device at all.
    pub network: Option<Network>,
    /// The run's `/tmp/workflow`, served by the runner over virtio-fs, to
    /// mount rather than receive a copy of. Only sent to an agent whose
    /// [`Hello::virtiofs`] says it can.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scratch: Option<ScratchMount>,
}

/// The tag the run's `/tmp/workflow` device carries.
pub const SCRATCH_TAG: &str = "iwci-scratch";

/// A virtio-fs device to mount ([`Setup::scratch`]).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct ScratchMount {
    /// The device's tag.
    pub tag: String,
    /// Where the job sees it: a clean absolute Unix path.
    pub at: String,
}

/// The machine's side of its one link ([`GUEST_IPV4`] and the gateway).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct Network {
    /// `10.0.2.15`.
    pub address: String,
    pub prefix: u8,
    /// `10.0.2.2`, which is also the name server.
    pub gateway: String,
    pub dns: Vec<String>,
}

impl Network {
    /// The fixed link every machine gets.
    pub fn standard() -> Network {
        let dotted = |a: [u8; 4]| format!("{}.{}.{}.{}", a[0], a[1], a[2], a[3]);
        Network {
            address: dotted(GUEST_IPV4),
            prefix: PREFIX_V4,
            gateway: dotted(GATEWAY_IPV4),
            dns: vec![dotted(GATEWAY_IPV4)],
        }
    }
}

/// The interpreter a script runs with (`shell:`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Shell {
    /// `bash --noprofile --norc -euo pipefail <file>`.
    Bash,
    /// `sh -eu <file>`.
    Sh,
    /// PowerShell 7: `pwsh -NoLogo -NoProfile -NonInteractive -File <file>`,
    /// with `$ErrorActionPreference = 'Stop'`.
    Pwsh,
    /// Windows PowerShell 5.1, as `pwsh` otherwise.
    Powershell,
    /// `cmd /D /E:ON /V:OFF /S /C "CALL <file>"`.
    Cmd,
}

impl Shell {
    pub fn name(self) -> &'static str {
        match self {
            Shell::Bash => "bash",
            Shell::Sh => "sh",
            Shell::Pwsh => "pwsh",
            Shell::Powershell => "powershell",
            Shell::Cmd => "cmd",
        }
    }

    pub fn parse(text: &str) -> Option<Shell> {
        Some(match text {
            "bash" => Shell::Bash,
            "sh" => Shell::Sh,
            "pwsh" => Shell::Pwsh,
            "powershell" => Shell::Powershell,
            "cmd" => Shell::Cmd,
            _ => return None,
        })
    }
}

/// The job's script.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct Exec {
    pub shell: Shell,
    pub script: String,
    /// Added to the machine's own environment; these win.
    pub env: Vec<(String, String)>,
    /// A Unix path; the Windows agent maps it ([`windows_path`]).
    pub cwd: String,
}

/// What the job left under `paths` (Unix paths): files it added or
/// changed, directories it made, links, and the paths it deleted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct Collect {
    /// Sent whatever `.gitignore` says: a job's artifacts, caches and
    /// downloads are often in ignored directories.
    pub paths: Vec<String>,
    /// The job's clone, when its changes count (`changes:`): new entries in
    /// it that git ignores ([`gitignore`]) stay in the machine. What a job
    /// installs into `node_modules` or builds into `target` is no change of
    /// its, and would only fill the runner's memory.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    /// The most file content to send; past it the archive ends early and
    /// [`Done::truncated`] says so.
    pub max_bytes: u64,
}

/// What the agent says.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "kebab-case")]
pub enum GuestMsg {
    Hello(Hello),
    Ready,
    Done(Done),
    Exited(Exited),
    /// Sent before the archive that answers [`HostMsg::Collect`].
    Collected(Collected),
    Error {
        message: String,
    },
}

/// The agent, as it introduces itself.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct Hello {
    pub protocol: u32,
    /// `linux` or `windows`.
    pub os: String,
    /// `x86_64` or `aarch64`.
    pub arch: String,
    /// The agent's version.
    pub agent: String,
    /// The machine image it runs in, as the image says (`ubuntu-24.04`),
    /// or empty when the image does not say.
    pub image: String,
    /// Whether the files it collects carry real Unix modes. Windows has
    /// none to give; the runner then keeps each file's mode as it was.
    pub modes: bool,
    /// Whether it can mount a virtio-fs device ([`Setup::scratch`]). An
    /// older agent says nothing, which is no.
    #[serde(default)]
    pub virtiofs: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct Done {
    /// Files, directories and links written or sent.
    pub entries: u64,
    /// File content written or sent, in bytes.
    pub bytes: u64,
    /// The archive stopped at [`Collect::max_bytes`].
    #[serde(default)]
    pub truncated: bool,
}

/// How the script ended.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct Exited {
    /// The exit status, or `128 + signal` for a script a signal ended.
    pub code: i32,
    #[serde(default)]
    pub signal: Option<i32>,
    /// The kernel's out-of-memory killer ended a process of the job.
    #[serde(default)]
    pub oom_killed: bool,
    /// The most memory the job's processes held at once, where the agent
    /// can tell (0 where it cannot).
    #[serde(default)]
    pub peak_memory_bytes: u64,
    /// The CPU time the job's processes used, where the agent can tell.
    #[serde(default)]
    pub cpu_ms: u64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct Collected {
    /// Unix paths that existed when the job started and are gone now,
    /// directories as one path each. Applied before the archive, so a
    /// directory deleted and made again comes back with only what the
    /// archive holds.
    pub deleted: Vec<String>,
}

/// Whether `path` is an absolute Unix path with nothing to normalise:
/// no `.` or `..` component, no empty one, no backslash or NUL.
pub fn is_clean_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.contains(['\\', '\0'])
        && (path == "/"
            || path[1..]
                .split('/')
                .all(|c| !c.is_empty() && c != "." && c != ".."))
}

/// Whether `path` is `prefix` or below it (both clean, see
/// [`is_clean_path`]).
pub fn is_under(path: &str, prefix: &str) -> bool {
    prefix == "/"
        || path == prefix
        || (path.starts_with(prefix) && path.as_bytes().get(prefix.len()) == Some(&b'/'))
}

/// A job's Unix path on Windows: the same path on the system drive,
/// `/app/src` as `C:\app\src`.
pub fn windows_path(unix: &str) -> String {
    let rest = unix.trim_start_matches('/').replace('/', "\\");
    format!("C:\\{rest}")
}

/// The reverse of [`windows_path`]: `C:\app\src` (any case of the drive
/// letter) as `/app/src`, or `None` for a path elsewhere.
pub fn unix_path(windows: &str) -> Option<String> {
    let rest = windows
        .strip_prefix("C:\\")
        .or_else(|| windows.strip_prefix("c:\\"))
        .or_else(|| (windows.eq_ignore_ascii_case("c:")).then_some(""))?;
    let rest = rest.trim_end_matches('\\');
    let unix = format!("/{}", rest.replace('\\', "/"));
    is_clean_path(&unix).then_some(unix)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let mut wire = Vec::new();
        write_frame(&mut wire, Kind::Stdout, b"hello").unwrap();
        send(&mut wire, &HostMsg::Shutdown).unwrap();
        let mut r = wire.as_slice();
        assert_eq!(
            read_frame(&mut r).unwrap(),
            Some((Kind::Stdout, b"hello".to_vec()))
        );
        let msg: HostMsg = receive(&mut r).unwrap();
        assert_eq!(msg, HostMsg::Shutdown);
        assert_eq!(read_frame(&mut r).unwrap(), None);
    }

    #[test]
    fn a_frame_cut_short_is_an_error() {
        let mut wire = Vec::new();
        write_frame(&mut wire, Kind::Data, b"abcdef").unwrap();
        wire.truncate(7);
        assert!(read_frame(&mut wire.as_slice()).is_err());
        assert!(read_frame(&mut [9u8, 0, 0, 0, 0].as_slice()).is_err());
    }

    #[test]
    fn oversized_frames_are_refused_both_ways() {
        let mut wire = Vec::new();
        assert!(write_frame(&mut wire, Kind::Data, &vec![0; MAX_FRAME + 1]).is_err());
        let mut head = vec![Kind::Data as u8];
        head.extend_from_slice(&((MAX_FRAME as u32) + 1).to_le_bytes());
        assert!(read_frame(&mut head.as_slice()).is_err());
    }

    #[test]
    fn data_streams_are_cut_into_frames_and_end() {
        let body: Vec<u8> = (0..(MAX_FRAME * 2 + 17)).map(|i| i as u8).collect();
        let mut wire = Vec::new();
        let mut w = DataWriter::new(&mut wire);
        w.write_all(&body).unwrap();
        assert_eq!(w.finish().unwrap(), body.len() as u64);
        send(&mut wire, &GuestMsg::Ready).unwrap();

        let mut r = wire.as_slice();
        let mut back = Vec::new();
        let mut reader = DataReader::new(&mut r);
        reader.read_to_end(&mut back).unwrap();
        assert_eq!(reader.received(), body.len() as u64);
        assert_eq!(back, body);
        let next: GuestMsg = receive(&mut r).unwrap();
        assert_eq!(next, GuestMsg::Ready);
    }

    #[test]
    fn drain_leaves_the_stream_at_the_next_frame() {
        let mut wire = Vec::new();
        let mut w = DataWriter::new(&mut wire);
        w.write_all(b"ignored").unwrap();
        w.finish().unwrap();
        send(&mut wire, &GuestMsg::Ready).unwrap();
        let mut r = wire.as_slice();
        assert_eq!(DataReader::new(&mut r).drain().unwrap(), 7);
        let next: GuestMsg = receive(&mut r).unwrap();
        assert_eq!(next, GuestMsg::Ready);
    }

    #[test]
    fn other_frames_inside_an_archive_are_an_error() {
        let mut wire = Vec::new();
        write_frame(&mut wire, Kind::Data, b"a").unwrap();
        write_frame(&mut wire, Kind::Stdout, b"b").unwrap();
        let mut r = wire.as_slice();
        let mut out = Vec::new();
        assert!(DataReader::new(&mut r).read_to_end(&mut out).is_err());
    }

    #[test]
    fn messages_have_stable_names() {
        let exec = HostMsg::Exec(Exec {
            shell: Shell::Pwsh,
            script: "echo hi".into(),
            env: vec![("A".into(), "1".into())],
            cwd: "/app".into(),
        });
        let text = serde_json::to_string(&exec).unwrap();
        assert_eq!(
            text,
            r#"{"op":"exec","shell":"pwsh","script":"echo hi","env":[["A","1"]],"cwd":"/app"}"#
        );
        let exited: GuestMsg =
            serde_json::from_str(r#"{"op":"exited","code":137,"signal":9,"oom-killed":true}"#)
                .unwrap();
        assert_eq!(
            exited,
            GuestMsg::Exited(Exited {
                code: 137,
                signal: Some(9),
                oom_killed: true,
                ..Default::default()
            })
        );
    }

    #[test]
    fn clean_paths() {
        for ok in ["/", "/app", "/app/src/a.rs", "/tmp/workflow"] {
            assert!(is_clean_path(ok), "{ok}");
        }
        for bad in [
            "",
            "app",
            "/app/",
            "/app//x",
            "/app/./x",
            "/app/../x",
            "/a\\b",
            "/a\0",
        ] {
            assert!(!is_clean_path(bad), "{bad:?}");
        }
        assert!(is_under("/app/x", "/app"));
        assert!(is_under("/app", "/app"));
        assert!(!is_under("/apple", "/app"));
        assert!(is_under("/anything", "/"));
    }

    #[test]
    fn windows_paths_map_onto_the_system_drive() {
        assert_eq!(windows_path("/app/src/a.rs"), "C:\\app\\src\\a.rs");
        assert_eq!(windows_path("/"), "C:\\");
        assert_eq!(unix_path("C:\\app\\src").as_deref(), Some("/app/src"));
        assert_eq!(unix_path("c:\\app\\").as_deref(), Some("/app"));
        assert_eq!(unix_path("C:\\").as_deref(), Some("/"));
        assert_eq!(unix_path("D:\\app"), None);
        assert_eq!(unix_path("C:\\app\\..\\x"), None);
    }
}
