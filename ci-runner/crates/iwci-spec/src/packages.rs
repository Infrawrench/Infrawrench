//! `packages:` jobs: one job per workspace package, ordered by the
//! packages' dependencies the way Turborepo orders a task.
//!
//! Before anything else is validated, a job with `packages:` is replaced by
//! one job per package it selects, keyed `<job>[<package dir>]`, and every
//! `needs:` that names a `packages:` job is rewritten:
//!
//! - `^build` (in a `packages:` job): the `build` of each workspace package
//!   this one depends on. A dependency without a `build` (filtered out) is
//!   looked through to its own dependencies, so the order still holds.
//! - `build` (in a `packages:` job): the same package's `build`, if it has
//!   one.
//! - `build` (in any other job): every package's `build`.
//!
//! From there on each package's job is an ordinary job, so readiness,
//! skipping, artifacts (handed on through `needs`, transitively) and the
//! task cache work as they do for any other.

use std::collections::{BTreeSet, HashMap};

use indexmap::IndexMap;

use crate::plan::PackageRef;
use crate::raw;
use crate::workspace::{Package, WorkspacePackages};
use crate::{PackagesSource, SpecError, is_name};

/// The package of each job `expand` made, by its key.
pub(crate) type Generated = HashMap<String, PackageRef>;

/// The directory the placeholder package has when the repository is not
/// known (`iwci validate`), so a `packages:` job is still checked.
pub const PLACEHOLDER_DIR: &str = "packages/example";

pub(crate) fn expand(
    pipeline: &mut raw::Pipeline,
    source: &PackagesSource,
    errors: &mut Vec<SpecError>,
) -> Generated {
    let mut generated = Generated::new();
    let wanted: Vec<String> = pipeline
        .jobs
        .iter()
        .filter(|(_, j)| {
            matches!(
                j.packages,
                Some(raw::Packages::Filter(_)) | Some(raw::Packages::All(true))
            )
        })
        .map(|(k, _)| k.clone())
        .collect();
    let mut error = |path: String, message: String| errors.push(SpecError { path, message });
    if wanted.is_empty() {
        for (key, job) in pipeline.jobs.iter_mut() {
            job.needs.retain(|need| match need.strip_prefix('^') {
                Some(base) => {
                    error(
                        format!("jobs.{key}.needs"),
                        format!("`^{base}` only means something in a job with `packages:`"),
                    );
                    false
                }
                None => true,
            });
        }
        return generated;
    }

    let placeholder;
    let workspace: &WorkspacePackages = match source {
        PackagesSource::Found(ws) => ws,
        PackagesSource::Unknown => {
            placeholder = WorkspacePackages {
                packages: vec![Package {
                    dir: PLACEHOLDER_DIR.into(),
                    name: "example".into(),
                    scripts: Default::default(),
                    deps: Vec::new(),
                    entries: BTreeSet::new(),
                }],
            };
            &placeholder
        }
        PackagesSource::Missing => {
            for key in &wanted {
                error(
                    format!("jobs.{key}.packages"),
                    "the repository declares no workspace: add a `pnpm-workspace.yaml`, or `workspaces` to the root `package.json`".into(),
                );
            }
            remove(pipeline, &wanted);
            return generated;
        }
        PackagesSource::Invalid(message) => {
            for key in &wanted {
                error(
                    format!("jobs.{key}.packages"),
                    format!("could not read the workspace: {message}"),
                );
            }
            remove(pipeline, &wanted);
            return generated;
        }
    };
    let filtering = !matches!(source, PackagesSource::Unknown);

    // Which packages each `packages:` job runs in.
    let mut selected: HashMap<String, BTreeSet<String>> = HashMap::new();
    for key in &wanted {
        let job = &pipeline.jobs[key];
        let path = format!("jobs.{key}");
        if !is_name(key) {
            // Reported by the validator once the key is back; generate
            // nothing from a key that could not be one.
            continue;
        }
        if job.matrix.is_some() {
            error(
                format!("{path}.matrix"),
                "a `packages:` job already has one entry per package; it cannot have a matrix too"
                    .into(),
            );
        }
        if !job.outputs.is_empty() {
            error(
                format!("{path}.outputs"),
                "a `packages:` job cannot declare outputs: every package would write the same names".into(),
            );
        }
        if matches!(job.changes, Some(raw::Changes::Commit(_))) {
            error(
                format!("{path}.changes"),
                "a `packages:` job cannot commit: each package would make its own commit".into(),
            );
        }
        let filter = match &job.packages {
            Some(raw::Packages::Filter(f)) => f.clone(),
            _ => raw::PackageFilter::default(),
        };
        let mut ok = true;
        for pattern in &filter.only {
            if let Err(e) = crate::glob::check_filter(pattern) {
                error(format!("{path}.packages.only"), e);
                ok = false;
            }
        }
        for name in &filter.has {
            if name.is_empty() || name.contains('/') || name == "." || name == ".." {
                error(
                    format!("{path}.packages.has"),
                    format!("`{name}` must be one name directly in the package's directory"),
                );
                ok = false;
            }
        }
        for (script, pattern) in &filter.scripts {
            let body = pattern.strip_prefix('!').unwrap_or(pattern);
            if body.is_empty() || command_glob(body).is_err() {
                error(
                    format!("{path}.packages.scripts.{script}"),
                    format!("`{pattern}` is not a glob over the script's command"),
                );
                ok = false;
            }
        }
        let picked: BTreeSet<String> = if !ok {
            BTreeSet::new()
        } else {
            workspace
                .packages
                .iter()
                .filter(|p| !filtering || lets_through(&filter, p))
                .map(|p| p.dir.clone())
                .collect()
        };
        selected.insert(key.clone(), picked);
    }

    // `needs.<job>` of a `packages:` job has no single value to read.
    for (key, job) in &pipeline.jobs {
        if let Some(cond) = &job.condition {
            for name in selected.keys() {
                if cond.contains(&format!("needs.{name}.")) {
                    error(
                        format!("jobs.{key}.if"),
                        format!(
                            "`needs.{name}` reads a `packages:` job, which has a result per package; use `success()`, `failure()` or `always()`"
                        ),
                    );
                }
            }
        }
    }

    let old = std::mem::take(&mut pipeline.jobs);
    let mut jobs: IndexMap<String, raw::Job> = IndexMap::with_capacity(old.len());
    for (key, job) in old {
        let path = format!("jobs.{key}");
        let Some(dirs) = selected.get(&key) else {
            if wanted.contains(&key) {
                // A key that is not a name: keep it so the validator names it.
                let mut job = job;
                job.packages = None;
                jobs.insert(key, job);
                continue;
            }
            // An ordinary job: a `packages:` job it needs means all of it.
            let mut job = job;
            let mut needs = Vec::new();
            for need in &job.needs {
                if let Some(base) = need.strip_prefix('^') {
                    error(
                        format!("{path}.needs"),
                        format!(
                            "`^{base}` only means something in a job with `packages:`; write `{base}` to wait for every package's"
                        ),
                    );
                } else if let Some(dirs) = selected.get(need) {
                    needs.extend(dirs.iter().map(|d| format!("{need}[{d}]")));
                } else {
                    needs.push(need.clone());
                }
            }
            job.needs = dedupe(needs);
            jobs.insert(key, job);
            continue;
        };
        for dir in dirs {
            let package = workspace.get(dir).expect("selected from the workspace");
            let mut needs = Vec::new();
            for need in &job.needs {
                if let Some(base) = need.strip_prefix('^') {
                    match selected.get(base) {
                        Some(theirs) => needs.extend(
                            dependencies_with(workspace, dir, theirs)
                                .into_iter()
                                .map(|d| format!("{base}[{d}]")),
                        ),
                        None if old_has(&wanted, base) => {}
                        None => error(
                            format!("{path}.needs"),
                            format!("`^{base}` needs a job with `packages:` named `{base}`"),
                        ),
                    }
                } else if need == &key {
                    error(
                        format!("{path}.needs"),
                        "a job cannot need itself; `^` waits for the packages it depends on, as `^build`".into(),
                    );
                } else if let Some(theirs) = selected.get(need) {
                    if theirs.contains(dir) {
                        needs.push(format!("{need}[{dir}]"));
                    }
                } else {
                    needs.push(need.clone());
                }
            }
            let mut instance = job.clone();
            instance.packages = None;
            instance.needs = dedupe(needs);
            let id = format!("{key}[{dir}]");
            generated.insert(
                id.clone(),
                PackageRef {
                    job: key.clone(),
                    dir: dir.clone(),
                    name: package.name.clone(),
                },
            );
            jobs.insert(id, instance);
        }
    }
    pipeline.jobs = jobs;
    generated
}

