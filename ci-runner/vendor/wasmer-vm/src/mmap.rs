// This file contains code from external sources.
// Attributions: https://github.com/wasmerio/wasmer/blob/main/docs/ATTRIBUTIONS.md

//! Low-level abstraction for allocating and managing zero-filled pages
//! of memory.

use more_asserts::assert_le;
use std::io;
use std::ptr;
use std::slice;

/// A simple struct consisting of a page-aligned pointer to page-aligned
/// and initially-zeroed memory and a length.
#[derive(Debug)]
pub struct Mmap {
    // Note that this is stored as a `usize` instead of a `*const` or `*mut`
    // pointer to allow this structure to be natively `Send` and `Sync` without
    // `unsafe impl`. This type is sendable across threads and shareable since
    // the coordination all happens at the OS layer.
    ptr: usize,
    total_size: usize,
    accessible_size: usize,
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    sync_on_drop: bool,
    // iwci patch (#996): an anonymous private mapping, which a data segment
    // may be mapped over (memory_image.rs), and how many times one has been.
    anonymous_private: bool,
    data_mappings: std::sync::atomic::AtomicU32,
    // iwci patch (#1314): compiled code (`with_at_least`), whose addresses
    // are never handed out again once it is dropped (`code_space` below).
    code: bool,
}

/// The type of mmap to create
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum MmapType {
    /// The memory is private to the process and not shared with other processes.
    Private,
    /// The memory is shared with other processes. This is only supported on Unix.
    /// When the memory is flushed it will update the file data.
    Shared,
}

impl Mmap {
    /// Construct a new empty instance of `Mmap`.
    pub fn new() -> Self {
        // Rust's slices require non-null pointers, even when empty. `Vec`
        // contains code to create a non-null dangling pointer value when
        // constructed empty, so we reuse that here.
        let empty = Vec::<u8>::new();
        Self {
            ptr: empty.as_ptr() as usize,
            total_size: 0,
            accessible_size: 0,
            sync_on_drop: false,
            anonymous_private: false,
            data_mappings: std::sync::atomic::AtomicU32::new(0),
            code: false,
        }
    }

    /// Create a new `Mmap` pointing to at least `size` bytes of page-aligned accessible memory.
    pub fn with_at_least(size: usize, hint_huge_pages: bool) -> Result<Self, String> {
        let page_size = region::page::size();
        let rounded_size = size.next_multiple_of(page_size);
        // iwci patch (#1314): only an engine's code memory asks for this, and
        // code goes where no code has been (`code_space` below).
        #[cfg(not(target_os = "windows"))]
        if rounded_size != 0 {
            let ptr = code_space::allocate(rounded_size)?;
            return Ok(Self {
                ptr,
                total_size: rounded_size,
                accessible_size: rounded_size,
                sync_on_drop: false,
                anonymous_private: false,
                data_mappings: std::sync::atomic::AtomicU32::new(0),
                code: true,
            });
        }
        Self::accessible_reserved(
            rounded_size,
            rounded_size,
            None,
            MmapType::Private,
            hint_huge_pages,
        )
    }

