//! Semver versions and the prefix requirements a `using:` line writes.
//!
//! Hand-written rather than the `semver` crate because the requirement
//! language is not Cargo's: `7.1` here means "the highest `7.1.x`", not
//! `^7.1`, and there are no operators. Build metadata is refused outright:
//! semver says it does not affect precedence, so `1.0.0+a` and `1.0.0+b` would
//! be two keys for one version, and `+` is outside the key grammar anyway.
//!
//! A fourth number is a rebuild of the same upstream release, for a builtin
//! whose version is its upstream's (`builtin:bun@1.4.4`) and whose build
//! changed: `1.4.4.1` sorts after `1.4.4` and before `1.4.5`, and `1`,
//! `1.4` and `1.4.4` all pick the highest rebuild, since a published
//! version's bytes never change. Four numbers pin one rebuild. A runner
//! from before rebuilds does not parse such a key and skips it, so it keeps
//! resolving the upstream release it knew. A rebuild is never a prerelease.

use std::cmp::Ordering;
use std::fmt;
use std::str::FromStr;

/// An error parsing a version or requirement.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid version {input:?}: {reason}")]
pub struct VersionError {
    /// What was parsed.
    pub input: String,
    /// Why it was refused.
    pub reason: &'static str,
}

/// One dot-separated prerelease identifier.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum PreId {
    /// All digits, compared numerically.
    Numeric(u64),
    /// Anything else, compared as ASCII.
    Alpha(String),
}

impl Ord for PreId {
    fn cmp(&self, other: &Self) -> Ordering {
        // Semver 11.4: numeric identifiers sort below alphanumeric ones.
        match (self, other) {
            (PreId::Numeric(a), PreId::Numeric(b)) => a.cmp(b),
            (PreId::Numeric(_), PreId::Alpha(_)) => Ordering::Less,
            (PreId::Alpha(_), PreId::Numeric(_)) => Ordering::Greater,
            (PreId::Alpha(a), PreId::Alpha(b)) => a.cmp(b),
        }
    }
}

impl PartialOrd for PreId {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// A `MAJOR.MINOR.PATCH[.REBUILD][-PRERELEASE]` version (a rebuild and a
/// prerelease never together). Serialises as its string.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct Version {
    /// Major component.
    pub major: u64,
    /// Minor component.
    pub minor: u64,
    /// Patch component.
    pub patch: u64,
    /// The rebuild of the upstream `MAJOR.MINOR.PATCH`, from 1; 0 for none.
    pub rebuild: u64,
    /// Prerelease identifiers; empty for a release.
    pub pre: Vec<PreId>,
}

impl Version {
    /// Whether this is a prerelease.
    pub fn is_prerelease(&self) -> bool {
        !self.pre.is_empty()
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        (self.major, self.minor, self.patch, self.rebuild)
            .cmp(&(other.major, other.minor, other.patch, other.rebuild))
            .then_with(|| match (self.pre.is_empty(), other.pre.is_empty()) {
                // A release sorts above any prerelease of the same triple.
                (true, true) => Ordering::Equal,
                (true, false) => Ordering::Greater,
                (false, true) => Ordering::Less,
                (false, false) => self.pre.cmp(&other.pre),
            })
    }
}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl fmt::Display for Version {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if self.rebuild > 0 {
            write!(f, ".{}", self.rebuild)?;
        }
        for (i, id) in self.pre.iter().enumerate() {
            f.write_str(if i == 0 { "-" } else { "." })?;
            match id {
                PreId::Numeric(n) => write!(f, "{n}")?,
                PreId::Alpha(s) => f.write_str(s)?,
            }
        }
        Ok(())
    }
}

fn numeric(input: &str, part: &str) -> Result<u64, VersionError> {
    let err = |reason| VersionError {
        input: input.to_owned(),
        reason,
    };
    if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
        return Err(err("components must be decimal numbers"));
    }
    if part.len() > 1 && part.starts_with('0') {
        return Err(err("components must not have leading zeros"));
    }
    part.parse().map_err(|_| err("component out of range"))
}

fn prerelease(input: &str, pre: &str) -> Result<Vec<PreId>, VersionError> {
    let err = |reason| VersionError {
        input: input.to_owned(),
        reason,
    };
    pre.split('.')
        .map(|id| {
            if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                return Err(err("prerelease identifiers are [0-9A-Za-z-]+"));
            }
            if id.bytes().all(|b| b.is_ascii_digit()) {
                numeric(input, id).map(PreId::Numeric)
            } else {
                Ok(PreId::Alpha(id.to_owned()))
            }
        })
        .collect()
}

