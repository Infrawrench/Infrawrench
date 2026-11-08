//! A flat encoding of [`Entry`] lists, for anything that stores a piece of
//! a file system: job caches today. Callers compress the stream; this only
//! frames it. Paths are UTF-8, lengths little-endian.

use std::io::{self, Read, Write};
use std::path::PathBuf;

use crate::Entry;

const MAGIC: &[u8; 8] = b"IWCIENTS";
const FORMAT: u32 = 1;
/// Paths and link targets are short; a longer one is a damaged stream.
const MAX_PATH: u32 = 1 << 16;

fn bad(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.to_string())
}

fn write_str(w: &mut impl Write, s: &str) -> io::Result<()> {
    let len = u32::try_from(s.len()).map_err(|_| bad("path too long"))?;
    w.write_all(&len.to_le_bytes())?;
    w.write_all(s.as_bytes())
}

fn read_u32(r: &mut impl Read) -> io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

fn read_u64(r: &mut impl Read) -> io::Result<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}

fn read_path(r: &mut impl Read) -> io::Result<PathBuf> {
    let len = read_u32(r)?;
    if len > MAX_PATH {
        return Err(bad("path too long"));
    }
    let mut buf = vec![0u8; len as usize];
    r.read_exact(&mut buf)?;
    let text = String::from_utf8(buf).map_err(|_| bad("path is not UTF-8"))?;
    // Every path that comes back goes through the same check as any other
    // untrusted path, so a stored `../` cannot escape where it is applied.
    crate::normalise(&text).map_err(|_| bad("path is not absolute and normalised"))
}

pub fn encode(w: &mut impl Write, entries: &[Entry]) -> io::Result<()> {
    w.write_all(MAGIC)?;
    w.write_all(&FORMAT.to_le_bytes())?;
    w.write_all(&(entries.len() as u64).to_le_bytes())?;
    for entry in entries {
        let text = |p: &std::path::Path| {
            p.to_str()
                .map(str::to_string)
                .ok_or_else(|| bad("path is not UTF-8"))
        };
        match entry {
            Entry::Dir { path } => {
                w.write_all(&[0])?;
                write_str(w, &text(path)?)?;
            }
            Entry::File { path, data } => {
                w.write_all(&[1])?;
                write_str(w, &text(path)?)?;
                w.write_all(&(data.len() as u64).to_le_bytes())?;
                w.write_all(data)?;
            }
            Entry::Symlink { path, target } => {
                w.write_all(&[2])?;
                write_str(w, &text(path)?)?;
                write_str(w, &text(target)?)?;
            }
        }
    }
    Ok(())
}

/// Decodes a stream `encode` wrote. `max_bytes` bounds the file contents
/// it will hold in memory.
pub fn decode(r: &mut impl Read, max_bytes: u64) -> io::Result<Vec<Entry>> {
    let mut magic = [0u8; 8];
    r.read_exact(&mut magic)?;
    if &magic != MAGIC || read_u32(r)? != FORMAT {
        return Err(bad("not an entry stream this runner writes"));
    }
    let count = read_u64(r)?;
    let mut entries = Vec::new();
    let mut total = 0u64;
    for _ in 0..count {
        let mut kind = [0u8; 1];
        r.read_exact(&mut kind)?;
        let path = read_path(r)?;
        entries.push(match kind[0] {
            0 => Entry::Dir { path },
            1 => {
                let len = read_u64(r)?;
                total = total.saturating_add(len);
                if total > max_bytes {
                    return Err(bad("larger than allowed"));
                }
                let mut data = vec![0u8; usize::try_from(len).map_err(|_| bad("file too large"))?];
                r.read_exact(&mut data)?;
                Entry::File {
                    path,
                    data: data.into(),
                }
            }
            2 => {
                let len = read_u32(r)?;
                if len > MAX_PATH {
                    return Err(bad("link target too long"));
                }
                let mut buf = vec![0u8; len as usize];
                r.read_exact(&mut buf)?;
                let target = String::from_utf8(buf).map_err(|_| bad("link target is not UTF-8"))?;
                Entry::Symlink {
                    path,
                    target: target.into(),
                }
            }
            _ => return Err(bad("unknown entry kind")),
        });
    }
    Ok(entries)
}
