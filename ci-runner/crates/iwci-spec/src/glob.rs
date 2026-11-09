//! Branch and path globs (`main`, `release/*`, `app/packages/web/**`).
//! `*` stops at `/`, `**` crosses it, as in most CI systems.
//!
//! In a filter (`branches:` and `paths:`), a pattern starting with `!`
//! excludes. Patterns are read in order and the last one that matches a
//! name decides, so `[app/**, "!app/docs/**"]` is everything under `app/`
//! but its docs, and a later pattern can include again. A list that starts
//! with an exclusion begins from everything, so `["!**/*.md"]` alone is
//! anything but Markdown.

pub(crate) fn compile(pattern: &str) -> Result<globset::GlobMatcher, globset::Error> {
    Ok(globset::GlobBuilder::new(pattern)
        .literal_separator(true)
        .build()?
        .compile_matcher())
}

/// Checks one filter pattern, `!` and all.
pub(crate) fn check_filter(pattern: &str) -> Result<(), String> {
    if pattern.is_empty() {
        // What YAML leaves of an unquoted `- !docs/**`: it reads the `!`
        // as a tag and the pattern as the tag's name.
        return Err(
            "an empty pattern; an exclusion has to be quoted in YAML, as `- \"!docs/**\"`".into(),
        );
    }
    let body = pattern.strip_prefix('!').unwrap_or(pattern);
    if body.is_empty() {
        return Err(format!("`{pattern}` has nothing to match"));
    }
    compile(body)
        .map(|_| ())
        .map_err(|e| format!("`{pattern}`: {e}"))
}

/// A filter's patterns compiled once, for matching many paths.
#[derive(Debug, Clone)]
pub struct PathFilter {
    starts_included: bool,
    patterns: Vec<(bool, globset::GlobMatcher)>,
}

impl PathFilter {
    /// Patterns that do not compile are left out; validation has already
    /// reported them.
    pub fn new(patterns: &[String]) -> Self {
        Self {
            starts_included: patterns.first().is_some_and(|p| p.starts_with('!')),
            patterns: patterns
                .iter()
                .filter_map(|p| {
                    let (negated, body) = match p.strip_prefix('!') {
                        Some(body) => (true, body),
                        None => (false, p.as_str()),
                    };
                    compile(body).ok().map(|m| (negated, m))
                })
                .collect(),
        }
    }

    pub fn matches(&self, candidate: &str) -> bool {
        let mut included = self.starts_included;
        for (negated, m) in &self.patterns {
            if m.is_match(candidate) {
                included = !negated;
            }
        }
        included
    }

    /// Where the paths the filter lets through can be, relative to the
    /// root: the directories to walk (the literal leading segments of each
    /// including pattern with a wildcard; `""` is the root) and single files
    /// (including patterns without a wildcard). Everything when the filter
    /// starts from everything.
    pub fn bases(&self, patterns: &[String]) -> (Vec<String>, Vec<String>) {
        if self.starts_included {
            return (vec![String::new()], Vec::new());
        }
        let mut dirs: Vec<String> = Vec::new();
        let mut files: Vec<String> = Vec::new();
        for p in patterns.iter().filter(|p| !p.starts_with('!')) {
            let segments: Vec<&str> = p.split('/').collect();
            let literal = segments
                .iter()
                .take_while(|s| !s.contains(['*', '?', '[', '{', '\\']))
                .count();
            if literal == segments.len() {
                files.push(p.clone());
            } else {
                dirs.push(segments[..literal].join("/"));
            }
        }
        dirs.sort();
        dirs.dedup();
        let all = dirs.clone();
        dirs.retain(|b| {
            !all.iter()
                .any(|o| o != b && (o.is_empty() || b.starts_with(&format!("{o}/"))))
        });
        files.sort();
        files.dedup();
        (dirs, files)
    }
}

/// Whether a filter's patterns let `candidate` through.
pub(crate) fn filter_matches(patterns: &[String], candidate: &str) -> bool {
    let mut included = patterns.first().is_some_and(|p| p.starts_with('!'));
    for pattern in patterns {
        let (negated, body) = match pattern.strip_prefix('!') {
            Some(body) => (true, body),
            None => (false, pattern.as_str()),
        };
        if compile(body).is_ok_and(|m| m.is_match(candidate)) {
            included = !negated;
        }
    }
    included
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(patterns: &[&str], candidate: &str) -> bool {
        let patterns: Vec<String> = patterns.iter().map(|p| p.to_string()).collect();
        filter_matches(&patterns, candidate)
    }

    #[test]
    fn exclusions_and_reinclusions_are_read_in_order() {
        let p = ["app/**", "!app/docs/**", "app/docs/api.md"];
        assert!(f(&p, "app/web/main.ts"));
        assert!(!f(&p, "app/docs/intro.md"));
        assert!(f(&p, "app/docs/api.md"), "a later pattern includes again");
        assert!(!f(&p, "README.md"), "nothing included it");
        assert!(
            f(&["!**/*.md"], "src/lib.rs"),
            "a leading exclusion starts from everything"
        );
        assert!(!f(&["!**/*.md"], "docs/a.md"));
        assert!(f(&["*", "!dependabot/*"], "main"));
        assert!(
            !f(&["*", "!dependabot/*"], "dependabot/npm"),
            "`*` alone stops at `/`"
        );
        assert!(f(&["**", "!dependabot/**"], "release/1.0"));
    }

    #[test]
    fn bad_filters_are_named() {
        assert!(check_filter("!").unwrap_err().contains("nothing to match"));
        assert!(check_filter("![").unwrap_err().contains("`![`"));
        assert!(check_filter("!docs/**").is_ok());
    }
}
