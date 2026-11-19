//! npm packages that load a native binary a job cannot run, and the
//! WebAssembly build of each that the JavaScript installers put in its
//! place.
//!
//! A job's `node` reports platform `wasi` and arch `wasm32` and cannot load
//! a `.node` addon or start a native executable. Most packages with a
//! native core already cope: their `wasm32` build is an optional
//! dependency the installers keep (rolldown, oxc, `@tailwindcss/oxide`).
//! The packages here publish theirs as a separate package instead, at the
//! same versions and with the same API for Node, so installing the
//! WebAssembly build in the native package's directory is what their own
//! documentation suggests (`"overrides": { "rollup": "npm:@rollup/wasm-node"
//! }`, `npm:esbuild-wasm`) without the lockfile having to say so:
//!
//! | Native         | WebAssembly build   | Loaded by                                                            |
//! | -------------- | ------------------- | -------------------------------------------------------------------- |
//! | `rollup` 4     | `@rollup/wasm-node` | Vite 5 to 7 and Vitest on them, at import (`dist/native.js`)         |
//! | `esbuild`      | `esbuild-wasm`      | Vite 5 to 7 (config bundling, TypeScript transforms), tsx, and more  |
//! | `lightningcss` | `lightningcss-wasm` | Tailwind CSS 4 (`@tailwindcss/node`), Vite's CSS minifier            |
//!
//! Rollup's and esbuild's builds have the native package's files apart
//! from the loader.
//!
//! `esbuild-wasm`'s API starts `node bin/esbuild`, which runs esbuild's Go
//! build with Go's `wasm_exec.js`, as Wrangler's builtin does. esbuild's
//! `@esbuild/wasi-preview1` build is no help: the API can only start an
//! executable, and a `.wasm` file is not one in a job. Rollup 3 and older
//! are plain JavaScript and stay as they are.
//!
//! `lightningcss-wasm` has other files than `lightningcss`, but its
//! `package.json` sends Node's `require` and `import` (the `node` export
//! condition) to `wasm-node.cjs` and `wasm-node.mjs`, which load the module
//! synchronously as they are imported and export what `lightningcss`'s
//! `node/index.js` does (`transform`, `transformStyleAttribute`, `bundle`,
//! `bundleAsync`, `browserslistToTargets`, `composeVisitors`, `Features`).
//! Its one dependency, `napi-wasm`, is a bundled dependency inside its own
//! tarball, so nothing beyond the tarball is fetched.
//!
//! # Verification
//!
//! The lockfile pins the native package, not its WebAssembly build, so the
//! build is checked against the integrity its registry publishes for that
//! version: [`Substitution::fetch`] reads the version's manifest
//! (`<registry>/<name>/<version>`, over HTTPS) for `dist.integrity`, which
//! must be a SHA-512, and fetches the tarball through the same verifying
//! fetcher as everything else. That is the check a package manager makes
//! when it adds a package, and weaker than a lockfile's pin only in that it
//! trusts the registry's answer at install time. A version the registry
//! does not have leaves the native package in place, as before.

use std::sync::Arc;

use serde::Deserialize;

use crate::fetch::{FetchError, Fetcher, Integrity};

/// A native package and the WebAssembly build that replaces it in a job.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WasmBuild {
    /// The package a lockfile pins.
    pub native: &'static str,
    /// Its WebAssembly build, published at the same versions.
    pub wasm: &'static str,
    /// The first major version of `native` that loads a native binary.
    pub since_major: u64,
}

/// What the JavaScript installers replace when installing for a job (see
/// the module documentation).
pub const WASM_BUILDS: &[WasmBuild] = &[
    WasmBuild {
        native: "rollup",
        wasm: "@rollup/wasm-node",
        since_major: 4,
    },
    WasmBuild {
        native: "esbuild",
        wasm: "esbuild-wasm",
        since_major: 0,
    },
    WasmBuild {
        native: "lightningcss",
        wasm: "lightningcss-wasm",
        since_major: 0,
    },
];

/// Part of a task cache key: a job that installs npm packages runs again
/// when what they are replaced with changes.
pub fn key() -> String {
    format!("{WASM_BUILDS:?}")
}

/// `name@version` to be installed as its WebAssembly build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Substitution {
    pub build: &'static WasmBuild,
    pub version: String,
}

/// The substitution `table` makes for the registry package `name@version`,
/// if any. Installers call this only for packages the lockfile resolves
/// from a registry, and only when installing for a job.
pub fn substitution(
    table: &'static [WasmBuild],
    name: &str,
    version: &str,
) -> Option<Substitution> {
    let build = table.iter().find(|build| build.native == name)?;
    let parsed = semver::Version::parse(version).ok()?;
    (parsed.major >= build.since_major).then(|| Substitution {
        build,
        version: version.to_string(),
    })
}

/// The registry's manifest of one version, as far as it is read here.
#[derive(Deserialize)]
struct Manifest {
    name: String,
    version: String,
    dist: Dist,
}

#[derive(Deserialize)]
struct Dist {
    integrity: Option<String>,
}

impl Substitution {
    /// `name@version` of the build, for reports.
    pub fn describe(&self) -> String {
        format!(
            "{}@{v} as {}@{v}",
            self.build.native,
            self.build.wasm,
            v = self.version
        )
    }

