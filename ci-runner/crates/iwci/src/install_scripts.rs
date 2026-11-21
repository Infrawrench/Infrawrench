//! `install-scripts: true`: after the runner's own install of a workspace's
//! pnpm, npm or Bun dependencies (which runs no script), the install scripts
//! that package manager would run, in a Linux virtual machine, with what
//! they wrote kept in the workspace every job starts from.
//!
//! Which scripts, and in what order, is [`iwci_deps::scripts::plan`]: the
//! package manager's own policy (`allowBuilds`, `allowScripts`,
//! `trustedDependencies`), dependencies before what depends on them, the
//! projects' own last. With none to run, no machine starts.
//!
//! The machine starts from the installed workspace, runs every step as the
//! package manager would (in the package's directory, with npm's lifecycle
//! variables, the `node_modules/.bin` directories above it on the `PATH`
//! and node-gyp pointed at the image's Node headers), and sends back what
//! changed under the clone. That is written into the workspace before it
//! is frozen, and kept in the run's caches under the commit, the workspace
//! and the plan, scoped to the repository and branch as `cache:` entries
//! are: a script may read anything in the commit (`prisma generate` reads
//! the schema, a `prepare` builds the project), so nothing narrower is
//! safe, and nothing a pull request's scripts wrote reaches its base
//! branch.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use iwci_deps::scripts::{Manager, Plan};
use iwci_spec::{Ecosystem, WorkspaceSpec};
use iwci_vfs::virtual_fs::FileSystem;
use iwci_vfs::{Entry, SnapshotBuilder};
use sha2::{Digest, Sha256};

use crate::machines::{Collected, Machines, ScriptRun};
use crate::schedule::Caches;

/// The machine's memory: what a job gets unless it asks.
const MEMORY: u64 = 4 << 30;
/// How long the scripts may take together.
const TIMEOUT: Duration = Duration::from_secs(30 * 60);
/// What the scripts deleted, kept in a cache entry beside what they wrote.
const DELETED: &str = "/.iwci-install-scripts/deleted";
/// The node-gyp npm bundles, and the directory with its `node-gyp`
/// command, in the machine image.
const NODE_GYP: &str = "/usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js";
const NODE_GYP_BIN: &str = "/usr/local/lib/node_modules/npm/bin/node-gyp-bin";

/// What running install scripts needs from the runner.
#[derive(Clone)]
pub struct ScriptHost {
    pub machines: Option<Arc<dyn Machines>>,
    pub caches: Option<Arc<dyn Caches>>,
    /// The commit the workspace is of, for the cache key.
    pub commit: String,
}

