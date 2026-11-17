//! The native extensions of gems, built for `env:ruby` ahead of time by
//! `builtins/environments/ruby/gems/build.sh` (one archive per Ruby, the gems
//! `gems.txt` pins), which `deps: [bundler]` places where RubyGems looks
//! for a gem's compiled part. Each archive is published to the store as a
//! blob (`builtins/publish.sh`) and read from there by its digest.

use std::sync::Arc;

use iwci_deps::bundler::{ArchivedBuilds, BuildPin};
use iwci_store::{Catalog, ObjectStore};

/// What gems/build.sh printed for each Ruby (`archive <sha256> (<size> bytes)`).
/// A new build of the same gems is reproducible and keeps these; a changed
/// gems.txt or a changed build changes them.
pub const GEM_BUILDS: &[BuildPin] = &[
    BuildPin {
        ruby: "3.4",
        sha256: "d9e7331bbc68489c84f83b72a5e3860af2f0549c569ba4c299556bcf1c230eb5",
        size: 2141105,
    },
    BuildPin {
        ruby: "4.0",
        sha256: "54c1bb3a4c2b3b557a2db4422a37f74b96a12cdc0e6abe969b716f430fb32efb",
        size: 2151647,
    },
];

/// Part of a task cache key: a job that installs gems runs again when the
/// builds it could have been given change.
pub fn key() -> String {
    GEM_BUILDS
        .iter()
        .map(|p| format!("{}:{}", p.ruby, p.sha256))
        .collect::<Vec<_>>()
        .join(",")
}

/// [`GEM_BUILDS`], read from `store` the first time an install asks.
pub fn from_store(store: Arc<dyn ObjectStore>) -> ArchivedBuilds {
    pinned_in(store, GEM_BUILDS)
}

fn pinned_in(store: Arc<dyn ObjectStore>, pins: &[BuildPin]) -> ArchivedBuilds {
    let catalog = Catalog::new(store);
    ArchivedBuilds::new(pins, move |pin| {
        catalog
            .blob(pin.sha256, pin.size)
            .map(|blob| blob.bytes.to_vec())
            .map_err(|e| {
                format!(
                    "{e}: builtins/environments/ruby/gems/build.sh {} builds it, and \
                     builtins/publish.sh puts it in the store",
                    pin.ruby
                )
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use iwci_deps::bundler::{ExtensionRequest, PrebuiltExtensions, ruby_abi};
    use iwci_store::{LocalStore, keys};

    #[test]
    fn every_pin_is_a_ruby_the_installer_knows_once() {
        for (i, pin) in GEM_BUILDS.iter().enumerate() {
            assert!(ruby_abi(pin.ruby).is_some(), "{}", pin.ruby);
            assert!(keys::is_valid_sha256(pin.sha256), "{}", pin.sha256);
            assert!(pin.size > 0);
            assert!(
                GEM_BUILDS[..i].iter().all(|p| p.ruby != pin.ruby),
                "{}",
                pin.ruby
            );
        }
        assert_eq!(
            key().split(',').filter(|k| !k.is_empty()).count(),
            GEM_BUILDS.len()
        );
    }

    fn archive() -> Vec<u8> {
        let mut tar = tar::Builder::new(Vec::new());
        for (path, data) in [
            ("ABI", &b"4.0.0-static\n"[..]),
            ("msgpack/1.8.7/msgpack/msgpack.so", b"\0asm"),
        ] {
            let mut header = tar::Header::new_gnu();
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(&mut header, path, data).unwrap();
        }
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        std::io::Write::write_all(&mut gz, &tar.into_inner().unwrap()).unwrap();
        gz.finish().unwrap()
    }

    #[test]
    fn reads_the_pinned_archive_from_the_store() {
        let dir = std::env::temp_dir().join(format!("iwci-gem-builds-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store: Arc<dyn ObjectStore> = Arc::new(LocalStore::new(&dir).unwrap());
        let bytes = archive();
        let sha256: &'static str = Box::leak(keys::sha256_hex(&bytes).into_boxed_str());
        let pin = BuildPin {
            ruby: "4.0",
            sha256,
            size: bytes.len() as u64,
        };
        let abi = ruby_abi("4.0").unwrap();
        let request = ExtensionRequest {
            name: "msgpack",
            version: "1.8.7",
            platform: "ruby",
            abi,
            extensions: &[],
        };

        // Not published yet: the error says what builds it.
        let err = pinned_in(store.clone(), &[pin])
            .files(&request)
            .unwrap_err();
        assert!(err.contains("gems/build.sh 4.0 builds it"), "{err}");

        store
            .put(
                &keys::blob_key(sha256).unwrap(),
                &bytes,
                "application/octet-stream",
            )
            .unwrap();
        let files = pinned_in(store, &[pin]).files(&request).unwrap().unwrap();
        assert_eq!(files[0].path, "msgpack/msgpack.so");
        assert_eq!(files[0].data, b"\0asm");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