    /// Create a new `Mmap` pointing to `accessible_size` bytes of page-aligned accessible memory,
    /// within a reserved mapping of `mapping_size` bytes. `accessible_size` and `mapping_size`
    /// must be native page-size multiples.
    #[cfg(not(target_os = "windows"))]
    pub fn accessible_reserved(
        mut accessible_size: usize,
        mapping_size: usize,
        mut backing_file: Option<std::path::PathBuf>,
        memory_type: MmapType,
        hint_huge_pages: bool,
    ) -> Result<Self, String> {
        use std::os::fd::IntoRawFd;

        let page_size = region::page::size();
        assert_le!(accessible_size, mapping_size);
        assert_eq!(mapping_size & (page_size - 1), 0);
        assert_eq!(accessible_size & (page_size - 1), 0);

        // Mmap may return EINVAL if the size is zero, so just
        // special-case that.
        if mapping_size == 0 {
            return Ok(Self::new());
        }

        // If there is a backing file, resize the file so that its at least
        // `mapping_size` bytes.
        let mut memory_fd = -1;
        if let Some(backing_file_path) = &mut backing_file {
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(&backing_file_path)
                .map_err(|e| e.to_string())?;

            let mut backing_file_accessible = backing_file_path.clone();
            backing_file_accessible.set_extension("accessible");

            let len = file.metadata().map_err(|e| e.to_string())?.len() as usize;
            if len < mapping_size {
                std::fs::write(&backing_file_accessible, format!("{len}").as_bytes()).ok();

                file.set_len(mapping_size as u64)
                    .map_err(|e| e.to_string())?;
            }

            if backing_file_accessible.exists() {
                let accessible = std::fs::read_to_string(&backing_file_accessible)
                    .map_err(|e| e.to_string())?
                    .parse::<usize>()
                    .map_err(|e| e.to_string())?;
                accessible_size = accessible_size.max(accessible);
            } else {
                accessible_size = accessible_size.max(len);
            }

            accessible_size = accessible_size.min(mapping_size);
            memory_fd = file.into_raw_fd();
        }

        // Compute the flags
        let mut flags = match memory_fd {
            fd if fd < 0 => libc::MAP_ANON,
            _ => libc::MAP_FILE,
        };
        flags |= match memory_type {
            MmapType::Private => libc::MAP_PRIVATE,
            MmapType::Shared => libc::MAP_SHARED,
        };

        Ok(if accessible_size == mapping_size {
            // Allocate a single read-write region at once.
            let ptr = unsafe {
                libc::mmap(
                    ptr::null_mut(),
                    mapping_size,
                    libc::PROT_READ | libc::PROT_WRITE,
                    flags,
                    memory_fd,
                    0,
                )
            };
            if ptr as isize == -1_isize {
                return Err(io::Error::last_os_error().to_string());
            }

            if hint_huge_pages {
                advise_huge_pages(ptr, mapping_size);
            }

            Self {
                ptr: ptr as usize,
                total_size: mapping_size,
                accessible_size,
                sync_on_drop: memory_fd != -1 && memory_type == MmapType::Shared,
                anonymous_private: memory_fd == -1 && memory_type == MmapType::Private,
                data_mappings: std::sync::atomic::AtomicU32::new(0),
                code: false,
            }
        } else {
            // Reserve the mapping size.
            let ptr = unsafe {
                libc::mmap(
                    ptr::null_mut(),
                    mapping_size,
                    libc::PROT_NONE,
                    flags,
                    memory_fd,
                    0,
                )
            };
            if ptr as isize == -1_isize {
                return Err(io::Error::last_os_error().to_string());
            }

            if hint_huge_pages {
                advise_huge_pages(ptr, mapping_size);
            }

            let mut result = Self {
                ptr: ptr as usize,
                total_size: mapping_size,
                accessible_size,
                sync_on_drop: memory_fd != -1 && memory_type == MmapType::Shared,
                anonymous_private: memory_fd == -1 && memory_type == MmapType::Private,
                data_mappings: std::sync::atomic::AtomicU32::new(0),
                code: false,
            };

            if accessible_size != 0 {
                // Commit the accessible size.
                result.make_accessible(0, accessible_size)?;
            }

            result
        })
    }

    /// Create a new `Mmap` pointing to `accessible_size` bytes of page-aligned accessible memory,
    /// within a reserved mapping of `mapping_size` bytes. `accessible_size` and `mapping_size`
    /// must be native page-size multiples.
    #[cfg(target_os = "windows")]
    pub fn accessible_reserved(
        accessible_size: usize,
        mapping_size: usize,
        _backing_file: Option<std::path::PathBuf>,
        _memory_type: MmapType,
        _hint_huge_pages: bool,
    ) -> Result<Self, String> {
        use windows_sys::Win32::System::Memory::{
            MEM_COMMIT, MEM_RESERVE, PAGE_NOACCESS, PAGE_READWRITE, VirtualAlloc,
        };

        let page_size = region::page::size();
        assert_le!(accessible_size, mapping_size);
        assert_eq!(mapping_size & (page_size - 1), 0);
        assert_eq!(accessible_size & (page_size - 1), 0);

        // VirtualAlloc may return ERROR_INVALID_PARAMETER if the size is zero,
        // so just special-case that.
        if mapping_size == 0 {
            return Ok(Self::new());
        }

        Ok(if accessible_size == mapping_size {
            // Allocate a single read-write region at once.
            let ptr = unsafe {
                VirtualAlloc(
                    ptr::null_mut(),
                    mapping_size,
                    MEM_RESERVE | MEM_COMMIT,
                    PAGE_READWRITE,
                )
            };
            if ptr.is_null() {
                return Err(io::Error::last_os_error().to_string());
            }

            Self {
                ptr: ptr as usize,
                total_size: mapping_size,
                accessible_size,
                sync_on_drop: false,
                anonymous_private: false,
                data_mappings: std::sync::atomic::AtomicU32::new(0),
                code: false,
            }
        } else {
            // Reserve the mapping size.
            let ptr =
                unsafe { VirtualAlloc(ptr::null_mut(), mapping_size, MEM_RESERVE, PAGE_NOACCESS) };
            if ptr.is_null() {
                return Err(io::Error::last_os_error().to_string());
            }

            let mut result = Self {
                ptr: ptr as usize,
                total_size: mapping_size,
                accessible_size,
                sync_on_drop: false,
                anonymous_private: false,
                data_mappings: std::sync::atomic::AtomicU32::new(0),
                code: false,
            };

            if accessible_size != 0 {
                // Commit the accessible size.
                result.make_accessible(0, accessible_size)?;
            }

            result
        })
    }