/// Splits off the prerelease and parses the dotted numeric part into at most
/// four components.
fn parse_parts(input: &str) -> Result<(Vec<u64>, Vec<PreId>), VersionError> {
    let err = |reason| VersionError {
        input: input.to_owned(),
        reason,
    };
    if input.contains('+') {
        return Err(err("build metadata (`+...`) is not supported"));
    }
    let (core, pre) = match input.split_once('-') {
        Some((core, pre)) => (core, prerelease(input, pre)?),
        None => (input, Vec::new()),
    };
    let nums = core
        .split('.')
        .map(|p| numeric(input, p))
        .collect::<Result<Vec<_>, _>>()?;
    if nums.len() > 4 {
        return Err(err("more than four components"));
    }
    if nums.len() == 4 && !pre.is_empty() {
        return Err(err("a rebuild is never a prerelease"));
    }
    if nums.len() == 4 && nums[3] == 0 {
        return Err(err("a rebuild counts from 1"));
    }
    Ok((nums, pre))
}

impl FromStr for Version {
    type Err = VersionError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let (nums, pre) = parse_parts(s)?;
        let (major, minor, patch, rebuild) = match nums[..] {
            [major, minor, patch] => (major, minor, patch, 0),
            [major, minor, patch, rebuild] => (major, minor, patch, rebuild),
            _ => {
                return Err(VersionError {
                    input: s.to_owned(),
                    reason: "expected MAJOR.MINOR.PATCH",
                });
            }
        };
        Ok(Version {
            major,
            minor,
            patch,
            rebuild,
            pre,
        })
    }
}

impl TryFrom<String> for Version {
    type Error = VersionError;

    fn try_from(s: String) -> Result<Self, Self::Error> {
        s.parse()
    }
}

impl From<Version> for String {
    fn from(v: Version) -> Self {
        v.to_string()
    }
}

/// A prefix requirement: `7`, `7.1`, `7.1.3`, `7.1.3.2` or `7.1.3-rc.1`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum VersionReq {
    /// `7`: the highest `7.x.y` release, rebuilds included.
    Major(u64),
    /// `7.1`: the highest `7.1.x` release, rebuilds included.
    Minor(u64, u64),
    /// `7.1.3`: `7.1.3` or its highest rebuild (`7.1.3.2`).
    Patch(u64, u64, u64),
    /// `7.1.3.2` or `7.1.3-rc.1`: exactly that version.
    Exact(Version),
}

impl VersionReq {
    /// Whether `v` satisfies the requirement. A prerelease is only matched by
    /// an exact requirement naming it, so publishing `8.0.0-rc.1` never moves
    /// a job pinned to `8` onto it.
    pub fn matches(&self, v: &Version) -> bool {
        match self {
            VersionReq::Major(m) => !v.is_prerelease() && v.major == *m,
            VersionReq::Minor(m, n) => !v.is_prerelease() && v.major == *m && v.minor == *n,
            VersionReq::Patch(m, n, p) => {
                !v.is_prerelease() && (v.major, v.minor, v.patch) == (*m, *n, *p)
            }
            VersionReq::Exact(e) => v == e,
        }
    }

    /// The highest of `versions` that matches.
    pub fn best<'a>(&self, versions: impl IntoIterator<Item = &'a Version>) -> Option<&'a Version> {
        versions.into_iter().filter(|v| self.matches(v)).max()
    }
}

impl fmt::Display for VersionReq {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            VersionReq::Major(m) => write!(f, "{m}"),
            VersionReq::Minor(m, n) => write!(f, "{m}.{n}"),
            VersionReq::Patch(m, n, p) => write!(f, "{m}.{n}.{p}"),
            VersionReq::Exact(v) => write!(f, "{v}"),
        }
    }
}

