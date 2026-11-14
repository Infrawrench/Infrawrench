use super::*;
use crate::syscalls::*;

/// ### `path_unlink_file()`
/// Unlink a file, deleting if the number of hardlinks is 1
/// Inputs:
/// - `Fd fd`
///     The base file descriptor from which the path is understood
/// - `const char *path`
///     Array of UTF-8 bytes representing the path
/// - `u32 path_len`
///     The number of bytes in the `path` array
#[instrument(level = "trace", skip_all, fields(%fd, path = field::Empty), ret)]
pub fn path_unlink_file<M: MemorySize>(
    mut ctx: FunctionEnvMut<'_, WasiEnv>,
    fd: WasiFd,
    path: WasmPtr<u8, M>,
    path_len: M::Offset,
) -> Result<Errno, WasiError> {
    WasiEnv::do_pending_operations(&mut ctx)?;

    let env = ctx.data();
    let (memory, mut state, inodes) = unsafe { env.get_memory_and_wasi_state_and_inodes(&ctx, 0) };

    let path_str = unsafe { get_input_str_ok!(&memory, path, path_len) };
    let base_dir = wasi_try_ok!(state.fs.get_path_base_fd(fd, &path_str));
    if !base_dir.inner.rights.contains(Rights::PATH_UNLINK_FILE) {
        return Ok(Errno::Access);
    }
    Span::current().record("path", path_str.as_str());

    let ret = path_unlink_file_internal(&mut ctx, fd, &path_str)?;
    let env = ctx.data();

    if ret == Errno::Success {
        #[cfg(feature = "journal")]
        if env.enable_journal {
            wasi_try_ok!(
                JournalEffector::save_path_unlink(&mut ctx, fd, path_str).map_err(|err| {
                    tracing::error!("failed to save unlink event - {}", err);
                    Errno::Fault
                })
            )
        }
    }

    Ok(ret)
}

pub(crate) fn path_unlink_file_internal(
    ctx: &mut FunctionEnvMut<'_, WasiEnv>,
    fd: WasiFd,
    path: &str,
) -> Result<Errno, WasiError> {
    let env = ctx.data();
    let (memory, mut state, inodes) = unsafe { env.get_memory_and_wasi_state_and_inodes(&ctx, 0) };

    // iwci patch (#1139): one unlink or rename at a time in this inode tree,
    // from the lookup below to the file's removal from the file system. The
    // name's entry used to leave the cache, its link count drop and the file
    // leave the file system in three steps any other unlink or rename of
    // the name could run between: an unlink that had looked the name up
    // before another unlinked it and a third thread put a new file there
    // found the new file's entry, `debug_assert!`ed on the old inode's count
    // of 0 and panicked, and one that found a file renamed there `assert!`ed
    // that it was the inode it had looked up. The lock `path_rename` (and a
    // creating open) holds makes them atomic, as on Linux: one unlink takes
    // the name, a racing one gets `ENOENT`, and a rename or a creation lands
    // wholly before or after.
    let rename_lock = state.fs.rename_lock.clone();
    let _one_at_a_time = rename_lock
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);

    let inode = wasi_try_ok!(state.fs.get_inode_at_path(inodes, fd, path, false));
    let (parent_inode, child_name) = wasi_try_ok!(state.fs.get_parent_inode_at_path(
        inodes,
        fd,
        std::path::Path::new(path),
        false
    ));
    let host_adjusted_path = {
        let guard = parent_inode.read();
        match guard.deref() {
            Kind::Dir { path, .. } => path.join(&child_name),
            Kind::Root { .. } => return Ok(Errno::Access),
            _ => unreachable!(
                "Internal logic error in wasi::path_unlink_file, parent is not a directory"
            ),
        }
    };

    // Reject directories before touching the parent's cached entries or the
    // inode's link count: a failed `path_unlink_file` must leave no side
    // effects, otherwise the directory would be evicted from the cache and
    // later `path_remove_directory` calls would lose track of it (returning
    // `ENOENT` and leaving the real directory tree in place).
    if matches!(inode.read().deref(), Kind::Dir { .. } | Kind::Root { .. }) {
        return Ok(Errno::Isdir);
    }

    let removed_inode = {
        let mut guard = parent_inode.write();
        let entry = match guard.deref_mut() {
            Kind::Dir { entries, .. } => {
                // iwci patch (#1139): what the name holds now is what goes,
                // as on Linux; a directory stays where it is (see above).
                if entries.get(&child_name).is_some_and(|entry| {
                    matches!(entry.read().deref(), Kind::Dir { .. } | Kind::Root { .. })
                }) {
                    return Ok(Errno::Isdir);
                }
                entries.remove(&child_name)
            }
            Kind::Root { .. } => return Ok(Errno::Access),
            _ => unreachable!(
                "Internal logic error in wasi::path_unlink_file, parent is not a directory"
            ),
        };
        let Some(removed_inode) = entry else {
            drop(guard);

            let inode_is_symlink = matches!(inode.read().deref(), Kind::Symlink { .. });
            if !inode_is_symlink {
                tracing::warn!(
                    "wasi::path_unlink_file: path resolution returned inode {:?} for {:?}, but parent directory had no matching entry",
                    inode.ino(),
                    child_name
                );
                return Ok(Errno::Noent);
            }
            return Ok(state.fs.remove_symlink_file(host_adjusted_path.as_path()));
        };
        removed_inode
    };

    // iwci patch (#1139): a count already at 0 is an entry some earlier
    // unlink left behind, not a link to remove; never take it below 0 (a
    // `u64` would wrap and the file's handle would never be released).
    let st_nlink = {
        let mut guard = removed_inode.stat.write().unwrap();
        let Some(st_nlink) = guard.st_nlink.checked_sub(1) else {
            return Ok(Errno::Noent);
        };
        guard.st_nlink = st_nlink;
        st_nlink
    };
    if st_nlink == 0 {
        {
            let mut guard = removed_inode.read();
            match guard.deref() {
                Kind::File { handle, path, .. } => {
                    if let Some(h) = handle {
                        let mut h = h.write().unwrap();
                        wasi_try_ok!(h.unlink().map_err(fs_error_into_wasi_err));
                    } else {
                        // File is closed
                        // problem with the abstraction, we can't call unlink because there's no handle
                        // drop mutable borrow on `path`
                        let path = path.clone();
                        drop(guard);
                        wasi_try_ok!(state.fs_remove_file(path));
                    }
                }
                Kind::Dir { .. } | Kind::Root { .. } => return Ok(Errno::Isdir),
                Kind::Symlink { .. } => {
                    drop(guard);
                    let errno = state.fs.remove_symlink_file(host_adjusted_path.as_path());
                    if errno != Errno::Success {
                        return Ok(errno);
                    }
                }
                _ => unimplemented!("wasi::path_unlink_file for Buffer"),
            }
        }
    }

    Ok(Errno::Success)
}
