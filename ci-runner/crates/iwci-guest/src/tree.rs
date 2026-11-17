//! The job's file tree in the machine: where its paths are, writing what
//! the runner puts, and telling what the job changed.

use std::collections::BTreeMap;
use std::fs::{self, Metadata};
use std::io::{self, Read};
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use crate::plan::{Before, NoMarkers, Origin, Plan, Planner, Probe};
use crate::put::{Extracted, extract};
use crate::root::Root;
use crate::stamp::{Stamp, kind_of, nanos};

/// Where the agent writes the job's scripts.
pub const RUN_DIR: &str = "/iwci/run";
/// The agent's own paths (the scripts; on Windows also its binary and the
/// image's name): never collected. The rest of `/iwci` is the runner's:
/// `$IWCI_OUTPUT` is `/iwci/output`, and comes back like any job file.
pub const AGENT_PATHS: [&str; 3] = [RUN_DIR, "/iwci/bin", "/iwci/image"];

/// A job's file tree, as [`serve`](crate::serve) uses it.
pub trait Tree: Send {
    /// Where the job's Unix path `unix` is on this machine, as the job's
    /// processes see it.
    fn path(&self, unix: &str) -> PathBuf;
    /// The mapping [`Tree::path`] uses, which also turns link targets
    /// between the job's form and the machine's.
    fn job_root(&self) -> &Root;
    /// Writes a tar archive into the tree and remembers what it wrote.
    fn put(&mut self, archive: &mut dyn Read) -> io::Result<Extracted>;
    /// Remembers the current state of paths the agent wrote itself (the
    /// machine's `/etc/hostname`), so a collect does not take them for
    /// the job's.
    fn track(&mut self, paths: &[String]);
    /// What a collect of `paths` (checked by
    /// [`requested`](crate::plan::requested)) sends, and of `repository`
    /// without what git ignores in it.
    fn plan(&self, paths: &[String], repository: Option<&str>) -> io::Result<Plan>;
    /// Whether collected entries carry real Unix modes.
    fn modes(&self) -> bool {
        cfg!(unix)
    }
}

/// How long before the moment a [`Manifest`] tree started that a change
/// still counts as the job's: file systems stamp times from a clock coarser
/// than the one the agent reads.
const CLOCK_SLACK: Duration = Duration::from_secs(2);

/// A portable tree: the machine's own file system under a [`Root`], with
/// a manifest of every path [`Tree::put`] wrote (Windows, and tests and
/// local debugging everywhere).
///
/// A path the manifest has is judged against its stamp. One it does not
/// have (a file the job made, or one the machine had before the job, such
/// as a Windows system file) counts as new when its change time is at or
/// after the moment the first `Put` began (less [`CLOCK_SLACK`]), and as
/// unchanged otherwise. So a file the job made is always sent, and the
/// machine's own files are sent only if something changed them during the
/// job. A file the machine had before the job and the job deleted is not
/// reported deleted: nothing remembers it.
pub struct Manifest {
    root: Root,
    tracked: BTreeMap<String, Stamp>,
    baseline_ns: i128,
    put_seen: bool,
}

impl Manifest {
    pub fn new(root: Root) -> Manifest {
        Manifest {
            root,
            tracked: BTreeMap::new(),
            baseline_ns: baseline_now(),
            put_seen: false,
        }
    }

    /// The paths the manifest holds, with their stamps.
    pub fn tracked(&self) -> &BTreeMap<String, Stamp> {
        &self.tracked
    }

    fn record(&mut self, unix: &str) {
        if let Ok(stamp) = Stamp::read(&self.root.native(unix)) {
            self.tracked.insert(unix.to_owned(), stamp);
        }
    }
}

fn baseline_now() -> i128 {
    nanos(SystemTime::now()) - CLOCK_SLACK.as_nanos() as i128
}

struct Since(i128);

impl Origin for Since {
    fn before(&self, _unix: &str, now: &Stamp) -> Before {
        if now.change_ns >= self.0 {
            Before::Absent
        } else {
            Before::Unchanged
        }
    }
    fn existed(&self, _unix: &str) -> bool {
        false
    }
}

impl Tree for Manifest {
    fn path(&self, unix: &str) -> PathBuf {
        self.root.native(unix)
    }

    fn job_root(&self) -> &Root {
        &self.root
    }

    fn put(&mut self, archive: &mut dyn Read) -> io::Result<Extracted> {
        if !self.put_seen {
            // `Setup` may have just set the clock: the baseline is now.
            self.put_seen = true;
            self.baseline_ns = baseline_now();
        }
        let extracted = extract(archive, &self.root, &[])?;
        for unix in &extracted.written {
            self.record(unix);
        }
        Ok(extracted)
    }

    fn track(&mut self, paths: &[String]) {
        for unix in paths {
            self.record(unix);
        }
    }

    fn plan(&self, paths: &[String], repository: Option<&str>) -> io::Result<Plan> {
        Planner {
            view: &self.root,
            job: &self.root,
            tracked: &self.tracked,
            origin: &Since(self.baseline_ns),
            probe: &NoMarkers,
            skip: &AGENT_PATHS,
        }
        .plan(paths, repository)
    }
}

