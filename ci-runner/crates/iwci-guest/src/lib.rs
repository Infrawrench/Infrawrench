//! `iwci-guest`, the agent inside a `platform: linux` or `platform: windows`
//! job's virtual machine.
//!
//! The runner talks to it over one byte stream in the protocol of
//! [`iwci_vm_proto`]; [`serve`] answers one conversation. The agent writes
//! the job's files ([`Tree::put`]), runs its script ([`exec`]) and sends
//! back what the script added, changed and deleted ([`Tree::plan`]).
//!
//! Two trees: [`Overlay`] inside a Linux machine, whose root is an overlay
//! file system so the upper directory is exactly what changed, and
//! [`Manifest`] everywhere else (Windows, tests, `serve-stdio`), which
//! remembers what it wrote and compares.

use std::io::{self, Read, Write};
use std::sync::{Arc, Mutex, MutexGuard};

use iwci_vm_proto::{
    Collect, DataReader, DataWriter, Done, GuestMsg, Hello, HostMsg, Kind, PROTOCOL, Setup, decode,
    read_frame, send,
};

pub mod collect;
pub mod exec;
#[cfg(target_os = "linux")]
pub mod init;
pub mod plan;
pub mod platform;
pub mod port;
pub mod prefetch;
pub mod put;
pub mod root;
pub mod stamp;
pub mod tree;
#[cfg(target_os = "linux")]
pub mod user;

pub use platform::{Local, Platform};
pub use root::Root;
pub use tree::{Manifest, Overlay, RUN_DIR, Tree};

/// The agent's version, as [`Hello::agent`] carries it.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// How a conversation ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Ended {
    /// The runner asked the machine to power off.
    Shutdown,
    /// The stream ended between requests.
    Closed,
}

/// Why a request failed.
pub enum Failure {
    /// The stream to the runner broke: the conversation is over.
    Broken(io::Error),
    /// The request failed; the runner is told and the conversation goes on.
    Refused(String),
}

pub(crate) fn lock<W>(m: &Mutex<W>) -> MutexGuard<'_, W> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn reply<W: Write>(out: &Mutex<W>, msg: &GuestMsg) -> io::Result<()> {
    send(&mut *lock(out), msg)
}

/// What [`serve`] says about itself in [`Hello`].
pub fn hello(platform: &dyn Platform, tree: &dyn Tree) -> Hello {
    Hello {
        protocol: PROTOCOL,
        os: std::env::consts::OS.into(),
        arch: std::env::consts::ARCH.into(),
        agent: VERSION.into(),
        image: platform.image(),
        modes: tree.modes(),
        virtiofs: platform.virtiofs(),
    }
}

/// A [`Read`] that remembers whether the stream under it failed, so a
/// failure inside the tar reader can be told apart from a refused entry.
struct Watched<'a, R: Read + ?Sized> {
    inner: &'a mut R,
    failed: bool,
}

impl<R: Read + ?Sized> Read for Watched<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.inner.read(buf).inspect_err(|_| self.failed = true)
    }
}

/// Answers one conversation: sends [`GuestMsg::Hello`], then answers each
/// request until [`HostMsg::Shutdown`] or the end of the stream. A request
/// that fails is answered with [`GuestMsg::Error`] and the conversation
/// goes on; only a broken stream returns an error.
///
/// The stream is read only between requests and while a request's own
/// archive arrives, and every write goes through one lock, so a reader and
/// a writer over one handle (a Windows serial port) never wait on each
/// other.
pub fn serve<R: Read, W: Write + Send + 'static>(
    mut reader: R,
    writer: W,
    platform: &dyn Platform,
    tree: &mut dyn Tree,
) -> io::Result<Ended> {
    let out = Arc::new(Mutex::new(writer));
    reply(&out, &GuestMsg::Hello(hello(platform, tree)))?;
    let mut ready = false;
    loop {
        let Some((kind, payload)) = read_frame(&mut reader)? else {
            return Ok(Ended::Closed);
        };
        if kind != Kind::Message {
            reply(
                &out,
                &GuestMsg::Error {
                    message: format!("expected a request, got a {kind:?} frame"),
                },
            )?;
            continue;
        }
        let msg: HostMsg = match decode(&payload) {
            Ok(msg) => msg,
            Err(e) => {
                reply(
                    &out,
                    &GuestMsg::Error {
                        message: format!("could not read the request: {e}"),
                    },
                )?;
                continue;
            }
        };
        let answer = match msg {
            HostMsg::Shutdown => return Ok(Ended::Shutdown),
            HostMsg::Setup(setup) => {
                let answer = setup_machine(platform, tree, &setup);
                if answer.is_ok() && !ready {
                    ready = true;
                    reply(&out, &GuestMsg::Ready)?;
                    platform.ready();
                    continue;
                }
                answer.map(|()| GuestMsg::Ready)
            }
            HostMsg::Put => put(&mut reader, tree),
            HostMsg::Exec(exec) => {
                let ctx = exec::Context {
                    run_dir: &tree.path(RUN_DIR),
                    cwd: &tree.path(&exec.cwd),
                    cgroups: platform.job_cgroups(),
                };
                if !iwci_vm_proto::is_clean_path(&exec.cwd) {
                    Err(Failure::Refused(format!(
                        "the working directory {:?} is not a clean absolute path",
                        exec.cwd
                    )))
                } else {
                    exec::run(&out, &exec, &ctx).map(GuestMsg::Exited)
                }
            }
            HostMsg::Collect(collect) => match collect_into(&out, tree, &collect) {
                Ok(done) => Ok(GuestMsg::Done(done)),
                Err(e) => Err(e),
            },
        };
        match answer {
            Ok(msg) => reply(&out, &msg)?,
            Err(Failure::Refused(message)) => reply(&out, &GuestMsg::Error { message })?,
            Err(Failure::Broken(e)) => return Err(e),
        }
    }
}