    /// Make the memory starting at `start` and extending for `len` bytes accessible.
    /// `start` and `len` must be native page-size multiples and describe a range within
    /// `self`'s reserved memory.
    #[cfg(not(target_os = "windows"))]
    pub fn make_accessible(&mut self, start: usize, len: usize) -> Result<(), String> {
        let page_size = region::page::size();
        assert_eq!(start & (page_size - 1), 0);
        assert_eq!(len & (page_size - 1), 0);
        assert_le!(len, self.total_size);
        assert_le!(start, self.total_size - len);

        // Commit the accessible size.
        let ptr = self.ptr as *const u8;
        unsafe { region::protect(ptr.add(start), len, region::Protection::READ_WRITE) }
            .map_err(|e| e.to_string())
    }

    /// Make the memory starting at `start` and extending for `len` bytes accessible.
    /// `start` and `len` must be native page-size multiples and describe a range within
    /// `self`'s reserved memory.
    #[cfg(target_os = "windows")]
    pub fn make_accessible(&mut self, start: usize, len: usize) -> Result<(), String> {
        use std::ffi::c_void;
        use windows_sys::Win32::System::Memory::{MEM_COMMIT, PAGE_READWRITE, VirtualAlloc};
        let page_size = region::page::size();
        assert_eq!(start & (page_size - 1), 0);
        assert_eq!(len & (page_size - 1), 0);
        assert_le!(len, self.len());
        assert_le!(start, self.len() - len);

        // Commit the accessible size.
        let ptr = self.ptr as *const u8;
        if unsafe {
            VirtualAlloc(
                ptr.add(start) as *mut c_void,
                len,
                MEM_COMMIT,
                PAGE_READWRITE,
            )
        }
        .is_null()
        {
            return Err(io::Error::last_os_error().to_string());
        }

        Ok(())
    }

    /// Return the allocated memory as a slice of u8.
    pub fn as_slice(&self) -> &[u8] {
        unsafe { slice::from_raw_parts(self.ptr as *const u8, self.total_size) }
    }

    /// Return the allocated memory as a slice of u8.
    pub fn as_slice_accessible(&self) -> &[u8] {
        unsafe { slice::from_raw_parts(self.ptr as *const u8, self.accessible_size) }
    }

    /// Return the allocated memory as a slice of u8.
    pub fn as_slice_arbitary(&self, size: usize) -> &[u8] {
        let size = usize::min(size, self.total_size);
        unsafe { slice::from_raw_parts(self.ptr as *const u8, size) }
    }

    /// Return the allocated memory as a mutable slice of u8.
    pub fn as_mut_slice(&mut self) -> &mut [u8] {
        unsafe { slice::from_raw_parts_mut(self.ptr as *mut u8, self.total_size) }
    }

    /// Return the allocated memory as a mutable slice of u8.
    pub fn as_mut_slice_accessible(&mut self) -> &mut [u8] {
        unsafe { slice::from_raw_parts_mut(self.ptr as *mut u8, self.accessible_size) }
    }

    /// Return the allocated memory as a mutable slice of u8.
    pub fn as_mut_slice_arbitrary(&mut self, size: usize) -> &mut [u8] {
        let size = usize::min(size, self.total_size);
        unsafe { slice::from_raw_parts_mut(self.ptr as *mut u8, size) }
    }

    /// Return the allocated memory as a pointer to u8.
    pub fn as_ptr(&self) -> *const u8 {
        self.ptr as *const u8
    }

    /// Return the allocated memory as a mutable pointer to u8.
    pub fn as_mut_ptr(&mut self) -> *mut u8 {
        self.ptr as *mut u8
    }

    /// Return the length of the allocated memory.
    pub fn len(&self) -> usize {
        self.total_size
    }

