//! `export-ignore` from a tree's `.gitattributes` files: what `git
//! archive` (and so a GitHub zipball, Composer's usual dist) leaves out.
//!
//! A package installed from its git commit is laid out as its dist would
//! be, so its tests and CI files stay out of `vendor/` exactly as they do
//! with `composer install`. `export-subst` is not applied.

/// One `.gitattributes` line that sets or unsets `export-ignore`.
#[derive(Debug, Clone)]
struct Rule {
    /// The directory of the `.gitattributes` file, `""` at the root.
    base: String,
    pattern: String,
    /// The pattern had a `/` before its end, so it is matched against the
    /// path below `base` rather than the last component alone.
    anchored: bool,
    /// A trailing `/`: matches directories only.
    directory_only: bool,
    ignore: bool,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct ExportIgnore {
    rules: Vec<Rule>,
}

impl ExportIgnore {
    /// The rules of every `.gitattributes` among `files` (path and content).
    pub(crate) fn from_files<'a>(files: impl Iterator<Item = (&'a str, &'a [u8])>) -> Self {
        let mut found: Vec<(String, String)> = files
            .filter_map(|(path, data)| {
                let base = match path.rsplit_once('/') {
                    Some((dir, ".gitattributes")) => dir.to_string(),
                    None if path == ".gitattributes" => String::new(),
                    _ => return None,
                };
                Some((base, String::from_utf8_lossy(data).into_owned()))
            })
            .collect();
        // Shallower files first, so deeper ones (read later) win, as in git.
        found.sort_by_key(|(base, _)| {
            (
                base.matches('/').count() + usize::from(!base.is_empty()),
                base.clone(),
            )
        });
        let mut rules = Vec::new();
        for (base, text) in found {
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') || line.starts_with("[attr]") {
                    continue;
                }
                let mut parts = line.split_whitespace();
                let Some(pattern) = parts.next() else {
                    continue;
                };
                // A quoted pattern (C-style) is rare enough to leave alone.
                if pattern.starts_with('"') {
                    continue;
                }
                let ignore = parts.fold(None, |state, attr| match attr {
                    "export-ignore" => Some(true),
                    "-export-ignore" | "!export-ignore" => Some(false),
                    _ => state,
                });
                let Some(ignore) = ignore else { continue };
                let directory_only = pattern.len() > 1 && pattern.ends_with('/');
                let pattern = pattern.trim_end_matches('/');
                let anchored = pattern.contains('/');
                rules.push(Rule {
                    base: base.clone(),
                    pattern: pattern.trim_start_matches('/').to_string(),
                    anchored,
                    directory_only,
                    ignore,
                });
            }
        }
        ExportIgnore { rules }
    }

    /// Whether `git archive` leaves `path` (a file) out: it, or a directory
    /// above it, has `export-ignore` set by the last rule that matches.
    pub(crate) fn excludes(&self, path: &str) -> bool {
        if self.rules.is_empty() {
            return false;
        }
        let parts: Vec<&str> = path.split('/').collect();
        (1..=parts.len()).any(|n| self.ignored(&parts[..n].join("/"), n < parts.len()))
    }

    fn ignored(&self, path: &str, is_dir: bool) -> bool {
        let mut state = false;
        for rule in &self.rules {
            if rule.directory_only && !is_dir {
                continue;
            }
            let relative = if rule.base.is_empty() {
                path
            } else {
                match path
                    .strip_prefix(&rule.base)
                    .and_then(|p| p.strip_prefix('/'))
                {
                    Some(p) => p,
                    None => continue,
                }
            };
            let subject = if rule.anchored {
                relative
            } else {
                relative.rsplit('/').next().unwrap_or(relative)
            };
            if wildmatch(rule.pattern.as_bytes(), subject.as_bytes()) {
                state = rule.ignore;
            }
        }
        state
    }
}

