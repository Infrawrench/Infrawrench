//! Which install scripts a package manager would run after an install, and
//! in what order: the plan `install-scripts: true` runs in a virtual
//! machine once the runner's own install (which runs none) is done.
//!
//! Read from the installed tree, so it is the same for every layout (npm's
//! nested `node_modules`, pnpm's and Bun's stores): every package directory
//! under the workspace's `node_modules`, found without following symlinks;
//! the workspace's own packages are what symlinks there point at outside
//! any `node_modules`. Each package's `preinstall`, `install` and
//! `postinstall` run, with `install` defaulting to `node-gyp rebuild` when
//! it has a `binding.gyp` and neither of the other two, as npm, pnpm and
//! Bun do. The projects themselves also run `preprepare`, `prepare` and
//! `postprepare` (and npm's `prepublish`).
//!
//! Which dependencies may run theirs is the package manager's own policy,
//! read from the project as that package manager reads it:
//!
//! - **npm**: since npm 12, only what `allowScripts` in `package.json`
//!   allows (by name, or `name@version`; `false` wins). Without the field
//!   a project on npm 12 or later (`packageManager`, `devEngines`) runs
//!   none, and any other every package's, as npm 11 and earlier did.
//!   `dangerously-allow-all-scripts` in `.npmrc` allows them all.
//! - **pnpm**: since pnpm 10, only what `allowBuilds` (10.26 and later) or
//!   `onlyBuiltDependencies` allows, from `pnpm-workspace.yaml` or the
//!   `pnpm` field of `package.json`; `dangerouslyAllowAllBuilds` allows
//!   all but what `allowBuilds` denies, and `neverBuiltDependencies` alone
//!   allows all but those. A project on pnpm 9 or earlier runs every
//!   package's but `neverBuiltDependencies`.
//! - **Bun**: `trustedDependencies` in `package.json` (or recorded in
//!   `bun.lock`), which replaces Bun's own list of trusted packages; with
//!   neither, that list (`bun/default-trusted-dependencies.txt`, from Bun
//!   1.4.5's `src/install/default-trusted-dependencies.txt`).
//!
//! `ignore-scripts` (`.npmrc`, pnpm's `ignoreScripts`, Bun's
//! `install.ignoreScripts` in `bunfig.toml`) runs nothing at all, the
//! projects' own included; pnpm's `ignoreDepScripts` runs only the
//! projects'.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use iwci_vfs::virtual_fs::FileSystem;
use serde_json::Value;

/// The package manager whose policy decides.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Manager {
    Npm,
    Pnpm,
    Bun,
}

impl Manager {
    pub fn name(self) -> &'static str {
        match self {
            Manager::Npm => "npm",
            Manager::Pnpm => "pnpm",
            Manager::Bun => "bun",
        }
    }
}

/// One lifecycle script.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Event {
    /// `postinstall`, as `npm_lifecycle_event` names it.
    pub name: String,
    pub command: String,
}

/// One package's scripts, run in its own directory.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct Step {
    /// The package's directory, an absolute guest path.
    pub dir: String,
    pub name: String,
    pub version: String,
    /// One of the workspace's own packages, not a dependency.
    pub project: bool,
    pub events: Vec<Event>,
}

/// What [`plan`] found.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize)]
pub struct Plan {
    /// In the order they run: every package after the packages it
    /// depends on, the projects after the dependencies.
    pub steps: Vec<Step>,
    /// Dependencies with install scripts that the policy leaves out, as
    /// `name@version`, sorted.
    pub blocked: Vec<String>,
    /// `ignore-scripts`: nothing runs.
    pub ignored: bool,
}

/// Bun's own list of packages whose scripts it runs without being told.
const BUN_TRUSTED: &str = include_str!("bun/default-trusted-dependencies.txt");

const DEPENDENCY_EVENTS: [&str; 3] = ["preinstall", "install", "postinstall"];