    /// iwci patch (#996): whether `memory.init` may map a data segment over
    /// this memory now: only an anonymous private mapping, and only
    /// [`crate::memory_image::MAX_MAPPINGS_PER_MEMORY`] times, after which
    /// it copies.
    pub(crate) fn claim_data_mapping(&self) -> bool {
        use std::sync::atomic::Ordering::Relaxed;
        self.anonymous_private
            && self
                .data_mappings
                .fetch_update(Relaxed, Relaxed, |n| {
                    (n < crate::memory_image::MAX_MAPPINGS_PER_MEMORY).then_some(n + 1)
                })
                .is_ok()
    }

    /// Return whether any memory has been allocated.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Duplicate in a new memory mapping.
    #[deprecated = "use `copy` instead"]
    pub fn duplicate(&self, size_hint: Option<usize>) -> Result<Self, String> {
        self.copy(size_hint)
    }

    /// Duplicate in a new memory mapping.
    pub fn copy(&self, size_hint: Option<usize>) -> Result<Self, String> {
        // NOTE: accessible_size != used size as the value is not
        //       automatically updated when the pre-provisioned space is used
        let mut copy_size = self.accessible_size;
        if let Some(size_hint) = size_hint {
            copy_size = usize::max(copy_size, size_hint);
        }

        let mut new =
            Self::accessible_reserved(copy_size, self.total_size, None, MmapType::Private, true)?;
        new.as_mut_slice_arbitrary(copy_size)
            .copy_from_slice(self.as_slice_arbitary(copy_size));
        Ok(new)
    }
}

#[cfg(not(target_os = "windows"))]
fn advise_huge_pages(ptr: *mut libc::c_void, len: usize) {
    #[cfg(target_os = "linux")]
    unsafe {
        // This is only a hint; allocation must still succeed if huge pages are unavailable.
        let _ = libc::madvise(ptr, len, libc::MADV_HUGEPAGE);
    }

    // The system call is unavailable on macOS system.
    #[cfg(not(target_os = "linux"))]
    let _ = (ptr, len);
}

impl Drop for Mmap {
    #[cfg(not(target_os = "windows"))]
    fn drop(&mut self) {
        if self.total_size != 0 {
            if self.sync_on_drop {
                let r = unsafe {
                    libc::msync(
                        self.ptr as *mut libc::c_void,
                        self.total_size,
                        libc::MS_SYNC | libc::MS_INVALIDATE,
                    )
                };
                assert_eq!(r, 0, "msync failed: {}", io::Error::last_os_error());
            }
            // iwci patch (#1314): code's addresses stay reserved.
            if self.code {
                code_space::release(self.ptr, self.total_size);
                return;
            }
            let r = unsafe { libc::munmap(self.ptr as *mut libc::c_void, self.total_size) };
            assert_eq!(r, 0, "munmap failed: {}", io::Error::last_os_error());
        }
    }

    #[cfg(target_os = "windows")]
    fn drop(&mut self) {
        if !self.is_empty() {
            use std::ffi::c_void;
            use windows_sys::Win32::System::Memory::{MEM_RELEASE, VirtualFree};
            let r = unsafe { VirtualFree(self.ptr as *mut c_void, 0, MEM_RELEASE) };
            assert_ne!(r, 0);
        }
    }
}

/// iwci patch (#1314): where compiled code is mapped.
///
/// An engine registers its code's unwind information with the system
/// unwinder (`__register_frame`), and the exceptions wasm throws are found
/// by it. libgcc 13 and 14 keep those registrations in a B-tree whose inner
/// separators are not raised for a range inserted across one (GCC PR
/// libgcc/119151, fixed in GCC 15): once a range was deregistered and a new
/// one registered over its old addresses, lookups in the upper part of the
/// new range found nothing, and an exception thrown through that code was
/// reported uncaught. Unloading and loading modules is exactly that, since
/// the kernel hands freed addresses out again. Ruby's setjmp/longjmp through
/// a C extension died this way now and then, with status 134.
///
/// So code is never put where code was: each mapping is carved, in
/// increasing order, from a large reservation that is never returned to the
/// kernel, and a dropped one becomes inaccessible again, its pages freed,
/// with its addresses still reserved. A new range then never overlaps an
/// old one, which is all the B-tree needs. What this costs is address
/// space, the total size of all code ever loaded, out of 128 TiB.
#[cfg(not(target_os = "windows"))]
pub(crate) mod code_space {
    use std::io;
    use std::ptr;
    use std::sync::Mutex;

