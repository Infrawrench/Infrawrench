//! `node_modules/.bin`: the commands a package's `bin` field declares,
//! linked where npm scripts find them (`pnpm run` and `bun run` put each
//! `node_modules/.bin` from the project up to the root on `PATH`, so
//! `"lint": "eslint ."` runs `node_modules/.bin/eslint`).
//!
//! A command comes from a package's `package.json`, as pnpm's
//! `@pnpm/bins.resolver` reads it:
//!
//! - `bin` as a string is one command named after the package, without its
//!   scope (`@scope/tool` gives `tool`);
//! - `bin` as a map names each command; a scoped key loses its scope too;
//! - without `bin`, every file under `directories.bin` is a command named
//!   after the file;
//! - a name that is empty, `.`, `..` or not URL-safe (other than `$`) is
//!   skipped, and so is a path that leaves the package.
//!
//! Two packages with a command of the same name are settled as pnpm settles
//! them: a direct dependency of the project beats one that is only hoisted
//! there, then a package named after the command beats one that is not,
//! then the package whose name sorts last, then the higher version.
//!
//! Each command is a relative symbolic link to the file, which is what pnpm
//! writes with `prefer-symlinked-executables` (its default with the hoisted
//! linker) and what Bun writes, rather than pnpm's default shell script: a
//! job's `bash` runs the file by its `#!` line (`#!/usr/bin/env node`), and
//! Node, following the link, resolves the file's own imports from where it
//! really is. The shell script would start `readlink`, `sed` and `uname`
//! as processes on every run. The file is made executable, as pnpm and npm
//! make it: a job's bash does not check, but a native program, or one a
//! WASIX process starts natively in the sandbox, runs only with its bit set
//! (README.md, "File modes").

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use iwci_vfs::SnapshotBuilder;
use iwci_vfs::virtual_fs::FileSystem as _;

/// One command a package declares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub name: String,
    /// The file it runs, relative to the package.
    pub path: String,
}

/// The commands `manifest` (a `package.json`) declares. `list_bin_dir`
/// lists the files under a directory of the package, relative to it, for
/// `directories.bin`.
pub fn commands(
    manifest: &serde_json::Value,
    list_bin_dir: &dyn Fn(&str) -> Vec<String>,
) -> Vec<Command> {
    let mut out = Vec::new();
    match manifest.get("bin") {
        Some(serde_json::Value::String(path)) => {
            if let Some(name) = manifest.get("name").and_then(|name| name.as_str()) {
                push(&mut out, name, path);
            }
        }
        Some(serde_json::Value::Object(map)) => {
            for (name, path) in map {
                if let Some(path) = path.as_str() {
                    push(&mut out, name, path);
                }
            }
        }
        _ => {
            if let Some(dir) = manifest
                .pointer("/directories/bin")
                .and_then(|dir| dir.as_str())
                .and_then(normalise)
            {
                for file in list_bin_dir(&dir) {
                    let name = file.rsplit('/').next().unwrap_or(&file).to_string();
                    push(&mut out, &name, &format!("{dir}/{file}"));
                }
            }
        }
    }
    out
}

fn push(out: &mut Vec<Command>, name: &str, path: &str) {
    let name = match name.strip_prefix('@') {
        Some(scoped) => scoped.split_once('/').map_or(name, |(_, rest)| rest),
        None => name,
    };
    if !safe_name(name) {
        return;
    }
    if let Some(path) = normalise(path) {
        out.push(Command {
            name: name.to_string(),
            path,
        });
    }
}

/// pnpm's `isSafeBinName`: what `encodeURIComponent` leaves as it is.
fn safe_name(name: &str) -> bool {
    if name.is_empty() || name == "." || name == ".." {
        return false;
    }
    name == "$"
        || name.bytes().all(|b| {
            b.is_ascii_alphanumeric()
                || matches!(
                    b,
                    b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
                )
        })
}