/// The scripts to run after installing the project in `dir` with
/// `manager`, from what is installed under it in `fs`.
pub fn plan(fs: &(impl FileSystem + ?Sized), manager: Manager, dir: &str) -> Plan {
    let dir = dir.trim_end_matches('/');
    let dir = if dir.is_empty() { "/" } else { dir };
    let root_json = read_json(fs, &format!("{dir}/package.json")).unwrap_or(Value::Null);
    let policy = Policy::load(fs, manager, dir, &root_json);
    if policy.ignore_all {
        return Plan {
            ignored: true,
            ..Plan::default()
        };
    }

    // Every package directory, and the projects the tree links to.
    let mut found = Found::default();
    found.visit_modules(fs, &format!("{dir}/node_modules"));
    let mut projects: BTreeSet<String> = found
        .links
        .iter()
        .filter_map(|link| realpath(fs, link))
        .filter(|real| !real.split('/').any(|c| c == "node_modules"))
        .filter(|real| {
            fs.metadata(Path::new(&format!("{real}/package.json")))
                .is_ok()
        })
        .collect();
    projects.insert(dir.to_string());

    // Each package as a node: its scripts and its dependencies.
    let mut nodes: BTreeMap<String, Node> = BTreeMap::new();
    for pkg in found.packages.iter().chain(projects.iter()) {
        if nodes.contains_key(pkg) {
            continue;
        }
        let Some(json) = read_json(fs, &format!("{pkg}/package.json")) else {
            continue;
        };
        let project = projects.contains(pkg);
        nodes.insert(pkg.clone(), Node::read(fs, manager, pkg, &json, project));
    }
    let edges: HashMap<String, Vec<String>> = nodes
        .iter()
        .map(|(pkg, node)| {
            let deps = node
                .deps
                .iter()
                .filter_map(|name| resolve(fs, pkg, name))
                .filter(|real| nodes.contains_key(real))
                .collect();
            (pkg.clone(), deps)
        })
        .collect();

    // What may run.
    let mut blocked = BTreeSet::new();
    let mut running: BTreeSet<String> = BTreeSet::new();
    for (pkg, node) in &nodes {
        if node.events.is_empty() {
            continue;
        }
        if node.project || (!policy.deps_off && policy.allows(&node.name, &node.version)) {
            running.insert(pkg.clone());
        } else {
            blocked.insert(format!("{}@{}", node.name, node.version));
        }
    }

    // Dependencies before dependents: depth first from each package that
    // runs, the dependencies' then the projects', the root last.
    let mut order = Vec::new();
    let mut seen = BTreeSet::new();
    let deps_first = running
        .iter()
        .filter(|p| !nodes[*p].project)
        .cloned()
        .collect::<Vec<_>>();
    let mut project_order: Vec<String> = projects
        .iter()
        .filter(|p| p.as_str() != dir && nodes.contains_key(*p))
        .cloned()
        .collect();
    project_order.push(dir.to_string());
    for start in deps_first.iter().chain(project_order.iter()) {
        post_order(start, &edges, &mut seen, &mut order);
    }
    let steps = order
        .into_iter()
        .filter(|p| running.contains(p))
        .map(|p| {
            let node = &nodes[&p];
            Step {
                dir: p.clone(),
                name: node.name.clone(),
                version: node.version.clone(),
                project: node.project,
                events: node.events.clone(),
            }
        })
        .collect();
    Plan {
        steps,
        blocked: blocked.into_iter().collect(),
        ignored: false,
    }
}

fn post_order(
    start: &str,
    edges: &HashMap<String, Vec<String>>,
    seen: &mut BTreeSet<String>,
    out: &mut Vec<String>,
) {
    // Iterative, so a deep tree cannot overflow the stack.
    if !seen.insert(start.to_string()) {
        return;
    }
    let mut stack: Vec<(String, usize)> = vec![(start.to_string(), 0)];
    while let Some((node, next)) = stack.pop() {
        let deps = edges.get(&node).map(Vec::as_slice).unwrap_or(&[]);
        if let Some(dep) = deps.get(next) {
            stack.push((node, next + 1));
            if seen.insert(dep.clone()) {
                stack.push((dep.clone(), 0));
            }
        } else {
            out.push(node);
        }
    }
}

