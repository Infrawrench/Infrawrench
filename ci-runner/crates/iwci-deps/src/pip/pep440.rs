//! PEP 440 versions and the specifier operators markers compare with.
//!
//! Only what the pip installer needs: parsing (with PEP 440's
//! normalisations), ordering, and the `==`, `!=`, `<`, `<=`, `>`, `>=`,
//! `~=` and `===` operators against a single version. Ranges are never
//! resolved here; a lock pins every version.

use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
enum Local {
    Number(u64),
    Text(String),
}

/// Equality is PEP 440's, as ordering is: `1.0 == 1.0.0`.
#[derive(Debug, Clone)]
pub struct Version {
    epoch: u64,
    release: Vec<u64>,
    /// `a`, `b` or `rc` as 0, 1, 2, and its number.
    pre: Option<(u8, u64)>,
    post: Option<u64>,
    dev: Option<u64>,
    local: Vec<Local>,
}

impl Version {
    pub fn parse(text: &str) -> Option<Version> {
        Parser::new(text).version()
    }

    pub fn has_local(&self) -> bool {
        !self.local.is_empty()
    }

    pub fn is_prerelease(&self) -> bool {
        self.pre.is_some() || self.dev.is_some()
    }

    fn without_local(&self) -> Version {
        Version {
            local: Vec::new(),
            ..self.clone()
        }
    }

    /// Epoch and release only.
    fn base(&self) -> Version {
        Version {
            epoch: self.epoch,
            release: self.release.clone(),
            pre: None,
            post: None,
            dev: None,
            local: Vec::new(),
        }
    }

    fn release_at(&self, i: usize) -> u64 {
        self.release.get(i).copied().unwrap_or(0)
    }

    /// Whether `self` matches `==spec` (`spec` without a trailing `.*`).
    /// A spec without a local label ignores the candidate's.
    pub fn matches_exactly(&self, spec: &Version) -> bool {
        if spec.has_local() {
            self == spec
        } else {
            self.without_local() == *spec
        }
    }
}

impl Ord for Version {
    fn cmp(&self, other: &Self) -> Ordering {
        // Releases compare with trailing zeros ignored: 1.0 == 1.0.0.
        let release = || {
            let n = self.release.len().max(other.release.len());
            (0..n)
                .map(|i| self.release_at(i).cmp(&other.release_at(i)))
                .find(|o| *o != Ordering::Equal)
                .unwrap_or(Ordering::Equal)
        };
        // packaging's sort key: a dev release with no pre or post sorts
        // before every pre-release; no pre-release sorts after them all.
        let pre_key = |v: &Version| -> (i8, u8, u64) {
            match (v.pre, v.post, v.dev) {
                (None, None, Some(_)) => (-1, 0, 0),
                (None, _, _) => (1, 0, 0),
                (Some((kind, n)), _, _) => (0, kind, n),
            }
        };
        let post_key = |v: &Version| v.post.map_or((0, 0), |n| (1, n));
        let dev_key = |v: &Version| v.dev.map_or((1, 0), |n| (0, n));
        self.epoch
            .cmp(&other.epoch)
            .then_with(release)
            .then_with(|| pre_key(self).cmp(&pre_key(other)))
            .then_with(|| post_key(self).cmp(&post_key(other)))
            .then_with(|| dev_key(self).cmp(&dev_key(other)))
            .then_with(|| compare_local(&self.local, &other.local))
    }
}

