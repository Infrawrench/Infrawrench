//! The run's `/tmp/workflow` as a Linux machine's virtio-fs device, served
//! by the runner itself.
//!
//! QEMU's `vhost-user-fs-device` hands the device's virtqueues to a
//! vhost-user back end over a Unix socket; this is that back end, in the
//! runner's own process, on rust-vmm's `vhost-user-backend` (what virtiofsd
//! is built on). The guest's kernel writes FUSE requests into the queues,
//! [`crate::fuse::Server`] answers each from the job's view of the
//! scratch directory, and the answer goes back into the guest's buffers.
//! virtiofsd itself was not usable: it serves a directory of the host's,
//! and the scratch directory lives in the runner's memory.
//!
//! The device has two queues, as virtio-fs has with one request queue:
//! 0 for the high-priority requests (`FORGET`, `INTERRUPT`), 1 for the
//! rest. A request is taken off its queue on the back end's own thread and
//! answered on one of [`WORKERS`] threads, so a request that waits (an
//! `open` of a file another runner wrote, whose bytes are still coming)
//! holds only its worker, never the queue; answers may go back in any
//! order, which virtqueues allow. The guest's memory is shared with QEMU
//! (`memory-backend-memfd,share=on`) and mapped here by the library; every
//! buffer address the guest gives is checked by `vm-memory` before it is
//! read or written.

use std::io;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use iwci_vfs::{DynFs, Modes};
use vhost::vhost_user::Listener;
use vhost::vhost_user::message::{VhostUserProtocolFeatures, VhostUserVirtioFeatures};
use vhost_user_backend::{VhostUserBackend, VhostUserDaemon, VringRwLock, VringT};
use virtio_bindings::bindings::virtio_config::VIRTIO_F_VERSION_1;
use virtio_bindings::bindings::virtio_ring::VIRTIO_RING_F_INDIRECT_DESC;
use virtio_queue::QueueOwnedT;
use vm_memory::{
    Bytes, GuestAddress, GuestAddressSpace, GuestMemoryAtomic, GuestMemoryLoadGuard,
    GuestMemoryMmap,
};
use vmm_sys_util::epoll::EventSet;
use vmm_sys_util::event::{
    EventConsumer, EventFlag, EventNotifier, new_event_consumer_and_notifier,
};

use crate::fuse::{MAX_IO, Server};

/// Threads answering one machine's requests.
pub const WORKERS: usize = 8;
const QUEUES: usize = 2;
const QUEUE_SIZE: usize = 1024;
/// The most of one request read from the guest: a write's data and its
/// headers.
const MAX_REQUEST: usize = MAX_IO as usize + 4096;

type Memory = GuestMemoryAtomic<GuestMemoryMmap>;

/// One request taken off a queue, to be answered on a worker.
struct Work {
    vring: VringRwLock,
    head: u16,
    request: Vec<u8>,
    /// Where the answer goes, in order.
    writable: Vec<(GuestAddress, usize)>,
}

struct Inner {
    server: Arc<Server>,
    memory: Mutex<Option<Memory>>,
    work: Mutex<Option<mpsc::Sender<Work>>>,
}

#[derive(Clone)]
struct Backend(Arc<Inner>);

impl Backend {
    fn memory(&self) -> Option<GuestMemoryLoadGuard<GuestMemoryMmap>> {
        self.0
            .memory
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(GuestAddressSpace::memory)
    }

    /// Takes every request off `vring` and hands each to a worker.
    fn drain(&self, vring: &VringRwLock) -> io::Result<()> {
        let Some(mem) = self.memory() else {
            return Ok(());
        };
        let chains: Vec<_> = {
            let mut state = vring.get_mut();
            state
                .get_queue_mut()
                .iter(mem.clone())
                .map_err(|e| io::Error::other(format!("{e:?}")))?
                .collect()
        };
        let sender = self
            .0
            .work
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        for chain in chains {
            let head = chain.head_index();
            let mut request = Vec::new();
            let mut writable = Vec::new();
            let mut readable = true;
            for desc in chain {
                let len = desc.len() as usize;
                if desc.is_write_only() {
                    writable.push((desc.addr(), len));
                    continue;
                }
                // Readable buffers come first; anything after the
                // writable ones begin is not a request.
                if !writable.is_empty() || request.len() + len > MAX_REQUEST {
                    readable = false;
                    continue;
                }
                let at = request.len();
                request.resize(at + len, 0);
                if mem.read_slice(&mut request[at..], desc.addr()).is_err() {
                    readable = false;
                }
            }
            if !readable {
                // Nothing that can be answered: give the buffers back.
                request.clear();
            }
            let work = Work {
                vring: vring.clone(),
                head,
                request,
                writable,
            };
            match &sender {
                Some(sender) if sender.send(work).is_ok() => {}
                _ => {
                    let _ = vring.add_used(head, 0);
                    let _ = vring.signal_used_queue();
                }
            }
        }
        Ok(())
    }
}

/// Answers one request and gives its buffers back.
fn answer(server: &Server, memory: &Mutex<Option<Memory>>, work: Work) {
    let mut written = 0usize;
    if let Some(reply) = server.handle(&work.request) {
        let mem = memory
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(GuestAddressSpace::memory);
        if let Some(mem) = mem {
            for (addr, len) in &work.writable {
                if written >= reply.len() {
                    break;
                }
                let n = (*len).min(reply.len() - written);
                if mem
                    .write_slice(&reply[written..written + n], *addr)
                    .is_err()
                {
                    break;
                }
                written += n;
            }
        }
    }
    let _ = work.vring.add_used(work.head, written as u32);
    let _ = work.vring.signal_used_queue();
}