/// A package, as far as its scripts go.
struct Node {
    name: String,
    version: String,
    project: bool,
    events: Vec<Event>,
    /// Names it depends on: `dependencies`, `optionalDependencies` and
    /// `peerDependencies`.
    deps: Vec<String>,
}

impl Node {
    fn read(
        fs: &(impl FileSystem + ?Sized),
        manager: Manager,
        dir: &str,
        json: &Value,
        project: bool,
    ) -> Node {
        let scripts = json.get("scripts").and_then(Value::as_object);
        let script = |name: &str| {
            scripts
                .and_then(|s| s.get(name))
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
        };
        let gyp = fs
            .metadata(Path::new(&format!("{dir}/binding.gyp")))
            .is_ok();
        let mut names: Vec<&str> = DEPENDENCY_EVENTS.to_vec();
        if project {
            if manager == Manager::Npm {
                names.push("prepublish");
            }
            names.extend(["preprepare", "prepare", "postprepare"]);
        }
        let mut events = Vec::new();
        for name in names {
            let command = match script(name) {
                Some(c) => Some(c),
                // node-gyp's default, as every one of them has it.
                None if name == "install" && gyp && script("preinstall").is_none() => {
                    Some("node-gyp rebuild".to_string())
                }
                None => None,
            };
            if let Some(command) = command {
                events.push(Event {
                    name: name.to_string(),
                    command,
                });
            }
        }
        let mut deps = BTreeSet::new();
        for field in ["dependencies", "optionalDependencies", "peerDependencies"] {
            if let Some(map) = json.get(field).and_then(Value::as_object) {
                deps.extend(map.keys().cloned());
            }
        }
        Node {
            name: json
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            version: json
                .get("version")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
            project,
            events,
            deps: deps.into_iter().collect(),
        }
    }
}

/// The package directories under a `node_modules`.
#[derive(Default)]
struct Found {
    packages: BTreeSet<String>,
    /// Symlinks found where packages go, for the projects they point at.
    links: Vec<String>,
}

impl Found {
    fn visit_modules(&mut self, fs: &(impl FileSystem + ?Sized), modules: &str) {
        for (name, kind) in list(fs, modules) {
            let path = format!("{modules}/{name}");
            match kind {
                Kind::Link => self.links.push(path),
                Kind::Dir if name.starts_with('.') => {
                    // A store (`.pnpm`, `.bun`): each entry has its own
                    // `node_modules`. `.bin` and caches have none.
                    if name == ".bin" || name == ".cache" {
                        continue;
                    }
                    for (entry, kind) in list(fs, &path) {
                        if kind == Kind::Dir {
                            self.visit_modules(fs, &format!("{path}/{entry}/node_modules"));
                        }
                    }
                }
                Kind::Dir if name.starts_with('@') => {
                    for (entry, kind) in list(fs, &path) {
                        let inner = format!("{path}/{entry}");
                        match kind {
                            Kind::Dir => self.package(fs, &inner),
                            Kind::Link => self.links.push(inner),
                            Kind::File => {}
                        }
                    }
                }
                Kind::Dir => self.package(fs, &path),
                Kind::File => {}
            }
        }
    }

