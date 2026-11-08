//! pnpm's hoisting, which decides what else is linked into
//! `node_modules/.pnpm/node_modules` (private hoisting, `hoistPattern`,
//! default `*`) and `node_modules` (public hoisting, `publicHoistPattern`,
//! default nothing since pnpm 10).
//!
//! It matters for type checking because a package's undeclared imports
//! resolve through it: Node and TypeScript walk up from
//! `.pnpm/<dir>/node_modules/<pkg>` and reach `.pnpm/node_modules` next.
//! Which version of a name wins is a precedence order, so this is a port of
//! pnpm's own walk (`crates/deps-restorer/src/hoist.rs` in the pnpm
//! repository) rather than a reimplementation: the importers' direct
//! dependencies first, then the graph in the walk order pnpm uses, sorted by
//! depth and then by virtual store directory name, first claim wins.

use std::collections::{BTreeMap, HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum HoistKind {
    /// `node_modules/.pnpm/node_modules/<alias>`.
    Private,
    /// `node_modules/<alias>`.
    Public,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum HoistTarget {
    /// A snapshot, by dependency path.
    Snapshot(String),
    /// A workspace project, by importer id.
    Project(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Hoisted {
    pub alias: String,
    pub target: HoistTarget,
    pub kind: HoistKind,
}

/// One snapshot in the walk.
#[derive(Debug, Clone)]
pub(crate) struct GraphNode {
    /// Alias to dependency path: `dependencies` sorted by alias, then
    /// `optionalDependencies` sorted by alias. `link:` entries are absent.
    pub children: Vec<(String, String)>,
    /// The virtual store directory name, pnpm's tie-break within a depth.
    pub sort_key: String,
}

/// A hoist pattern list as pnpm's matcher reads it: `*` is a wildcard, a
/// leading `!` excludes, and later patterns override earlier ones.
#[derive(Debug, Clone, Default)]
pub(crate) struct Matcher {
    patterns: Vec<(bool, String)>,
}

impl Matcher {
    pub fn new(patterns: &[String]) -> Self {
        Matcher {
            patterns: patterns
                .iter()
                .map(|pattern| match pattern.strip_prefix('!') {
                    Some(rest) => (true, rest.to_string()),
                    None => (false, pattern.clone()),
                })
                .collect(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.patterns.is_empty()
    }

    pub fn matches(&self, name: &str) -> bool {
        if self.patterns.is_empty() {
            return false;
        }
        // Only exclusions means "everything else".
        let mut matched = self.patterns.iter().all(|(negated, _)| *negated);
        for (negated, pattern) in &self.patterns {
            if glob(pattern, name) {
                matched = !negated;
            }
        }
        matched
    }
}

/// `*`-only glob matching, iterative with one backtrack point.
fn glob(pattern: &str, text: &str) -> bool {
    let (p, t) = (pattern.as_bytes(), text.as_bytes());
    let (mut pi, mut ti) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while ti < t.len() {
        if pi < p.len() && p[pi] == b'*' {
            star = Some((pi, ti));
            pi += 1;
        } else if pi < p.len() && p[pi] == t[ti] {
            pi += 1;
            ti += 1;
        } else if let Some((star_pi, star_ti)) = star {
            pi = star_pi + 1;
            ti = star_ti + 1;
            star = Some((star_pi, star_ti + 1));
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == b'*')
}

pub(crate) struct HoistInput<'a> {
    /// Every snapshot reachable from the installed importers, including
    /// those skipped for their platform (the walk passes through them).
    pub graph: &'a HashMap<String, GraphNode>,
    /// Importer id to its direct registry dependencies, `(alias, dep
    /// path)`, in pnpm's merge order (dev, then prod, then optional).
    pub direct_deps_by_importer: &'a BTreeMap<String, Vec<(String, String)>>,
    /// Whether a snapshot is installed. One that is not (skipped for its
    /// platform) is never hoisted and does not claim its alias.
    pub installed: &'a dyn Fn(&str) -> bool,
    pub private: Matcher,
    pub public: Matcher,
    /// `hoistWorkspacePackages`: each named workspace project as
    /// `(name, importer id)`, or `None` when the setting is off.
    pub workspace_packages: Option<Vec<(String, String)>>,
}

struct Entry<'a> {
    depth: i32,
    sort_key: &'a str,
    children: &'a [(String, String)],
}

pub(crate) fn hoist(input: &HoistInput<'_>) -> Vec<Hoisted> {
    let mut pass = Pass {
        input,
        claimed: input
            .direct_deps_by_importer
            .get(".")
            .map(|deps| deps.iter().map(|(alias, _)| alias.to_lowercase()).collect())
            .unwrap_or_default(),
        out: Vec::new(),
    };

    let mut direct_deps: Vec<(String, String)> = Vec::new();
    let mut direct_seen = HashSet::new();
    for deps in input.direct_deps_by_importer.values() {
        for (alias, dep_path) in deps {
            if direct_seen.insert(alias.as_str()) {
                direct_deps.push((alias.clone(), dep_path.clone()));
            }
        }
    }
    if let Some(workspace) = &input.workspace_packages {
        // Workspace project names move to the front of the direct
        // dependencies, in project order.
        let names: HashMap<&str, usize> = workspace
            .iter()
            .enumerate()
            .map(|(index, (name, _))| (name.as_str(), index))
            .collect();
        direct_deps
            .sort_by_key(|(alias, _)| names.get(alias.as_str()).copied().unwrap_or(usize::MAX));
    }

    let mut visited: HashSet<&str> = HashSet::new();
    let mut direct_nodes = Vec::new();
    for deps in input.direct_deps_by_importer.values() {
        for (_, dep_path) in deps {
            if let Some((key, _)) = input.graph.get_key_value(dep_path.as_str())
                && visited.insert(key.as_str())
            {
                direct_nodes.push(key.as_str());
            }
        }
    }

    let mut entries = vec![Entry {
        depth: -1,
        sort_key: "",
        children: &direct_deps,
    }];
    walk(direct_nodes, input.graph, &mut visited, &mut entries);
    // Stable, so equal keys keep walk order, as in pnpm.
    entries.sort_by(|a, b| {
        a.depth
            .cmp(&b.depth)
            .then_with(|| a.sort_key.cmp(b.sort_key))
    });

    let mut workspace_done = false;
    for entry in &entries {
        if !workspace_done && entry.depth >= 0 {
            pass.place_workspace_packages();
            workspace_done = true;
        }
        for (alias, dep_path) in entry.children {
            pass.place(alias, dep_path);
        }
    }
    if !workspace_done {
        pass.place_workspace_packages();
    }
    pass.out
}

/// pnpm's graph walk: level by level per group of siblings, depth first
/// across groups, marking a node visited when its parent's group expands.
fn walk<'a>(
    nodes: Vec<&'a str>,
    graph: &'a HashMap<String, GraphNode>,
    visited: &mut HashSet<&'a str>,
    entries: &mut Vec<Entry<'a>>,
) {
    let mut steps = vec![(nodes, 0)];
    while let Some((nodes, depth)) = steps.pop() {
        for node in &nodes {
            let graph_node = &graph[*node];
            entries.push(Entry {
                depth,
                sort_key: &graph_node.sort_key,
                children: &graph_node.children,
            });
        }
        let next_steps: Vec<Vec<&'a str>> = nodes
            .iter()
            .map(|node| {
                graph[*node]
                    .children
                    .iter()
                    .filter_map(|(_, child)| {
                        let (key, _) = graph.get_key_value(child.as_str())?;
                        visited.insert(key.as_str()).then_some(key.as_str())
                    })
                    .collect()
            })
            .collect();
        for next in next_steps.into_iter().rev() {
            if !next.is_empty() {
                steps.push((next, depth + 1));
            }
        }
    }
}

struct Pass<'a> {
    input: &'a HoistInput<'a>,
    /// Lowercased aliases already taken. Seeded with the root project's
    /// direct dependencies, which already own those names in the root
    /// `node_modules`.
    claimed: HashSet<String>,
    out: Vec<Hoisted>,
}

impl Pass<'_> {
    fn kind(&self, alias: &str) -> Option<HoistKind> {
        if self.input.public.matches(alias) {
            Some(HoistKind::Public)
        } else if self.input.private.matches(alias) {
            Some(HoistKind::Private)
        } else {
            None
        }
    }

    fn place(&mut self, alias: &str, dep_path: &str) {
        let Some(kind) = self.kind(alias) else { return };
        let normalized = alias.to_lowercase();
        if self.claimed.contains(&normalized)
            || !self.input.graph.contains_key(dep_path)
            || !(self.input.installed)(dep_path)
        {
            return;
        }
        self.claimed.insert(normalized);
        self.out.push(Hoisted {
            alias: alias.to_string(),
            target: HoistTarget::Snapshot(dep_path.to_string()),
            kind,
        });
    }

    fn place_workspace_packages(&mut self) {
        let Some(workspace) = &self.input.workspace_packages else {
            return;
        };
        let candidates: Vec<(&str, &str, HoistKind)> = workspace
            .iter()
            .filter_map(|(name, id)| {
                let kind = self.kind(name)?;
                (!self.claimed.contains(&name.to_lowercase())).then_some((
                    name.as_str(),
                    id.as_str(),
                    kind,
                ))
            })
            .collect();
        // Two projects whose names differ only in case cannot both own
        // the alias, so neither gets it.
        let mut counts: HashMap<String, usize> = HashMap::new();
        for (name, _, _) in &candidates {
            *counts.entry(name.to_lowercase()).or_default() += 1;
        }
        for (name, id, kind) in candidates {
            let normalized = name.to_lowercase();
            if counts[&normalized] == 1 && self.claimed.insert(normalized) {
                self.out.push(Hoisted {
                    alias: name.to_string(),
                    target: HoistTarget::Project(id.to_string()),
                    kind,
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matcher_follows_pnpm_patterns() {
        let all = Matcher::new(&["*".into()]);
        assert!(all.matches("@types/node"));
        let eslint = Matcher::new(&["*eslint*".into(), "!eslint-config-x".into()]);
        assert!(eslint.matches("@typescript-eslint/parser"));
        assert!(!eslint.matches("eslint-config-x"));
        assert!(!eslint.matches("prettier"));
        assert!(Matcher::new(&["!react".into()]).matches("vue"));
        assert!(!Matcher::new(&[]).matches("anything"));
        assert!(glob("a*b*c", "aXXbYYc"));
        assert!(!glob("a*b", "aXXc"));
    }

    #[test]
    fn shallower_and_earlier_claims_win() {
        let node = |children: &[(&str, &str)], key: &str| GraphNode {
            children: children
                .iter()
                .map(|(a, d)| (a.to_string(), d.to_string()))
                .collect(),
            sort_key: key.to_string(),
        };
        let mut graph = HashMap::new();
        graph.insert("a@1".to_string(), node(&[("c", "c@1")], "a@1"));
        graph.insert(
            "b@1".to_string(),
            node(&[("c", "c@2"), ("d", "d@1")], "b@1"),
        );
        graph.insert("c@1".to_string(), node(&[], "c@1"));
        graph.insert("c@2".to_string(), node(&[], "c@2"));
        graph.insert("d@1".to_string(), node(&[("a", "a@2")], "d@1"));
        graph.insert("a@2".to_string(), node(&[], "a@2"));
        let mut direct = BTreeMap::new();
        direct.insert(".".to_string(), vec![("a".to_string(), "a@1".to_string())]);
        direct.insert(
            "pkg".to_string(),
            vec![("b".to_string(), "b@1".to_string())],
        );
        let installed = |_: &str| true;
        let input = HoistInput {
            graph: &graph,
            direct_deps_by_importer: &direct,
            installed: &installed,
            private: Matcher::new(&["*".into()]),
            public: Matcher::default(),
            workspace_packages: Some(vec![("pkg".into(), "pkg".into())]),
        };
        let hoisted = hoist(&input);
        let names: Vec<(&str, &HoistTarget)> = hoisted
            .iter()
            .map(|h| (h.alias.as_str(), &h.target))
            .collect();
        assert_eq!(
            names,
            vec![
                // `a` is the root's own and is never hoisted over; `b` is a
                // workspace project's direct dependency.
                ("b", &HoistTarget::Snapshot("b@1".into())),
                ("pkg", &HoistTarget::Project("pkg".into())),
                // a@1 sorts before b@1 at depth 0, so its `c` wins.
                ("c", &HoistTarget::Snapshot("c@1".into())),
                ("d", &HoistTarget::Snapshot("d@1".into())),
            ]
        );
    }
}