/// Where the Linux init puts the job's overlay upper directory.
pub const OVERLAY_UPPER: &str = "/.iwci/rw/upper";
/// The overlay's lower layers as the init binds them into the job's root,
/// top first: the workspace image, then the machine image.
pub const OVERLAY_LOWERS: [&str; 2] = ["/.iwci/ws", "/.iwci/base"];

/// The Linux tree: the job's root is an overlay file system whose upper
/// directory holds exactly what changed since the machine started, so a
/// collect walks only that.
///
/// In the upper directory a character device numbered 0/0 is a whiteout
/// (the path was deleted) and a directory with `trusted.overlay.opaque` set
/// to `y` was deleted and made again. Entries are judged against what
/// `Put` wrote (stamps read from the upper directory right after writing)
/// and otherwise against the lower layers: a file or link in the upper
/// directory over the same in a lower one was written; a directory over a
/// directory is sent only if its mode changed.
pub struct Overlay {
    root: Root,
    upper: Root,
    lowers: Vec<PathBuf>,
    tracked: BTreeMap<String, Stamp>,
    probe: Box<dyn Probe + Send>,
}

/// Never looked at or written by a job: the agent's own mounts and scripts.
const OVERLAY_SKIP: [&str; 4] = ["/.iwci", AGENT_PATHS[0], AGENT_PATHS[1], AGENT_PATHS[2]];

impl Overlay {
    /// The tree inside the Linux machine (see the init in `main.rs`).
    #[cfg(target_os = "linux")]
    pub fn linux() -> Overlay {
        Overlay::new(
            Root::Dir(PathBuf::from("/")),
            PathBuf::from(OVERLAY_UPPER),
            OVERLAY_LOWERS.iter().map(PathBuf::from).collect(),
            Box::new(OverlayMarkers),
        )
    }

    /// A tree whose job paths are under `root`, with its overlay's upper
    /// directory at `upper` and lower layers `lowers` (top first). `probe`
    /// recognises the markers; tests pass their own.
    pub fn new(
        root: Root,
        upper: PathBuf,
        lowers: Vec<PathBuf>,
        probe: Box<dyn Probe + Send>,
    ) -> Overlay {
        Overlay {
            root,
            upper: Root::Dir(upper),
            lowers,
            tracked: BTreeMap::new(),
            probe,
        }
    }

    fn record(&mut self, unix: &str) {
        // Read from the upper directory, where the collect will look.
        if let Ok(stamp) = Stamp::read(&self.upper.native(unix)) {
            self.tracked.insert(unix.to_owned(), stamp);
        }
    }
}

/// The overlay's lower layers.
struct Lowers<'a>(&'a [PathBuf]);

impl Lowers<'_> {
    fn find(&self, unix: &str) -> Option<Metadata> {
        self.0
            .iter()
            .find_map(|lower| fs::symlink_metadata(Root::Dir(lower.clone()).native(unix)).ok())
    }
}

impl Origin for Lowers<'_> {
    fn before(&self, unix: &str, _now: &Stamp) -> Before {
        match self.find(unix) {
            None => Before::Absent,
            Some(meta) => Before::Present(kind_of(&meta), mode_of(&meta)),
        }
    }
    fn existed(&self, unix: &str) -> bool {
        self.find(unix).is_some()
    }
}

fn mode_of(_meta: &Metadata) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        _meta.mode() & 0o7777
    }
    #[cfg(not(unix))]
    0
}

impl Tree for Overlay {
    fn path(&self, unix: &str) -> PathBuf {
        self.root.native(unix)
    }

    fn job_root(&self) -> &Root {
        &self.root
    }

    fn put(&mut self, archive: &mut dyn Read) -> io::Result<Extracted> {
        let extracted = extract(archive, &self.root, &OVERLAY_SKIP[..1])?;
        for unix in &extracted.written {
            self.record(unix);
        }
        Ok(extracted)
    }

    fn track(&mut self, paths: &[String]) {
        for unix in paths {
            self.record(unix);
        }
    }

    fn plan(&self, paths: &[String], repository: Option<&str>) -> io::Result<Plan> {
        Planner {
            view: &self.upper,
            job: &self.root,
            tracked: &self.tracked,
            origin: &Lowers(&self.lowers),
            probe: &*self.probe,
            skip: &OVERLAY_SKIP,
        }
        .plan(paths, repository)
    }
}

/// The kernel's overlay markers.
#[cfg(target_os = "linux")]
pub struct OverlayMarkers;

#[cfg(target_os = "linux")]
impl Probe for OverlayMarkers {
    fn whiteout(&self, _path: &std::path::Path, meta: &Metadata) -> bool {
        use std::os::unix::fs::{FileTypeExt, MetadataExt};
        meta.file_type().is_char_device() && meta.rdev() == 0
    }

    fn opaque(&self, path: &std::path::Path) -> bool {
        use std::os::unix::ffi::OsStrExt;
        let Ok(c_path) = std::ffi::CString::new(path.as_os_str().as_bytes()) else {
            return false;
        };
        let mut value = [0u8; 2];
        // SAFETY: both strings are NUL-terminated and the buffer's length
        // is passed with it.
        let n = unsafe {
            libc::lgetxattr(
                c_path.as_ptr(),
                c"trusted.overlay.opaque".as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
            )
        };
        n == 1 && value[0] == b'y'
    }
}