fn setup_machine(
    platform: &dyn Platform,
    tree: &mut dyn Tree,
    setup: &Setup,
) -> Result<(), Failure> {
    if setup.protocol != PROTOCOL {
        return Err(Failure::Refused(format!(
            "the runner speaks protocol {} and this agent {PROTOCOL}",
            setup.protocol
        )));
    }
    let written = platform.setup(setup).map_err(Failure::Refused)?;
    tree.track(&written);
    if let Some(scratch) = &setup.scratch {
        if !iwci_vm_proto::is_clean_path(&scratch.at) || scratch.at == "/" {
            return Err(Failure::Refused(format!(
                "the scratch directory {:?} is not a clean absolute path",
                scratch.at
            )));
        }
        platform
            .mount_scratch(&scratch.tag, &tree.path(&scratch.at))
            .map_err(Failure::Refused)?;
    }
    Ok(())
}

fn put<R: Read>(reader: &mut R, tree: &mut dyn Tree) -> Result<GuestMsg, Failure> {
    let mut data = DataReader::new(reader);
    let mut watched = Watched {
        inner: &mut data,
        failed: false,
    };
    let result = tree.put(&mut watched);
    if watched.failed {
        // The archive itself did not arrive whole: the stream is out of
        // step.
        let e = result
            .err()
            .unwrap_or_else(|| io::ErrorKind::InvalidData.into());
        return Err(Failure::Broken(e));
    }
    data.drain().map_err(Failure::Broken)?;
    match result {
        Ok(extracted) => {
            if extracted.skipped_links > 0 {
                eprintln!(
                    "iwci-guest: {} symbolic links were left out (this machine cannot make them)",
                    extracted.skipped_links
                );
            }
            Ok(GuestMsg::Done(Done {
                entries: extracted.entries,
                bytes: extracted.bytes,
                truncated: false,
            }))
        }
        Err(e) => Err(Failure::Refused(format!("writing the job's files: {e}"))),
    }
}

fn collect_into<W: Write>(
    out: &Mutex<W>,
    tree: &mut dyn Tree,
    collect: &Collect,
) -> Result<Done, Failure> {
    let paths = plan::requested(&collect.paths).map_err(Failure::Refused)?;
    if let Some(repository) = &collect.repository
        && !iwci_vm_proto::is_clean_path(repository)
    {
        return Err(Failure::Refused(format!(
            "{repository:?} is not a clean absolute path"
        )));
    }
    let plan = tree
        .plan(&paths, collect.repository.as_deref())
        .map_err(|e| Failure::Refused(format!("looking for the job's changes: {e}")))?;
    let mut guard = lock(out);
    send(
        &mut *guard,
        &GuestMsg::Collected(iwci_vm_proto::Collected {
            deleted: plan.deleted,
        }),
    )
    .map_err(Failure::Broken)?;
    let mut data = DataWriter::new(&mut *guard);
    let emitted = collect::emit(
        &plan.items,
        collect.max_bytes,
        tree.modes(),
        tree.job_root(),
        &mut data,
    );
    match emitted {
        Err(collect::EmitError::Stream(e)) => Err(Failure::Broken(e)),
        Err(collect::EmitError::Files(message)) => {
            data.finish().map_err(Failure::Broken)?;
            Err(Failure::Refused(message))
        }
        Ok(done) => {
            data.finish().map_err(Failure::Broken)?;
            Ok(done)
        }
    }
}
