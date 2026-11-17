//! Gems' native extensions built ahead of time, one archive per Ruby, as
//! `builtins/environments/ruby/gems/build.sh` writes them (a gzipped tar):
//!
//! ```text
//! ABI                          Gem.extension_api_version, one line
//! <name>/<version>/<files>     what goes in that gem's extension directory
//! ```
//!
//! An archive is pinned by its SHA-256 and size ([`BuildPin`]) and fetched
//! the first time a gem of its Ruby asks, through whatever the caller
//! passes (the runner reads its store).

use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::sync::{Arc, Mutex};

use flate2::read::GzDecoder;

use super::{ExtensionRequest, PrebuiltExtensions, RubyAbi};
use crate::archive::{TarItem, read_tar};
use crate::git::TreeFile;

/// One Ruby's archive.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BuildPin {
    /// `major.minor`, as [`RubyAbi::version`].
    pub ruby: &'static str,
    /// Of the gzipped archive.
    pub sha256: &'static str,
    pub size: u64,
}

/// The largest archive, unpacked: every extension of a Rails lock is a
/// few tens of megabytes.
const MAX_UNPACKED: u64 = 1 << 30;
const MAX_FILES: usize = 100_000;

/// One archive, read.
#[derive(Debug)]
pub struct BuildArchive {
    /// `Gem.extension_api_version` it was built for.
    pub api: String,
    /// Each gem's files, by name and then version.
    pub gems: BTreeMap<String, BTreeMap<String, Vec<TreeFile>>>,
}

impl BuildArchive {
    /// Reads a gzipped archive. Symbolic links, and anything outside a
    /// `<name>/<version>/` directory but `ABI`, refuse it.
    pub fn parse(bytes: &[u8]) -> Result<Self, String> {
        let mut tar = Vec::new();
        GzDecoder::new(bytes)
            .take(MAX_UNPACKED + 1)
            .read_to_end(&mut tar)
            .map_err(|e| format!("not a gzip stream: {e}"))?;
        let mut api = None;
        let mut gems: BTreeMap<String, BTreeMap<String, Vec<TreeFile>>> = BTreeMap::new();
        for item in read_tar(tar.as_slice(), MAX_FILES, MAX_UNPACKED)? {
            let TarItem::File(file) = item else {
                return Err("a symbolic link".to_string());
            };
            if file.path == "ABI" {
                let text = String::from_utf8(file.data).map_err(|_| "ABI is not UTF-8")?;
                api = Some(text.trim().to_string());
                continue;
            }
            let mut parts = file.path.splitn(3, '/');
            let (Some(name), Some(version), Some(path)) =
                (parts.next(), parts.next(), parts.next())
            else {
                return Err(format!("{}: not under <name>/<version>/", file.path));
            };
            gems.entry(name.to_string())
                .or_default()
                .entry(version.to_string())
                .or_default()
                .push(TreeFile {
                    path: path.to_string(),
                    data: file.data,
                    executable: file.executable,
                });
        }
        Ok(Self {
            api: api.ok_or("no ABI file")?,
            gems,
        })
    }
}

type Fetch = dyn Fn(&BuildPin) -> Result<Vec<u8>, String> + Send + Sync;

/// [`PrebuiltExtensions`] from one archive per Ruby. A Ruby without a pin
/// has no builds.
pub struct ArchivedBuilds {
    pins: Vec<BuildPin>,
    fetch: Box<Fetch>,
    /// Archives read, by Ruby; a failure is not remembered.
    loaded: Mutex<HashMap<&'static str, Arc<BuildArchive>>>,
}

impl ArchivedBuilds {
    /// `fetch` returns an archive's bytes; they are checked against the pin
    /// here, whatever it checked itself.
    pub fn new(
        pins: &[BuildPin],
        fetch: impl Fn(&BuildPin) -> Result<Vec<u8>, String> + Send + Sync + 'static,
    ) -> Self {
        Self {
            pins: pins.to_vec(),
            fetch: Box::new(fetch),
            loaded: Mutex::new(HashMap::new()),
        }
    }

