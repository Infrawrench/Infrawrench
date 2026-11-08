//! pnpm's dependency paths, ported from its `deps/path` package
//! (`pnpm11/deps/path/src/index.ts` in the pnpm repository, which pnpm 11
//! uses for lockfile format 9).
//!
//! A dependency path is a snapshot key: `name@version`, optionally followed
//! by a `(patch_hash=...)` group and then one `(peer@version)` group per
//! resolved peer, where each peer may carry its own nested groups:
//! `drizzle-orm@0.45.2(patch_hash=af52...)(gel@2.2.0(supports-color@10.2.2))`.
//! The virtual store directory of each snapshot is derived from it by
//! [`dep_path_to_filename`]; getting that exactly right is what lets a
//! layout written here be compared byte for byte with a real pnpm install.

use sha2::Digest;

/// pnpm's default `virtualStoreDirMaxLength` everywhere but Windows.
pub const DEFAULT_VIRTUAL_STORE_DIR_MAX_LENGTH: usize = 120;

const PATCH_HASH_PREFIX: &str = "(patch_hash=";

/// Where a dependency path's suffix groups start: the patch hash group and
/// the first peer group, as byte offsets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
struct SuffixIndex {
    peers: Option<usize>,
    patch_hash: Option<usize>,
}

/// Port of `indexOfDepPathSuffix`. Scans back from the closing paren over
/// balanced groups to the first character outside any of them; the groups
/// start right after it. Parentheses are ASCII, so walking bytes is safe on
/// any UTF-8 input.
fn index_of_suffix(dep_path: &str) -> SuffixIndex {
    let bytes = dep_path.as_bytes();
    if bytes.last() != Some(&b')') {
        return SuffixIndex::default();
    }
    let mut open = 1i32;
    for index in (0..bytes.len() - 1).rev() {
        match bytes[index] {
            b'(' => open -= 1,
            b')' => open += 1,
            _ if open == 0 => {
                let start = index + 1;
                if dep_path[start..].starts_with(PATCH_HASH_PREFIX) {
                    return SuffixIndex {
                        patch_hash: Some(start),
                        peers: dep_path[index + 2..].find('(').map(|i| i + index + 2),
                    };
                }
                return SuffixIndex {
                    patch_hash: None,
                    peers: Some(start),
                };
            }
            _ => {}
        }
    }
    SuffixIndex::default()
}

/// The dependency path without its patch hash and peer groups: the key of
/// the package's entry in the lockfile's `packages` section.
pub fn remove_suffix(dep_path: &str) -> &str {
    let suffix = index_of_suffix(dep_path);
    match (suffix.patch_hash, suffix.peers) {
        (Some(index), _) | (None, Some(index)) => &dep_path[..index],
        (None, None) => dep_path,
    }
}

/// The dependency path without its peer groups (the patch hash stays): what
/// identifies one set of package files, as pnpm's `getPkgIdWithPatchHash`.
pub fn remove_peers_suffix(dep_path: &str) -> &str {
    match index_of_suffix(dep_path).peers {
        Some(index) => &dep_path[..index],
        None => dep_path,
    }
}

/// The package's own patch hash. A patched peer inside the peer groups
/// does not count, as in pnpm's `hasPatchHash`.
pub fn patch_hash(dep_path: &str) -> Option<&str> {
    let start = index_of_suffix(dep_path).patch_hash? + PATCH_HASH_PREFIX.len();
    let rest = &dep_path[start..];
    rest.find(')').map(|end| &rest[..end])
}

/// Splits `name@version` at the `@` that is not a scope marker.
pub fn split_name_version(key: &str) -> Option<(&str, &str)> {
    let at = key.get(1..)?.find('@')? + 1;
    let (name, version) = (&key[..at], &key[at + 1..]);
    (!name.is_empty() && !version.is_empty()).then_some((name, version))
}

/// Port of `refToRelative`: the dependency path a dependency reference
/// points at, or `None` for a `link:` reference. A reference is either a
/// bare version (`4.4.3(supports-color@10.2.2)`, meaning `alias@...`) or a
/// whole dependency path, which is how npm aliases are written
/// (`string-width-cjs: string-width@4.2.3`).
pub fn ref_to_relative(reference: &str, alias: &str) -> Option<String> {
    if reference.starts_with("link:") {
        return None;
    }
    if reference.starts_with('@') {
        return Some(reference.to_string());
    }
    let Some(at) = reference.find('@') else {
        return Some(format!("{alias}@{reference}"));
    };
    let colon = reference.find(':');
    let bracket = reference.find('(');
    if colon.is_none_or(|colon| at < colon) && bracket.is_none_or(|bracket| at < bracket) {
        return Some(reference.to_string());
    }
    Some(format!("{alias}@{reference}"))
}

