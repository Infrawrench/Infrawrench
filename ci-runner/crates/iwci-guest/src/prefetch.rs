//! Reads a streamed-in tree ahead of the job, so its files are in the
//! machine before the job asks for them.
//!
//! A machine's own files can be served by the runner over virtio-fs
//! rather than given as a disk (`init::files_tag`): then every file
//! crosses only when it is read, and the server lets the kernel keep what
//! crossed. This walks the tree from the moment the machine is up, on a
//! few threads, and reads each file once, which leaves it in the page
//! cache; the job's own reads find it there, or wait for it alone if it
//! has not come yet. Breadth first, so the files at the top of the tree
//! (manifests, lockfiles, configuration) come first. Held to a budget of
//! bytes and a largest file, so a large repository does not fill the
//! machine's memory with files nobody reads.

use std::collections::VecDeque;
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex};

/// What [`prefetch`] read.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Prefetched {
    pub files: u64,
    pub bytes: u64,
}

struct Queue {
    dirs: VecDeque<PathBuf>,
    files: VecDeque<PathBuf>,
    /// Threads busy with an entry: the walk is over when none are and
    /// nothing is queued.
    busy: usize,
}

/// Reads every regular file under `root` once, on `threads` threads,
/// until `budget` bytes have been read; files larger than `largest` are
/// left for the job to read if it wants them. Returns once the walk is
/// over.
pub fn prefetch(root: &Path, threads: usize, budget: u64, largest: u64) -> Prefetched {
    let queue = Mutex::new(Queue {
        dirs: VecDeque::from([root.to_path_buf()]),
        files: VecDeque::new(),
        busy: 0,
    });
    let more = Condvar::new();
    // Bytes promised to files taken so far: a file is taken only if it
    // fits what is left.
    let promised = AtomicU64::new(0);
    let read = Mutex::new(Prefetched::default());
    std::thread::scope(|scope| {
        for _ in 0..threads.max(1) {
            scope.spawn(|| {
                lower_priority();
                let mut buf = vec![0u8; 1 << 20];
                loop {
                    // Files first, so a level is read before the walk
                    // goes deeper.
                    let next = {
                        let mut q = queue.lock().unwrap_or_else(|e| e.into_inner());
                        loop {
                            if let Some(file) = q.files.pop_front() {
                                q.busy += 1;
                                break Some(Ok(file));
                            }
                            if let Some(dir) = q.dirs.pop_front() {
                                q.busy += 1;
                                break Some(Err(dir));
                            }
                            if q.busy == 0 {
                                more.notify_all();
                                break None;
                            }
                            q = more.wait(q).unwrap_or_else(|e| e.into_inner());
                        }
                    };
                    let Some(next) = next else { return };
                    match next {
                        Ok(path) => {
                            if let Some(n) = read_through(&path, &mut buf) {
                                let mut r = read.lock().unwrap_or_else(|e| e.into_inner());
                                r.files += 1;
                                r.bytes += n;
                            }
                        }
                        Err(dir) => {
                            let mut dirs = Vec::new();
                            let mut files = Vec::new();
                            if let Ok(entries) = std::fs::read_dir(&dir) {
                                for entry in entries.flatten() {
                                    let Ok(ft) = entry.file_type() else { continue };
                                    if ft.is_dir() {
                                        dirs.push(entry.path());
                                    } else if ft.is_file() {
                                        let size = entry.metadata().map_or(0, |m| m.len());
                                        if size > largest {
                                            continue;
                                        }
                                        let taken = promised
                                            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |p| {
                                                (p + size <= budget).then_some(p + size)
                                            })
                                            .is_ok();
                                        if taken {
                                            files.push(entry.path());
                                        }
                                    }
                                }
                            }
                            let mut q = queue.lock().unwrap_or_else(|e| e.into_inner());
                            q.dirs.extend(dirs);
                            q.files.extend(files);
                        }
                    }
                    let mut q = queue.lock().unwrap_or_else(|e| e.into_inner());
                    q.busy -= 1;
                    drop(q);
                    more.notify_all();
                }
            });
        }
    });
    read.into_inner().unwrap_or_else(|e| e.into_inner())
}

/// Reads `path` to its end, keeping nothing: the kernel keeps the pages.
fn read_through(path: &Path, buf: &mut [u8]) -> Option<u64> {
    let mut file = File::open(path).ok()?;
    let mut total = 0u64;
    loop {
        match file.read(buf) {
            Ok(0) => return Some(total),
            Ok(n) => total += n as u64,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => return Some(total),
        }
    }
}

/// The job's own work comes first: these threads run at the lowest CPU
/// priority there is.
fn lower_priority() {
    #[cfg(target_os = "linux")]
    // SAFETY: plain system calls; 0 is this thread (setpriority acts on
    // a thread id on Linux).
    unsafe {
        let tid = libc::syscall(libc::SYS_gettid) as libc::id_t;
        libc::setpriority(libc::PRIO_PROCESS, tid, 19);
    }
}

/// How much to read ahead in a machine: a quarter of its memory, at most
/// 2 GiB, from `/proc/meminfo`'s `MemTotal` (in KiB).
pub fn budget(meminfo: &str) -> u64 {
    let total_kib = meminfo
        .lines()
        .find_map(|l| l.strip_prefix("MemTotal:"))
        .and_then(|rest| rest.split_whitespace().next()?.parse::<u64>().ok())
        .unwrap_or(0);
    (total_kib * 1024 / 4).min(2 << 30)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "iwci-prefetch-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("a/b/c")).unwrap();
        std::fs::write(dir.join("top.json"), [1u8; 10]).unwrap();
        std::fs::write(dir.join("a/one"), [1u8; 100]).unwrap();
        std::fs::write(dir.join("a/b/two"), [1u8; 1000]).unwrap();
        std::fs::write(dir.join("a/b/c/big"), [1u8; 50_000]).unwrap();
        dir
    }

    #[test]
    fn reads_every_file_once() {
        let dir = tree();
        let got = prefetch(&dir, 3, u64::MAX, u64::MAX);
        assert_eq!(
            got,
            Prefetched {
                files: 4,
                bytes: 51_110
            }
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn keeps_to_its_budget_and_skips_the_largest_files() {
        let dir = tree();
        // The big file is over the largest; the rest fit.
        let got = prefetch(&dir, 2, u64::MAX, 10_000);
        assert_eq!(
            got,
            Prefetched {
                files: 3,
                bytes: 1_110
            }
        );
        // A budget the first two levels fit and the third does not.
        let got = prefetch(&dir, 1, 200, u64::MAX);
        assert_eq!(
            got,
            Prefetched {
                files: 2,
                bytes: 110
            }
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_missing_root_reads_nothing() {
        let got = prefetch(Path::new("/nonexistent/iwci"), 4, u64::MAX, u64::MAX);
        assert_eq!(got, Prefetched::default());
    }

    #[test]
    fn the_budget_is_a_quarter_of_memory_and_at_most_two_gib() {
        assert_eq!(
            budget("MemTotal:        2097152 kB\nMemFree: 1 kB\n"),
            512 << 20
        );
        assert_eq!(budget("MemTotal:       33554432 kB\n"), 2 << 30);
        assert_eq!(budget(""), 0);
    }
}