impl PartialEq for Version {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for Version {}

impl PartialOrd for Version {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

fn compare_local(a: &[Local], b: &[Local]) -> Ordering {
    for (x, y) in a.iter().zip(b) {
        let o = match (x, y) {
            (Local::Number(x), Local::Number(y)) => x.cmp(y),
            (Local::Text(x), Local::Text(y)) => x.cmp(y),
            // A number sorts after any text.
            (Local::Number(_), Local::Text(_)) => Ordering::Greater,
            (Local::Text(_), Local::Number(_)) => Ordering::Less,
        };
        if o != Ordering::Equal {
            return o;
        }
    }
    a.len().cmp(&b.len())
}

/// Whether `candidate` satisfies `op spec`, as `packaging`'s `Specifier`
/// decides it with pre-releases allowed. `None` when `spec` is not a
/// version the operator takes; the caller then compares strings.
pub fn compare(candidate: &str, op: &str, spec: &str) -> Option<bool> {
    if op == "===" {
        return Some(candidate.trim().eq_ignore_ascii_case(spec.trim()));
    }
    let candidate = Version::parse(candidate)?;
    if let Some(prefix) = spec.trim().strip_suffix(".*") {
        if !matches!(op, "==" | "!=") {
            return None;
        }
        let prefix = Version::parse(prefix)?;
        if prefix.has_local() || prefix.dev.is_some() {
            return None;
        }
        let matched = prefix_matches(&candidate, &prefix);
        return Some(if op == "==" { matched } else { !matched });
    }
    let spec = Version::parse(spec)?;
    let public = candidate.without_local();
    Some(match op {
        "==" => candidate.matches_exactly(&spec),
        "!=" => !candidate.matches_exactly(&spec),
        "<=" => public <= spec,
        ">=" => public >= spec,
        "<" => {
            public < spec
                && !(!spec.is_prerelease()
                    && candidate.is_prerelease()
                    && candidate.base() == spec.base())
        }
        ">" => {
            public > spec
                && !(spec.post.is_none()
                    && candidate.post.is_some()
                    && candidate.base() == spec.base())
                && !(candidate.has_local() && candidate.base() == spec.base())
        }
        "~=" => {
            if spec.release.len() < 2 {
                return None;
            }
            let mut prefix = spec.base();
            prefix.release.pop();
            public >= spec && prefix_matches(&candidate, &prefix)
        }
        _ => return None,
    })
}

/// `== prefix.*`: the candidate's release starts with the prefix's (and
/// any pre or post part the prefix names).
fn prefix_matches(candidate: &Version, prefix: &Version) -> bool {
    if candidate.epoch != prefix.epoch {
        return false;
    }
    let n = prefix.release.len();
    if (0..n).any(|i| candidate.release_at(i) != prefix.release[i]) {
        return false;
    }
    match (prefix.pre, prefix.post) {
        (Some(pre), _) => candidate.pre == Some(pre) && candidate.release.len() <= n,
        (None, Some(post)) => candidate.post == Some(post) && candidate.release.len() <= n,
        (None, None) => true,
    }
}

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> Parser<'a> {
    fn new(text: &'a str) -> Self {
        Parser {
            s: text.trim().as_bytes(),
            i: 0,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).map(u8::to_ascii_lowercase)
    }

    fn number(&mut self) -> Option<u64> {
        let start = self.i;
        while self.peek().is_some_and(|c| c.is_ascii_digit()) {
            self.i += 1;
        }
        if self.i == start {
            return None;
        }
        std::str::from_utf8(&self.s[start..self.i])
            .ok()?
            .parse()
            .ok()
    }

    fn word(&mut self, words: &[&str]) -> Option<usize> {
        let rest = &self.s[self.i..];
        // Longest first, so `preview` is not read as `pre`.
        let mut best: Option<(usize, usize)> = None;
        for (index, w) in words.iter().enumerate() {
            if rest.len() >= w.len()
                && rest[..w.len()].eq_ignore_ascii_case(w.as_bytes())
                && best.is_none_or(|(_, len)| w.len() > len)
            {
                best = Some((index, w.len()));
            }
        }
        let (index, len) = best?;
        self.i += len;
        Some(index)
    }

