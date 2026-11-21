//! The run's `/tmp/workflow` on every runner of a split run.
//!
//! Each runner keeps its own copy of the directory in memory, as a run on
//! one runner does. What a job writes there reaches the others as
//! *layers*, and every runner's jobs see every runner's files:
//!
//! - **A file is sent once it is closed.** Every job sees the directory
//!   through a [`ScratchView`], which notes each path it changes. A file is
//!   sent when nothing has it open for writing: when the job that wrote it
//!   ends, at the latest, and within a second while other runners run jobs
//!   of the pipeline. So a job sees a file another runner's job closed, as
//!   it would on one disk, and the record of a job says which of its
//!   runner's layers hold what it wrote: a job that needs it starts only
//!   once those are known here.
//! - **A layer is a list, then the files.** Its list (paths, sizes, where
//!   each file is) is read first, and each file shows in the directory from
//!   then on, with its size, before its bytes are here. They come in the
//!   background; opening a file that has not come yet waits for it alone
//!   and has it fetched next. A file of [`OWN_OBJECT`] bytes or more is an
//!   object of its own, smaller ones travel together, so opening one never
//!   waits for much else.
//! - **What may not leave stays.** A file a job that reads secrets (or was
//!   handed what one left) wrote, one that holds a secret's value, and one
//!   past what the run may send are listed as *withheld*: they show, and
//!   opening one fails. A helper whose job does that gives the job back to
//!   the primary, which has the file, so a run never fails because it was
//!   split. A helper never withholds: it has no secrets, and a job whose
//!   files would take it past what it may send is handed back instead.
//! - **A newer local write wins.** A path written here and not sent yet,
//!   or open for writing, is left as it is when another runner's layer
//!   names it. Two jobs that write one file at the same time on two
//!   runners end with one runner's copy each, as the README says of jobs
//!   that share the directory at the same time.

use super::*;
use std::collections::{BTreeSet, VecDeque};
use std::io::{self, SeekFrom};
use std::path::Path;
use std::pin::Pin;
use std::task::{Context, Poll};

use futures::future::BoxFuture;
use iwci_vfs::virtual_fs::{
    self, AsyncRead, AsyncSeek, AsyncWrite, DirEntry, FileOpener, FileSystem, FileType, FsError,
    Metadata, OpenOptions, OpenOptionsConfig, ReadBuf, ReadDir, VirtualFile,
};
use iwci_vfs::{DynFs, archive};

/// A file at least this large is an object of its own.
pub(super) const OWN_OBJECT: u64 = 1 << 20;
/// Smaller files travel together, about this much in one object.
const PACK: u64 = 4 << 20;
/// Objects of other runners' layers fetched at once.
pub(super) const SCRATCH_FETCHERS: usize = 4;
/// How often a wait for a file looks at the job's cancel and deadline.
const WAIT_STEP: Duration = Duration::from_millis(100);

/// One layer: what changed under `/tmp/workflow` on one runner, in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
pub struct Layer {
    pub entries: Vec<LayerEntry>,
}

/// A path in a [`Layer`], relative to nothing: these are the paths the
/// scratch file system has (`/shared.txt`), not the guest's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum LayerEntry {
    Dir {
        path: String,
    },
    /// A file whose bytes are in the runner's scratch object `object`.
    File {
        path: String,
        size: u64,
        object: String,
    },
    Symlink {
        path: String,
        target: String,
    },
    Deleted {
        path: String,
    },
    /// A file that stays on the runner that wrote it.
    Withheld {
        path: String,
        size: u64,
    },
}

/// Whether `name` is a runner's scratch object: `<layer>.list` for a
/// layer's list, `<layer>.<n>` for its files.
pub fn object_name(name: &str) -> bool {
    let mut parts = name.splitn(2, '.');
    let layer = parts.next().unwrap_or("");
    let rest = parts.next().unwrap_or("");
    !layer.is_empty()
        && layer.len() <= 20
        && layer.bytes().all(|b| b.is_ascii_digit())
        && (rest == "list"
            || (!rest.is_empty() && rest.len() <= 20 && rest.bytes().all(|b| b.is_ascii_digit())))
}

/// How [`Scratch::publish`] went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Published {
    /// Nothing was waiting to be sent.
    Nothing,
    /// This runner's layers up to this one hold everything closed so far.
    Layer(u64),
    /// A helper's files would take it past what it may send: none of
    /// them is sent, and the jobs that wrote them are handed back.
    TooMuch,
    /// The store did not take it; the paths are sent next time.
    Failed(String),
}