/// Port of `depPathToFilename`: the directory under the virtual store
/// (`node_modules/.pnpm`) that holds this snapshot.
///
/// Characters that are unsafe in a file name become `+` (so `@scope/name`
/// becomes `@scope+name`), peer groups become `_`-separated, and a name
/// that is too long, has upper case, or could collide after escaping is cut
/// to `max_length_without_hash - 33` characters plus `_` and the first 32
/// hex digits of its SHA-256.
pub fn dep_path_to_filename(dep_path: &str, max_length_without_hash: usize) -> String {
    let unescaped = filename_unescaped(dep_path);
    let mut filename: String = unescaped
        .chars()
        .map(|c| match c {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' => '+',
            c => c,
        })
        .collect();
    if filename.contains('(') {
        if filename.ends_with(')') {
            filename.pop();
        }
        // `.replace(/\)\(|\(|\)/g, '_')`: a `)(` pair is one underscore.
        let mut out = String::with_capacity(filename.len());
        let mut chars = filename.chars().peekable();
        while let Some(c) = chars.next() {
            match c {
                ')' => {
                    if chars.peek() == Some(&'(') {
                        chars.next();
                    }
                    out.push('_');
                }
                '(' => out.push('_'),
                c => out.push(c),
            }
        }
        filename = out;
    }
    let ambiguous = has_ambiguous_escape(dep_path);
    let hash_input = if ambiguous {
        dep_path.to_string()
    } else {
        filename.clone()
    };
    // Windows strips trailing dots and spaces, so pnpm escapes them too.
    let kept = filename.trim_end_matches(['.', ' ']).len();
    let escaped_trailing = kept < filename.len();
    if escaped_trailing {
        let stripped = filename.len() - kept;
        filename.truncate(kept);
        filename.push_str(&"+".repeat(stripped));
    }
    // JavaScript measures UTF-16 units; npm names and versions are ASCII,
    // where that is the same as counting characters.
    let length = filename.chars().count();
    let has_upper = filename != filename.to_lowercase() && !filename.starts_with("file+");
    if ambiguous || escaped_trailing || length > max_length_without_hash || has_upper {
        let keep = max_length_without_hash.saturating_sub(33);
        let prefix: String = filename.chars().take(keep).collect();
        return format!("{prefix}_{}", short_hash(&hash_input));
    }
    filename
}

fn filename_unescaped(dep_path: &str) -> String {
    if let Some(rest) = dep_path.strip_prefix("file:") {
        return format!("file+{rest}");
    }
    // pnpm rebuilds `name@version` around the version separator here, which
    // is the identity; only the leading slash of old lockfiles is dropped.
    dep_path.strip_prefix('/').unwrap_or(dep_path).to_string()
}

/// Port of `hasAmbiguousEscape`: whether the URL or path in a non-registry
/// version holds characters that escaping could map onto another path.
fn has_ambiguous_escape(dep_path: &str) -> bool {
    let pkg_id = dep_path.split('(').next().unwrap_or(dep_path);
    let pkg_id = pkg_id.strip_prefix('/').unwrap_or(pkg_id);
    let is_file = pkg_id.starts_with("file:");
    let separator = pkg_id
        .get(1..)
        .and_then(|rest| rest.find('@'))
        .map(|i| i + 1);
    let version = match (is_file, separator) {
        (true, _) => pkg_id,
        (false, Some(separator)) => &pkg_id[separator + 1..],
        (false, None) => return false,
    };
    let Some(scheme_end) = version.find(':') else {
        return false;
    };
    if parse_registry_qualified_version(version) {
        return false;
    }
    let location = &version[scheme_end + 1..];
    let location = location.strip_prefix("//").unwrap_or(location);
    location.chars().any(|c| {
        matches!(
            c,
            '+' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#'
        )
    })
}

/// Whether `version` is `<registryName>:<semver>` (lockfile format 12's
/// named registries), which escapes unambiguously.
fn parse_registry_qualified_version(version: &str) -> bool {
    const RESERVED: &[&str] = &[
        "bitbucket",
        "catalog",
        "custom",
        "file",
        "git",
        "github",
        "gitlab",
        "http",
        "https",
        "jsr",
        "link",
        "npm",
        "runtime",
        "ssh",
        "workspace",
    ];
    let Some(colon) = version.find(':').filter(|&colon| colon >= 1) else {
        return false;
    };
    let (name, rest) = (&version[..colon], &version[colon + 1..]);
    let well_formed = name.starts_with(|c: char| c.is_ascii_alphabetic())
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'));
    well_formed && !RESERVED.contains(&name) && is_valid_semver(rest)
}

/// node-semver's `valid`, which also takes a leading `v` or `=`.
fn is_valid_semver(version: &str) -> bool {
    let version = version.trim();
    let version = version.strip_prefix('=').unwrap_or(version);
    let version = version.strip_prefix('v').unwrap_or(version);
    semver::Version::parse(version).is_ok()
}