/// Runs the install scripts of `spec`'s installs, already written into
/// `builder`, and writes what they changed into it. Lines for the run go
/// to `lines`. An `Err` fails the workspace: a script failed, or there were
/// scripts to run and no machine to run them in.
pub fn run(
    host: Option<&ScriptHost>,
    builder: &SnapshotBuilder,
    spec: &WorkspaceSpec,
    lines: &mut Vec<String>,
) -> Result<(), String> {
    let mut plans: Vec<(String, Manager, Plan)> = Vec::new();
    for dep in &spec.deps {
        let manager = match dep.ecosystem {
            Ecosystem::Npm => Manager::Npm,
            Ecosystem::Pnpm => Manager::Pnpm,
            Ecosystem::Bun => Manager::Bun,
            _ => continue,
        };
        let plan = iwci_deps::scripts::plan(builder.fs(), manager, &dep.dir);
        if plan.ignored {
            lines.push(format!(
                "install scripts ({} in {}): none, ignore-scripts is set",
                manager.name(),
                dep.dir
            ));
        }
        if !plan.blocked.is_empty() {
            lines.push(format!(
                "install scripts ({} in {}): left out, as {}'s settings leave them: {}",
                manager.name(),
                dep.dir,
                manager.name(),
                plan.blocked.join(", ")
            ));
        }
        plans.push((dep.dir.clone(), manager, plan));
    }
    let steps: usize = plans.iter().map(|(_, _, p)| p.steps.len()).sum();
    if steps == 0 {
        lines.push("install scripts: none to run".into());
        return Ok(());
    }
    let named: Vec<String> = plans
        .iter()
        .flat_map(|(_, _, p)| p.steps.iter().map(|s| format!("{}@{}", s.name, s.version)))
        .collect();
    let Some(host) = host else {
        return Err(no_machines(&named));
    };

    // Where the scripts' changes come back from: the clone, which holds
    // every project and `node_modules`.
    let root = spec
        .clone
        .as_ref()
        .map_or_else(|| "/app".to_string(), |c| c.into.clone());
    let key = cache_key(&host.commit, spec, &plans);

    if let Some(caches) = &host.caches {
        match caches.restore(&key, &[], u64::MAX) {
            Ok(Some(found)) => {
                let (deleted, entries): (Vec<Entry>, Vec<Entry>) = found
                    .entries
                    .into_iter()
                    .partition(|e| entry_path(e) == Path::new(DELETED));
                let deleted = deleted_paths(&deleted);
                apply(builder, &deleted, &entries, &found.modes)?;
                lines.push(format!(
                    "install scripts: those of {}, from the cache ({})",
                    count(steps, "package", "packages"),
                    named.join(", ")
                ));
                return Ok(());
            }
            Ok(None) => {}
            Err(e) => lines.push(format!(
                "install scripts: the cache could not be read ({e})"
            )),
        }
    }
    let machines = host.machines.as_ref().ok_or_else(|| no_machines(&named))?;

    // The machine starts from the workspace as it is now.
    let copy = SnapshotBuilder::new();
    copy.apply(&builder.entries())
        .map_err(|e| format!("install scripts: {e}"))?;
    copy.apply_modes(&builder.modes())
        .map_err(|e| format!("install scripts: {e}"))?;
    let snapshot = copy.freeze();
    let fs = snapshot.fork();
    let script = script(&plans);
    let collect = vec![root.clone()];
    let started = std::time::Instant::now();
    let outcome = machines.run_script(ScriptRun {
        id: "install-scripts",
        workspace: &snapshot,
        workspace_key: format!("{}:{}:install-scripts", host.commit, spec.key),
        fs: &fs,
        script: &script,
        env: vec![("CI".into(), "true".into()), ("IWCI".into(), "true".into())],
        cwd: &root,
        collect: &collect,
        memory_bytes: MEMORY,
        timeout: TIMEOUT,
    })?;
    if outcome.exit_code != Some(0) {
        let why = match outcome.exit_code {
            Some(code) => format!("exited with {code}"),
            None => format!("did not finish within {} minutes", TIMEOUT.as_secs() / 60),
        };
        return Err(format!(
            "install scripts {why}:\n{}",
            tail(&format!("{}{}", outcome.stdout, outcome.stderr), 40)
        ));
    }
    let Collected { deleted, entries } = outcome.collected;
    let modes: Vec<(PathBuf, u32)> = entries
        .iter()
        .filter_map(|(e, mode)| mode.map(|m| (entry_path(e).to_path_buf(), m)))
        .collect();
    let entries: Vec<Entry> = entries.into_iter().map(|(e, _)| e).collect();
    apply(builder, &deleted, &entries, &modes)?;
    lines.push(format!(
        "install scripts: ran those of {} in a virtual machine in {:.1} s ({})",
        count(steps, "package", "packages"),
        started.elapsed().as_secs_f64(),
        named.join(", ")
    ));
    if let Some(caches) = &host.caches {
        let mut kept = entries;
        kept.push(Entry::File {
            path: DELETED.into(),
            data: deleted
                .iter()
                .map(|p| format!("{}\n", p.display()))
                .collect::<String>()
                .into_bytes()
                .into(),
        });
        if let Err(e) = caches.save_with_modes(&key, &[], &kept, &modes) {
            lines.push(format!("install scripts: not kept in the cache ({e})"));
        }
    }
    Ok(())
}

fn no_machines(named: &[String]) -> String {
    format!(
        "install-scripts: true: the install scripts of {} to run ({}), and this runner has no Linux virtual machines to run them in",
        count(named.len(), "package", "packages"),
        named.join(", ")
    )
}

fn count(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("1 {one}")
    } else {
        format!("{n} {many}")
    }
}

/// The cache key: the commit, the workspace and the plan, under a version
/// of how they are run.
fn cache_key(commit: &str, spec: &WorkspaceSpec, plans: &[(String, Manager, Plan)]) -> String {
    let steps: Vec<_> = plans
        .iter()
        .map(|(dir, manager, plan)| (dir, manager.name(), &plan.steps))
        .collect();
    let text = serde_json::to_string(&(1, commit, &spec.key, std::env::consts::ARCH, steps))
        .expect("serialisable");
    format!(
        "install-scripts/{}",
        hex::encode(&Sha256::digest(text.as_bytes())[..16])
    )
}

fn entry_path(entry: &Entry) -> &Path {
    match entry {
        Entry::Dir { path } | Entry::File { path, .. } | Entry::Symlink { path, .. } => path,
    }
}