/// One run's `/tmp/workflow` on this runner. Cheap to clone.
#[derive(Debug, Clone)]
pub struct Scratch(Arc<Shared>);

#[derive(Debug)]
struct Shared {
    fs: JobFs,
    /// Whether the run is split: only then are writes followed.
    split: bool,
    state: Mutex<State>,
    changed: Condvar,
    /// One layer written at a time, so their numbers follow their order.
    publishing: Mutex<()>,
}

#[derive(Debug, Default)]
struct State {
    /// Files another runner has whose bytes are not here, or never will
    /// be.
    pending: BTreeMap<PathBuf, Pending>,
    /// Paths written here and not sent yet, and whether a job that may
    /// not send what it writes wrote one of them.
    dirty: BTreeMap<PathBuf, bool>,
    /// Paths open for writing here now, and how many times.
    writers: HashMap<PathBuf, usize>,
    /// This runner's layers so far.
    layers: u64,
    /// Bytes of files this runner has sent.
    sent: u64,
    /// The last layer of each other runner taken in here.
    applied: HashMap<String, u64>,
    /// Objects to fetch, the one a job waits for first.
    queue: VecDeque<Object>,
    queued: BTreeSet<Object>,
    /// The run is over: nothing more is fetched or waited for.
    stopped: bool,
    /// Writes were dropped unsent ([`Scratch::forget_unsent`]).
    spoiled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct Object {
    runner: String,
    name: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Pending {
    Coming {
        object: Object,
        size: u64,
    },
    /// It stays on `runner`, or could not be kept here.
    Withheld {
        runner: String,
        size: u64,
        why: String,
    },
}

impl Pending {
    fn size(&self) -> u64 {
        match self {
            Pending::Coming { size, .. } | Pending::Withheld { size, .. } => *size,
        }
    }
}

fn file_meta(size: u64) -> Metadata {
    Metadata {
        ft: FileType::new_file(),
        len: size,
        ..Metadata::default()
    }
}

fn layer_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

impl Scratch {
    /// The directory over `fs`. Writes are only followed when `split`.
    pub fn new(fs: JobFs, split: bool) -> Self {
        Self(Arc::new(Shared {
            fs,
            split,
            state: Mutex::default(),
            changed: Condvar::new(),
            publishing: Mutex::new(()),
        }))
    }

    /// The files this runner has now, without what is still coming.
    pub fn fs(&self) -> &JobFs {
        &self.0.fs
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.0.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The directory as one job sees it. `tainted` for a job whose files
    /// may not leave the runner: it reads secrets, or was handed what a
    /// job that does left. A wait for a file ends with `cancel` and at
    /// `deadline`.
    pub fn view(
        &self,
        tainted: bool,
        cancel: Option<iwci_runtime::Cancel>,
        deadline: Option<Instant>,
    ) -> ScratchView {
        ScratchView(Arc::new(ViewFs {
            scratch: self.clone(),
            tainted,
            withheld: Mutex::default(),
            cancel,
            deadline,
        }))
    }

    /// This runner's layers so far.
    pub fn layers(&self) -> u64 {
        self.lock().layers
    }

    /// The run is over: fetchers stop and waits end.
    pub(super) fn stop(&self) {
        self.lock().stopped = true;
        self.0.changed.notify_all();
    }

    fn touched(&self, path: &Path, tainted: bool) {
        if !self.0.split {
            return;
        }
        let mut s = self.lock();
        let entry = s.dirty.entry(path.to_path_buf()).or_insert(false);
        *entry |= tainted;
    }

    fn pending(&self, path: &Path) -> Option<Pending> {
        if !self.0.split {
            return None;
        }
        self.lock().pending.get(path).cloned()
    }

    /// Whether anything at or under `path` is still another runner's.
    fn pending_under(&self, path: &Path) -> bool {
        self.0.split
            && self
                .lock()
                .pending
                .range(path.to_path_buf()..)
                .next()
                .is_some_and(|(p, _)| p.starts_with(path))
    }

    /// Forgets what was coming for `path` and under it: this runner
    /// replaces it.
    fn drop_pending(&self, path: &Path) {
        if !self.0.split {
            return;
        }
        let mut s = self.lock();
        let gone: Vec<PathBuf> = s
            .pending
            .range(path.to_path_buf()..)
            .take_while(|(p, _)| p.starts_with(path))
            .map(|(p, _)| p.clone())
            .collect();
        for p in gone {
            s.pending.remove(&p);
        }
    }

    /// Waits until every file at or under `path` is here. Withheld is
    /// an error naming why.
    fn arrive(&self, path: &Path, view: &ViewFs) -> Result<(), FsError> {
        if !self.0.split {
            return Ok(());
        }
        let mut s = self.lock();
        loop {
            let first = s
                .pending
                .range(path.to_path_buf()..)
                .take_while(|(p, _)| p.starts_with(path))
                .map(|(p, pending)| (p.clone(), pending.clone()))
                .next();
            match first {
                None => return Ok(()),
                Some((p, Pending::Withheld { runner, why, .. })) => {
                    view.withhold(&p, &runner, &why);
                    return Err(FsError::PermissionDenied);
                }
                Some((_, Pending::Coming { object, .. })) => {
                    if s.stopped || view.given_up() {
                        return Err(FsError::Interrupted);
                    }
                    // Fetched next.
                    if s.queued.contains(&object) {
                        s.queue.retain(|o| *o != object);
                        s.queue.push_front(object);
                        self.0.changed.notify_all();
                    }
                    s = self
                        .0
                        .changed
                        .wait_timeout(s, WAIT_STEP)
                        .unwrap_or_else(|e| e.into_inner())
                        .0;
                }
            }
        }
    }

    /// Waits until every file another runner sent is here, for a job that
    /// is given a copy of the directory (a machine). What is withheld is
    /// left out of the copy.
    pub fn settle(&self, cancelled: &dyn Fn() -> bool) -> Result<(), String> {
        if !self.0.split {
            return Ok(());
        }
        let mut s = self.lock();
        loop {
            let coming = s
                .pending
                .values()
                .filter(|p| matches!(p, Pending::Coming { .. }))
                .count();
            if coming == 0 {
                return Ok(());
            }
            if s.stopped || cancelled() {
                return Err(format!(
                    "{coming} file(s) another runner wrote to /tmp/workflow had not come"
                ));
            }
            s = self
                .0
                .changed
                .wait_timeout(s, WAIT_STEP)
                .unwrap_or_else(|e| e.into_inner())
                .0;
        }
    }

    /// Sends what was written here and is closed now as a new layer.
    /// `cap` is the most this runner may send in all; past it, the
    /// primary withholds files and a helper sends none
    /// ([`Published::TooMuch`]).
    pub(super) fn publish(&self, split: &dyn Split, mask: &Masker, cap: u64) -> Published {
        if !self.0.split {
            return Published::Nothing;
        }
        let _one = self.0.publishing.lock().unwrap_or_else(|e| e.into_inner());
        let helper = split.helper();
        let (taken, layer, sent) = {
            let mut s = self.lock();
            let ready: Vec<PathBuf> = s
                .dirty
                .keys()
                .filter(|p| !s.writers.contains_key(*p))
                .cloned()
                .collect();
            let taken: BTreeMap<PathBuf, bool> = ready
                .into_iter()
                .filter_map(|p| s.dirty.remove(&p).map(|t| (p, t)))
                .collect();
            (taken, s.layers + 1, s.sent)
        };
        if taken.is_empty() {
            return Published::Nothing;
        }
        let fs = self.0.fs.as_dyn();
        let mut entries: Vec<LayerEntry> = Vec::new();
        let mut files: Vec<(PathBuf, shared_buffer::OwnedBuffer)> = Vec::new();
        let mut listed: HashSet<PathBuf> = HashSet::new();
        let mut bytes = 0u64;
        let mut too_much = false;
        for (path, tainted) in &taken {
            if fs.symlink_metadata(path).is_err() {
                if listed.insert(path.clone()) {
                    entries.push(LayerEntry::Deleted {
                        path: layer_path(path),
                    });
                }
                continue;
            }
            for entry in self.0.fs.entries_under(&[path]) {
                let entry_path = match &entry {
                    Entry::Dir { path }
                    | Entry::File { path, .. }
                    | Entry::Symlink { path, .. } => path.clone(),
                };
                if entry_path == Path::new("/") || !listed.insert(entry_path.clone()) {
                    continue;
                }
                match entry {
                    Entry::Dir { path } => entries.push(LayerEntry::Dir {
                        path: layer_path(&path),
                    }),
                    Entry::Symlink { path, target } => entries.push(LayerEntry::Symlink {
                        path: layer_path(&path),
                        target: layer_path(&target),
                    }),
                    Entry::File { path, data } => {
                        let size = data.len() as u64;
                        let over = sent + bytes + size > cap;
                        let secret = *tainted || mask.finds(&data);
                        if helper && over {
                            too_much = true;
                        }
                        if helper || !(over || secret) {
                            bytes += size;
                            files.push((path, data));
                        } else {
                            entries.push(LayerEntry::Withheld {
                                path: layer_path(&path),
                                size,
                            });
                        }
                    }
                }
            }
        }
        if too_much {
            // Nothing is sent: the job ending now is handed back, and
            // [`Scratch::forget_unsent`] drops what it wrote.
            let mut s = self.lock();
            for (path, tainted) in taken {
                let entry = s.dirty.entry(path).or_insert(false);
                *entry |= tainted;
            }
            return Published::TooMuch;
        }
        // Objects: a large file alone, smaller ones together.
        let mut objects: Vec<Vec<Entry>> = Vec::new();
        let mut pack: Vec<Entry> = Vec::new();
        let mut pack_bytes = 0u64;
        for (path, data) in files {
            let size = data.len() as u64;
            if size >= OWN_OBJECT {
                if !pack.is_empty() {
                    objects.push(std::mem::take(&mut pack));
                    pack_bytes = 0;
                }
                entries.push(LayerEntry::File {
                    path: layer_path(&path),
                    size,
                    object: format!("{layer}.{}", objects.len()),
                });
                objects.push(vec![Entry::File { path, data }]);
                continue;
            }
            if pack_bytes + size > PACK && !pack.is_empty() {
                objects.push(std::mem::take(&mut pack));
                pack_bytes = 0;
            }
            entries.push(LayerEntry::File {
                path: layer_path(&path),
                size,
                object: format!("{layer}.{}", objects.len()),
            });
            pack_bytes += size;
            pack.push(Entry::File { path, data });
        }
        if !pack.is_empty() {
            objects.push(pack);
        }
        let written = (|| -> Result<(), String> {
            for (n, object) in objects.iter().enumerate() {
                let bytes = encode(object)?;
                split.put_scratch(&format!("{layer}.{n}"), &bytes)?;
            }
            let list = serde_json::to_vec(&Layer { entries }).map_err(|e| e.to_string())?;
            split.put_scratch(&format!("{layer}.list"), &list)?;
            split.scratch_layer(layer)
        })();
        let mut s = self.lock();
        match written {
            Ok(()) => {
                s.layers = layer;
                s.sent += bytes;
                Published::Layer(layer)
            }
            Err(e) => {
                // Sent next time, unless written again since.
                for (path, tainted) in taken {
                    let entry = s.dirty.entry(path).or_insert(false);
                    *entry |= tainted;
                }
                Published::Failed(e)
            }
        }
    }

    /// Forgets what is waiting to be sent, when a helper may send no
    /// more. Every helper job that ends from then on is handed back
    /// ([`Scratch::spoiled`]): what it wrote may be among what was
    /// dropped.
    pub(super) fn forget_unsent(&self) {
        let mut s = self.lock();
        s.dirty.clear();
        s.spoiled = true;
    }

    /// Whether [`Scratch::forget_unsent`] dropped anything.
    pub(super) fn spoiled(&self) -> bool {
        self.lock().spoiled
    }

    /// Takes in `runner`'s layers up to `upto`: their files show here from
    /// now on, and come in the background.
    pub(super) fn catch_up(
        &self,
        split: &dyn Split,
        runner: &str,
        upto: u64,
    ) -> Result<(), String> {
        if !self.0.split || runner == split.runner() {
            return Ok(());
        }
        loop {
            let next = self.lock().applied.get(runner).copied().unwrap_or(0) + 1;
            if next > upto {
                return Ok(());
            }
            let list = split
                .get_scratch(runner, &format!("{next}.list"))?
                .ok_or_else(|| format!("layer {next} of `{runner}` is not there yet"))?;
            let layer: Layer = serde_json::from_slice(&list)
                .map_err(|e| format!("layer {next} of `{runner}` does not read: {e}"))?;
            self.apply(runner, next, layer)?;
        }
    }

    fn apply(&self, runner: &str, number: u64, layer: Layer) -> Result<(), String> {
        let fs = &self.0.fs;
        let mut s = self.lock();
        if s.applied.get(runner).copied().unwrap_or(0) + 1 != number {
            // Another thread took it in first.
            return Ok(());
        }
        for entry in layer.entries {
            let path = match &entry {
                LayerEntry::Dir { path }
                | LayerEntry::File { path, .. }
                | LayerEntry::Symlink { path, .. }
                | LayerEntry::Deleted { path }
                | LayerEntry::Withheld { path, .. } => iwci_vfs::normalise(path)
                    .map_err(|e| format!("layer {number} of `{runner}`: {e}"))?,
            };
            if path == Path::new("/") {
                continue;
            }
            // Written here since: this runner's copy is the newer one.
            if s.dirty.contains_key(&path) || s.writers.contains_key(&path) {
                continue;
            }
            let parent = |s: &mut State| {
                if let Some(parent) = path.parent() {
                    let _ = fs.apply(&[Entry::Dir {
                        path: parent.to_path_buf(),
                    }]);
                    s.pending.remove(parent);
                }
            };
            match entry {
                LayerEntry::Dir { .. } => {
                    s.pending.remove(&path);
                    if fs
                        .as_dyn()
                        .symlink_metadata(&path)
                        .is_ok_and(|m| !m.is_dir())
                    {
                        remove_all(fs, &path);
                    }
                    let _ = fs.apply(&[Entry::Dir { path }]);
                }
                LayerEntry::File { size, object, .. } => {
                    if !object_name(&object) {
                        return Err(format!("layer {number} of `{runner}` names a bad object"));
                    }
                    parent(&mut s);
                    // A directory there is replaced by the file.
                    if fs
                        .as_dyn()
                        .symlink_metadata(&path)
                        .is_ok_and(|m| m.is_dir())
                    {
                        remove_all(fs, &path);
                    }
                    let object = Object {
                        runner: runner.to_string(),
                        name: object,
                    };
                    if s.queued.insert(object.clone()) {
                        s.queue.push_back(object.clone());
                    }
                    s.pending.insert(path, Pending::Coming { object, size });
                }
                LayerEntry::Symlink { target, .. } => {
                    parent(&mut s);
                    s.pending.remove(&path);
                    let _ = fs.apply(&[Entry::Symlink {
                        path,
                        target: PathBuf::from(target),
                    }]);
                }
                LayerEntry::Deleted { .. } => {
                    let gone: Vec<PathBuf> = s
                        .pending
                        .range(path.clone()..)
                        .take_while(|(p, _)| p.starts_with(&path))
                        .map(|(p, _)| p.clone())
                        .collect();
                    for p in gone {
                        s.pending.remove(&p);
                    }
                    remove_all(fs, &path);
                }
                LayerEntry::Withheld { size, .. } => {
                    parent(&mut s);
                    s.pending.insert(
                        path,
                        Pending::Withheld {
                            runner: runner.to_string(),
                            size,
                            why: format!("it stays on `{runner}`"),
                        },
                    );
                }
            }
        }
        s.applied.insert(runner.to_string(), number);
        drop(s);
        self.0.changed.notify_all();
        Ok(())
    }

    /// Fetches other runners' files until the run is over, the one a job
    /// waits for first. A file that does not fit the run's `scratch:` is
    /// withheld from then on.
    pub(super) fn fetch(&self, split: &dyn Split, max_bytes: u64) {
        loop {
            let object = {
                let mut s = self.lock();
                loop {
                    if s.stopped {
                        return;
                    }
                    if let Some(object) = s.queue.pop_front() {
                        break object;
                    }
                    s = self
                        .0
                        .changed
                        .wait_timeout(s, WAIT_STEP)
                        .unwrap_or_else(|e| e.into_inner())
                        .0;
                }
            };
            let mut wait = Duration::from_millis(50);
            let entries = loop {
                let got = split
                    .get_scratch(&object.runner, &object.name)
                    .and_then(|b| b.ok_or_else(|| "not there".to_string()))
                    .and_then(|b| decode(&b, max_bytes));
                match got {
                    Ok(entries) => break entries,
                    Err(_) => {
                        if self.lock().stopped {
                            return;
                        }
                        std::thread::sleep(wait);
                        wait = (wait * 2).min(Duration::from_secs(1));
                    }
                }
            };
            let mut s = self.lock();
            s.queued.remove(&object);
            for entry in entries {
                let Entry::File { path, data } = entry else {
                    continue;
                };
                let Ok(path) = iwci_vfs::normalise(&path) else {
                    continue;
                };
                let ours = matches!(
                    s.pending.get(&path),
                    Some(Pending::Coming { object: o, .. }) if *o == object
                );
                if !ours {
                    continue;
                }
                let size = data.len() as u64;
                match self.0.fs.apply(&[Entry::File {
                    path: path.clone(),
                    data,
                }]) {
                    Ok(()) => {
                        s.pending.remove(&path);
                    }
                    Err(e) => {
                        s.pending.insert(
                            path,
                            Pending::Withheld {
                                runner: object.runner.clone(),
                                size,
                                why: format!("it did not fit here: {e}"),
                            },
                        );
                    }
                }
            }
            drop(s);
            self.0.changed.notify_all();
        }
    }
}

fn encode(entries: &[Entry]) -> Result<Vec<u8>, String> {
    let mut encoder = zstd::stream::Encoder::new(Vec::new(), 1).map_err(|e| e.to_string())?;
    encoder.include_checksum(true).map_err(|e| e.to_string())?;
    archive::encode(&mut encoder, entries).map_err(|e| e.to_string())?;
    encoder.finish().map_err(|e| e.to_string())
}

fn decode(bytes: &[u8], max_bytes: u64) -> Result<Vec<Entry>, String> {
    let mut decoder = zstd::stream::Decoder::new(bytes).map_err(|e| e.to_string())?;
    archive::decode(&mut decoder, max_bytes).map_err(|e| e.to_string())
}

/// Removes `path` and everything under it, children first.
fn remove_all(fs: &JobFs, path: &Path) {
    let mut entries = fs.entries_under(&[path]);
    entries.reverse();
    for entry in entries {
        let _ = match entry {
            Entry::Dir { path } => fs.remove_dir(path),
            Entry::File { path, .. } | Entry::Symlink { path, .. } => fs.remove_file(path),
        };
    }
}

/// The run's `/tmp/workflow` as one job sees it: the files every runner
/// of the run has, the ones still coming included. Cheap to clone.
#[derive(Debug, Clone)]
pub struct ScratchView(Arc<ViewFs>);

#[derive(Debug)]
struct ViewFs {
    scratch: Scratch,
    tainted: bool,
    /// The first withheld file the job tried to read, and why it could
    /// not.
    withheld: Mutex<Option<String>>,
    cancel: Option<iwci_runtime::Cancel>,
    deadline: Option<Instant>,
}

impl ScratchView {
    /// What the guest is given.
    pub fn as_dyn(&self) -> DynFs {
        if self.0.scratch.0.split {
            self.0.clone()
        } else {
            self.0.scratch.0.fs.as_dyn()
        }
    }

    /// The files this runner has now.
    pub fn fs(&self) -> &JobFs {
        self.0.scratch.fs()
    }

    pub fn read(&self, path: impl AsRef<Path>) -> iwci_vfs::Result<Vec<u8>> {
        iwci_vfs::read_file(self.as_dyn().as_ref(), path)
    }

    pub fn write(&self, path: impl AsRef<Path>, bytes: &[u8]) -> iwci_vfs::Result<()> {
        iwci_vfs::write_file(self.as_dyn().as_ref(), path, bytes)
    }

    /// Waits until every file another runner sent is here: a machine is
    /// given a copy of the directory.
    pub fn settle(&self) -> Result<(), String> {
        let view = &self.0;
        self.0.scratch.settle(&|| view.given_up())
    }

    /// Notes paths the runner wrote for the job (what a machine sent
    /// back), as the job's own writes.
    pub fn wrote<'p>(&self, paths: impl IntoIterator<Item = &'p Path>) {
        for path in paths {
            self.0.scratch.drop_pending(path);
            self.0.scratch.touched(path, self.0.tainted);
        }
    }

    /// Why the job could not read a file another runner kept, if it tried.
    pub fn withheld(&self) -> Option<String> {
        self.0
            .withheld
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
}

impl ViewFs {
    fn inner(&self) -> DynFs {
        self.scratch.0.fs.as_dyn()
    }

    fn given_up(&self) -> bool {
        self.cancel.as_ref().is_some_and(|c| c.is_cancelled())
            || self.deadline.is_some_and(|d| Instant::now() >= d)
    }

    fn withhold(&self, path: &Path, runner: &str, why: &str) {
        let mut first = self.withheld.lock().unwrap_or_else(|e| e.into_inner());
        if first.is_none() {
            *first = Some(format!(
                "/tmp/workflow{} is on `{runner}` only ({why})",
                path.display()
            ));
        }
    }

    fn touched(&self, path: &Path) {
        self.scratch.touched(path, self.tainted);
    }
}

impl FileSystem for ViewFs {
    fn readlink(&self, path: &Path) -> virtual_fs::Result<PathBuf> {
        if self.scratch.pending(path).is_some() {
            return Err(FsError::InvalidInput);
        }
        self.inner().readlink(path)
    }

    fn read_dir(&self, path: &Path) -> virtual_fs::Result<ReadDir> {
        let listed = self.inner().read_dir(path)?;
        let coming: Vec<(PathBuf, u64)> = {
            let s = self.scratch.lock();
            s.pending
                .range(path.to_path_buf()..)
                .take_while(|(p, _)| p.starts_with(path))
                .filter(|(p, _)| p.parent() == Some(path))
                .map(|(p, pending)| (p.clone(), pending.size()))
                .collect()
        };
        if coming.is_empty() {
            return Ok(listed);
        }
        let names: HashSet<&PathBuf> = coming.iter().map(|(p, _)| p).collect();
        let mut data: Vec<DirEntry> = listed
            .filter_map(Result::ok)
            .filter(|e| !names.contains(&e.path))
            .collect();
        data.extend(coming.into_iter().map(|(path, size)| DirEntry {
            path,
            metadata: Ok(file_meta(size)),
        }));
        Ok(ReadDir::new(data))
    }

    fn create_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        if self.scratch.pending(path).is_some() {
            return Err(FsError::AlreadyExists);
        }
        self.inner().create_dir(path)?;
        self.touched(path);
        Ok(())
    }

    fn create_symlink(&self, source: &Path, target: &Path) -> virtual_fs::Result<()> {
        if self.scratch.pending(target).is_some() {
            return Err(FsError::AlreadyExists);
        }
        self.inner().create_symlink(source, target)?;
        self.touched(target);
        Ok(())
    }

    fn hard_link(&self, source: &Path, target: &Path) -> virtual_fs::Result<()> {
        self.scratch.arrive(source, self)?;
        if self.scratch.pending(target).is_some() {
            return Err(FsError::AlreadyExists);
        }
        self.inner().hard_link(source, target)?;
        self.touched(target);
        Ok(())
    }

    fn remove_dir(&self, path: &Path) -> virtual_fs::Result<()> {
        if self.scratch.pending_under(path) {
            return Err(FsError::DirectoryNotEmpty);
        }
        self.inner().remove_dir(path)?;
        self.touched(path);
        Ok(())
    }

    fn rename<'a>(&'a self, from: &'a Path, to: &'a Path) -> BoxFuture<'a, virtual_fs::Result<()>> {
        Box::pin(async move {
            self.scratch.arrive(from, self)?;
            self.inner().rename(from, to).await?;
            self.scratch.drop_pending(to);
            self.touched(from);
            self.touched(to);
            Ok(())
        })
    }

