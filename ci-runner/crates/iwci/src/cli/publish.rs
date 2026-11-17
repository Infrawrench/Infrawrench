//! `iwci publish <dist-dir>...`: uploads what `builtins/*/build.sh` built.
//! Each directory has a `build.json` naming its files; blobs go up first
//! (skipped when already present), the manifest last and create-only, so a
//! version is never half-published and never changes once it is.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::process::ExitCode;

use iwci_store::{
    Abi, EnvCache, EnvDraft, EnvEntry, FileSource, Namespace, PackageSource, TargetSource,
    ToolDraft, Version,
};
use serde::Deserialize;

use super::{Args, style};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Build {
    kind: Kind,
    name: String,
    version: String,
    #[serde(default)]
    abi: Option<Abi>,
    #[serde(default)]
    module: Option<String>,
    #[serde(default)]
    files: Vec<BuildFile>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: BTreeMap<String, String>,
    #[serde(default)]
    entry: Option<EnvEntry>,
    #[serde(default)]
    packages: Vec<BuildPackage>,
    /// An environment's caches, as the manifest has them.
    #[serde(default)]
    caches: Vec<EnvCache>,
    #[serde(default)]
    description: Option<String>,
    /// A native builtin's program and files, by target.
    #[serde(default)]
    targets: BTreeMap<String, BuildTarget>,
    #[serde(default)]
    aliases: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BuildTarget {
    program: String,
    #[serde(default)]
    files: Vec<BuildFile>,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum Kind {
    Builtin,
    Environment,
    /// Files the runner pins by digest in its own source (the gem builds,
    /// `crate::gem_builds`): uploaded as blobs, with no manifest.
    Blobs,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BuildFile {
    path: String,
    file: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct BuildPackage {
    name: String,
    version: String,
    file: String,
}

pub fn publish(mut args: Args) -> Result<ExitCode, String> {
    let cache = super::cache_dir(&mut args)?;
    let store = super::store::open(&mut args, &cache)?;
    let dirs = args.rest();
    if dirs.is_empty() {
        return Err("usage: iwci publish <dist-dir>... [--store <dir>]".into());
    }
    for dir in dirs {
        let dir = PathBuf::from(dir);
        let build: Build = {
            let path = dir.join("build.json");
            let text = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            serde_json::from_slice(&text).map_err(|e| format!("{}: {e}", path.display()))?
        };
        let version: Version = build
            .version
            .parse()
            .map_err(|e| format!("{}: version: {e}", dir.display()))?;
        let at = |file: &str| -> Result<PathBuf, String> {
            // A build.json names files beside it, never elsewhere.
            if file.contains('/') || file == ".." {
                return Err(format!(
                    "{}: `{file}` must be a file name in the same directory",
                    dir.display()
                ));
            }
            Ok(dir.join(file))
        };
        let sources = |files: &[BuildFile]| -> Result<Vec<FileSource>, String> {
            files
                .iter()
                .map(|f| {
                    Ok(FileSource {
                        guest_path: f.path.clone(),
                        source: at(&f.file)?,
                    })
                })
                .collect()
        };
        let report = match build.kind {
            Kind::Builtin => {
                let draft = ToolDraft {
                    name: build.name.clone(),
                    version,
                    abi: build.abi.ok_or("a builtin needs `abi`")?,
                    // A native builtin has `targets` instead.
                    module: build.module.as_deref().map(at).transpose()?,
                    files: sources(&build.files)?,
                    args: build.args,
                    env: build.env,
                    description: build.description,
                    targets: build
                        .targets
                        .iter()
                        .map(|(target, t)| {
                            Ok((
                                target.clone(),
                                TargetSource {
                                    program: at(&t.program)?,
                                    files: sources(&t.files)?,
                                },
                            ))
                        })
                        .collect::<Result<_, String>>()?,
                    aliases: build.aliases,
                };
                iwci_store::publish_tool(store.as_ref(), &Namespace::Builtin, &draft)
                    .map(|(_, report)| report)
            }
            Kind::Blobs => {
                let files = build
                    .files
                    .iter()
                    .map(|f| at(&f.file))
                    .collect::<Result<Vec<_>, String>>()?;
                let (uploaded, skipped) = iwci_store::publish_blobs(store.as_ref(), &files)
                    .map_err(|e| format!("{}: {e}", dir.display()))?;
                println!(
                    "{} {}@{} as blobs ({} uploaded, {} already there): {}",
                    style::ok("published"),
                    build.name,
                    version,
                    uploaded.len(),
                    skipped.len(),
                    uploaded
                        .iter()
                        .chain(&skipped)
                        .map(|d| format!("sha256:{d}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                continue;
            }
            Kind::Environment => {
                let draft = EnvDraft {
                    name: build.name.clone(),
                    version,
                    packages: build
                        .packages
                        .iter()
                        .map(|p| {
                            Ok(PackageSource {
                                name: p.name.clone(),
                                version: p
                                    .version
                                    .parse()
                                    .map_err(|e| format!("{}: {e}", p.name))?,
                                source: at(&p.file)?,
                            })
                        })
                        .collect::<Result<_, String>>()?,
                    entry: build.entry.ok_or("an environment needs `entry`")?,
                    env: build.env,
                    caches: build.caches,
                    description: build.description,
                };
                iwci_store::publish_env(store.as_ref(), &draft).map(|(_, report)| report)
            }
        }
        .map_err(|e| format!("{}: {e}", dir.display()))?;
        println!(
            "{} {} ({:?}; {} uploaded, {} already there)",
            style::ok("published"),
            report.manifest_key,
            report.outcome,
            report.uploaded.len(),
            report.skipped.len()
        );
    }
    Ok(ExitCode::SUCCESS)
}