    fn package(&mut self, fs: &(impl FileSystem + ?Sized), dir: &str) {
        if fs
            .metadata(Path::new(&format!("{dir}/package.json")))
            .is_ok()
            && self.packages.insert(dir.to_string())
        {
            self.visit_modules(fs, &format!("{dir}/node_modules"));
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Dir,
    File,
    Link,
}

/// A directory's entries, sorted, without following symlinks.
fn list(fs: &(impl FileSystem + ?Sized), dir: &str) -> Vec<(String, Kind)> {
    let Ok(entries) = fs.read_dir(Path::new(dir)) else {
        return Vec::new();
    };
    let mut out: Vec<(String, Kind)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.path.file_name()?.to_str()?.to_string();
            let meta = fs.symlink_metadata(&e.path).ok()?;
            let ft = meta.file_type();
            let kind = if ft.is_symlink() {
                Kind::Link
            } else if ft.is_dir() {
                Kind::Dir
            } else {
                Kind::File
            };
            Some((name, kind))
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// `path` with every symlink in it followed, or `None` when it does not
/// exist or links round in circles.
fn realpath(fs: &(impl FileSystem + ?Sized), path: &str) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut todo: Vec<String> = path
        .split('/')
        .filter(|c| !c.is_empty())
        .rev()
        .map(str::to_owned)
        .collect();
    let mut hops = 0;
    while let Some(part) = todo.pop() {
        match part.as_str() {
            "." => continue,
            ".." => {
                parts.pop();
                continue;
            }
            _ => {}
        }
        let here = format!(
            "/{}",
            parts
                .iter()
                .chain([&part])
                .cloned()
                .collect::<Vec<_>>()
                .join("/")
        );
        let meta = fs.symlink_metadata(Path::new(&here)).ok()?;
        if meta.file_type().is_symlink() {
            hops += 1;
            if hops > 40 {
                return None;
            }
            let target = fs.readlink(Path::new(&here)).ok()?;
            let target = target.to_str()?.to_string();
            if target.starts_with('/') {
                parts.clear();
            }
            todo.extend(
                target
                    .split('/')
                    .filter(|c| !c.is_empty())
                    .rev()
                    .map(str::to_owned),
            );
        } else {
            parts.push(part);
        }
    }
    Some(format!("/{}", parts.join("/")))
}

/// Where Node would find `name` from a package in `from`: the nearest
/// `node_modules/<name>` going up, followed to its real directory.
fn resolve(fs: &(impl FileSystem + ?Sized), from: &str, name: &str) -> Option<String> {
    let mut dir = PathBuf::from(from);
    loop {
        if dir.file_name().is_none_or(|n| n != "node_modules") {
            let candidate = dir.join("node_modules").join(name);
            if let Some(candidate) = candidate.to_str()
                && fs.symlink_metadata(Path::new(candidate)).is_ok()
            {
                return realpath(fs, candidate);
            }
        }
        if !dir.pop() {
            return None;
        }
    }
}

fn read_json(fs: &(impl FileSystem + ?Sized), path: &str) -> Option<Value> {
    let bytes = iwci_vfs::read_file(fs, path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn read_text(fs: &(impl FileSystem + ?Sized), path: &str) -> Option<String> {
    String::from_utf8(iwci_vfs::read_file(fs, path).ok()?).ok()
}

/// A package manager's rules, as read from the project.
#[derive(Debug, Default)]
struct Policy {
    /// `ignore-scripts`: nothing at all runs.
    ignore_all: bool,
    /// No dependency's scripts run (pnpm's `ignoreDepScripts`).
    deps_off: bool,
    /// Every dependency runs, except `deny`.
    all: bool,
    allow: Vec<Matcher>,
    deny: Vec<Matcher>,
}

impl Policy {
    fn allows(&self, name: &str, version: &str) -> bool {
        if self.deny.iter().any(|m| m.matches(name, version)) {
            return false;
        }
        self.all || self.allow.iter().any(|m| m.matches(name, version))
    }

    fn load(fs: &(impl FileSystem + ?Sized), manager: Manager, dir: &str, root: &Value) -> Policy {
        let npmrc = read_text(fs, &format!("{dir}/.npmrc")).unwrap_or_default();
        let npmrc_true = |key: &str| npmrc_bool(&npmrc, key) == Some(true);
        let major = package_manager_major(root, manager.name());
        match manager {
            Manager::Npm => {
                if npmrc_true("ignore-scripts") {
                    return Policy {
                        ignore_all: true,
                        ..Policy::default()
                    };
                }
                let mut policy = Policy::default();
                if let Some(map) = root.get("allowScripts").and_then(Value::as_object) {
                    for (key, allowed) in map {
                        let matcher = Matcher::parse(key);
                        match allowed.as_bool() {
                            Some(true) => policy.allow.push(matcher),
                            Some(false) => policy.deny.push(matcher),
                            None => {}
                        }
                    }
                } else if major.is_none_or(|m| m < 12) {
                    // npm 11 and earlier ran every package's.
                    policy.all = true;
                }
                if npmrc_true("dangerously-allow-all-scripts") {
                    policy.all = true;
                }
                policy
            }
            Manager::Pnpm => {
                let yaml: serde_yaml_ng::Value =
                    read_text(fs, &format!("{dir}/pnpm-workspace.yaml"))
                        .and_then(|t| serde_yaml_ng::from_str(&t).ok())
                        .unwrap_or(serde_yaml_ng::Value::Null);
                let field = root.get("pnpm").cloned().unwrap_or(Value::Null);
                // A setting from pnpm-workspace.yaml, else package.json's
                // `pnpm` field, as JSON.
                let setting = |key: &str| -> Option<Value> {
                    yaml.get(key)
                        .and_then(|v| serde_json::to_value(v).ok())
                        .or_else(|| field.get(key).cloned())
                };
                let flag = |key: &str, npmrc_key: &str| {
                    setting(key).and_then(|v| v.as_bool()).unwrap_or(false) || npmrc_true(npmrc_key)
                };
                if flag("ignoreScripts", "ignore-scripts") {
                    return Policy {
                        ignore_all: true,
                        ..Policy::default()
                    };
                }
                let mut policy = Policy {
                    deps_off: flag("ignoreDepScripts", "ignore-dep-scripts"),
                    ..Policy::default()
                };
                let names = |key: &str| -> Option<Vec<Matcher>> {
                    setting(key).and_then(|v| {
                        v.as_array().map(|a| {
                            a.iter()
                                .filter_map(Value::as_str)
                                .map(Matcher::parse)
                                .collect()
                        })
                    })
                };
                let only = names("onlyBuiltDependencies").or_else(|| {
                    let file = setting("onlyBuiltDependenciesFile")?;
                    let path = format!("{dir}/{}", file.as_str()?);
                    let list = read_json(fs, &path)?;
                    Some(
                        list.as_array()?
                            .iter()
                            .filter_map(Value::as_str)
                            .map(Matcher::parse)
                            .collect(),
                    )
                });
                let never = names("neverBuiltDependencies");
                let mut allow_builds = false;
                if let Some(map) = setting("allowBuilds").as_ref().and_then(Value::as_object) {
                    allow_builds = true;
                    for (key, allowed) in map {
                        match allowed.as_bool() {
                            Some(true) => policy.allow.push(Matcher::parse(key)),
                            Some(false) => policy.deny.push(Matcher::parse(key)),
                            None => {}
                        }
                    }
                }
                if let Some(only) = &only {
                    policy.allow.extend(only.iter().cloned());
                }
                if let Some(never) = &never {
                    policy.deny.extend(never.iter().cloned());
                }
                if major.is_some_and(|m| m < 10) {
                    // pnpm 9 and earlier built every package but
                    // `neverBuiltDependencies`.
                    policy.all = only.is_none();
                } else if setting("dangerouslyAllowAllBuilds").and_then(|v| v.as_bool())
                    == Some(true)
                    || (never.is_some() && only.is_none() && !allow_builds)
                {
                    policy.all = true;
                }
                policy
            }
            Manager::Bun => {
                let bunfig: toml::Value = read_text(fs, &format!("{dir}/bunfig.toml"))
                    .and_then(|t| toml::from_str(&t).ok())
                    .unwrap_or(toml::Value::Table(Default::default()));
                let bunfig_ignore = bunfig
                    .get("install")
                    .and_then(|i| i.get("ignoreScripts"))
                    .and_then(toml::Value::as_bool)
                    == Some(true);
                if bunfig_ignore || npmrc_true("ignore-scripts") {
                    return Policy {
                        ignore_all: true,
                        ..Policy::default()
                    };
                }
                let listed = root
                    .get("trustedDependencies")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect::<Vec<_>>()
                    })
                    .or_else(|| bun_lock_trusted(fs, dir));
                let names: Vec<String> = match listed {
                    Some(names) => names,
                    None => BUN_TRUSTED
                        .lines()
                        .map(str::trim)
                        .filter(|l| !l.is_empty() && !l.starts_with('#'))
                        .map(str::to_owned)
                        .collect(),
                };
                Policy {
                    allow: names.iter().map(|n| Matcher::name(n)).collect(),
                    ..Policy::default()
                }
            }
        }
    }
}

/// `trustedDependencies` as `bun.lock` records it, when it does.
fn bun_lock_trusted(fs: &(impl FileSystem + ?Sized), dir: &str) -> Option<Vec<String>> {
    // bun.lock is JSONC: trailing commas, no comments in practice.
    let text = read_text(fs, &format!("{dir}/bun.lock"))?;
    let start = text.find("\"trustedDependencies\"")?;
    let open = start + text[start..].find('[')?;
    let close = open + text[open..].find(']')?;
    Some(
        text[open + 1..close]
            .split(',')
            .map(|s| s.trim().trim_matches('"').to_string())
            .filter(|s| !s.is_empty())
            .collect(),
    )
}

/// The major version of `manager` a project names in `packageManager`
/// (`pnpm@10.20.0`) or `devEngines.packageManager`.
fn package_manager_major(root: &Value, manager: &str) -> Option<u64> {
    let from_field = root
        .get("packageManager")
        .and_then(Value::as_str)
        .and_then(|s| {
            s.strip_prefix(manager)?
                .strip_prefix('@')
                .map(str::to_owned)
        });
    let from_dev = || {
        let pm = root.get("devEngines")?.get("packageManager")?;
        let entries: Vec<&Value> = match pm {
            Value::Array(a) => a.iter().collect(),
            other => vec![other],
        };
        entries.into_iter().find_map(|e| {
            (e.get("name")?.as_str()? == manager)
                .then(|| e.get("version")?.as_str().map(str::to_owned))
                .flatten()
        })
    };
    let version = from_field.or_else(from_dev)?;
    let digits: String = version
        .trim_start_matches(|c: char| !c.is_ascii_digit())
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    digits.parse().ok()
}

/// An `.npmrc` boolean, last line wins.
fn npmrc_bool(text: &str, key: &str) -> Option<bool> {
    text.lines().rev().find_map(|line| {
        let line = line.trim();
        if line.starts_with('#') || line.starts_with(';') {
            return None;
        }
        let (k, v) = line.split_once('=')?;
        (k.trim() == key).then(|| v.trim().trim_matches('"') == "true")
    })
}

/// A package a policy names: by name, or `name@1.2.3 || 1.2.4` (exact
/// versions or ranges).
#[derive(Debug, Clone)]
struct Matcher {
    name: String,
    versions: Option<Vec<String>>,
}

impl Matcher {
    fn name(name: &str) -> Matcher {
        Matcher {
            name: name.to_string(),
            versions: None,
        }
    }

    fn parse(spec: &str) -> Matcher {
        let spec = spec.trim();
        // The version separator is the last `@` that is not the scope's.
        match spec.get(1..).and_then(|s| s.rfind('@')).map(|i| i + 1) {
            Some(at) => Matcher {
                name: spec[..at].to_string(),
                versions: Some(
                    spec[at + 1..]
                        .split("||")
                        .map(|v| v.trim().to_string())
                        .filter(|v| !v.is_empty())
                        .collect(),
                ),
            },
            None if spec.is_empty() => Matcher::name(""),
            None => Matcher::name(spec),
        }
    }

    fn matches(&self, name: &str, version: &str) -> bool {
        if self.name != name {
            return false;
        }
        let Some(versions) = &self.versions else {
            return true;
        };
        versions.iter().any(|want| {
            want == version
                || match (
                    semver::Version::parse(version),
                    semver::Version::parse(want),
                ) {
                    (Ok(have), Ok(exact)) => have == exact,
                    (Ok(have), Err(_)) => {
                        semver::VersionReq::parse(want).is_ok_and(|req| req.matches(&have))
                    }
                    _ => false,
                }
        })
    }
}

#[cfg(test)]
mod tests;