    fn metadata(&self, path: &Path) -> virtual_fs::Result<Metadata> {
        match self.scratch.pending(path) {
            Some(pending) => Ok(file_meta(pending.size())),
            None => self.inner().metadata(path),
        }
    }

    fn symlink_metadata(&self, path: &Path) -> virtual_fs::Result<Metadata> {
        match self.scratch.pending(path) {
            Some(pending) => Ok(file_meta(pending.size())),
            None => self.inner().symlink_metadata(path),
        }
    }

    fn remove_file(&self, path: &Path) -> virtual_fs::Result<()> {
        let had = self.scratch.pending(path).is_some();
        self.scratch.drop_pending(path);
        let removed = self.inner().remove_file(path);
        self.touched(path);
        match removed {
            Err(FsError::EntryNotFound) if had => Ok(()),
            other => other,
        }
    }

    fn new_open_options(&self) -> OpenOptions<'_> {
        OpenOptions::new(self)
    }
}

impl FileOpener for ViewFs {
    fn open(
        &self,
        path: &Path,
        conf: &OpenOptionsConfig,
    ) -> virtual_fs::Result<Box<dyn VirtualFile + Send + Sync + 'static>> {
        let writes = conf.write || conf.append || conf.truncate || conf.create || conf.create_new;
        if let Some(pending) = self.scratch.pending(path) {
            if conf.create_new {
                return Err(FsError::AlreadyExists);
            }
            if conf.truncate && !conf.read && !matches!(pending, Pending::Withheld { .. }) {
                // Replaced whole: what was coming is not needed.
                self.scratch.drop_pending(path);
            } else {
                self.scratch.arrive(path, self)?;
            }
        }
        let file = self
            .inner()
            .new_open_options()
            .options(conf.clone())
            .open(path)?;
        if !writes || !self.scratch.0.split {
            return Ok(file);
        }
        {
            let mut s = self.scratch.lock();
            *s.writers.entry(path.to_path_buf()).or_insert(0) += 1;
            let entry = s.dirty.entry(path.to_path_buf()).or_insert(false);
            *entry |= self.tainted;
        }
        Ok(Box::new(Writing {
            file,
            path: path.to_path_buf(),
            scratch: self.scratch.clone(),
            tainted: self.tainted,
        }))
    }
}

