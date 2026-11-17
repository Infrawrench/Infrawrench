//! Bun's isolated layout: every package in `node_modules/.bun/<name>@<version>`
//! with a symlink per dependency next to it, and the projects' own
//! dependencies linked into their `node_modules`.
//!
//! A package with peer dependencies is installed once per set of packages
//! its peers resolve to, each in a directory that ends in a hash of that
//! set. A peer resolves the way Bun's `isolated_install.rs` resolves it:
//! to the package of that name the nearest dependent above depends on, and
//! otherwise to the one the lockfile resolved for the package itself. Which
//! peer names can reach past a package (`leaking`) is the same fixed point
//! Bun computes, and it is what keeps the walk finite: two paths to a
//! package that agree on those names share one directory.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};

use base64::Engine;

use super::lockfile::{Lockfile, Package, Resolution, key_segments};
use super::wyhash::wyhash11;
use super::{BunError, BunOptions, Layout, Result, Settings, accepts, directory_of, edges};
use crate::pnpm::hoist::Matcher;

/// The most Bun writes of a resolution into a directory name, and where it
/// cuts a longer one to make room for a hash.
const MAX_RESOLUTION_LEN: usize = 80;
const CUT_RESOLUTION_LEN: usize = MAX_RESOLUTION_LEN - 1 - 16;

#[derive(Clone, Copy)]
struct Edge<'a> {
    alias: &'a str,
    peer: bool,
    optional: bool,
    target: Option<usize>,
}

struct Node<'a> {
    /// `None` for the root project.
    package: Option<&'a Package>,
    edges: Vec<Edge<'a>>,
    /// The names this package depends on itself, which satisfy its own
    /// peers and those of everything below it.
    provides: BTreeSet<&'a str>,
}

impl Node<'_> {
    /// A directory of the repository: linked to, never instantiated.
    fn is_directory(&self) -> bool {
        self.package
            .is_none_or(|package| package.resolution.is_directory())
    }
}

enum Link {
    Store(usize),
    Directory(usize),
}

struct Instance {
    node: usize,
    dir: String,
    links: Vec<(String, Link)>,
}

struct Store<'a> {
    nodes: Vec<Node<'a>>,
    leaking: Vec<Vec<&'a str>>,
    options: &'a BunOptions,
    instances: Vec<Instance>,
    by_context: HashMap<(usize, Vec<Option<usize>>), usize>,
    by_dir: HashMap<String, usize>,
    rejected: BTreeSet<&'a str>,
}

/// `text` as Bun writes it into a directory name.
fn store_path(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '#' | '?' => '+',
            other => other,
        })
        .collect()
}

/// The digest bytes of a Subresource Integrity string.
fn digest(integrity: &str) -> Vec<u8> {
    integrity
        .split_once('-')
        .and_then(|(_, encoded)| {
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .ok()
        })
        .unwrap_or_default()
}

/// The part of a package's identity after the `@`, as Bun prints it.
fn resolution_text(package: &Package) -> &str {
    match &package.resolution {
        Resolution::Npm { version, .. } => version,
        _ => package
            .ident
            .get(package.name.len() + 1..)
            .unwrap_or_default(),
    }
}

/// `name@resolution` for the store, without a peer hash.
fn store_key(package: &Package) -> String {
    let resolution = store_path(resolution_text(package));
    let resolution = if resolution.len() <= MAX_RESOLUTION_LEN {
        resolution
    } else {
        // Bun appends its own hash of the whole text here. This one is
        // different, so such a directory is not named as Bun names it; it
        // is as unique.
        use sha2::Digest;
        let hash = sha2::Sha256::digest(resolution.as_bytes());
        let mut cut = CUT_RESOLUTION_LEN;
        while !resolution.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}+{}", &resolution[..cut], hex::encode(&hash[..8]))
    };
    format!("{}@{resolution}", store_path(&package.name))
}

impl<'a> Store<'a> {
    fn build(lock: &'a Lockfile, options: &'a BunOptions) -> Result<Store<'a>> {
        // One node per package, whatever number of places the hoisted tree
        // has it in; its dependencies resolve from the shallowest.
        let mut keys: Vec<&'a str> = lock.packages.keys().map(String::as_str).collect();
        keys.sort_by_key(|key| (key_segments(key).len(), *key));
        let mut index_of: HashMap<&'a str, usize> = HashMap::new();
        let mut canonical: Vec<&'a str> = vec![""];
        let mut node_of_key: HashMap<&'a str, usize> = HashMap::new();
        for key in keys {
            let package = &lock.packages[key];
            let index = *index_of.entry(package.ident.as_str()).or_insert_with(|| {
                canonical.push(key);
                canonical.len() - 1
            });
            node_of_key.insert(key, index);
        }