impl VhostUserBackend for Backend {
    type Bitmap = ();
    type Vring = VringRwLock;

    fn num_queues(&self) -> usize {
        QUEUES
    }

    fn max_queue_size(&self) -> usize {
        QUEUE_SIZE
    }

    fn features(&self) -> u64 {
        (1 << VIRTIO_F_VERSION_1)
            | (1 << VIRTIO_RING_F_INDIRECT_DESC)
            | VhostUserVirtioFeatures::PROTOCOL_FEATURES.bits()
    }

    fn protocol_features(&self) -> VhostUserProtocolFeatures {
        VhostUserProtocolFeatures::MQ
    }

    /// An event per worker thread of the library's, which it signals when
    /// the device goes away; without one, dropping the daemon waits for
    /// those threads forever.
    fn exit_event(&self, _thread_index: usize) -> Option<(EventConsumer, EventNotifier)> {
        new_event_consumer_and_notifier(EventFlag::NONBLOCK | EventFlag::CLOEXEC).ok()
    }

    fn set_event_idx(&self, _enabled: bool) {
        // Not offered: every answer signals the guest.
    }

    fn update_memory(&self, mem: Memory) -> io::Result<()> {
        *self.0.memory.lock().unwrap_or_else(|e| e.into_inner()) = Some(mem);
        Ok(())
    }

    fn handle_event(
        &self,
        device_event: u16,
        evset: EventSet,
        vrings: &[VringRwLock],
        _thread_id: usize,
    ) -> io::Result<()> {
        if evset != EventSet::IN {
            return Err(io::Error::other("an event other than input"));
        }
        let vring = vrings
            .get(device_event as usize)
            .ok_or_else(|| io::Error::other("no such queue"))?;
        self.drain(vring)
    }
}

/// A machine's virtio-fs device, served until the machine is gone.
pub struct Serving {
    socket: PathBuf,
    connected: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    workers: Vec<JoinHandle<()>>,
    inner: Arc<Inner>,
}

impl Serving {
    /// Starts serving `fs` (its files' modes in `modes`) on a socket at
    /// `socket`, which exists before this returns, so QEMU can be started
    /// at once.
    /// Every file is shown as owned by `owner` (uid, gid).
    pub fn start(
        fs: DynFs,
        modes: Modes,
        owner: (u32, u32),
        socket: &Path,
    ) -> Result<Serving, String> {
        Self::with_server(Server::new(fs, modes).owned_by(owner.0, owner.1), socket)
    }

    /// [`Serving::start`] for a file system the machine only reads
    /// ([`Server::read_only`]).
    pub fn start_read_only(
        fs: DynFs,
        modes: Modes,
        owner: (u32, u32),
        socket: &Path,
    ) -> Result<Serving, String> {
        Self::with_server(
            Server::read_only(fs, modes).owned_by(owner.0, owner.1),
            socket,
        )
    }

    fn with_server(server: Server, socket: &Path) -> Result<Serving, String> {
        let _ = std::fs::remove_file(socket);
        let mut listener =
            Listener::new(socket, true).map_err(|e| format!("virtio-fs socket: {e}"))?;
        let (sender, receiver) = mpsc::channel::<Work>();
        let inner = Arc::new(Inner {
            server: Arc::new(server),
            memory: Mutex::new(None),
            work: Mutex::new(Some(sender)),
        });
        let receiver = Arc::new(Mutex::new(receiver));
        let mut workers = Vec::new();
        for n in 0..WORKERS {
            let (inner, receiver) = (inner.clone(), receiver.clone());
            let worker = std::thread::Builder::new()
                .name(format!("iwci-virtiofs-{n}"))
                .spawn(move || {
                    loop {
                        let next = receiver.lock().unwrap_or_else(|e| e.into_inner()).recv();
                        let Ok(work) = next else { return };
                        answer(&inner.server, &inner.memory, work);
                    }
                })
                .map_err(|e| format!("virtio-fs worker: {e}"))?;
            workers.push(worker);
        }
        let backend = Backend(inner.clone());
        let mut daemon = VhostUserDaemon::new(
            "iwci-virtiofs".into(),
            backend,
            GuestMemoryAtomic::new(GuestMemoryMmap::new()),
        )
        .map_err(|e| format!("virtio-fs: {e}"))?;
        let connected = Arc::new(AtomicBool::new(false));
        let flag = connected.clone();
        let thread = std::thread::Builder::new()
            .name("iwci-virtiofs".into())
            .spawn(move || {
                if daemon.start(&mut listener).is_ok() {
                    flag.store(true, Ordering::SeqCst);
                    let _ = daemon.wait();
                }
                for handler in daemon.get_epoll_handlers() {
                    handler.send_exit_event();
                }
            })
            .map_err(|e| format!("virtio-fs: {e}"))?;
        Ok(Serving {
            socket: socket.to_path_buf(),
            connected,
            thread: Some(thread),
            workers,
            inner,
        })
    }
}

impl Drop for Serving {
    /// Called once the machine has stopped. A machine that never started
    /// never connected: a connection of our own ends the wait for it.
    fn drop(&mut self) {
        if !self.connected.load(Ordering::SeqCst) {
            let _ = UnixStream::connect(&self.socket);
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        // No more work: the workers end once what they hold is answered.
        self.inner
            .work
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
        if std::env::var_os("IWCI_VIRTIOFS_COUNTS").is_some() {
            eprintln!(
                "iwci: virtio-fs {}: requests by opcode {:?}",
                self.socket.display(),
                self.inner.server.counts()
            );
        }
        let _ = std::fs::remove_file(&self.socket);
    }
}
