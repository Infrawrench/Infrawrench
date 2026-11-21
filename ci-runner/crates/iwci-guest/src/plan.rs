//! Deciding what a [`HostMsg::Collect`](iwci_vm_proto::HostMsg::Collect)
//! sends: the paths the job deleted and the entries it added or changed.
//!
//! One walk serves both trees. It looks at a *view* of the machine (the
//! whole tree for [`Manifest`](crate::Manifest), the overlay's upper
//! directory for [`Overlay`](crate::Overlay)) and judges each entry against
//! three sources:
//!
//! - the *tracked* map, the stamps of what [`HostMsg::Put`] (and `Setup`)
//!   wrote, read back right after writing;
//! - an [`Origin`], for anything not tracked: what was there before (the
//!   overlay's lower layers), or whether it changed since the agent's
//!   baseline moment (a plain tree);
//! - a [`Probe`], which recognises the overlay's whiteouts and opaque
//!   directories (never, for a plain tree).
//!
//! In the job's repository, a new entry that git ignores is left where it
//! is, with everything below it ([`iwci_vm_proto::gitignore`]).
//!
//! [`HostMsg::Put`]: iwci_vm_proto::HostMsg::Put

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{self, Metadata};
use std::io;
use std::path::{Path, PathBuf};

use iwci_vm_proto::gitignore::GitIgnore;
use iwci_vm_proto::{is_clean_path, is_under};

use crate::root::{Root, ancestors, join, under_any};
use crate::stamp::{EntryKind, Stamp};

/// What was at a path, untracked, before the job ran.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Before {
    /// Nothing: the entry is new.
    Absent,
    /// The same entry, unchanged: do not send it (a directory is still
    /// walked).
    Unchanged,
    /// An entry of this kind and mode, which the view now shadows.
    Present(EntryKind, u32),
}

/// Where untracked entries came from.
pub trait Origin {
    fn before(&self, unix: &str, now: &Stamp) -> Before;
    /// Whether anything was at `unix` before the job ran (for a whiteout or
    /// an opaque directory, which say only that something is gone).
    fn existed(&self, unix: &str) -> bool;
}

/// Recognises the overlay's markers in the view.
pub trait Probe {
    /// A whiteout: the path was deleted.
    fn whiteout(&self, path: &Path, meta: &Metadata) -> bool;
    /// An opaque directory: deleted and made again, hiding what was below.
    fn opaque(&self, path: &Path) -> bool;
}

/// A plain tree has no markers.
pub struct NoMarkers;

impl Probe for NoMarkers {
    fn whiteout(&self, _: &Path, _: &Metadata) -> bool {
        false
    }
    fn opaque(&self, _: &Path) -> bool {
        false
    }
}

/// One entry to send.
#[derive(Debug, Clone)]
pub struct Item {
    pub unix: String,
    /// Where to read it from.
    pub native: PathBuf,
    pub stamp: Stamp,
}

/// What a collect sends.
#[derive(Debug, Default)]
pub struct Plan {
    /// Deleted paths, each a topmost one: no path here is below another.
    pub deleted: Vec<String>,
    /// Entries to send, parents before children.
    pub items: Vec<Item>,
}

/// Whether git ignores a path (a directory when the flag is set).
type Ignored<'a> = &'a dyn Fn(&str, bool) -> bool;

/// What holds for everything below a directory the walk entered.
#[derive(Clone, Copy)]
struct Below<'a> {
    /// Everything is new: an ancestor was deleted and made again.
    forced: bool,
    /// In the repository: what git ignores is left alone.
    ignored: Option<Ignored<'a>>,
}

/// The walk; see the module.
pub struct Planner<'a> {
    pub view: &'a Root,
    /// The job's files as its processes see them, where the repository's
    /// `.gitignore` files are read.
    pub job: &'a Root,
    pub tracked: &'a BTreeMap<String, Stamp>,
    pub origin: &'a dyn Origin,
    pub probe: &'a dyn Probe,
    /// Paths never looked at (the agent's own).
    pub skip: &'a [&'a str],
}