fn old_has(wanted: &[String], key: &str) -> bool {
    wanted.iter().any(|k| k == key)
}

fn remove(pipeline: &mut raw::Pipeline, keys: &[String]) {
    pipeline.jobs.retain(|k, _| !keys.contains(k));
    for job in pipeline.jobs.values_mut() {
        job.needs.retain(|n| !keys.contains(n));
    }
}

/// Whether a `packages:` filter selects `package`.
fn lets_through(filter: &raw::PackageFilter, package: &Package) -> bool {
    if !filter.only.is_empty() {
        // Read in order like `paths:`, each pattern matching the package's
        // directory or its name.
        let mut included = filter.only.first().is_some_and(|p| p.starts_with('!'));
        for pattern in &filter.only {
            let (negated, body) = match pattern.strip_prefix('!') {
                Some(body) => (true, body),
                None => (false, pattern.as_str()),
            };
            if crate::glob::compile(body)
                .is_ok_and(|m| m.is_match(&package.dir) || m.is_match(&package.name))
            {
                included = !negated;
            }
        }
        if !included {
            return false;
        }
    }
    filter.has.iter().all(|n| package.entries.contains(n))
        && filter
            .has_script
            .iter()
            .all(|s| package.scripts.contains_key(s))
        && filter.scripts.iter().all(|(script, pattern)| {
            let (negated, body) = match pattern.strip_prefix('!') {
                Some(body) => (true, body),
                None => (false, pattern.as_str()),
            };
            let matched = package
                .scripts
                .get(script)
                .is_some_and(|cmd| command_glob(body).is_ok_and(|m| m.is_match(cmd)));
            matched != negated
        })
}

/// A glob over a script's command, where `*` crosses `/`.
fn command_glob(pattern: &str) -> Result<globset::GlobMatcher, globset::Error> {
    Ok(globset::Glob::new(pattern)?.compile_matcher())
}

/// The nearest packages `dir` depends on, directly or through packages
/// outside `among`, that are in `among`.
fn dependencies_with(
    workspace: &WorkspacePackages,
    dir: &str,
    among: &BTreeSet<String>,
) -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let mut seen = BTreeSet::new();
    let mut stack: Vec<&str> = workspace
        .get(dir)
        .map(|p| p.deps.iter().map(String::as_str).collect())
        .unwrap_or_default();
    while let Some(d) = stack.pop() {
        if !seen.insert(d) {
            continue;
        }
        if among.contains(d) {
            out.insert(d.to_string());
        } else if let Some(p) = workspace.get(d) {
            stack.extend(p.deps.iter().map(String::as_str));
        }
    }
    out
}

fn dedupe(list: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    list.into_iter()
        .filter(|n| seen.insert(n.clone()))
        .collect()
}
