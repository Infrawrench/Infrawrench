//! The runner's side of the conversation with `iwci-guest`.
//!
//! One thread reads the agent's frames as they come and hands them over a
//! channel, so every wait here has a deadline and the machine can be
//! stopped (a timeout, a cancel, a hang) while the agent is silent: the
//! caller kills the emulator, the stream ends, and the reader ends with it.

use std::io::{self, Read, Write};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use iwci_vm_proto::{
    Collect, Collected, DataWriter, Done, Exec, Exited, GuestMsg, Hello, HostMsg, Kind, Setup,
    decode, read_frame, send,
};

use crate::archive::{self, Moded};

type Frame = (Kind, Vec<u8>);

/// An open conversation.
pub struct Agent {
    writer: Box<dyn Write + Send>,
    frames: Receiver<io::Result<Frame>>,
    reader: Option<JoinHandle<()>>,
}

/// Why a wait ended without its answer.
#[derive(Debug)]
pub enum Failed {
    /// Nothing came in time.
    TimedOut(&'static str),
    /// The stream ended or broke: the machine stopped.
    Gone(String),
    /// The agent answered with an error.
    Refused(String),
    /// The agent said something out of turn.
    Confused(String),
}

impl std::fmt::Display for Failed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failed::TimedOut(what) => write!(f, "the machine's agent did not {what} in time"),
            Failed::Gone(why) => write!(f, "the machine stopped ({why})"),
            Failed::Refused(why) => write!(f, "the machine's agent: {why}"),
            Failed::Confused(why) => {
                write!(f, "the machine's agent said something unexpected: {why}")
            }
        }
    }
}

/// What the script's run is told while it waits, and what it answers.
pub enum Tick<'a> {
    /// Output, `true` for standard error.
    Output(bool, &'a [u8]),
    /// Nothing arrived for a while.
    Idle,
}

/// Whether to keep waiting for the script.
pub enum Watch {
    Continue,
    /// Stop waiting: the caller stops the machine.
    Stop,
}

/// How the script's run ended.
pub enum Ran {
    Exited(Exited),
    Stopped,
}

impl Agent {
    /// Starts the conversation over a stream's two halves.
    pub fn start(
        reader: impl Read + Send + 'static,
        writer: impl Write + Send + 'static,
    ) -> io::Result<Agent> {
        let (tx, rx) = channel();
        let mut reader = reader;
        let handle = std::thread::Builder::new()
            .name("iwci-vm-agent".into())
            .spawn(move || {
                loop {
                    match read_frame(&mut reader) {
                        Ok(Some(frame)) => {
                            if tx.send(Ok(frame)).is_err() {
                                return;
                            }
                        }
                        Ok(None) => {
                            let _ = tx.send(Err(io::ErrorKind::UnexpectedEof.into()));
                            return;
                        }
                        Err(e) => {
                            let _ = tx.send(Err(e));
                            return;
                        }
                    }
                }
            })?;
        Ok(Agent {
            writer: Box::new(writer),
            frames: rx,
            reader: Some(handle),
        })
    }

    fn next(&self, deadline: Instant, what: &'static str) -> Result<Frame, Failed> {
        let wait = deadline.saturating_duration_since(Instant::now());
        match self.frames.recv_timeout(wait) {
            Ok(Ok(frame)) => Ok(frame),
            Ok(Err(e)) => Err(Failed::Gone(e.to_string())),
            Err(RecvTimeoutError::Timeout) => Err(Failed::TimedOut(what)),
            Err(RecvTimeoutError::Disconnected) => Err(Failed::Gone("the stream ended".into())),
        }
    }

    fn message(&self, deadline: Instant, what: &'static str) -> Result<GuestMsg, Failed> {
        match self.next(deadline, what)? {
            (Kind::Message, bytes) => match decode::<GuestMsg>(&bytes) {
                Ok(GuestMsg::Error { message }) => Err(Failed::Refused(message)),
                Ok(msg) => Ok(msg),
                Err(e) => Err(Failed::Confused(e.to_string())),
            },
            (kind, _) => Err(Failed::Confused(format!("a {kind:?} frame"))),
        }
    }

    fn send(&mut self, msg: &HostMsg) -> Result<(), Failed> {
        send(&mut self.writer, msg).map_err(|e| Failed::Gone(e.to_string()))
    }

    /// Waits for the agent to introduce itself.
    pub fn hello(&mut self, within: Duration) -> Result<Hello, Failed> {
        match self.message(Instant::now() + within, "start")? {
            GuestMsg::Hello(hello) => Ok(hello),
            other => Err(Failed::Confused(format!("{other:?} before hello"))),
        }
    }

    pub fn setup(&mut self, setup: Setup, within: Duration) -> Result<(), Failed> {
        self.send(&HostMsg::Setup(setup))?;
        match self.message(Instant::now() + within, "set up")? {
            GuestMsg::Ready => Ok(()),
            other => Err(Failed::Confused(format!("{other:?} for setup"))),
        }
    }