    fn archive(&self, abi: &RubyAbi) -> Result<Option<Arc<BuildArchive>>, String> {
        let Some(pin) = self.pins.iter().find(|p| p.ruby == abi.version) else {
            return Ok(None);
        };
        // Held while fetching: the gems of an install ask at once, and the
        // first one reads the archive for all of them.
        let mut loaded = self.loaded.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(archive) = loaded.get(pin.ruby) {
            return Ok(Some(archive.clone()));
        }
        let what = format!(
            "the gem builds for Ruby {} (sha256:{})",
            pin.ruby, pin.sha256
        );
        let bytes = (self.fetch)(pin).map_err(|e| format!("{what}: {e}"))?;
        let actual = {
            use sha2::Digest;
            hex::encode(sha2::Sha256::digest(&bytes))
        };
        if actual != pin.sha256 || bytes.len() as u64 != pin.size {
            return Err(format!(
                "{what}: got {} bytes hashing to {actual}, expected {}",
                bytes.len(),
                pin.size
            ));
        }
        let archive = BuildArchive::parse(&bytes).map_err(|e| format!("{what}: {e}"))?;
        if archive.api != abi.extension_api_version {
            return Err(format!(
                "{what}: built for {}, not {}",
                archive.api, abi.extension_api_version
            ));
        }
        let archive = Arc::new(archive);
        loaded.insert(pin.ruby, archive.clone());
        Ok(Some(archive))
    }
}

impl PrebuiltExtensions for ArchivedBuilds {
    fn key(&self) -> String {
        self.pins
            .iter()
            .map(|p| format!("{}:{}", p.ruby, p.sha256))
            .collect::<Vec<_>>()
            .join(",")
    }

    fn files(&self, gem: &ExtensionRequest<'_>) -> Result<Option<Vec<TreeFile>>, String> {
        if gem.platform != "ruby" {
            return Ok(None);
        }
        Ok(self.archive(gem.abi)?.and_then(|archive| {
            archive
                .gems
                .get(gem.name)
                .and_then(|versions| versions.get(gem.version))
                .cloned()
        }))
    }

    fn versions(&self, name: &str, abi: &RubyAbi) -> Result<Vec<String>, String> {
        let Some(archive) = self.archive(abi)? else {
            return Ok(Vec::new());
        };
        let mut versions: Vec<String> = archive
            .gems
            .get(name)
            .map(|v| v.keys().cloned().collect())
            .unwrap_or_default();
        versions.sort_by(|a, b| compare_versions(a, b));
        Ok(versions)
    }
}

