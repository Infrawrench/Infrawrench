//! Unpacking npm package tarballs into memory.
//!
//! An npm tarball is a gzipped tar whose entries all sit under one top
//! directory (`package/` for anything `npm pack` made, the bare name for
//! some older `@types` tarballs); that first component is dropped, as npm
//! does. Symlinks and hard links are skipped, as npm skips them, so a
//! tarball cannot point a path outside its package. An entry whose path
//! climbs out with `..` or is absolute fails the whole package rather than
//! being skipped: a registry serving one is not to be trusted with the rest.

use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;

/// The default cap on one package's unpacked size. The biggest packages in
/// practice (prebuilt toolchains) unpack to a few hundred megabytes; this
/// stops a small tarball that inflates without end.
pub const DEFAULT_MAX_UNPACKED_BYTES: u64 = 2 << 30;

/// The regular files of a package tarball (path relative to the package
/// root, to contents), and which of them the tarball marks executable, as
/// npm, pnpm and Bun keep them: a program a package ships (turbo's,
/// sherif's) runs natively only with its bit set.
pub fn extract_with_executables(bytes: &[u8], max_unpacked: u64) -> Result<Unpacked, String> {
    // Every npm tarball is gzipped, but a plain tar costs nothing to accept.
    if bytes.starts_with(&[0x1f, 0x8b]) {
        unpack(flate2::read::MultiGzDecoder::new(bytes), max_unpacked)
    } else {
        unpack(bytes, max_unpacked)
    }
}

/// A package's files by path, and the paths of its executables.
pub type Unpacked = (BTreeMap<String, Vec<u8>>, BTreeSet<String>);

fn unpack(reader: impl Read, max_unpacked: u64) -> Result<Unpacked, String> {
    let mut archive = tar::Archive::new(reader);
    let mut files = BTreeMap::new();
    let mut executables = BTreeSet::new();
    let mut total = 0u64;
    let entries = archive.entries().map_err(|e| e.to_string())?;
    for entry in entries {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_contiguous()) {
            continue;
        }
        let raw = entry.path_bytes();
        let raw = std::str::from_utf8(&raw)
            .map_err(|_| "an entry's path is not UTF-8".to_string())?
            .to_string();
        let Some(path) = package_relative(&raw)? else {
            continue;
        };
        let size = entry.header().size().map_err(|e| e.to_string())?;
        total = total.saturating_add(size);
        if total > max_unpacked {
            return Err(format!("unpacks to more than {max_unpacked} bytes"));
        }
        let mut contents = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
        entry
            .read_to_end(&mut contents)
            .map_err(|e| format!("{raw}: {e}"))?;
        if entry.header().mode().is_ok_and(|mode| mode & 0o111 != 0) {
            executables.insert(path.clone());
        }
        files.insert(path, contents);
    }
    Ok((files, executables))
}

/// `raw` without its first component, or `None` for the top directory
/// itself. Errors on anything that would land outside the package.
fn package_relative(raw: &str) -> Result<Option<String>, String> {
    if raw.starts_with('/') {
        return Err(format!("{raw}: absolute or escaping entry"));
    }
    let parts: Vec<&str> = raw
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    if parts.contains(&"..") {
        return Err(format!("{raw}: entry climbs out of the package"));
    }
    if parts.len() < 2 {
        return Ok(None);
    }
    Ok(Some(parts[1..].join("/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_top_directory_is_stripped() {
        assert_eq!(
            package_relative("package/lib/a.js").unwrap().as_deref(),
            Some("lib/a.js")
        );
        assert_eq!(
            package_relative("./node/index.d.ts").unwrap().as_deref(),
            Some("index.d.ts")
        );
        assert_eq!(package_relative("package/").unwrap(), None);
        assert!(package_relative("package/../../x").is_err());
        assert!(package_relative("/etc/passwd").is_err());
        assert!(package_relative("../x/y").is_err());
    }

    /// A program a package ships keeps its executable bit.
    #[test]
    fn executables_are_the_files_the_tarball_marks() {
        let mut tar = tar::Builder::new(Vec::new());
        for (path, mode) in [("package/bin/turbo", 0o755), ("package/README.md", 0o644)] {
            let mut header = tar::Header::new_gnu();
            header.set_size(2);
            header.set_mode(mode);
            header.set_cksum();
            tar.append_data(&mut header, path, &b"hi"[..]).unwrap();
        }
        let bytes = tar.into_inner().unwrap();
        let (files, executables) = extract_with_executables(&bytes, 1 << 20).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(executables.into_iter().collect::<Vec<_>>(), ["bin/turbo"]);
    }
}