/// git's wildmatch with `WM_PATHNAME`: `*` and `?` stop at `/`, `**`
/// between slashes (or at either end) crosses any number of directories,
/// and `[...]` is a character class.
fn wildmatch(pattern: &[u8], text: &[u8]) -> bool {
    match pattern.first() {
        None => text.is_empty(),
        Some(b'*') if pattern.get(1) == Some(&b'*') => {
            let rest = &pattern[2..];
            // `**/` also matches nothing at all: `a/**/b` matches `a/b`.
            if let Some(after) = rest.strip_prefix(b"/")
                && wildmatch(after, text)
            {
                return true;
            }
            (0..=text.len()).any(|i| wildmatch(rest, &text[i..]))
        }
        Some(b'*') => {
            let rest = &pattern[1..];
            for i in 0..=text.len() {
                if wildmatch(rest, &text[i..]) {
                    return true;
                }
                if text.get(i) == Some(&b'/') {
                    break;
                }
            }
            false
        }
        Some(b'?') => {
            text.first().is_some_and(|&c| c != b'/') && wildmatch(&pattern[1..], &text[1..])
        }
        Some(b'[') => {
            let Some(&c) = text.first() else { return false };
            let Some(end) = pattern[1..]
                .iter()
                .skip(1)
                .position(|&b| b == b']')
                .map(|p| p + 2)
            else {
                return c == b'[' && wildmatch(&pattern[1..], &text[1..]);
            };
            let mut class = &pattern[1..end];
            let negate = matches!(class.first(), Some(b'!' | b'^'));
            if negate {
                class = &class[1..];
            }
            let mut matched = false;
            let mut i = 0;
            while i < class.len() {
                if i + 2 < class.len() && class[i + 1] == b'-' {
                    matched |= class[i] <= c && c <= class[i + 2];
                    i += 3;
                } else {
                    matched |= class[i] == c;
                    i += 1;
                }
            }
            c != b'/' && matched != negate && wildmatch(&pattern[end + 1..], &text[1..])
        }
        Some(b'\\') if pattern.len() > 1 => {
            text.first() == Some(&pattern[1]) && wildmatch(&pattern[2..], &text[1..])
        }
        Some(&p) => text.first() == Some(&p) && wildmatch(&pattern[1..], &text[1..]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rules(files: &[(&str, &str)]) -> ExportIgnore {
        ExportIgnore::from_files(files.iter().map(|(p, t)| (*p, t.as_bytes())))
    }

    #[test]
    fn a_typical_package() {
        let e = rules(&[(
            ".gitattributes",
            "* text=auto\n/tests export-ignore\n/.github/ export-ignore\n*.md export-ignore\n\
             /phpunit.xml.dist export-ignore\n/docs/** export-ignore\n",
        )]);
        for out in [
            "tests/FooTest.php",
            ".github/workflows/ci.yml",
            "README.md",
            "src/notes.md",
            "phpunit.xml.dist",
            "docs/a/b.txt",
        ] {
            assert!(e.excludes(out), "{out}");
        }
        for kept in [
            "src/Foo.php",
            "src/tests/Helper.php",
            "composer.json",
            "docs",
        ] {
            assert!(!e.excludes(kept), "{kept}");
        }
    }

    #[test]
    fn deeper_files_and_unsetting() {
        let e = rules(&[
            (".gitattributes", "*.txt export-ignore\n"),
            (
                "keep/.gitattributes",
                "*.txt -export-ignore\nsecret.php export-ignore\n",
            ),
        ]);
        assert!(e.excludes("a.txt"));
        assert!(!e.excludes("keep/a.txt"));
        assert!(e.excludes("keep/sub/secret.php"));
        assert!(!e.excludes("secret.php"));
    }

    #[test]
    fn wildmatch_rules() {
        assert!(wildmatch(b"a/**/b", b"a/b"));
        assert!(wildmatch(b"a/**/b", b"a/x/y/b"));
        assert!(!wildmatch(b"a/*/b", b"a/x/y/b"));
        assert!(wildmatch(b"*.ph[pt]", b"x.pht"));
        assert!(!wildmatch(b"*.ph[!pt]", b"x.php"));
        assert!(wildmatch(b"?.md", b"a.md"));
        assert!(!wildmatch(b"*", b"a/b"));
    }
}