/// pnpm's `createShortHash`: the first 32 hex digits of SHA-256.
fn short_hash(input: &str) -> String {
    let digest = hex::encode(sha2::Sha256::digest(input.as_bytes()));
    digest[..32].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DRIZZLE: &str = "drizzle-orm@0.45.2(patch_hash=af5270b78eaa22944fcb6b36b1dc3574ded989dff17585739f2eab2c623032ba)(@cloudflare/workers-types@5.20260808.1)(@libsql/client@0.14.0)(@opentelemetry/api@1.9.1)(@types/better-sqlite3@7.6.13)(@types/pg@8.21.0)(@types/sql.js@1.4.11)(better-sqlite3@11.10.0)(gel@2.2.0(supports-color@10.2.2))(mysql2@3.23.2(@types/node@22.20.1))(pg@8.22.0)(postgres@3.4.9)(sql.js@1.14.1)";

    #[test]
    fn suffixes_split_like_pnpm() {
        assert_eq!(remove_suffix(DRIZZLE), "drizzle-orm@0.45.2");
        assert_eq!(
            remove_peers_suffix(DRIZZLE),
            "drizzle-orm@0.45.2(patch_hash=af5270b78eaa22944fcb6b36b1dc3574ded989dff17585739f2eab2c623032ba)"
        );
        assert_eq!(
            patch_hash(DRIZZLE),
            Some("af5270b78eaa22944fcb6b36b1dc3574ded989dff17585739f2eab2c623032ba")
        );
        // A patched peer is not the package's own patch.
        let peer_patched = "@volar/typescript@2.4.28(@tsc-rs/typescript@0.8.0(patch_hash=9cc9))";
        assert_eq!(patch_hash(peer_patched), None);
        assert_eq!(remove_suffix(peer_patched), "@volar/typescript@2.4.28");
        assert_eq!(remove_suffix("@types/node@22.20.1"), "@types/node@22.20.1");
        assert_eq!(
            split_name_version("@types/node@22.20.1"),
            Some(("@types/node", "22.20.1"))
        );
        assert_eq!(split_name_version("ms@2.1.3"), Some(("ms", "2.1.3")));
        assert_eq!(split_name_version("@scope/nameless"), None);
    }

    #[test]
    fn references_resolve_to_dep_paths() {
        assert_eq!(ref_to_relative("2.1.3", "ms").unwrap(), "ms@2.1.3");
        assert_eq!(
            ref_to_relative("4.4.3(supports-color@10.2.2)", "debug").unwrap(),
            "debug@4.4.3(supports-color@10.2.2)"
        );
        assert_eq!(
            ref_to_relative("string-width@4.2.3", "string-width-cjs").unwrap(),
            "string-width@4.2.3"
        );
        assert_eq!(
            ref_to_relative("@tsc-rs/typescript@0.8.0(patch_hash=9cc9)", "typescript").unwrap(),
            "@tsc-rs/typescript@0.8.0(patch_hash=9cc9)"
        );
        assert_eq!(ref_to_relative("link:../client-core", "x"), None);
        assert_eq!(
            ref_to_relative("https://codeload.github.com/a/b/tar.gz/abc", "b").unwrap(),
            "b@https://codeload.github.com/a/b/tar.gz/abc"
        );
    }

    /// Directory names copied from a real pnpm 11.20 install of this
    /// repository's lockfile.
    #[test]
    fn filenames_match_a_real_pnpm_install() {
        let cases = [
            ("@0no-co/graphql.web@1.3.3", "@0no-co+graphql.web@1.3.3"),
            (
                "@anthropic-ai/sdk@0.96.0(zod@3.25.76)",
                "@anthropic-ai+sdk@0.96.0_zod@3.25.76",
            ),
            (
                "@tsc-rs/typescript@0.8.0(patch_hash=9cc9538baa11d2f109137f7adaf757cc7023c5f87f7414fa612203a3b6eaea8b)",
                "@tsc-rs+typescript@0.8.0_patch_hash=9cc9538baa11d2f109137f7adaf757cc7023c5f87f7414fa612203a3b6eaea8b",
            ),
            (
                DRIZZLE,
                "drizzle-orm@0.45.2_patch_hash=af5270b78eaa22944fcb6b36b1dc3574ded989dff17585739f2eab2c6_7acc4f74a00f5b805885080e3b2d1678",
            ),
        ];
        for (dep_path, expected) in cases {
            assert_eq!(
                dep_path_to_filename(dep_path, DEFAULT_VIRTUAL_STORE_DIR_MAX_LENGTH),
                expected
            );
        }
    }

    #[test]
    fn upper_case_and_trailing_dots_are_hashed() {
        let upper = dep_path_to_filename("JSONStream@1.3.5", 120);
        assert!(upper.starts_with("JSONStream@1.3.5_"));
        assert_eq!(upper.len(), "JSONStream@1.3.5_".len() + 32);
        let dotted = dep_path_to_filename("a@1.0.0(b@1.)", 120);
        assert!(dotted.starts_with("a@1.0.0_b@1+_"), "{dotted}");
        assert!(has_ambiguous_escape("a@https://example.com/a+b.tgz"));
        assert!(!has_ambiguous_escape("a@https://example.com/a/b.tgz"));
        assert!(!has_ambiguous_escape("a@1.0.0"));
    }
}
