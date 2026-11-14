//! iwci patch (#996): `memory.init` of a large passive data segment maps it
//! copy-on-write instead of copying it.
//!
//! A module built for threads (every WASIX program that links pthreads)
//! keeps its data in passive segments, which its start function copies into
//! the shared memory with `memory.init`. Edge.js's is 45 MB (its built-in
//! modules' sources, ICU's data and the rest of its read-only data), so
//! every `node` copied 45 MB, into pages the kernel first zeroed (2 MB at a
//! time, since linear memories ask for huge pages), and kept them: a `node`
//! that reads a few MB of it held all of it. Here the segment is written
//! once per process into a sealed memfd, and the whole pages of each
//! `memory.init` destination are mapped from it privately: a page is read
//! from the shared copy until the guest writes it, which copies that page
//! alone. The bytes the guest sees are the same as a copy's.
//!
//! Only for a memory whose pages are an anonymous private mapping of
//! wasmer-vm's own ([`crate::LinearMemory::maps_data_copy_on_write`]), which
//! nothing else maps over or reads from a file, and only on Linux. A
//! segment is told from another by its identity (the `Arc` the module
//! holds), never by its address alone, which a later module could reuse.

use std::sync::Arc;

/// Below this many whole pages a copy is as cheap as a mapping.
pub(crate) const MIN_MAPPED_BYTES: usize = 1 << 20;

#[cfg(target_os = "linux")]
mod imp {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::sync::{Arc, Mutex, Weak};

    /// One segment's bytes in a memfd, `phase` bytes into it, so the file is
    /// page aligned with a destination `phase` bytes into a page.
    struct Image {
        data: Weak<[u8]>,
        src: usize,
        len: usize,
        phase: usize,
        fd: OwnedFd,
    }

    static IMAGES: Mutex<Vec<Image>> = Mutex::new(Vec::new());

    fn page_size() -> usize {
        // SAFETY: sysconf has no preconditions.
        let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if size > 0 { size as usize } else { 4096 }
    }

    /// The memfd holding `data[src..src + len]` at offset `phase`, made the
    /// first time it is asked for. The returned descriptor is a duplicate,
    /// so the caller maps it without the lock.
    fn image(data: &Arc<[u8]>, src: usize, len: usize, phase: usize) -> Option<OwnedFd> {
        let mut images = IMAGES.lock().unwrap_or_else(|e| e.into_inner());
        // Images of modules that are gone are dropped, so their memory is
        // given back and their addresses cannot be mistaken for a live one.
        images.retain(|image| image.data.strong_count() > 0);
        let found = images.iter().find(|image| {
            image.src == src
                && image.len == len
                && image.phase == phase
                && image
                    .data
                    .upgrade()
                    .is_some_and(|live| Arc::ptr_eq(&live, data))
        });
        if let Some(image) = found {
            return image.fd.try_clone().ok();
        }
        let fd = make(&data[src..src + len], phase)?;
        let dup = fd.try_clone().ok()?;
        images.push(Image {
            data: Arc::downgrade(data),
            src,
            len,
            phase,
            fd,
        });
        Some(dup)
    }

    /// A sealed memfd of `phase` zero bytes and then `bytes`.
    fn make(bytes: &[u8], phase: usize) -> Option<OwnedFd> {
        // SAFETY: a NUL-terminated name and valid flags.
        let raw = unsafe {
            libc::memfd_create(
                c"wasm-data-segment".as_ptr(),
                libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
            )
        };
        if raw < 0 {
            return None;
        }
        // SAFETY: a descriptor memfd_create just returned, owned by nothing
        // else.
        let fd = unsafe { OwnedFd::from_raw_fd(raw) };
        let size = libc::off_t::try_from(phase + bytes.len()).ok()?;
        // SAFETY: plain calls on a descriptor we own.
        if unsafe { libc::ftruncate(fd.as_raw_fd(), size) } != 0 {
            return None;
        }
        let mut written = 0;
        while written < bytes.len() {
            let rest = &bytes[written..];
            // SAFETY: `rest` is valid for reads of its length.
            let n = unsafe {
                libc::pwrite(
                    fd.as_raw_fd(),
                    rest.as_ptr().cast(),
                    rest.len(),
                    (phase + written) as libc::off_t,
                )
            };
            if n <= 0 {
                return None;
            }
            written += n as usize;
        }
        // Nothing can change it from here on, so a mapping of it is only
        // ever these bytes.
        let seals = libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;
        // SAFETY: a plain call on a descriptor we own.
        if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_ADD_SEALS, seals) } != 0 {
            return None;
        }
        Some(fd)
    }

    pub(crate) unsafe fn map(
        base: *mut u8,
        dst: usize,
        data: &Arc<[u8]>,
        src: usize,
        len: usize,
    ) -> bool {
        let page = page_size();
        let end = dst + len;
        let first = dst.next_multiple_of(page);
        let last = end - end % page;
        if last <= first || last - first < super::MIN_MAPPED_BYTES {
            return false;
        }
        let phase = dst % page;
        let Some(fd) = image(data, src, len, phase) else {
            return false;
        };
        // `base + dst` is `phase` bytes into the file, so `base + first` is
        // a whole number of pages into it.
        let offset = phase + (first - dst);
        // SAFETY: the caller guarantees `base..base + end` is accessible
        // memory of an anonymous private mapping that nothing else maps
        // over, so replacing its pages in `first..last` changes nothing but
        // their contents, which are the segment's bytes either way.
        unsafe {
            let at = base.add(first);
            let mapped = libc::mmap(
                at.cast(),
                last - first,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_PRIVATE | libc::MAP_FIXED,
                fd.as_raw_fd(),
                offset as libc::off_t,
            );
            if mapped == libc::MAP_FAILED {
                // MAP_FIXED unmaps before it maps, so a failure may have left
                // a hole: make the pages anonymous again and copy instead.
                let again = libc::mmap(
                    at.cast(),
                    last - first,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_PRIVATE | libc::MAP_ANONYMOUS | libc::MAP_FIXED,
                    -1,
                    0,
                );
                assert!(
                    again != libc::MAP_FAILED,
                    "could not restore linear memory pages: {}",
                    std::io::Error::last_os_error()
                );
                return false;
            }
            debug_assert_eq!(mapped.cast::<u8>(), at);
            // The partial pages at either end are copied.
            std::ptr::copy_nonoverlapping(data.as_ptr().add(src), base.add(dst), first - dst);
            std::ptr::copy_nonoverlapping(
                data.as_ptr().add(src + (last - dst)),
                base.add(last),
                end - last,
            );
        }
        true
    }

    #[cfg(test)]
    pub(crate) fn images() -> usize {
        IMAGES.lock().unwrap_or_else(|e| e.into_inner()).len()
    }
}

