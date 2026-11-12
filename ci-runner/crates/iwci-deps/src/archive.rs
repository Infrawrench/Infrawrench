//! Reading a zip that a lockfile pinned (a wheel, a Composer dist) into
//! memory, refusing anything that could write outside where it is unpacked.

use std::io::{Cursor, Read};

/// One file of an archive. Directories are implied by the paths and not
/// returned.
#[derive(Debug, Clone)]
pub(crate) struct ArchiveFile {
    /// Relative, `/`-separated, with no empty, `.` or `..` component.
    pub path: String,
    pub data: Vec<u8>,
    pub executable: bool,
}

/// The files of the zip in `bytes`, at most `max_files` of them and
/// `max_unpacked` bytes in all.
pub(crate) fn read_zip(
    bytes: &[u8],
    max_files: usize,
    max_unpacked: u64,
) -> Result<Vec<ArchiveFile>, String> {
    let mut archive =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("unreadable zip: {e}"))?;
    if archive.len() > max_files {
        return Err(format!(
            "{} entries, over the limit of {max_files}",
            archive.len()
        ));
    }
    let mut files = Vec::with_capacity(archive.len());
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|e| format!("unreadable zip entry {index}: {e}"))?;
        let name = std::str::from_utf8(entry.name_raw())
            .map_err(|_| format!("zip entry {index} has a name that is not UTF-8"))?
            .to_string();
        if entry.is_dir() {
            check_path(name.trim_end_matches('/'))?;
            continue;
        }
        let mode = entry.unix_mode().unwrap_or(0o644);
        if mode & 0o170000 == 0o120000 {
            return Err(format!("{name}: a symbolic link"));
        }
        check_path(&name)?;
        let declared = entry.size();
        total = total.saturating_add(declared);
        if total > max_unpacked {
            return Err(format!("over {max_unpacked} bytes unpacked"));
        }
        // Never trust the declared size for the allocation, and stop one
        // byte past it so a lying header cannot inflate without bound.
        let mut data = Vec::with_capacity(declared.min(1 << 20) as usize);
        (&mut entry)
            .take(declared.saturating_add(1))
            .read_to_end(&mut data)
            .map_err(|e| format!("{name}: {e}"))?;
        if data.len() as u64 > declared {
            return Err(format!("{name}: larger than its declared size"));
        }
        files.push(ArchiveFile {
            path: name,
            data,
            executable: mode & 0o111 != 0,
        });
    }
    Ok(files)
}

/// A relative `/`-separated path that stays where it is put.
pub(crate) fn check_path(path: &str) -> Result<(), String> {
    if path.is_empty() {
        return Ok(());
    }
    if path.starts_with('/') || path.contains('\\') || path.contains('\0') {
        return Err(format!("{path:?}: not a relative path"));
    }
    for part in path.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return Err(format!("{path:?}: escapes the archive"));
        }
    }
    Ok(())
}

/// The single directory every file sits in, as a GitHub zipball and most
/// dist archives have, or `None` when there is not exactly one.
pub(crate) fn common_root(files: &[ArchiveFile]) -> Option<String> {
    let mut root: Option<&str> = None;
    for file in files {
        let (first, rest) = file.path.split_once('/')?;
        if rest.is_empty() {
            return None;
        }
        match root {
            None => root = Some(first),
            Some(r) if r == first => {}
            Some(_) => return None,
        }
    }
    root.map(str::to_string)
}

#[cfg(test)]
pub(crate) fn zip_of(files: &[(&str, &[u8])]) -> Vec<u8> {
    use std::io::Write;
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (name, data) in files {
        writer.start_file(*name, options).unwrap();
        writer.write_all(data).unwrap();
    }
    writer.finish().unwrap().into_inner()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_paths_that_escape() {
        for bad in ["../x", "a/../../x", "/etc/passwd", "a//b", "a\\b"] {
            let zip = zip_of(&[(bad, b"x")]);
            assert!(read_zip(&zip, 10, 1 << 20).is_err(), "{bad}");
        }
        let zip = zip_of(&[("pkg/a.py", b"x"), ("pkg/sub/b.py", b"y")]);
        let files = read_zip(&zip, 10, 1 << 20).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(common_root(&files).as_deref(), Some("pkg"));
        assert!(read_zip(&zip, 1, 1 << 20).is_err());
        assert!(read_zip(&zip, 10, 1).is_err());
    }
}