    fn separator(&mut self) -> bool {
        if matches!(self.peek(), Some(b'.' | b'-' | b'_')) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    /// Tries `f` and rewinds when it fails.
    fn attempt<T>(&mut self, f: impl FnOnce(&mut Self) -> Option<T>) -> Option<T> {
        let at = self.i;
        let out = f(self);
        if out.is_none() {
            self.i = at;
        }
        out
    }

    fn version(mut self) -> Option<Version> {
        if self.peek() == Some(b'v') {
            self.i += 1;
        }
        let first = self.number()?;
        let (epoch, mut release) = if self.peek() == Some(b'!') {
            self.i += 1;
            (first, vec![self.number()?])
        } else {
            (0, vec![first])
        };
        while let Some(n) = self.attempt(|p| {
            (p.peek() == Some(b'.')).then_some(())?;
            p.i += 1;
            p.number()
        }) {
            release.push(n);
        }
        let pre = self.attempt(|p| {
            p.separator();
            let kind = match p.word(&["a", "alpha", "b", "beta", "c", "rc", "pre", "preview"])? {
                0 | 1 => 0,
                2 | 3 => 1,
                _ => 2,
            };
            let n = p
                .attempt(|p| {
                    p.separator();
                    p.number()
                })
                .unwrap_or(0);
            Some((kind, n))
        });
        let post = self.attempt(|p| {
            if p.peek() == Some(b'-')
                && let Some(n) = p.attempt(|p| {
                    p.i += 1;
                    p.number()
                })
            {
                return Some(n);
            }
            p.separator();
            p.word(&["post", "rev", "r"])?;
            Some(
                p.attempt(|p| {
                    p.separator();
                    p.number()
                })
                .unwrap_or(0),
            )
        });
        let dev = self.attempt(|p| {
            p.separator();
            p.word(&["dev"])?;
            Some(
                p.attempt(|p| {
                    p.separator();
                    p.number()
                })
                .unwrap_or(0),
            )
        });
        let mut local = Vec::new();
        if self.peek() == Some(b'+') {
            self.i += 1;
            let rest = std::str::from_utf8(&self.s[self.i..]).ok()?;
            for part in rest.split(['.', '-', '_']) {
                if part.is_empty() || !part.bytes().all(|b| b.is_ascii_alphanumeric()) {
                    return None;
                }
                local.push(match part.parse() {
                    Ok(n) if part.bytes().all(|b| b.is_ascii_digit()) => Local::Number(n),
                    _ => Local::Text(part.to_ascii_lowercase()),
                });
            }
            self.i = self.s.len();
        }
        (self.i == self.s.len()).then_some(Version {
            epoch,
            release,
            pre,
            post,
            dev,
            local,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(s: &str) -> Version {
        Version::parse(s).unwrap_or_else(|| panic!("{s} parses"))
    }

    #[test]
    fn parses_and_normalises() {
        assert_eq!(v("1.0"), v("1.0.0"));
        assert_eq!(v("1.0a1"), v("1.0.alpha.1"));
        assert_eq!(v("1.0rc1"), v("1.0c1"));
        assert_eq!(v("1.0-1"), v("1.0.post1"));
        assert_eq!(v("v2.5.1"), v("2.5.1"));
        assert_eq!(v("1.0.dev0"), v("1.0dev"));
        assert!(Version::parse("1.0+").is_none());
        assert!(Version::parse("one").is_none());
        assert!(Version::parse("1.0 junk").is_none());
    }

    #[test]
    fn orders_like_packaging() {
        let order = [
            "1.0.dev1",
            "1.0a1",
            "1.0a2.dev1",
            "1.0a2",
            "1.0b1",
            "1.0rc1",
            "1.0",
            "1.0+local",
            "1.0.post1.dev1",
            "1.0.post1",
            "1.1",
        ];
        for pair in order.windows(2) {
            assert!(v(pair[0]) < v(pair[1]), "{} < {}", pair[0], pair[1]);
        }
        assert!(v("1!0.1") > v("2.0"));
    }

    #[test]
    fn specifiers() {
        assert_eq!(compare("3.13", ">=", "3.8"), Some(true));
        assert_eq!(compare("3.13", "<", "3.13"), Some(false));
        assert_eq!(compare("3.13.15", "==", "3.13.*"), Some(true));
        assert_eq!(compare("3.13.15", "!=", "3.12.*"), Some(true));
        assert_eq!(compare("2.5.1+wasix.3", "==", "2.5.1"), Some(true));
        assert_eq!(compare("2.5.1", "==", "2.5.1+wasix.3"), Some(false));
        assert_eq!(compare("1.4.2", "~=", "1.4"), Some(true));
        assert_eq!(compare("2.0", "~=", "1.4"), Some(false));
        assert_eq!(compare("1.0a1", "<", "1.0"), Some(false));
        assert_eq!(compare("1.0.post1", ">", "1.0"), Some(false));
        assert_eq!(compare("linux", "==", "3"), None);
        assert_eq!(compare("anything", "===", "Anything"), Some(true));
    }
}