impl FromStr for VersionReq {
    type Err = VersionError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        let (nums, pre) = parse_parts(s)?;
        match (nums.as_slice(), pre.is_empty()) {
            (&[m], true) => Ok(VersionReq::Major(m)),
            (&[m, n], true) => Ok(VersionReq::Minor(m, n)),
            (&[m, n, p], true) => Ok(VersionReq::Patch(m, n, p)),
            (&[_, _, _], false) | (&[_, _, _, _], _) => Ok(VersionReq::Exact(s.parse()?)),
            _ => Err(VersionError {
                input: s.to_owned(),
                reason: "a prerelease needs a full MAJOR.MINOR.PATCH",
            }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        s.parse().unwrap()
    }

    #[test]
    fn parse_and_display_round_trip() {
        for s in [
            "0.0.0",
            "7.1.3",
            "1.0.0-rc.1",
            "1.0.0-alpha-1.x.0",
            "10.20.30",
            "1.4.4.1",
            "1.4.4.12",
        ] {
            assert_eq!(v(s).to_string(), s);
        }
        for bad in [
            "",
            "1",
            "1.2",
            "1.2.3.4.5",
            "1.2.3.0",
            "1.2.3.01",
            "1.2.3.4-rc.1",
            "01.2.3",
            "1.02.3",
            "1.2.3-",
            "1.2.3-a..b",
            "1.2.3-01",
            "1.2.3+build",
            "v1.2.3",
            "1.2.x",
            "1.2.3-a_b",
        ] {
            assert!(bad.parse::<Version>().is_err(), "{bad:?} accepted");
        }
    }

    #[test]
    fn semver_precedence() {
        let ordered = [
            "1.0.0-alpha",
            "1.0.0-alpha.1",
            "1.0.0-alpha.beta",
            "1.0.0-beta",
            "1.0.0-beta.2",
            "1.0.0-beta.11",
            "1.0.0-rc.1",
            "1.0.0",
            "1.0.0.1",
            "1.0.0.2",
            "1.0.0.10",
            "1.0.1",
            "1.1.0",
            "2.0.0",
        ];
        for pair in ordered.windows(2) {
            assert!(v(pair[0]) < v(pair[1]), "{} < {}", pair[0], pair[1]);
        }
    }

    #[test]
    fn prefix_requirements() {
        let all: Vec<Version> = [
            "7.0.9",
            "7.1.0",
            "7.1.3",
            "7.2.0-rc.1",
            "7.10.0",
            "8.0.0-rc.1",
        ]
        .iter()
        .map(|s| v(s))
        .collect();
        let best = |r: &str| {
            r.parse::<VersionReq>()
                .unwrap()
                .best(&all)
                .map(ToString::to_string)
        };
        assert_eq!(best("7").as_deref(), Some("7.10.0"));
        assert_eq!(best("7.1").as_deref(), Some("7.1.3"));
        assert_eq!(best("7.1.0").as_deref(), Some("7.1.0"));
        // Prefixes never select a prerelease, exact requirements can.
        assert_eq!(best("7.2"), None);
        assert_eq!(best("8"), None);
        assert_eq!(best("8.0.0-rc.1").as_deref(), Some("8.0.0-rc.1"));
        assert_eq!(best("7.1.4"), None);
        // `7.1` is not a string prefix: it must not pick up 7.10.0.
        assert!(!"7.1".parse::<VersionReq>().unwrap().matches(&v("7.10.0")));
        assert!("7.1-rc.1".parse::<VersionReq>().is_err());
        assert!("7.1.3+x".parse::<VersionReq>().is_err());
    }

    /// A rebuild of an upstream release (`builtin:bun` 1.4.4 with more of
    /// the C library): every prefix and the bare upstream version pick the
    /// highest rebuild, four numbers pin one, and the next upstream release
    /// still wins over any rebuild of this one.
    #[test]
    fn rebuilds_are_picked_by_every_prefix_and_pinned_by_four_numbers() {
        let mut all: Vec<Version> = ["1.4.3", "1.4.4", "1.4.4.1", "1.4.4.2"]
            .iter()
            .map(|s| v(s))
            .collect();
        let best = |all: &[Version], r: &str| {
            r.parse::<VersionReq>()
                .unwrap()
                .best(all)
                .map(ToString::to_string)
        };
        for r in ["1", "1.4", "1.4.4"] {
            assert_eq!(best(&all, r).as_deref(), Some("1.4.4.2"), "{r}");
        }
        assert_eq!(best(&all, "1.4.4.1").as_deref(), Some("1.4.4.1"));
        assert_eq!(best(&all, "1.4.3").as_deref(), Some("1.4.3"));
        assert_eq!(best(&all, "1.4.4.3"), None);
        assert_eq!("1.4.4".parse::<VersionReq>().unwrap().to_string(), "1.4.4");
        assert_eq!(
            "1.4.4.1".parse::<VersionReq>().unwrap().to_string(),
            "1.4.4.1"
        );
        all.push(v("1.4.5"));
        assert_eq!(best(&all, "1.4").as_deref(), Some("1.4.5"));
        assert!("1.4.4.0".parse::<VersionReq>().is_err());
        assert!("1.4.4.1-rc.1".parse::<VersionReq>().is_err());
    }
}