/// A scratch file open for writing: it is not sent until it is closed.
#[derive(Debug)]
struct Writing {
    file: Box<dyn VirtualFile + Send + Sync + 'static>,
    path: PathBuf,
    scratch: Scratch,
    tainted: bool,
}

impl Drop for Writing {
    fn drop(&mut self) {
        let mut s = self.scratch.lock();
        if let Some(n) = s.writers.get_mut(&self.path) {
            *n -= 1;
            if *n == 0 {
                s.writers.remove(&self.path);
            }
        }
        let entry = s.dirty.entry(self.path.clone()).or_insert(false);
        *entry |= self.tainted;
    }
}

impl AsyncWrite for Writing {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.file).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.file).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.file).poll_shutdown(cx)
    }
}

impl AsyncRead for Writing {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        Pin::new(&mut self.file).poll_read(cx, buf)
    }
}

impl AsyncSeek for Writing {
    fn start_seek(mut self: Pin<&mut Self>, position: SeekFrom) -> io::Result<()> {
        Pin::new(&mut self.file).start_seek(position)
    }

    fn poll_complete(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<u64>> {
        Pin::new(&mut self.file).poll_complete(cx)
    }
}

impl VirtualFile for Writing {
    fn last_accessed(&self) -> u64 {
        self.file.last_accessed()
    }
    fn last_modified(&self) -> u64 {
        self.file.last_modified()
    }
    fn created_time(&self) -> u64 {
        self.file.created_time()
    }
    fn set_times(&mut self, atime: Option<u64>, mtime: Option<u64>) -> virtual_fs::Result<()> {
        self.file.set_times(atime, mtime)
    }
    fn size(&self) -> u64 {
        self.file.size()
    }
    fn set_len(&mut self, new_size: u64) -> virtual_fs::Result<()> {
        self.file.set_len(new_size)
    }
    fn unlink(&mut self) -> virtual_fs::Result<()> {
        self.file.unlink()
    }
    fn is_open(&self) -> bool {
        self.file.is_open()
    }
    fn get_special_fd(&self) -> Option<u32> {
        self.file.get_special_fd()
    }
    fn write_from_mmap(&mut self, offset: u64, len: u64) -> io::Result<()> {
        self.file.write_from_mmap(offset, len)
    }
    fn copy_reference(
        &mut self,
        src: Box<dyn VirtualFile + Send + Sync + 'static>,
    ) -> BoxFuture<'_, io::Result<()>> {
        self.file.copy_reference(src)
    }
    fn copy_from_owned_buffer(
        &mut self,
        src: &shared_buffer::OwnedBuffer,
    ) -> BoxFuture<'_, io::Result<()>> {
        self.file.copy_from_owned_buffer(src)
    }
    fn as_owned_buffer(&self) -> Option<shared_buffer::OwnedBuffer> {
        self.file.as_owned_buffer()
    }
    fn poll_read_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Pin::new(&mut *self.file).poll_read_ready(cx)
    }
    fn poll_write_ready(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<usize>> {
        Pin::new(&mut *self.file).poll_write_ready(cx)
    }
}

#[cfg(test)]
#[path = "schedule_scratch_tests.rs"]
mod tests;