/// Checks the requested paths and drops any below another.
pub fn requested(paths: &[String]) -> Result<Vec<String>, String> {
    for path in paths {
        if !is_clean_path(path) {
            return Err(format!("{path:?} is not a clean absolute path"));
        }
    }
    Ok(topmost(paths.iter().cloned().collect()))
}

fn lstat(path: &Path) -> io::Result<Option<Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(meta) => Ok(Some(meta)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        // A file where a directory should be: the path is not there.
        Err(e) if e.raw_os_error() == not_a_directory() => Ok(None),
        Err(e) => Err(e),
    }
}

fn not_a_directory() -> Option<i32> {
    #[cfg(unix)]
    return Some(libc::ENOTDIR);
    #[cfg(windows)]
    return Some(3); // ERROR_PATH_NOT_FOUND
    #[cfg(not(any(unix, windows)))]
    return None;
}

impl Planner<'_> {
    /// Plans a collect of `paths`, already checked by [`requested`], and
    /// of `repository` (checked too) without what git ignores in it.
    pub fn plan(&self, paths: &[String], repository: Option<&str>) -> io::Result<Plan> {
        let mut deleted = BTreeSet::new();
        let mut items = Vec::new();
        if let Some(repository) = repository
            && !under_any(repository, self.skip)
        {
            let rules = GitIgnore::new(repository, |unix: &str| {
                fs::read(self.job.native(unix)).ok()
            });
            let ignored = |unix: &str, is_dir: bool| rules.ignored(unix, is_dir);
            self.plan_one(repository, Some(&ignored), &mut deleted, &mut items)?;
        }
        for path in paths {
            if under_any(path, self.skip) {
                continue;
            }
            self.plan_one(path, None, &mut deleted, &mut items)?;
        }
        // A path both in the repository and asked for on its own (an
        // artifact) goes once.
        let mut sent = HashSet::new();
        items.retain(|item| sent.insert(item.unix.clone()));
        Ok(Plan {
            deleted: topmost(deleted),
            items,
        })
    }

    fn existed(&self, unix: &str) -> bool {
        self.tracked.contains_key(unix) || self.origin.existed(unix)
    }

    fn plan_one(
        &self,
        path: &str,
        ignored: Option<Ignored<'_>>,
        deleted: &mut BTreeSet<String>,
        items: &mut Vec<Item>,
    ) -> io::Result<()> {
        // What is above the requested path decides whether it is still
        // there, and whether everything under it is new.
        let mut forced = false;
        let mut gone = false;
        for dir in ancestors(path) {
            let native = self.view.native(dir);
            let Some(meta) = lstat(&native)? else {
                break;
            };
            if self.probe.whiteout(&native, &meta)
                || !meta.is_dir()
                || meta.file_type().is_symlink()
            {
                gone = true;
                break;
            }
            if self.probe.opaque(&native) {
                forced = true;
            }
        }
        if (gone || forced) && self.existed(path) {
            deleted.insert(path.to_owned());
        }
        if !gone {
            let native = self.view.native(path);
            if let Some(meta) = lstat(&native)? {
                let below = Below { forced, ignored };
                self.visit(path, native, &meta, below, deleted, items)?;
            }
        }
        // Tracked paths that are no longer there at all. (A tracked path
        // the overlay also had below shows as a whiteout, which the walk
        // reports; one only the job's files had just disappears.)
        for (unix, _) in self
            .tracked
            .range::<str, _>((std::ops::Bound::Included(path), std::ops::Bound::Unbounded))
            .take_while(|(unix, _)| is_under(unix, path))
        {
            if under_any(unix, self.skip) {
                continue;
            }
            if lstat(&self.view.native(unix))?.is_none() {
                deleted.insert(unix.clone());
            }
        }
        Ok(())
    }

    fn visit(
        &self,
        unix: &str,
        native: PathBuf,
        meta: &Metadata,
        below: Below<'_>,
        deleted: &mut BTreeSet<String>,
        items: &mut Vec<Item>,
    ) -> io::Result<()> {
        let Below { forced, ignored } = below;
        if under_any(unix, self.skip) && unix != "/" {
            return Ok(());
        }
        if self.probe.whiteout(&native, meta) {
            if self.existed(unix) {
                deleted.insert(unix.to_owned());
            }
            return Ok(());
        }
        let now = Stamp::from_meta(&native, meta)?;
        if now.kind == EntryKind::Other {
            return Ok(());
        }
        let is_dir = now.kind == EntryKind::Dir;
        // Something the job made that git ignores is not its change; one
        // the repository had is, even where a rule now matches it.
        if !self.existed(unix) && ignored.is_some_and(|ignored| ignored(unix, is_dir)) {
            return Ok(());
        }
        let mut children_forced = forced;
        let send = if unix == "/" {
            false
        } else if forced {
            true
        } else if is_dir && self.probe.opaque(&native) {
            if self.existed(unix) {
                deleted.insert(unix.to_owned());
            }
            children_forced = true;
            true
        } else if let Some(old) = self.tracked.get(unix) {
            if old.kind != now.kind || (is_dir && old.ident != now.ident) {
                // Replaced by something else, or deleted and made again:
                // what was below is gone too.
                deleted.insert(unix.to_owned());
                children_forced = true;
                true
            } else {
                now.content_differs(old)
            }
        } else {
            match self.origin.before(unix, &now) {
                Before::Absent => true,
                Before::Unchanged => false,
                Before::Present(kind, _) if kind != now.kind => {
                    deleted.insert(unix.to_owned());
                    children_forced = true;
                    true
                }
                Before::Present(_, mode) if is_dir => mode != now.mode,
                // A file or link in the view over one below was written.
                Before::Present(..) => true,
            }
        };
        if send {
            items.push(Item {
                unix: unix.to_owned(),
                native: native.clone(),
                stamp: now,
            });
        }
        if is_dir {
            let mut children = Vec::new();
            let entries = match fs::read_dir(&native) {
                Ok(entries) => entries,
                // A system directory the agent may not read cannot hold
                // anything the job wrote.
                Err(e) if e.kind() == io::ErrorKind::PermissionDenied && !send => return Ok(()),
                Err(e) => {
                    return Err(io::Error::new(
                        e.kind(),
                        format!("reading {}: {e}", native.display()),
                    ));
                }
            };
            for entry in entries {
                let entry = entry?;
                let name = entry.file_name();
                let name = name.to_str().ok_or_else(|| {
                    io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!(
                            "{} holds a name that is not UTF-8: {:?}",
                            native.display(),
                            entry.file_name()
                        ),
                    )
                })?;
                children.push(name.to_owned());
            }
            children.sort();
            for name in children {
                let child = join(unix, &name);
                if !is_clean_path(&child) {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("{child:?} cannot be named as a job's path"),
                    ));
                }
                let child_native = native.join(&name);
                if let Some(meta) = lstat(&child_native)? {
                    self.visit(
                        &child,
                        child_native,
                        &meta,
                        Below {
                            forced: children_forced,
                            ignored,
                        },
                        deleted,
                        items,
                    )?;
                }
            }
        }
        Ok(())
    }
}

/// Keeps only paths that are not below another in the set.
pub fn topmost(paths: BTreeSet<String>) -> Vec<String> {
    let mut kept: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut out: Vec<String> = Vec::new();
    // Sorted order puts a parent before its children, so a path's kept
    // ancestor is always already in the set.
    for path in paths {
        if path == "/" || !ancestors(&path).iter().any(|a| kept.contains(*a)) {
            kept.insert(path.clone());
            out.push(path);
        }
    }
    if kept.contains("/") {
        return vec!["/".to_owned()];
    }
    out
}