        let mut nodes = Vec::with_capacity(canonical.len());
        for (index, key) in canonical.iter().enumerate() {
            let package = (index != 0).then(|| &lock.packages[*key]);
            let found = match package {
                None => edges(lock, &lock.workspaces[""].deps, &[], "the root", options)?,
                Some(package) => {
                    let path = key_segments(key);
                    match &package.resolution {
                        Resolution::Workspace { path: dir } => match lock.workspaces.get(dir) {
                            Some(workspace) => {
                                edges(lock, &workspace.deps, &path, &package.ident, options)?
                            }
                            None => Vec::new(),
                        },
                        // A linked directory's dependencies are its own
                        // business, and a bundled package's came with it.
                        Resolution::Link { .. } | Resolution::Root => Vec::new(),
                        _ if package.bundled => Vec::new(),
                        _ => edges(lock, &package.deps, &path, &package.ident, options)?,
                    }
                }
            };
            let edges: Vec<Edge<'a>> = found
                .into_iter()
                .map(|edge| Edge {
                    alias: edge.alias,
                    peer: edge.peer,
                    optional: edge.optional,
                    target: edge
                        .target
                        .filter(|key| !lock.packages[*key].bundled)
                        .map(|key| node_of_key[key]),
                })
                .collect();
            let provides = edges
                .iter()
                .filter(|edge| !edge.peer && edge.target.is_some())
                .map(|edge| edge.alias)
                .collect();
            nodes.push(Node {
                package,
                edges,
                provides,
            });
        }