/// Gem versions compared as RubyGems would for plain releases: each
/// dot-separated part as a number when both are numbers.
fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
    let mut a = a.split('.');
    let mut b = b.split('.');
    loop {
        match (a.next(), b.next()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, Some(_)) => return std::cmp::Ordering::Less,
            (Some(_), None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) => {
                let order = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(x), Ok(y)) => x.cmp(&y),
                    _ => x.cmp(y),
                };
                if order.is_ne() {
                    return order;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bundler::ruby_abi;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn archive(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut tar = tar::Builder::new(Vec::new());
        for (path, data) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, path, *data).unwrap();
        }
        let tar = tar.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut gz, &tar).unwrap();
        gz.finish().unwrap()
    }

    fn pin_of(ruby: &'static str, bytes: &[u8]) -> BuildPin {
        use sha2::Digest;
        BuildPin {
            ruby,
            sha256: Box::leak(hex::encode(sha2::Sha256::digest(bytes)).into_boxed_str()),
            size: bytes.len() as u64,
        }
    }

    fn request<'a>(name: &'a str, version: &'a str, abi: &'a RubyAbi) -> ExtensionRequest<'a> {
        ExtensionRequest {
            name,
            version,
            platform: "ruby",
            abi,
            extensions: &[],
        }
    }

    #[test]
    fn finds_a_gems_build_and_lists_the_versions_there_are() {
        let bytes = archive(&[
            ("ABI", b"4.0.0-static\n"),
            ("nokogiri/1.19.7/nokogiri/nokogiri.so", b"\0asm 1"),
            ("nokogiri/1.10.0/nokogiri/nokogiri.so", b"\0asm 2"),
            ("nokogiri/1.9.2/nokogiri/nokogiri.so", b"\0asm 3"),
            ("websocket-driver/0.9.0/websocket_mask.so", b"\0asm 4"),
        ]);
        let pin = pin_of("4.0", &bytes);
        let fetches = Arc::new(AtomicUsize::new(0));
        let counted = fetches.clone();
        let builds = ArchivedBuilds::new(&[pin], move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
            Ok(bytes.clone())
        });
        let abi = ruby_abi("4.0").unwrap();
        let files = builds
            .files(&request("nokogiri", "1.19.7", abi))
            .unwrap()
            .unwrap();
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "nokogiri/nokogiri.so");
        assert_eq!(files[0].data, b"\0asm 1");
        let driver = builds
            .files(&request("websocket-driver", "0.9.0", abi))
            .unwrap()
            .unwrap();
        assert_eq!(driver[0].path, "websocket_mask.so");
        assert!(
            builds
                .files(&request("nokogiri", "1.19.6", abi))
                .unwrap()
                .is_none()
        );
        assert!(
            builds
                .files(&request("ffi", "1.17.4", abi))
                .unwrap()
                .is_none()
        );
        assert_eq!(
            builds.versions("nokogiri", abi).unwrap(),
            ["1.9.2", "1.10.0", "1.19.7"]
        );
        assert!(builds.versions("ffi", abi).unwrap().is_empty());
        // Read once for every question.
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
        // No pin for 3.4: no builds, and nothing fetched.
        let old = ruby_abi("3.4").unwrap();
        assert!(
            builds
                .files(&request("nokogiri", "1.19.7", old))
                .unwrap()
                .is_none()
        );
        assert_eq!(fetches.load(Ordering::SeqCst), 1);
        assert!(builds.key().starts_with("4.0:"));
    }

    #[test]
    fn an_archive_that_is_not_the_pinned_one_is_refused() {
        let bytes = archive(&[("ABI", b"4.0.0-static\n")]);
        let mut pin = pin_of("4.0", &bytes);
        pin.size += 1;
        let builds = ArchivedBuilds::new(&[pin], move |_| Ok(bytes.clone()));
        let abi = ruby_abi("4.0").unwrap();
        let err = builds.files(&request("x", "1", abi)).unwrap_err();
        assert!(err.contains("expected"), "{err}");

        // Built for another Ruby.
        let bytes = archive(&[("ABI", b"3.4.0-static\n")]);
        let pin = pin_of("4.0", &bytes);
        let builds = ArchivedBuilds::new(&[pin], move |_| Ok(bytes.clone()));
        let err = builds.files(&request("x", "1", abi)).unwrap_err();
        assert!(
            err.contains("built for 3.4.0-static, not 4.0.0-static"),
            "{err}"
        );

        // Missing from the store: said, and tried again next time.
        let tries = Arc::new(AtomicUsize::new(0));
        let counted = tries.clone();
        let builds = ArchivedBuilds::new(&[pin_of("4.0", b"x")], move |_| {
            counted.fetch_add(1, Ordering::SeqCst);
            Err("not in the store".to_string())
        });
        let err = builds.versions("x", abi).unwrap_err();
        assert!(
            err.starts_with("the gem builds for Ruby 4.0 (sha256:"),
            "{err}"
        );
        assert!(err.ends_with("not in the store"), "{err}");
        let _ = builds.versions("x", abi);
        assert_eq!(tries.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn files_outside_a_gem_directory_are_refused() {
        for files in [
            &[("ABI", &b"4.0.0-static"[..]), ("stray.so", b"x")][..],
            &[("ABI", b"4.0.0-static"), ("nokogiri/1.0", b"x")],
            &[("nokogiri/1.0/x.so", b"x")],
        ] {
            assert!(BuildArchive::parse(&archive(files)).is_err());
        }
        assert!(BuildArchive::parse(b"not gzip").is_err());
    }
}
