//! Node tools (`abi: node`): a program from npm, such as a deployment CLI,
//! published as a zstd-compressed tar of its installed directory and run by
//! a job's environment on its own `node` (`tools:`). The directory is
//! unpacked once per runner into a read-only file system and mounted into
//! every job that uses that build; its command is a small bash script.

use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, LazyLock, Mutex, Weak};

use iwci_runtime::{DynFs, PathTree};
use iwci_store::{Blob, ToolManifest};
use iwci_vfs::virtual_fs::FileSystem;

/// Where a Node tool's directory is mounted: `<dir>/<name>/<version>`.
pub const NODE_TOOLS_DIR: &str = "/usr/local/lib/iwci/tools";
/// The most a tool's directory may hold once unpacked, and the most entries
/// it may have: the archive is a stored blob, and a repository can upload
/// one, so it is held to what a real CLI needs with room to spare.
const MAX_TREE_BYTES: u64 = 1 << 30;
const MAX_TREE_ENTRIES: usize = 200_000;

type Trees = Mutex<HashMap<String, Weak<dyn FileSystem + Send + Sync>>>;

/// Unpacked directories by the archive's hash, while a job holds one.
static TREES: LazyLock<Trees> = LazyLock::new(Mutex::default);

/// The tool's directory, mounted, and the script that runs it.
pub fn node_tree(manifest: &ToolManifest, module: &Blob) -> Result<PathTree, String> {
    let dir = format!("{NODE_TOOLS_DIR}/{}/{}", manifest.name, manifest.version);
    Ok(PathTree {
        name: manifest.name.clone(),
        dir: dir.clone(),
        fs: tree_fs(module)?,
        scripts: vec![(manifest.name.clone(), shim(manifest, &dir))],
        needs: Some("node".into()),
    })
}

fn tree_fs(module: &Blob) -> Result<DynFs, String> {
    let mut trees = TREES.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(fs) = trees.get(&module.sha256).and_then(Weak::upgrade) {
        return Ok(fs);
    }
    trees.retain(|_, fs| fs.strong_count() > 0);
    // Unpacked under the lock: two jobs starting together with the same
    // tool unpack it once.
    let fs = unpack(&module.bytes)?;
    trees.insert(module.sha256.clone(), Arc::downgrade(&fs));
    Ok(fs)
}

/// A zstd-compressed tar as a read-only file system: directories, regular
/// files and relative or absolute symbolic links; anything else is refused.
pub fn unpack(bytes: &[u8]) -> Result<DynFs, String> {
    let fail = |e: &dyn std::fmt::Display| format!("unpacking the tool: {e}");
    let decoder = zstd::stream::read::Decoder::new(bytes).map_err(|e| fail(&e))?;
    let mut archive = tar::Archive::new(decoder);
    let builder = iwci_vfs::SnapshotBuilder::new();
    let (mut total, mut count) = (0u64, 0usize);
    for entry in archive.entries().map_err(|e| fail(&e))? {
        let mut entry = entry.map_err(|e| fail(&e))?;
        count += 1;
        if count > MAX_TREE_ENTRIES {
            return Err(fail(&format!("more than {MAX_TREE_ENTRIES} entries")));
        }
        let raw = entry.path().map_err(|e| fail(&e))?.into_owned();
        let Some(text) = raw.to_str() else {
            return Err(fail(&format!("{} is not UTF-8", raw.display())));
        };
        let relative = text.trim_start_matches("./").trim_end_matches('/');
        if relative.is_empty() || relative == "." {
            continue;
        }
        let path = iwci_vfs::normalise(format!("/{relative}"))
            .map_err(|_| fail(&format!("{text} is not a path inside the tool")))?;
        if path.components().any(|c| c.as_os_str() == "..") {
            return Err(fail(&format!("{text} climbs out of the tool")));
        }
        let kind = entry.header().entry_type();
        if kind.is_dir() {
            builder.mkdir_all(&path).map_err(|e| fail(&e))?;
        } else if kind.is_file() {
            total += entry.size();
            if total > MAX_TREE_BYTES {
                return Err(fail(&format!("more than {MAX_TREE_BYTES} bytes")));
            }
            let mut data = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut data).map_err(|e| fail(&e))?;
            builder.write(&path, &data).map_err(|e| fail(&e))?;
            if entry.header().mode().is_ok_and(|m| m & 0o111 != 0) {
                builder.set_mode(&path, 0o755).map_err(|e| fail(&e))?;
            }
        } else if kind.is_symlink() {
            let target = entry
                .link_name()
                .map_err(|e| fail(&e))?
                .ok_or_else(|| fail(&format!("{text} links to nothing")))?;
            if let Some(parent) = path.parent() {
                builder.mkdir_all(parent).map_err(|e| fail(&e))?;
            }
            builder.symlink(&path, &target).map_err(|e| fail(&e))?;
        } else {
            return Err(fail(&format!(
                "{text} is neither a file, a directory nor a link"
            )));
        }
    }
    Ok(builder.freeze().read_only())
}

