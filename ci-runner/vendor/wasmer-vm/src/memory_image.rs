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
//! once per process into a sealed memfd, and the whole pages of the
//! destination are mapped from it privately: a page is read from the shared
//! copy until the guest writes it, which copies that page alone. The bytes
//! the guest sees are the same as a copy's.
//!
//! Only the shape that start function has: the whole segment at once
//! (`src == 0`, its full length), at least [`MIN_MAPPED_BYTES`] of whole
//! pages. The images are bounded: one per segment and destination offset
//! within a page, at most [`MAX_IMAGES_PER_SEGMENT`] per segment and
//! [`MAX_IMAGE_BYTES`] in the process, and a memory is mapped over at most
//! [`MAX_MAPPINGS_PER_MEMORY`] times. Anything else, and anything past a
//! bound, is copied as before.
//!
//! Only for a memory whose pages are an anonymous private mapping of
//! wasmer-vm's own ([`crate::LinearMemory::claim_data_mapping`]), which
//! nothing else maps over or reads from a file, and only on Linux. A
//! segment is told from another by its identity (the `Arc` the module
//! holds), never by its address alone, which a later module could reuse.

use std::sync::Arc;

/// Below this many whole pages a copy is as cheap as a mapping.
pub(crate) const MIN_MAPPED_BYTES: usize = 1 << 20;

/// The images of one segment, one per destination offset within a page.
/// A module's start function initializes a segment at one address.
pub(crate) const MAX_IMAGES_PER_SEGMENT: usize = 2;

/// The bytes all images in the process may hold together (Edge.js's is
/// 45.6 MB, and a runner keeps at most two engine generations of each
/// environment's module).
#[cfg(not(test))]
pub(crate) const MAX_IMAGE_BYTES: usize = 256 << 20;
#[cfg(test)]
pub(crate) const MAX_IMAGE_BYTES: usize = 16 << 20;

/// How many times one memory may be mapped over; a start function does it
/// once.
pub(crate) const MAX_MAPPINGS_PER_MEMORY: u32 = 4;

/// What [`init`] did.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Init {
    /// The destination holds the segment's bytes.
    Mapped,
    /// Nothing was mapped and the destination is accessible as it was: the
    /// caller copies.
    Copy,
    /// The destination could not be made accessible again. Never seen; the
    /// caller traps rather than touch it.
    Failed,
}

#[cfg(target_os = "linux")]
mod imp {
    use super::Init;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::sync::{Arc, Mutex, Weak};

    /// One segment's bytes in a memfd, `phase` bytes into it, so the file is
    /// page aligned with a destination `phase` bytes into a page.
    struct Image {
        data: Weak<[u8]>,
        phase: usize,
        bytes: usize,
        fd: OwnedFd,
    }

    static IMAGES: Mutex<Vec<Image>> = Mutex::new(Vec::new());

    fn page_size() -> usize {
        // SAFETY: sysconf has no preconditions.
        let size = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
        if size > 0 { size as usize } else { 4096 }
    }