/// A path inside a package, `/`-separated with no `.` or `..` left, or
/// `None` when it leaves the package or names it.
fn normalise(path: &str) -> Option<String> {
    let path = path.replace('\\', "/");
    if path.starts_with('/') || path.get(1..2) == Some(":") {
        return None;
    }
    let mut parts: Vec<&str> = Vec::new();
    for part in path.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            part => parts.push(part),
        }
    }
    (!parts.is_empty()).then(|| parts.join("/"))
}

/// A package whose commands may go into one `.bin` directory.
#[derive(Debug, Clone)]
pub struct BinSource {
    /// The package's directory, absolute.
    pub dir: PathBuf,
    /// Whether the project that owns the `.bin` depends on it itself,
    /// rather than having it hoisted into its `node_modules`.
    pub direct: bool,
}

struct Candidate {
    target: PathBuf,
    package: String,
    version: Option<semver::Version>,
    direct: bool,
}

/// Every file under `dir` in the builder's own file system, relative to it.
fn list_files(builder: &SnapshotBuilder, dir: &Path) -> Vec<String> {
    let fs = builder.fs();
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        let Ok(entries) = fs.read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = fs.symlink_metadata(&entry.path) else {
                continue;
            };
            if meta.is_dir() {
                stack.push(entry.path);
            } else if meta.is_file()
                && let Ok(relative) = entry.path.strip_prefix(dir)
            {
                out.push(relative.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    out.sort();
    out
}

/// The links `<bins_dir>/<command>` to make for `sources`, after settling
/// names two of them share: `(link, relative target)`. Each chosen target
/// is given mode 0755 in `builder`. A package without a readable
/// `package.json` has no commands.
pub fn plan(
    builder: &SnapshotBuilder,
    bins_dir: &Path,
    sources: &[BinSource],
) -> Vec<(PathBuf, PathBuf)> {
    let mut chosen: BTreeMap<String, Candidate> = BTreeMap::new();
    for source in sources {
        let Ok(bytes) = builder.read(source.dir.join("package.json")) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        let package = manifest
            .get("name")
            .and_then(|name| name.as_str())
            .unwrap_or_default()
            .to_string();
        let version = manifest
            .get("version")
            .and_then(|version| version.as_str())
            .and_then(|version| semver::Version::parse(version).ok());
        let list = |dir: &str| list_files(builder, &source.dir.join(dir));
        for command in commands(&manifest, &list) {
            let candidate = Candidate {
                target: source.dir.join(&command.path),
                package: package.clone(),
                version: version.clone(),
                direct: source.direct,
            };
            match chosen.get(&command.name) {
                Some(current) if !wins(&command.name, &candidate, current) => {}
                _ => {
                    chosen.insert(command.name, candidate);
                }
            }
        }
    }
    chosen
        .into_iter()
        .map(|(name, candidate)| {
            // A command's file is executable, as pnpm and npm make it
            // (`chmod 755` on each bin target): a job's bash does not ask,
            // but a native one in the sandbox runs only an executable file.
            let _ = builder.set_mode(&candidate.target, 0o755);
            (
                bins_dir.join(&name),
                crate::pnpm::relative(bins_dir, &candidate.target),
            )
        })
        .collect()
}

/// Whether `candidate` takes the command `name` from `current`, as pnpm's
/// `preferDirectCmds` and `compareCommandsInConflict` decide.
fn wins(name: &str, candidate: &Candidate, current: &Candidate) -> bool {
    if candidate.direct != current.direct {
        return candidate.direct;
    }
    let owns = |c: &Candidate| c.package == name;
    if owns(candidate) != owns(current) {
        return owns(candidate);
    }
    if candidate.package != current.package {
        return candidate.package > current.package;
    }
    candidate.version > current.version
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(manifest: &str, files: &[&str]) -> Vec<(String, String)> {
        let manifest: serde_json::Value = serde_json::from_str(manifest).unwrap();
        let files: Vec<String> = files.iter().map(|f| f.to_string()).collect();
        commands(&manifest, &|_| files.clone())
            .into_iter()
            .map(|c| (c.name, c.path))
            .collect()
    }

    #[test]
    fn bin_is_read_as_pnpm_reads_it() {
        assert_eq!(
            names(
                r#"{"name":"eslint","bin":{"eslint":"./bin/eslint.js"}}"#,
                &[]
            ),
            [("eslint".into(), "bin/eslint.js".into())]
        );
        assert_eq!(
            names(r#"{"name":"@vitest/cli","bin":"dist/cli.mjs"}"#, &[]),
            [("cli".into(), "dist/cli.mjs".into())]
        );
        assert_eq!(
            names(r#"{"name":"x","bin":{"@scope/tool":"t.js"}}"#, &[]),
            [("tool".into(), "t.js".into())]
        );
        // Unsafe names and paths out of the package are skipped.
        assert_eq!(
            names(
                r#"{"name":"x","bin":{"..":"a.js","a b":"a.js","ok":"../../etc/passwd","$":"d.js","fine":"lib/../f.js"}}"#,
                &[]
            ),
            [("$".into(), "d.js".into()), ("fine".into(), "f.js".into())]
        );
        // `directories.bin` when there is no `bin`.
        assert_eq!(
            names(
                r#"{"name":"x","directories":{"bin":"./scripts"}}"#,
                &["one", "sub/two.js"]
            ),
            [
                ("one".into(), "scripts/one".into()),
                ("two.js".into(), "scripts/sub/two.js".into())
            ]
        );
        assert!(names(r#"{"name":"x","directories":{"bin":"../out"}}"#, &["a"]).is_empty());
        assert!(names(r#"{"name":"x"}"#, &[]).is_empty());
    }

    fn package(builder: &SnapshotBuilder, dir: &str, manifest: &str) -> BinSource {
        builder
            .write(format!("{dir}/package.json"), manifest.as_bytes())
            .unwrap();
        BinSource {
            dir: PathBuf::from(dir),
            direct: false,
        }
    }

    #[test]
    fn a_shared_name_goes_to_the_package_pnpm_picks() {
        let builder = SnapshotBuilder::new();
        let bins = Path::new("/w/node_modules/.bin");
        let owner = package(
            &builder,
            "/w/node_modules/tsc",
            r#"{"name":"tsc","version":"1.0.0","bin":"bin/tsc"}"#,
        );
        let typescript = package(
            &builder,
            "/w/node_modules/typescript",
            r#"{"name":"typescript","version":"5.0.0","bin":{"tsc":"bin/tsc","tsserver":"bin/tsserver"}}"#,
        );
        let plan_for = |sources: &[BinSource]| -> BTreeMap<String, String> {
            plan(&builder, bins, sources)
                .into_iter()
                .map(|(link, target)| {
                    (
                        link.file_name().unwrap().to_string_lossy().into_owned(),
                        target.display().to_string(),
                    )
                })
                .collect()
        };
        // The package named after the command wins, in either order.
        for sources in [
            vec![owner.clone(), typescript.clone()],
            vec![typescript.clone(), owner.clone()],
        ] {
            let plan = plan_for(&sources);
            assert_eq!(plan["tsc"], "../tsc/bin/tsc");
            assert_eq!(plan["tsserver"], "../typescript/bin/tsserver");
        }
        // A direct dependency beats a hoisted one.
        let direct = BinSource {
            direct: true,
            ..typescript.clone()
        };
        assert_eq!(
            plan_for(&[owner.clone(), direct])["tsc"],
            "../typescript/bin/tsc"
        );
        // Between two others, the name that sorts last, then the version.
        let a = package(
            &builder,
            "/w/node_modules/a",
            r#"{"name":"a","version":"1.0.0","bin":{"run":"a.js"}}"#,
        );
        let b = package(
            &builder,
            "/w/node_modules/b",
            r#"{"name":"b","version":"1.0.0","bin":{"run":"b.js"}}"#,
        );
        assert_eq!(plan_for(&[b.clone(), a.clone()])["run"], "../b/b.js");
        let newer = package(
            &builder,
            "/w/node_modules/.pnpm/b@2.0.0/node_modules/b",
            r#"{"name":"b","version":"2.0.0","bin":{"run":"b.js"}}"#,
        );
        assert_eq!(
            plan_for(&[newer, b])["run"],
            "../.pnpm/b@2.0.0/node_modules/b/b.js"
        );
    }
}