    /// How much address space each reservation takes.
    const ARENA: usize = 64 << 30;

    #[cfg(target_os = "linux")]
    const NORESERVE: libc::c_int = libc::MAP_NORESERVE;
    #[cfg(not(target_os = "linux"))]
    const NORESERVE: libc::c_int = 0;

    struct Arena {
        next: usize,
        end: usize,
    }

    static ARENA_STATE: Mutex<Arena> = Mutex::new(Arena { next: 0, end: 0 });

    /// Maps `size` bytes (a multiple of the page size) of zeroed read-write
    /// memory at addresses no code has had.
    pub(crate) fn allocate(size: usize) -> Result<usize, String> {
        let mut arena = ARENA_STATE.lock().unwrap_or_else(|e| e.into_inner());
        if arena.end - arena.next < size {
            // A new reservation; what is left of the old one stays reserved.
            // Under a limit on address space (`ulimit -v`) that refuses a
            // large one, a reservation of just this mapping still never
            // reuses an address.
            let reserve = |len: usize| {
                let base = unsafe {
                    libc::mmap(
                        ptr::null_mut(),
                        len,
                        libc::PROT_NONE,
                        libc::MAP_PRIVATE | libc::MAP_ANON | NORESERVE,
                        -1,
                        0,
                    )
                };
                (base != libc::MAP_FAILED).then_some((base as usize, len))
            };
            let Some((base, len)) = reserve(ARENA.max(size)).or_else(|| reserve(size)) else {
                return Err(io::Error::last_os_error().to_string());
            };
            arena.next = base;
            arena.end = base + len;
        }
        let at = arena.next;
        let mapped = unsafe {
            libc::mmap(
                at as *mut libc::c_void,
                size,
                libc::PROT_READ | libc::PROT_WRITE,
                libc::MAP_PRIVATE | libc::MAP_ANON | libc::MAP_FIXED,
                -1,
                0,
            )
        };
        if mapped == libc::MAP_FAILED {
            return Err(io::Error::last_os_error().to_string());
        }
        arena.next += size;
        Ok(at)
    }

    /// Frees the pages of code mapped by [`allocate`] and keeps its
    /// addresses reserved, so nothing is mapped there again.
    pub(crate) fn release(at: usize, size: usize) {
        let r = unsafe {
            libc::mmap(
                at as *mut libc::c_void,
                size,
                libc::PROT_NONE,
                libc::MAP_PRIVATE | libc::MAP_ANON | libc::MAP_FIXED | NORESERVE,
                -1,
                0,
            )
        };
        assert_ne!(
            r,
            libc::MAP_FAILED,
            "reserving freed code failed: {}",
            io::Error::last_os_error()
        );
    }
}

fn _assert() {
    fn _assert_send_sync<T: Send + Sync>() {}
    _assert_send_sync::<Mmap>();
}

// iwci patch (#1314): code is never mapped where code was.
#[cfg(all(test, not(target_os = "windows")))]
mod code_space_tests {
    use super::*;

    fn range(m: &Mmap) -> (usize, usize) {
        (m.as_ptr() as usize, m.as_ptr() as usize + m.len())
    }

    fn overlaps(a: (usize, usize), b: (usize, usize)) -> bool {
        a.0 < b.1 && b.0 < a.1
    }

    #[test]
    fn freed_code_addresses_are_never_handed_out_again() {
        let page = region::page::size();
        let mut seen: Vec<(usize, usize)> = Vec::new();
        let mut held = Vec::new();
        for i in 0..200 {
            let mut code = Mmap::with_at_least(page * (1 + i % 7) - 100, false).unwrap();
            let r = range(&code);
            assert!(
                seen.iter().all(|s| !overlaps(*s, r)),
                "{r:x?} overlaps code mapped before"
            );
            // Zeroed and writable, as an engine's code memory needs.
            assert!(code.as_slice().iter().all(|b| *b == 0));
            code.as_mut_slice().fill(0xcc);
            seen.push(r);
            // Some go at once and others stay a while, as modules come and go.
            if i % 3 == 0 {
                held.push(code);
            }
            if held.len() > 10 {
                held.remove(0);
            }
        }
        drop(held);
        // Nor does anything else land there.
        for _ in 0..50 {
            let data =
                Mmap::accessible_reserved(page * 4, page * 4, None, MmapType::Private, false)
                    .unwrap();
            let r = range(&data);
            assert!(
                seen.iter().all(|s| !overlaps(*s, r)),
                "{r:x?} overlaps freed code"
            );
        }
    }
}
