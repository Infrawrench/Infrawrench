//! Reading `Gemfile.lock`, as Bundler's `LockfileParser` reads it.
//!
//! ```text
//! GIT                              one section per git source
//!   remote: https://github.com/rails/rails.git
//!   revision: 0123…                the commit
//!   branch: main                   (or ref:, tag:), glob:, submodules:
//!   specs:
//!     rails (8.1.0.alpha)          a gem the source provides
//!       actionpack (= 8.1.0.alpha) and what it depends on
//!
//! GEM                              one section per gem server
//!   remote: https://rubygems.org/
//!   specs:
//!     nokogiri (1.19.7)            the `ruby` platform's build
//!     nokogiri (1.19.7-x86_64-linux-gnu)
//!
//! PATH                             a directory of the repository
//!   remote: .
//!   specs:
//!     mygem (0.1.0)
//!
//! PLATFORMS / DEPENDENCIES / CHECKSUMS / RUBY VERSION / BUNDLED WITH
//! ```

use std::collections::BTreeMap;

/// One gem a source provides, as the lock names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct LockedSpec {
    pub name: String,
    pub version: String,
    /// `ruby` when the lock names no platform.
    pub platform: String,
    /// Names of the gems it depends on.
    pub dependencies: Vec<String>,
}

impl LockedSpec {
    /// `name-version`, or `name-version-platform` for a platform's build:
    /// the gem's file name, and its directory once installed.
    pub fn full_name(&self) -> String {
        if self.platform == "ruby" {
            format!("{}-{}", self.name, self.version)
        } else {
            format!("{}-{}-{}", self.name, self.version, self.platform)
        }
    }