    /// The build's tarball, from `registry` (the base URL the installer
    /// uses for the build's name, scope included), verified against the
    /// integrity the registry publishes for it. `None` when the registry
    /// has no such version, in which case the native package is installed.
    pub fn fetch(
        &self,
        fetcher: &dyn Fetcher,
        registry: &str,
    ) -> Result<Option<Arc<[u8]>>, FetchError> {
        let registry = registry.trim_end_matches('/');
        let name = self.build.wasm;
        let version = &self.version;
        // A scoped name's slash is escaped, as npm's own client asks.
        let url = format!("{registry}/{}/{version}", name.replace('/', "%2f"));
        let bytes = match fetcher.fetch(&url, &Integrity::Unpinned) {
            Ok(bytes) => bytes,
            Err(FetchError::NotFound { .. }) => return Ok(None),
            Err(error) => return Err(error),
        };
        let bad = |message: String| FetchError::Http {
            url: url.clone(),
            message,
        };
        let manifest: Manifest = serde_json::from_slice(&bytes)
            .map_err(|e| bad(format!("not a package version manifest: {e}")))?;
        if manifest.name != name || manifest.version != *version {
            return Err(bad(format!(
                "the registry answered with {}@{}",
                manifest.name, manifest.version
            )));
        }
        let integrity = manifest
            .dist
            .integrity
            .filter(|integrity| integrity.starts_with("sha512-"))
            .ok_or_else(|| bad("the registry publishes no SHA-512 integrity".to_string()))?;
        let basename = name.rsplit('/').next().unwrap_or(name);
        let tarball = format!("{registry}/{name}/-/{basename}-{version}.tgz");
        fetcher
            .fetch(&tarball, &Integrity::Sri(integrity))
            .map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fetch::MemoryFetcher;

    const REGISTRY: &str = "https://registry.npmjs.org/";

    fn manifest(name: &str, version: &str, integrity: &str) -> String {
        format!(
            r#"{{"name":"{name}","version":"{version}","dist":{{"integrity":"{integrity}","shasum":"x"}}}}"#
        )
    }

    #[test]
    fn only_versions_with_a_native_binary_are_replaced() {
        let rollup = substitution(WASM_BUILDS, "rollup", "4.52.0").unwrap();
        assert_eq!(rollup.build.wasm, "@rollup/wasm-node");
        assert_eq!(
            rollup.describe(),
            "rollup@4.52.0 as @rollup/wasm-node@4.52.0"
        );
        assert!(substitution(WASM_BUILDS, "rollup", "4.0.0-24").is_some());
        assert!(substitution(WASM_BUILDS, "rollup", "3.29.5").is_none());
        assert!(substitution(WASM_BUILDS, "esbuild", "0.25.12").is_some());
        assert!(substitution(WASM_BUILDS, "esbuild-wasm", "0.25.12").is_none());
        assert!(substitution(WASM_BUILDS, "@rollup/wasm-node", "4.52.0").is_none());
        assert!(substitution(&[], "rollup", "4.52.0").is_none());
        assert!(substitution(WASM_BUILDS, "rollup", "not-a-version").is_none());
    }

    #[test]
    fn the_build_is_checked_against_the_registrys_integrity() {
        let fetcher = MemoryFetcher::new();
        let tarball = b"the build".to_vec();
        let integrity = {
            use base64::Engine;
            use sha2::Digest;
            let digest = sha2::Sha512::digest(&tarball);
            format!(
                "sha512-{}",
                base64::engine::general_purpose::STANDARD.encode(digest)
            )
        };
        fetcher.insert(
            "https://registry.npmjs.org/@rollup%2fwasm-node/4.52.0",
            manifest("@rollup/wasm-node", "4.52.0", &integrity),
        );
        fetcher.insert(
            "https://registry.npmjs.org/@rollup/wasm-node/-/wasm-node-4.52.0.tgz",
            tarball.clone(),
        );
        let rollup = substitution(WASM_BUILDS, "rollup", "4.52.0").unwrap();
        let bytes = rollup.fetch(&fetcher, REGISTRY).unwrap().unwrap();
        assert_eq!(&*bytes, tarball.as_slice());

        // A tarball that is not what the registry says is refused.
        fetcher.insert(
            "https://registry.npmjs.org/@rollup/wasm-node/-/wasm-node-4.52.0.tgz",
            b"something else".to_vec(),
        );
        let error = rollup.fetch(&fetcher, REGISTRY).unwrap_err();
        assert!(
            matches!(error, FetchError::IntegrityMismatch { .. }),
            "{error}"
        );
    }

    #[test]
    fn a_version_the_registry_lacks_keeps_the_native_package() {
        let fetcher = MemoryFetcher::new();
        let esbuild = substitution(WASM_BUILDS, "esbuild", "0.0.1").unwrap();
        assert_eq!(esbuild.fetch(&fetcher, REGISTRY).unwrap(), None);
        assert_eq!(
            fetcher.requests(),
            ["https://registry.npmjs.org/esbuild-wasm/0.0.1"]
        );
    }

    #[test]
    fn a_manifest_that_does_not_answer_the_question_is_an_error() {
        let fetcher = MemoryFetcher::new();
        let url = "https://registry.npmjs.org/esbuild-wasm/0.25.12";
        let esbuild = substitution(WASM_BUILDS, "esbuild", "0.25.12").unwrap();
        for body in [
            manifest("esbuild-wasm", "0.25.11", "sha512-AA=="),
            manifest("esbuild", "0.25.12", "sha512-AA=="),
            manifest("esbuild-wasm", "0.25.12", "sha1-AA=="),
            r#"{"name":"esbuild-wasm","version":"0.25.12","dist":{}}"#.to_string(),
            "<html>".to_string(),
        ] {
            fetcher.insert(url, body.clone());
            assert!(
                matches!(
                    esbuild.fetch(&fetcher, REGISTRY),
                    Err(FetchError::Http { .. })
                ),
                "{body}"
            );
        }
    }
}