fn deleted_paths(entries: &[Entry]) -> Vec<PathBuf> {
    entries
        .iter()
        .filter_map(|e| match e {
            Entry::File { data, .. } => Some(
                String::from_utf8_lossy(data.as_ref())
                    .lines()
                    .filter(|l| !l.is_empty())
                    .map(PathBuf::from)
                    .collect::<Vec<_>>(),
            ),
            _ => None,
        })
        .flatten()
        .collect()
}

/// Writes the scripts' changes into the workspace: deletions first, then
/// what they wrote, then modes.
fn apply(
    builder: &SnapshotBuilder,
    deleted: &[PathBuf],
    entries: &[Entry],
    modes: &[(PathBuf, u32)],
) -> Result<(), String> {
    for path in deleted {
        remove_all(builder.fs(), path);
    }
    // A file where a directory was, or the other way round, goes first.
    for entry in entries {
        let path = entry_path(entry);
        if let Ok(meta) = builder.fs().symlink_metadata(path) {
            let replace = match entry {
                Entry::Dir { .. } => !meta.is_dir(),
                Entry::File { .. } | Entry::Symlink { .. } => meta.is_dir(),
            };
            if replace {
                remove_all(builder.fs(), path);
            }
        }
    }
    builder
        .apply(entries)
        .map_err(|e| format!("install scripts: {e}"))?;
    builder
        .apply_modes(modes)
        .map_err(|e| format!("install scripts: {e}"))
}

fn remove_all(fs: &(impl FileSystem + ?Sized), path: &Path) {
    let Ok(meta) = fs.symlink_metadata(path) else {
        return;
    };
    if meta.is_dir() {
        if let Ok(children) = fs.read_dir(path) {
            for child in children.flatten() {
                remove_all(fs, &child.path);
            }
        }
        let _ = fs.remove_dir(path);
    } else {
        let _ = fs.remove_file(path);
    }
}

/// The last `n` lines of `text`.
fn tail(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(n)..].join("\n")
}

/// `s` as one `bash` word.
fn quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

/// The script the machine runs: every step of every plan, in order, as the
/// package manager runs a lifecycle script.
pub fn script(plans: &[(String, Manager, Plan)]) -> String {
    let mut out = String::from(
        r#"set -euo pipefail
# The `node_modules/.bin` of the package and of every directory above it,
# nearest first, as the package managers put them on a script's PATH.
iwci_bins() {
  local d=$1 out=""
  while :; do
    [ -d "$d/node_modules/.bin" ] && out="$out${out:+:}$d/node_modules/.bin"
    [ "$d" = / ] && break
    d=$(dirname "$d")
  done
  printf '%s' "$out"
}
# iwci_step <project dir> <user agent> <dir> <name> <version> <event> <command>
iwci_step() {
  local root=$1 agent=$2 dir=$3 name=$4 version=$5 event=$6 cmd=$7
  printf '> %s@%s %s: %s\n' "$name" "$version" "$event" "$cmd" >&2
  local bins
  bins=$(iwci_bins "$dir")
  if ! (
    cd "$dir" &&
      PATH="$bins${bins:+:}"__NODE_GYP_BIN__":$PATH" \
      INIT_CWD="$root" \
      npm_config_local_prefix="$root" \
      npm_config_user_agent="$agent" \
      npm_config_node_gyp=__NODE_GYP__ \
      npm_config_nodedir=/usr/local \
      npm_lifecycle_event="$event" \
      npm_lifecycle_script="$cmd" \
      npm_package_name="$name" \
      npm_package_version="$version" \
      npm_package_json="$dir/package.json" \
      npm_node_execpath="$(command -v node)" \
      sh -c "$cmd"
  ); then
    printf 'iwci: %s@%s %s failed\n' "$name" "$version" "$event" >&2
    exit 1
  fi
}
"#,
    )
    .replace("__NODE_GYP_BIN__", &quote(NODE_GYP_BIN))
    .replace("__NODE_GYP__", &quote(NODE_GYP));
    let mut seen = BTreeSet::new();
    for (dir, manager, plan) in plans {
        let agent = format!("{}/iwci node linux", manager.name());
        for step in &plan.steps {
            if !seen.insert(step.dir.clone()) {
                continue;
            }
            for event in &step.events {
                out.push_str(&format!(
                    "iwci_step {} {} {} {} {} {} {}\n",
                    quote(dir),
                    quote(&agent),
                    quote(&step.dir),
                    quote(&step.name),
                    quote(&step.version),
                    quote(&event.name),
                    quote(&event.command),
                ));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests;