    /// `name (version)` or `name (version-platform)`, as the lock writes it.
    pub fn lock_name(&self) -> String {
        if self.platform == "ruby" {
            format!("{} ({})", self.name, self.version)
        } else {
            format!("{} ({}-{})", self.name, self.version, self.platform)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SourceKind {
    /// A gem server: `GEM`. Modern locks have one remote per section; an
    /// old one lists several, each of which may serve any of its gems.
    Gem {
        remotes: Vec<String>,
    },
    Git {
        remote: String,
        revision: String,
        /// `branch: main`, `tag: v1`, `ref: …`, for messages.
        reference: Option<String>,
        submodules: bool,
    },
    Path {
        remote: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Source {
    pub kind: SourceKind,
    pub specs: Vec<LockedSpec>,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct Lockfile {
    pub sources: Vec<Source>,
    pub platforms: Vec<String>,
    /// Whether the lock has a `CHECKSUMS` section at all.
    pub has_checksums: bool,
    /// Each gem's SHA-256 (lowercase hex) by its [`LockedSpec::lock_name`].
    /// A gem listed without one (a `PATH` or `GIT` gem) maps to `None`.
    pub checksums: BTreeMap<String, Option<String>>,
    /// `ruby 3.4.1p0` → `3.4.1p0`.
    pub ruby_version: Option<String>,
    pub bundled_with: Option<String>,
}

#[derive(PartialEq)]
enum Section {
    Source,
    Platforms,
    Dependencies,
    Checksums,
    RubyVersion,
    BundledWith,
    Other,
}

/// Parses `text`, a `Gemfile.lock`.
pub(crate) fn parse(text: &str) -> Result<Lockfile, String> {
    if text.contains("<<<<<<<") && text.contains(">>>>>>>") {
        return Err("has merge conflict markers".to_string());
    }
    let mut lock = Lockfile::default();
    let mut section = Section::Other;
    // The source being read: its header, its options and its specs.
    let mut header = String::new();
    let mut options: Vec<(String, String)> = Vec::new();
    let mut specs: Vec<LockedSpec> = Vec::new();
    let mut in_specs = false;

    for (index, raw) in text.lines().enumerate() {
        let line_no = index + 1;
        let line = raw.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        if !line.starts_with(' ') {
            if section == Section::Source {
                lock.sources.push(finish_source(
                    &header,
                    &options,
                    std::mem::take(&mut specs),
                )?);
                options.clear();
            }
            in_specs = false;
            section = match line {
                "GEM" | "GIT" | "PATH" => {
                    header = line.to_string();
                    Section::Source
                }
                "PLUGIN SOURCE" => {
                    return Err(format!(
                        "line {line_no}: a Bundler plugin source, which is not supported"
                    ));
                }
                "PLATFORMS" => Section::Platforms,
                "DEPENDENCIES" => Section::Dependencies,
                "CHECKSUMS" => {
                    lock.has_checksums = true;
                    Section::Checksums
                }
                "RUBY VERSION" => Section::RubyVersion,
                "BUNDLED WITH" => Section::BundledWith,
                // Bundler skips sections it does not know.
                _ => Section::Other,
            };
            continue;
        }
        let indent = line.len() - line.trim_start_matches(' ').len();
        let content = &line[indent..];
        let bad = |what: &str| format!("line {line_no}: {what}: {content:?}");
        match section {
            Section::Source => match indent {
                2 if content == "specs:" => in_specs = true,
                2 => {
                    let (key, value) = content
                        .split_once(": ")
                        .or_else(|| content.strip_suffix(':').map(|k| (k, "")))
                        .ok_or_else(|| bad("not `key: value`"))?;
                    options.push((key.to_string(), value.to_string()));
                }
                4 if in_specs => {
                    let (name, version, platform, _) =
                        spec_line(content).ok_or_else(|| bad("not a gem and its version"))?;
                    let version = version.ok_or_else(|| bad("a gem without a version"))?;
                    specs.push(LockedSpec {
                        name,
                        version,
                        platform: platform.unwrap_or_else(|| "ruby".to_string()),
                        dependencies: Vec::new(),
                    });
                }
                6 if in_specs => {
                    let (name, _, _, _) =
                        spec_line(content).ok_or_else(|| bad("not a dependency"))?;
                    specs
                        .last_mut()
                        .ok_or_else(|| bad("a dependency before any gem"))?
                        .dependencies
                        .push(name);
                }
                _ => return Err(bad("unexpected indentation")),
            },
            Section::Platforms => lock.platforms.push(content.to_string()),
            Section::Checksums => {
                let (name_part, sums) = match content.find(") ") {
                    Some(at) => (&content[..=at], Some(&content[at + 2..])),
                    None => (content, None),
                };
                let (name, version, platform, _) =
                    spec_line(name_part).ok_or_else(|| bad("not a checksum line"))?;
                let version = version.ok_or_else(|| bad("a checksum without a version"))?;
                let spec = LockedSpec {
                    name,
                    version,
                    platform: platform.unwrap_or_else(|| "ruby".to_string()),
                    dependencies: Vec::new(),
                };
                let mut sha256 = None;
                for sum in sums.unwrap_or("").split(',') {
                    if let Some(hex) = sum.trim().strip_prefix("sha256=") {
                        if hex.len() != 64 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                            return Err(bad("a sha256 that is not 64 hex digits"));
                        }
                        sha256 = Some(hex.to_ascii_lowercase());
                    }
                }
                lock.checksums.insert(spec.lock_name(), sha256);
            }
            Section::RubyVersion => {
                lock.ruby_version = Some(
                    content
                        .strip_prefix("ruby ")
                        .unwrap_or(content)
                        .trim()
                        .to_string(),
                );
            }
            Section::BundledWith => lock.bundled_with = Some(content.trim().to_string()),
            Section::Dependencies | Section::Other => {}
        }
    }
    if section == Section::Source {
        lock.sources.push(finish_source(&header, &options, specs)?);
    }
    Ok(lock)
}

fn finish_source(
    header: &str,
    options: &[(String, String)],
    specs: Vec<LockedSpec>,
) -> Result<Source, String> {
    let get = |key: &str| {
        options
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.clone())
    };
    let remotes: Vec<String> = options
        .iter()
        .filter(|(k, _)| k == "remote")
        .map(|(_, v)| v.clone())
        .collect();
    let first_remote = || {
        remotes
            .first()
            .cloned()
            .ok_or_else(|| format!("a {header} section without a remote"))
    };
    let kind = match header {
        "GEM" => SourceKind::Gem {
            remotes: remotes.clone(),
        },
        "GIT" => SourceKind::Git {
            remote: first_remote()?,
            revision: get("revision")
                .ok_or_else(|| format!("the GIT section for {} has no revision", remotes[0]))?,
            reference: ["branch", "tag", "ref"]
                .iter()
                .find_map(|k| get(k).map(|v| format!("{k}: {v}"))),
            submodules: get("submodules").is_some_and(|v| v == "true"),
        },
        _ => SourceKind::Path {
            remote: first_remote()?,
        },
    };
    Ok(Source { kind, specs })
}

/// `name (version-platform)!` split as Bundler's `NAME_VERSION` pattern
/// splits it: the version is everything before the first `-` in the
/// parentheses, the platform everything after.
fn spec_line(text: &str) -> Option<(String, Option<String>, Option<String>, bool)> {
    let (text, pinned) = match text.strip_suffix('!') {
        Some(rest) => (rest, true),
        None => (text, false),
    };
    let (name, rest) = match text.split_once(' ') {
        Some((name, rest)) => (name, Some(rest)),
        None => (text, None),
    };
    if name.is_empty() || name.contains(char::is_whitespace) {
        return None;
    }
    let Some(rest) = rest else {
        return Some((name.to_string(), None, None, pinned));
    };
    let inner = rest.strip_prefix('(')?.strip_suffix(')')?;
    let (version, platform) = match inner.split_once('-') {
        Some((v, p)) => (v, Some(p.to_string())),
        None => (inner, None),
    };
    Some((
        name.to_string(),
        Some(version.to_string()),
        platform,
        pinned,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spec_lines_split_as_bundler_splits_them() {
        assert_eq!(
            spec_line("nokogiri (1.19.7-x86_64-linux-gnu)"),
            Some((
                "nokogiri".into(),
                Some("1.19.7".into()),
                Some("x86_64-linux-gnu".into()),
                false
            ))
        );
        assert_eq!(
            spec_line("rails (= 8.1.0.alpha)"),
            Some(("rails".into(), Some("= 8.1.0.alpha".into()), None, false))
        );
        assert_eq!(
            spec_line("mygem!"),
            Some(("mygem".into(), None, None, true))
        );
        assert_eq!(spec_line("rack"), Some(("rack".into(), None, None, false)));
        assert_eq!(spec_line("bad (1.0"), None);
    }
}