    /// The memfd holding `data` at offset `phase`, made the first time it is
    /// asked for, or `None` past a bound. The returned descriptor is a
    /// duplicate, so the caller maps it without the lock.
    fn image(data: &Arc<[u8]>, phase: usize) -> Option<OwnedFd> {
        let mut images = IMAGES.lock().unwrap_or_else(|e| e.into_inner());
        // Images of modules that are gone are dropped, so their memory is
        // given back and their addresses cannot be mistaken for a live one.
        images.retain(|image| image.data.strong_count() > 0);
        let is_this = |image: &Image| {
            image
                .data
                .upgrade()
                .is_some_and(|live| Arc::ptr_eq(&live, data))
        };
        if let Some(image) = images.iter().find(|image| image.phase == phase && is_this(image)) {
            return image.fd.try_clone().ok();
        }
        let bytes = phase + data.len();
        let held: usize = images.iter().map(|image| image.bytes).sum();
        if images.iter().filter(|image| is_this(image)).count() >= super::MAX_IMAGES_PER_SEGMENT
            || held + bytes > super::MAX_IMAGE_BYTES
        {
            return None;
        }
        let fd = make(data, phase)?;
        let dup = fd.try_clone().ok()?;
        images.push(Image {
            data: Arc::downgrade(data),
            phase,
            bytes,
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

    // Ways for the tests to make the remap fail: 1, the move fails and the
    // destination is as it was; 2, the move fails after unmapping the
    // destination; 3, that, and the destination cannot be mapped again.
    #[cfg(test)]
    thread_local! {
        pub(crate) static FAULT: std::cell::Cell<u8> = const { std::cell::Cell::new(0) };
    }

    #[cfg(test)]
    fn fault() -> u8 {
        FAULT.with(|f| f.get())
    }

    #[cfg(not(test))]
    fn fault() -> u8 {
        0
    }

    /// Whether every page of `at..at + size` is mapped.
    unsafe fn mapped(at: *mut u8, size: usize, page: usize) -> bool {
        let mut pages = vec![0u8; size.div_ceil(page)];
        // SAFETY: `pages` has a byte for every page of the range; mincore
        // only reads the page tables and fails on an unmapped page.
        unsafe { libc::mincore(at.cast(), size, pages.as_mut_ptr().cast()) == 0 }
    }

    /// Replaces the pages `at..at + size` with `fd` from `offset`, privately.
    /// The file is mapped elsewhere first, so a failure there leaves the
    /// destination alone, and then moved over it, which the kernel refuses
    /// before unmapping anything when the mappings would run out.
    unsafe fn remap(at: *mut u8, size: usize, fd: &OwnedFd, offset: usize, page: usize) -> Init {
        // SAFETY: a new mapping at an address of the kernel's choosing.
        let staged = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                size,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_PRIVATE,
                fd.as_raw_fd(),
                offset as libc::off_t,
            )
        };
        if staged == libc::MAP_FAILED {
            return Init::Copy;
        }
        let fault = fault();
        // SAFETY: `staged` is the mapping just made, of `size` bytes, and
        // the caller guarantees `at..at + size` is pages of a memory that
        // nothing else maps over.
        let moved = unsafe {
            if fault == 0 {
                libc::mremap(
                    staged,
                    size,
                    size,
                    libc::MREMAP_MAYMOVE | libc::MREMAP_FIXED,
                    at.cast::<libc::c_void>(),
                )
            } else {
                if fault >= 2 {
                    libc::munmap(at.cast(), size);
                }
                libc::MAP_FAILED
            }
        };
        if moved != libc::MAP_FAILED {
            debug_assert_eq!(moved.cast::<u8>(), at);
            return Init::Mapped;
        }
        // SAFETY: the staged mapping, which nothing else refers to.
        unsafe { libc::munmap(staged, size) };
        // SAFETY: reads the page tables of the range.
        if unsafe { mapped(at, size, page) } {
            return Init::Copy;
        }
        // The move unmapped the destination and failed: make it anonymous
        // again, for the caller to copy into.
        // SAFETY: as above; the range is the memory's and holds nothing.
        let again = unsafe {
            if fault >= 3 {
                libc::MAP_FAILED
            } else {
                libc::mmap(
                    at.cast(),
                    size,
                    libc::PROT_READ | libc::PROT_WRITE,
                    libc::MAP_PRIVATE | libc::MAP_ANONYMOUS | libc::MAP_FIXED,
                    -1,
                    0,
                )
            }
        };
        if again == libc::MAP_FAILED {
            Init::Failed
        } else {
            Init::Copy
        }
    }

    pub(crate) unsafe fn init(
        base: *mut u8,
        dst: usize,
        data: &Arc<[u8]>,
        claim: impl FnOnce() -> bool,
    ) -> Init {
        let page = page_size();
        let end = dst + data.len();
        let first = dst.next_multiple_of(page);
        let last = end - end % page;
        if last <= first || last - first < super::MIN_MAPPED_BYTES {
            return Init::Copy;
        }
        let phase = dst % page;
        let Some(fd) = image(data, phase) else {
            return Init::Copy;
        };
        if !claim() {
            return Init::Copy;
        }
        // `base + dst` is `phase` bytes into the file, so `base + first` is
        // a whole number of pages into it.
        let offset = phase + (first - dst);
        // SAFETY: the caller guarantees `base..base + end` is accessible
        // memory of an anonymous private mapping that nothing else maps
        // over, so replacing its pages in `first..last` changes nothing but
        // their contents, which are the segment's bytes either way.
        unsafe {
            let outcome = remap(base.add(first), last - first, &fd, offset, page);
            if outcome == Init::Mapped {
                // The partial pages at either end are copied.
                std::ptr::copy_nonoverlapping(data.as_ptr(), base.add(dst), first - dst);
                std::ptr::copy_nonoverlapping(
                    data.as_ptr().add(last - dst),
                    base.add(last),
                    end - last,
                );
            }
            outcome
        }
    }

    #[cfg(test)]
    pub(crate) fn images() -> usize {
        let mut images = IMAGES.lock().unwrap_or_else(|e| e.into_inner());
        images.retain(|image| image.data.strong_count() > 0);
        images.len()
    }
}

/// Initializes `base[dst..dst + data.len()]` with all of `data` by mapping
/// it copy-on-write, calling `claim` (the memory's
/// [`crate::LinearMemory::claim_data_mapping`]) once an image is at hand.
/// [`Init::Copy`] leaves the copy to the caller: a range under
/// [`MIN_MAPPED_BYTES`] of whole pages, a bound reached, another platform,
/// or a mapping that failed.
///
/// # Safety
///
/// `base..base + dst + data.len()` must be accessible memory of an anonymous
/// private mapping that no one else maps over while `claim` answers `true`,
/// and the caller must have the right to write the whole destination range.
pub(crate) unsafe fn init(
    base: *mut u8,
    dst: usize,
    data: &Arc<[u8]>,
    claim: impl FnOnce() -> bool,
) -> Init {
    #[cfg(target_os = "linux")]
    {
        unsafe { imp::init(base, dst, data, claim) }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (base, dst, data, claim);
        Init::Copy
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::{Mmap, MmapType};
    use std::sync::Mutex;

    /// The images are the process's, so the tests that make them run alone.
    static SERIAL: Mutex<()> = Mutex::new(());

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn segment(len: usize, seed: u8) -> Arc<[u8]> {
        (0..len)
            .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
            .collect::<Vec<_>>()
            .into()
    }

    fn memory(bytes: usize) -> Mmap {
        Mmap::accessible_reserved(bytes, bytes, None, MmapType::Private, true).unwrap()
    }

    /// `memory.init` of the whole of `data` at `dst`, as the instance does it.
    fn init_at(mem: &mut Mmap, dst: usize, data: &Arc<[u8]>) -> Init {
        let base = mem.as_mut_ptr();
        let outcome = unsafe { init(base, dst, data, || mem.claim_data_mapping()) };
        if outcome == Init::Copy {
            mem.as_mut_slice()[dst..dst + data.len()].copy_from_slice(data);
        }
        outcome
    }

    /// The mappings of the process inside `mem`.
    fn mappings_in(mem: &Mmap) -> usize {
        let (lo, hi) = (mem.as_ptr() as usize, mem.as_ptr() as usize + mem.len());
        std::fs::read_to_string("/proc/self/maps")
            .unwrap()
            .lines()
            .filter(|line| {
                let range = line.split(' ').next().unwrap();
                let (a, b) = range.split_once('-').unwrap();
                let (a, b) = (
                    usize::from_str_radix(a, 16).unwrap(),
                    usize::from_str_radix(b, 16).unwrap(),
                );
                a < hi && b > lo
            })
            .count()
    }

    #[test]
    fn a_mapped_segment_reads_and_writes_like_a_copy() {
        let _serial = serial();
        let len = 3 * MIN_MAPPED_BYTES + 777;
        let data = segment(len, 7);
        let mut mem = memory(8 << 20);
        mem.as_mut_slice().fill(0xee);
        // An unaligned destination.
        let dst = 12345;
        assert_eq!(init_at(&mut mem, dst, &data), Init::Mapped);
        let slice = mem.as_mut_slice();
        assert!(slice[..dst].iter().all(|&b| b == 0xee));
        assert_eq!(&slice[dst..dst + len], &data[..]);
        assert!(slice[dst + len..].iter().all(|&b| b == 0xee));
        // A write changes this memory alone.
        slice[dst + 2 * MIN_MAPPED_BYTES] ^= 0xff;
        let mut other = memory(8 << 20);
        assert_eq!(init_at(&mut other, dst, &data), Init::Mapped);
        assert_eq!(&other.as_slice()[dst..dst + len], &data[..]);
        assert_ne!(mem.as_slice()[dst + 2 * MIN_MAPPED_BYTES], data[2 * MIN_MAPPED_BYTES]);
        // And a copy of the memory (a fork) has its bytes.
        let copy = mem.copy(None).unwrap();
        assert_eq!(copy.as_slice()[dst + 2 * MIN_MAPPED_BYTES], mem.as_slice()[dst + 2 * MIN_MAPPED_BYTES]);
        assert_eq!(&copy.as_slice()[dst..dst + MIN_MAPPED_BYTES], &data[..MIN_MAPPED_BYTES]);
    }

    #[test]
    fn a_small_segment_is_left_to_the_copy() {
        let data = segment(MIN_MAPPED_BYTES - 1, 1);
        let mut mem = memory(4 << 20);
        // Whole pages under the minimum once the partial ends are left out.
        assert!(unsafe { init(mem.as_mut_ptr(), 1, &data, || true) } == Init::Copy);
        assert!(mem.as_slice().iter().all(|&b| b == 0));
    }

    #[test]
    fn a_segment_of_a_module_that_is_gone_is_never_mapped_again() {
        let _serial = serial();
        let len = MIN_MAPPED_BYTES + 4096;
        let mut mem = memory(4 << 20);
        let first = segment(len, 3);
        assert_eq!(init_at(&mut mem, 0, &first), Init::Mapped);
        drop(first);
        // Another segment, perhaps at the same address, gets its own bytes.
        let second = segment(len, 9);
        assert_eq!(init_at(&mut mem, 0, &second), Init::Mapped);
        assert_eq!(&mem.as_slice()[..len], &second[..]);
        drop(second);
        // Mapping another drops the images of both.
        let third = segment(len, 5);
        assert_eq!(init_at(&mut mem, 0, &third), Init::Mapped);
        assert_eq!(imp::images(), 1, "images of dropped segments are kept");
    }

    #[test]
    fn images_are_bounded_per_segment_and_in_all() {
        let _serial = serial();
        let len = MIN_MAPPED_BYTES + 3 * 4096;
        let data = segment(len, 11);
        // A segment at many offsets within a page: the first ones are
        // mapped, the rest copied.
        let mapped = (0..16usize)
            .filter(|&phase| {
                let mut mem = memory(4 << 20);
                let dst = 4096 + phase * 17;
                let outcome = init_at(&mut mem, dst, &data);
                assert_eq!(&mem.as_slice()[dst..dst + len], &data[..]);
                outcome == Init::Mapped
            })
            .count();
        assert_eq!(mapped, MAX_IMAGES_PER_SEGMENT);
        assert_eq!(imp::images(), MAX_IMAGES_PER_SEGMENT);
        // Many segments: no more than the byte bound is held.
        let segments: Vec<_> = (0..32u8).map(|seed| segment(len, seed)).collect();
        for data in &segments {
            let mut mem = memory(4 << 20);
            init_at(&mut mem, 0, data);
            assert_eq!(&mem.as_slice()[..len], &data[..]);
        }
        let images = imp::images();
        assert!(images * len <= MAX_IMAGE_BYTES, "{images} images of {len} bytes");
        assert!(images > MAX_IMAGES_PER_SEGMENT);
        drop((data, segments));
        assert_eq!(imp::images(), 0);
    }

    #[test]
    fn a_memory_is_mapped_over_a_bounded_number_of_times() {
        let _serial = serial();
        let len = MIN_MAPPED_BYTES + 4096;
        let (a, b) = (segment(len, 21), segment(len, 22));
        let mut mem = memory(8 << 20);
        let before = mappings_in(&mem);
        let mut expected = vec![0u8; mem.len()];
        // Two segments in turn over the same pages, a page further along
        // each time.
        let mut mapped = 0;
        for i in 0..256 {
            let (data, dst) = (if i % 2 == 0 { &a } else { &b }, 4096 * (1 + i));
            mapped += usize::from(init_at(&mut mem, dst, data) == Init::Mapped);
            expected[dst..dst + len].copy_from_slice(data);
        }
        assert_eq!(mapped, MAX_MAPPINGS_PER_MEMORY as usize);
        assert!(mem.as_slice() == &expected[..], "the memory differs from a copy's");
        let after = mappings_in(&mem);
        assert!(
            after <= before + 2 * MAX_MAPPINGS_PER_MEMORY as usize + 2,
            "{before} mappings before, {after} after"
        );
        // A fork starts its own count, and copies its bytes.
        let copy = mem.copy(None).unwrap();
        assert!(copy.as_slice() == &expected[..]);
        assert!(copy.claim_data_mapping());
    }

    #[test]
    fn a_failed_mapping_leaves_the_destination_to_the_copy() {
        let _serial = serial();
        let len = MIN_MAPPED_BYTES + 4096;
        let data = segment(len, 31);
        for fault in [1, 2] {
            imp::FAULT.with(|f| f.set(fault));
            let mut mem = memory(4 << 20);
            mem.as_mut_slice().fill(0xee);
            assert_eq!(init_at(&mut mem, 100, &data), Init::Copy, "fault {fault}");
            imp::FAULT.with(|f| f.set(0));
            let slice = mem.as_slice();
            assert!(slice[..100].iter().all(|&b| b == 0xee));
            assert_eq!(&slice[100..100 + len], &data[..]);
        }
        // When the destination cannot be made accessible again, it says so
        // rather than panicking.
        imp::FAULT.with(|f| f.set(3));
        let mut mem = memory(4 << 20);
        let outcome = unsafe { init(mem.as_mut_ptr(), 100, &data, || mem.claim_data_mapping()) };
        imp::FAULT.with(|f| f.set(0));
        assert_eq!(outcome, Init::Failed);
    }
}