/// `#!/bin/bash` that runs the tool's script on the environment's `node`
/// with the manifest's arguments, then the caller's.
fn shim(manifest: &ToolManifest, dir: &str) -> Vec<u8> {
    let mut words = vec![quote(&format!("{dir}/{}", manifest.args[0]))];
    words.extend(manifest.args[1..].iter().map(|a| quote(a)));
    format!(
        "#!/bin/bash\n# {}@{}, run on the environment's node (iwci).\nexec node {} \"$@\"\n",
        manifest.name,
        manifest.version,
        words.join(" ")
    )
    .into_bytes()
}

/// One shell word, single-quoted.
fn quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn archive(build: impl FnOnce(&mut tar::Builder<Vec<u8>>)) -> Vec<u8> {
        let mut tar = tar::Builder::new(Vec::new());
        build(&mut tar);
        let raw = tar.into_inner().unwrap();
        zstd::stream::encode_all(&raw[..], 3).unwrap()
    }

    fn file(tar: &mut tar::Builder<Vec<u8>>, path: &str, data: &[u8], mode: u32) {
        let mut header = tar::Header::new_gnu();
        header.set_size(data.len() as u64);
        header.set_mode(mode);
        header.set_entry_type(tar::EntryType::Regular);
        tar.append_data(&mut header, path, data).unwrap();
    }

    fn manifest(args: &[&str]) -> ToolManifest {
        ToolManifest {
            schema: iwci_store::SCHEMA,
            name: "vercel".into(),
            version: "65.16.0".parse().unwrap(),
            abi: iwci_store::Abi::Node,
            module: iwci_store::BlobRef {
                sha256: "0".repeat(64),
                size: 1,
            },
            files: Vec::new(),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: Default::default(),
            description: None,
        }
    }

    #[test]
    fn unpacks_files_directories_and_links() {
        let bytes = archive(|tar| {
            let mut dir = tar::Header::new_gnu();
            dir.set_entry_type(tar::EntryType::Directory);
            dir.set_size(0);
            dir.set_mode(0o755);
            tar.append_data(&mut dir, "./node_modules/", &[][..])
                .unwrap();
            file(tar, "./node_modules/x/cli.js", b"console.log(1)\n", 0o755);
            file(tar, "node_modules/x/package.json", b"{}\n", 0o644);
            let mut link = tar::Header::new_gnu();
            link.set_entry_type(tar::EntryType::Symlink);
            link.set_size(0);
            tar.append_link(&mut link, "node_modules/y", "x").unwrap();
        });
        let fs = unpack(&bytes).unwrap();
        assert_eq!(
            iwci_vfs::read_file(fs.as_ref(), "/node_modules/x/cli.js").unwrap(),
            b"console.log(1)\n"
        );
        assert_eq!(
            iwci_vfs::read_file(fs.as_ref(), "/node_modules/y/package.json").unwrap(),
            b"{}\n"
        );
        // Read only: a job cannot change a tool another job runs.
        assert!(iwci_vfs::write_file(fs.as_ref(), "/node_modules/x/cli.js", b"x").is_err());
    }

    #[test]
    fn refuses_what_is_not_a_tool_directory() {
        let climbing = archive(|tar| {
            // `tar::Builder` refuses `..` itself, so write the name raw.
            let mut header = tar::Header::new_gnu();
            header.set_size(1);
            header.set_mode(0o644);
            header.set_entry_type(tar::EntryType::Regular);
            header.as_old_mut().name[..9].copy_from_slice(b"../escape");
            header.set_cksum();
            tar.append(&header, &b"x"[..]).unwrap();
        });
        // Refused by the path check or, before it, by the archive reader.
        let err = unpack(&climbing).unwrap_err();
        assert!(err.contains("escape"), "{err}");
        let fifo = archive(|tar| {
            let mut header = tar::Header::new_gnu();
            header.set_size(0);
            header.set_entry_type(tar::EntryType::Fifo);
            tar.append_data(&mut header, "pipe", &[][..]).unwrap();
        });
        assert!(unpack(&fifo).unwrap_err().contains("neither"));
        assert!(unpack(b"not zstd").is_err());
    }

    #[test]
    fn the_command_runs_the_script_on_node_with_quoted_arguments() {
        let m = manifest(&["node_modules/x/cli.js", "--no-analytics", "it's"]);
        let script =
            String::from_utf8(shim(&m, "/usr/local/lib/iwci/tools/vercel/65.16.0")).unwrap();
        assert_eq!(
            script,
            "#!/bin/bash\n# vercel@65.16.0, run on the environment's node (iwci).\n\
             exec node '/usr/local/lib/iwci/tools/vercel/65.16.0/node_modules/x/cli.js' '--no-analytics' 'it'\\''s' \"$@\"\n"
        );
    }

    #[test]
    fn a_build_is_unpacked_once_while_jobs_hold_it() {
        let bytes = archive(|tar| file(tar, "a.js", b"1", 0o644));
        let blob = Blob {
            sha256: "ab".repeat(32),
            bytes: bytes.into(),
        };
        let m = manifest(&["a.js"]);
        let first = node_tree(&m, &blob).unwrap();
        let second = node_tree(&m, &blob).unwrap();
        assert!(Arc::ptr_eq(&first.fs, &second.fs));
        assert_eq!(first.dir, "/usr/local/lib/iwci/tools/vercel/65.16.0");
        assert_eq!(first.needs.as_deref(), Some("node"));
        assert_eq!(first.scripts[0].0, "vercel");
    }
}