/// Initializes `base[dst..dst + len]` with `data[src..src + len]` by mapping
/// the segment copy-on-write, or answers `false` and leaves the copy to the
/// caller (a range under [`MIN_MAPPED_BYTES`] of whole pages, another
/// platform, or a mapping that failed).
///
/// # Safety
///
/// `base..base + dst + len` must be accessible memory of an anonymous private
/// mapping that no one else maps over, `src + len` must be within `data`,
/// and the caller must have the right to write the whole destination range.
pub(crate) unsafe fn map(base: *mut u8, dst: usize, data: &Arc<[u8]>, src: usize, len: usize) -> bool {
    #[cfg(target_os = "linux")]
    {
        unsafe { imp::map(base, dst, data, src, len) }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (base, dst, data, src, len);
        false
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::{Mmap, MmapType};
    use std::sync::Mutex;

    /// The images are the process's, so the tests that count them run alone.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn segment(len: usize, seed: u8) -> Arc<[u8]> {
        (0..len)
            .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
            .collect::<Vec<_>>()
            .into()
    }

    #[test]
    fn a_mapped_segment_reads_and_writes_like_a_copy() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let len = 3 * MIN_MAPPED_BYTES + 777;
        let data = segment(len + 100, 7);
        let mut mem = Mmap::accessible_reserved(8 << 20, 8 << 20, None, MmapType::Private, true).unwrap();
        mem.as_mut_slice().fill(0xee);
        let base = mem.as_mut_ptr();
        // An unaligned destination and source.
        let (dst, src) = (12345, 50);
        assert!(unsafe { map(base, dst, &data, src, len) });
        let slice = mem.as_mut_slice();
        assert!(slice[..dst].iter().all(|&b| b == 0xee));
        assert_eq!(&slice[dst..dst + len], &data[src..src + len]);
        assert!(slice[dst + len..].iter().all(|&b| b == 0xee));
        // A write changes this memory alone.
        slice[dst + 2 * MIN_MAPPED_BYTES] ^= 0xff;
        let mut other = Mmap::accessible_reserved(8 << 20, 8 << 20, None, MmapType::Private, true).unwrap();
        assert!(unsafe { map(other.as_mut_ptr(), dst, &data, src, len) });
        assert_eq!(&other.as_mut_slice()[dst..dst + len], &data[src..src + len]);
        assert_ne!(mem.as_mut_slice()[dst + 2 * MIN_MAPPED_BYTES], data[src + 2 * MIN_MAPPED_BYTES]);
        // And a copy of the memory (a fork) has its bytes.
        let copy = mem.copy(None).unwrap();
        assert_eq!(copy.as_slice()[dst + 2 * MIN_MAPPED_BYTES], mem.as_slice()[dst + 2 * MIN_MAPPED_BYTES]);
        assert_eq!(&copy.as_slice()[dst..dst + MIN_MAPPED_BYTES], &data[src..src + MIN_MAPPED_BYTES]);
    }

    #[test]
    fn a_small_segment_is_left_to_the_copy() {
        let data = segment(MIN_MAPPED_BYTES, 1);
        let mut mem = Mmap::accessible_reserved(4 << 20, 4 << 20, None, MmapType::Private, true).unwrap();
        // Whole pages under the minimum once the partial ends are left out.
        assert!(!unsafe { map(mem.as_mut_ptr(), 1, &data, 0, MIN_MAPPED_BYTES - 1) });
        assert!(mem.as_slice().iter().all(|&b| b == 0));
    }

    #[test]
    fn a_segment_of_a_module_that_is_gone_is_never_mapped_again() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let len = MIN_MAPPED_BYTES + 4096;
        let mut mem = Mmap::accessible_reserved(4 << 20, 4 << 20, None, MmapType::Private, true).unwrap();
        let first = segment(len, 3);
        assert!(unsafe { map(mem.as_mut_ptr(), 0, &first, 0, len) });
        drop(first);
        // Another segment, perhaps at the same address, gets its own bytes.
        let second = segment(len, 9);
        assert!(unsafe { map(mem.as_mut_ptr(), 0, &second, 0, len) });
        assert_eq!(&mem.as_slice()[..len], &second[..]);
        drop(second);
        // Mapping another drops the images of both.
        let third = segment(len, 5);
        assert!(unsafe { map(mem.as_mut_ptr(), 0, &third, 0, len) });
        assert_eq!(imp::images(), 1, "images of dropped segments are kept");
    }
}