    /// Sends `entries` as one archive, each under `prefix`, and waits for
    /// them to be written.
    pub fn put(&mut self, parts: &[(&str, &[Moded])], within: Duration) -> Result<Done, Failed> {
        self.send(&HostMsg::Put)?;
        let gone = |e: io::Error| Failed::Gone(e.to_string());
        {
            let mut data = DataWriter::new(&mut self.writer);
            // One archive with every part: the tar writer's end-of-archive
            // blocks come once, after the last.
            let mut tar = Vec::new();
            for (prefix, entries) in parts {
                let mut part = Vec::new();
                archive::write(&mut part, prefix, entries).map_err(gone)?;
                // Drop each part's two zero blocks but the last part's.
                part.truncate(part.len().saturating_sub(1024));
                tar.extend_from_slice(&part);
            }
            tar.extend_from_slice(&[0u8; 1024]);
            data.write_all(&tar).map_err(gone)?;
            data.finish().map_err(gone)?;
        }
        match self.message(Instant::now() + within, "write the job's files")? {
            GuestMsg::Done(done) => Ok(done),
            other => Err(Failed::Confused(format!("{other:?} for put"))),
        }
    }

    /// Runs the script. `watch` sees its output as it comes, and is asked
    /// at least every `tick` whether to keep waiting.
    pub fn exec(
        &mut self,
        exec: Exec,
        tick: Duration,
        watch: &mut dyn FnMut(Tick<'_>) -> Watch,
    ) -> Result<Ran, Failed> {
        self.send(&HostMsg::Exec(exec))?;
        loop {
            match self.frames.recv_timeout(tick) {
                Ok(Ok((Kind::Stdout, data))) => {
                    if let Watch::Stop = watch(Tick::Output(false, &data)) {
                        return Ok(Ran::Stopped);
                    }
                }
                Ok(Ok((Kind::Stderr, data))) => {
                    if let Watch::Stop = watch(Tick::Output(true, &data)) {
                        return Ok(Ran::Stopped);
                    }
                }
                Ok(Ok((Kind::Message, bytes))) => {
                    return match decode::<GuestMsg>(&bytes) {
                        Ok(GuestMsg::Exited(exited)) => Ok(Ran::Exited(exited)),
                        Ok(GuestMsg::Error { message }) => Err(Failed::Refused(message)),
                        Ok(other) => Err(Failed::Confused(format!("{other:?} while running"))),
                        Err(e) => Err(Failed::Confused(e.to_string())),
                    };
                }
                Ok(Ok((kind, _))) => {
                    return Err(Failed::Confused(format!("a {kind:?} frame while running")));
                }
                Ok(Err(e)) => return Err(Failed::Gone(e.to_string())),
                Err(RecvTimeoutError::Timeout) => {
                    if let Watch::Stop = watch(Tick::Idle) {
                        return Ok(Ran::Stopped);
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(Failed::Gone("the stream ended".into()));
                }
            }
        }
    }

    /// Asks for what the job left under `collect.paths`: the paths it
    /// deleted, and its files with their modes.
    pub fn collect(
        &mut self,
        collect: Collect,
        within: Duration,
    ) -> Result<(Collected, Vec<Moded>, Done), Failed> {
        let limit = collect.max_bytes;
        self.send(&HostMsg::Collect(collect))?;
        let deadline = Instant::now() + within;
        let collected = match self.message(deadline, "send back the job's files")? {
            GuestMsg::Collected(c) => c,
            other => return Err(Failed::Confused(format!("{other:?} for collect"))),
        };
        let mut data = Frames {
            agent: self,
            deadline,
            buf: Vec::new(),
            at: 0,
            done: false,
            failed: None,
        };
        let read = archive::read(&mut data, limit);
        // Whatever the archive held, read to its end so the stream is at
        // the next message.
        let mut sink = [0u8; 8192];
        while !data.done && data.failed.is_none() {
            if data.read(&mut sink).is_err() {
                break;
            }
        }
        if let Some(failed) = data.failed.take() {
            return Err(failed);
        }
        let entries = read.map_err(Failed::Refused)?;
        match self.message(deadline, "finish sending the job's files")? {
            GuestMsg::Done(done) => Ok((collected, entries, done)),
            other => Err(Failed::Confused(format!("{other:?} after collect"))),
        }
    }

    /// Asks the machine to power off; it is stopped anyway right after.
    pub fn shutdown(&mut self) {
        let _ = self.send(&HostMsg::Shutdown);
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        // The reader ends when the stream does, which the caller makes
        // happen by stopping the machine; it is not waited for here.
        drop(self.reader.take());
    }
}

/// The archive's data frames as a [`Read`], each frame waited for until
/// the collect's deadline.
struct Frames<'a> {
    agent: &'a Agent,
    deadline: Instant,
    buf: Vec<u8>,
    at: usize,
    done: bool,
    failed: Option<Failed>,
}

impl Read for Frames<'_> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        while self.at == self.buf.len() {
            if self.done {
                return Ok(0);
            }
            if self.failed.is_some() {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            match self.agent.next(self.deadline, "send back the job's files") {
                Ok((Kind::Data, data)) => {
                    self.buf = data;
                    self.at = 0;
                }
                Ok((Kind::DataEnd, _)) => self.done = true,
                Ok((kind, _)) => {
                    self.failed = Some(Failed::Confused(format!("a {kind:?} frame in the files")));
                }
                Err(e) => self.failed = Some(e),
            }
        }
        let n = out.len().min(self.buf.len() - self.at);
        out[..n].copy_from_slice(&self.buf[self.at..self.at + n]);
        self.at += n;
        Ok(n)
    }
}