        // Every package a dependency of a given name resolves to anywhere:
        // what a peer of that name can turn out to be.
        let mut named: HashMap<&str, BTreeSet<usize>> = HashMap::new();
        for node in &nodes {
            for edge in &node.edges {
                if let Some(target) = edge.target {
                    named.entry(edge.alias).or_default().insert(target);
                }
            }
        }
        let mut leaking: Vec<BTreeSet<&'a str>> = vec![BTreeSet::new(); nodes.len()];
        let mut changed = true;
        while changed {
            changed = false;
            for (index, node) in nodes.iter().enumerate() {
                let mut leaks: BTreeSet<&'a str> = BTreeSet::new();
                let inherit = |target: usize, leaks: &mut BTreeSet<&'a str>| {
                    if !nodes[target].is_directory() {
                        leaks.extend(leaking[target].iter().copied());
                    }
                };
                for edge in &node.edges {
                    if edge.peer {
                        leaks.insert(edge.alias);
                        for target in named.get(edge.alias).into_iter().flatten() {
                            inherit(*target, &mut leaks);
                        }
                    } else if let Some(target) = edge.target {
                        inherit(target, &mut leaks);
                    }
                }
                leaks.retain(|name| !node.provides.contains(name));
                if leaks != leaking[index] {
                    leaking[index] = leaks;
                    changed = true;
                }
            }
        }

        Ok(Store {
            nodes,
            leaking: leaking
                .into_iter()
                .map(|names| names.into_iter().collect())
                .collect(),
            options,
            instances: Vec::new(),
            by_context: HashMap::new(),
            by_dir: HashMap::new(),
            rejected: BTreeSet::new(),
        })
    }

    /// What each of `node`'s dependencies is, given the packages its
    /// dependents provide by name.
    fn resolved(&mut self, node: usize, above: &BTreeMap<&'a str, usize>) -> Vec<(&'a str, usize)> {
        let mut out = Vec::new();
        for edge in self.nodes[node].edges.clone() {
            let target = if edge.peer {
                if self.nodes[node].provides.contains(edge.alias) {
                    continue;
                }
                match above.get(edge.alias).copied().or(edge.target) {
                    // A package is never its own peer.
                    Some(target) if target != node => target,
                    _ => continue,
                }
            } else {
                let Some(target) = edge.target else { continue };
                if edge.optional
                    && let Some(package) = self.nodes[target].package
                    && !accepts(self.options, package)
                {
                    self.rejected.insert(package.ident.as_str());
                    continue;
                }
                target
            };
            out.push((edge.alias, target));
        }
        out
    }

    fn link(
        &mut self,
        resolved: Vec<(&'a str, usize)>,
        above: &BTreeMap<&'a str, usize>,
    ) -> Vec<(String, Link)> {
        let mut visible = above.clone();
        visible.extend(resolved.iter().copied());
        resolved
            .into_iter()
            .map(|(alias, target)| {
                let link = if self.nodes[target].is_directory() {
                    Link::Directory(target)
                } else {
                    Link::Store(self.instance(target, &visible))
                };
                (alias.to_string(), link)
            })
            .collect()
    }

    /// The packages a peer of `name` resolves to below `node` when nothing
    /// above provides one: each declaring package's own.
    fn defaults(&self, node: usize, name: &str, seen: &mut HashSet<usize>, out: &mut Vec<usize>) {
        if !seen.insert(node) {
            return;
        }
        for edge in &self.nodes[node].edges {
            let Some(target) = edge.target else { continue };
            if edge.peer {
                if edge.alias == name && target != node {
                    out.push(target);
                }
            } else if !self.nodes[target].is_directory() && self.leaking[target].contains(&name) {
                self.defaults(target, name, seen, out);
            }
        }
    }

    fn dir(&self, node: usize, context: &[Option<usize>]) -> String {
        let package = self.nodes[node].package.expect("the root is not installed");
        let mut peers: Vec<usize> = Vec::new();
        for (name, target) in self.leaking[node].iter().zip(context) {
            match target {
                Some(target) => peers.push(*target),
                None => self.defaults(node, name, &mut HashSet::new(), &mut peers),
            }
        }
        let name_of =
            |index: usize| -> &str { self.nodes[index].package.map_or("", |p| p.name.as_str()) };
        peers.retain(|peer| *peer != node);
        peers.sort_by(|a, b| name_of(*a).cmp(name_of(*b)).then(a.cmp(b)));
        peers.dedup();
        let pinned = match &package.resolution {
            Resolution::Tarball {
                integrity: Some(integrity),
                ..
            } => digest(integrity),
            _ => Vec::new(),
        };
        let hash = if peers.is_empty() {
            pinned
                .first_chunk::<8>()
                .map_or(0, |head| u64::from_be_bytes(*head))
        } else {
            let mut input = pinned;
            for peer in peers {
                if let Some(package) = self.nodes[peer].package {
                    input.extend_from_slice(package.name.as_bytes());
                    input.extend_from_slice(resolution_text(package).as_bytes());
                }
            }
            wyhash11(&input)
        };
        let key = store_key(package);
        if hash == 0 {
            key
        } else {
            format!("{key}+{hash:016x}")
        }
    }

    fn instance(&mut self, node: usize, visible: &BTreeMap<&'a str, usize>) -> usize {
        let context: Vec<Option<usize>> = self.leaking[node]
            .iter()
            .map(|name| visible.get(name).copied())
            .collect();
        let key = (node, context);
        if let Some(index) = self.by_context.get(&key) {
            return *index;
        }
        let dir = self.dir(node, &key.1);
        if let Some(index) = self.by_dir.get(&dir).copied() {
            self.by_context.insert(key, index);
            return index;
        }
        let index = self.instances.len();
        self.instances.push(Instance {
            node,
            dir: dir.clone(),
            links: Vec::new(),
        });
        self.by_dir.insert(dir, index);
        let above: BTreeMap<&'a str, usize> = self.leaking[node]
            .iter()
            .zip(&key.1)
            .filter_map(|(name, target)| target.map(|target| (*name, target)))
            .collect();
        self.by_context.insert(key, index);
        let resolved = self.resolved(node, &above);
        let links = self.link(resolved, &above);
        self.instances[index].links = links;
        index
    }
}

/// The walk below recurses once per package on the longest dependency
/// chain, which in a large lockfile is longer than a worker thread's stack
/// is deep.
const STACK_BYTES: usize = 256 << 20;

pub(super) fn plan<'a>(
    lock: &'a Lockfile,
    root: &Path,
    settings: &Settings,
    options: &'a BunOptions,
) -> Result<Layout<'a>> {
    std::thread::scope(|scope| {
        std::thread::Builder::new()
            .name("bun-isolated-plan".to_string())
            .stack_size(STACK_BYTES)
            .spawn_scoped(scope, || plan_here(lock, root, settings, options))
            .map_err(|error| BunError::Config {
                path: root.display().to_string(),
                message: format!("could not start a thread to plan the install: {error}"),
            })?
            .join()
            .unwrap_or_else(|panic| std::panic::resume_unwind(panic))
    })
}

fn plan_here<'a>(
    lock: &'a Lockfile,
    root: &Path,
    settings: &Settings,
    options: &'a BunOptions,
) -> Result<Layout<'a>> {
    let mut store = Store::build(lock, options)?;
    let store_dir = root.join("node_modules/.bun");

    // The root first, then every workspace as a dependent below it.
    let nothing = BTreeMap::new();
    let root_resolved = store.resolved(0, &nothing);
    let root_visible: BTreeMap<&str, usize> = root_resolved.iter().copied().collect();
    let mut projects: Vec<(PathBuf, Vec<(String, Link)>)> = Vec::new();
    let root_links = store.link(root_resolved, &nothing);
    projects.push((root.to_path_buf(), root_links));
    let mut workspaces: Vec<(usize, &str)> = store
        .nodes
        .iter()
        .enumerate()
        .filter_map(|(index, node)| match &node.package?.resolution {
            Resolution::Workspace { path } => Some((index, path.as_str())),
            _ => None,
        })
        .collect();
    workspaces.sort_by_key(|(_, path)| *path);
    for (index, path) in workspaces {
        let resolved = store.resolved(index, &root_visible);
        let links = store.link(resolved, &root_visible);
        projects.push((iwci_vfs::join_under(root, path)?, links));
    }

    let package_dir = |instance: &Instance| -> Result<PathBuf> {
        let name = &store.nodes[instance.node]
            .package
            .expect("an instance is a package")
            .name;
        Ok(iwci_vfs::join_under(
            &store_dir,
            format!("{}/node_modules/{name}", instance.dir),
        )?)
    };
    let target_of = |link: &Link| -> Result<PathBuf> {
        match link {
            Link::Store(index) => package_dir(&store.instances[*index]),
            Link::Directory(node) => match store.nodes[*node].package {
                Some(package) => directory_of(root, package),
                None => Ok(root.to_path_buf()),
            },
        }
    };

    let mut layout = Layout::default();
    for instance in &store.instances {
        let package = store.nodes[instance.node]
            .package
            .expect("an instance is a package");
        layout.trees.push((package_dir(instance)?, package));
        let modules = iwci_vfs::join_under(&store_dir, format!("{}/node_modules", instance.dir))?;
        for (alias, link) in &instance.links {
            // The package itself already sits under its own name here.
            if *alias == package.name {
                continue;
            }
            layout
                .links
                .push((iwci_vfs::join_under(&modules, alias)?, target_of(link)?));
        }
    }
    for (dir, links) in &projects {
        let modules = dir.join("node_modules");
        for (alias, link) in links {
            layout
                .links
                .push((iwci_vfs::join_under(&modules, alias)?, target_of(link)?));
        }
    }

    // Hoisting: the first package to claim a name, breadth first from the
    // projects, is linked into `.bun/node_modules`, which every package in
    // the store can resolve through.
    let hidden = Matcher::new(&settings.hoist_pattern);
    let public = Matcher::new(&settings.public_hoist_pattern);
    let hidden_modules = store_dir.join("node_modules");
    let public_modules = root.join("node_modules");
    let mut hidden_claimed: HashSet<&str> = HashSet::new();
    let mut public_claimed: HashSet<&str> = projects[0]
        .1
        .iter()
        .map(|(alias, _)| alias.as_str())
        .collect();
    let mut visited: HashSet<usize> = HashSet::new();
    let mut queue: VecDeque<(&[(String, Link)], bool)> = projects
        .iter()
        .enumerate()
        .map(|(index, (_, links))| (links.as_slice(), index == 0))
        .collect();
    while let Some((links, of_root)) = queue.pop_front() {
        for (alias, link) in links {
            let Link::Store(index) = link else { continue };
            let instance = &store.instances[*index];
            if hidden.matches(alias) && hidden_claimed.insert(alias) {
                let link = iwci_vfs::join_under(&hidden_modules, alias)?;
                layout.hoisted_links.insert(link.clone());
                layout.links.push((link, package_dir(instance)?));
                layout.hoisted += 1;
            }
            if !of_root && public.matches(alias) && public_claimed.insert(alias) {
                let link = iwci_vfs::join_under(&public_modules, alias)?;
                layout.hoisted_links.insert(link.clone());
                layout.links.push((link, package_dir(instance)?));
                layout.hoisted += 1;
            }
            if visited.insert(*index) {
                queue.push_back((instance.links.as_slice(), false));
            }
        }
    }

    let installed: HashSet<&str> = layout
        .trees
        .iter()
        .map(|(_, package)| package.ident.as_str())
        .collect();
    layout.skipped = store
        .rejected
        .iter()
        .filter(|ident| !installed.contains(*ident))
        .map(|ident| ident.to_string())
        .collect();
    Ok(layout)
}
