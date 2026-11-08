//! The object store abstraction and its local and layered implementations.

use std::fs;
use std::io::{self, Write as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::error::StoreError;
use crate::keys::{blob_digest, sha256_hex, validate_key, validate_prefix};

/// Largest object any store reads or writes. Equal to the blob cap: nothing
/// legitimate in the bucket is bigger, and a cap at the transport stops a
/// hostile or broken server from making us buffer without bound.
pub const MAX_OBJECT_SIZE: u64 = crate::manifest::MAX_BLOB_SIZE;

/// What `head` reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectMeta {
    /// Length in bytes.
    pub size: u64,
}

/// One object of a detailed listing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectInfo {
    pub key: String,
    pub size: u64,
    /// Last modified, in seconds since the Unix epoch, when the store says.
    pub modified: Option<u64>,
}

/// A flat key-value store of immutable-ish objects, shaped like S3.
///
/// Every method validates its key with [`crate::keys::validate_key`] (or
/// `validate_prefix` for `list`) before touching anything, so an
/// implementation never sees a key that could escape its namespace.
pub trait ObjectStore: Send + Sync {
    /// The object's bytes, or `None` when there is no such key.
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, StoreError>;

    /// The object's metadata, or `None` when there is no such key.
    fn head(&self, key: &str) -> Result<Option<ObjectMeta>, StoreError>;

    /// Writes the object, replacing any existing one.
    fn put(&self, key: &str, bytes: &[u8], content_type: &str) -> Result<(), StoreError>;

    /// Writes the object only if the key is free. Returns `false`, writing
    /// nothing, when it already exists. This is what makes manifest versions
    /// immutable even when two publishers race.
    fn put_if_absent(
        &self,
        key: &str,
        bytes: &[u8],
        content_type: &str,
    ) -> Result<bool, StoreError>;

    /// Every key starting with `prefix`, sorted, following pagination to the
    /// end.
    fn list(&self, prefix: &str) -> Result<Vec<String>, StoreError>;

    /// Removes the object. A key that is already gone is not an error.
    /// Only mutable objects (job caches) are ever deleted: the immutable
    /// namespaces have no delete path anywhere in the runner.
    fn delete(&self, key: &str) -> Result<(), StoreError>;

    /// [`ObjectStore::list`] with each object's size and age, for quotas.
    /// The default asks `head` per key; stores that list sizes override it.
    fn list_detailed(&self, prefix: &str) -> Result<Vec<ObjectInfo>, StoreError> {
        let mut out = Vec::new();
        for key in self.list(prefix)? {
            if let Some(meta) = self.head(&key)? {
                out.push(ObjectInfo {
                    key,
                    size: meta.size,
                    modified: None,
                });
            }
        }
        Ok(out)
    }
}

impl<S: ObjectStore + ?Sized> ObjectStore for std::sync::Arc<S> {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, StoreError> {
        (**self).get(key)
    }
    fn head(&self, key: &str) -> Result<Option<ObjectMeta>, StoreError> {
        (**self).head(key)
    }
    fn put(&self, key: &str, bytes: &[u8], content_type: &str) -> Result<(), StoreError> {
        (**self).put(key, bytes, content_type)
    }
    fn put_if_absent(
        &self,
        key: &str,
        bytes: &[u8],
        content_type: &str,
    ) -> Result<bool, StoreError> {
        (**self).put_if_absent(key, bytes, content_type)
    }
    fn list(&self, prefix: &str) -> Result<Vec<String>, StoreError> {
        (**self).list(prefix)
    }
    fn delete(&self, key: &str) -> Result<(), StoreError> {
        (**self).delete(key)
    }
    fn list_detailed(&self, prefix: &str) -> Result<Vec<ObjectInfo>, StoreError> {
        (**self).list_detailed(prefix)
    }
}

pub(crate) fn check_size(key: &str, len: usize) -> Result<(), StoreError> {
    if len as u64 > MAX_OBJECT_SIZE {
        return Err(StoreError::TooLarge {
            key: key.to_owned(),
            limit: MAX_OBJECT_SIZE,
        });
    }
    Ok(())
}

/// Objects as files under a directory: key `a/b/c` is `<root>/a/b/c`.
///
/// Writes go to `<root>/.staging/` and are renamed into place, so a reader
/// never sees a half-written object and a crash leaves only staging debris.
/// The key grammar forbids a first segment starting with `.`, which keeps
/// `.staging` out of every key and every listing.
#[derive(Debug, Clone)]
pub struct LocalStore {
    root: PathBuf,
}

const STAGING: &str = ".staging";

fn io_err<'a>(op: &'static str, path: &'a Path) -> impl FnOnce(io::Error) -> StoreError + 'a {
    move |source| StoreError::Io {
        op,
        path: path.to_owned(),
        source,
    }
}

impl LocalStore {
    /// Opens (creating if needed) a store rooted at `root`.
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, StoreError> {
        let root = root.into();
        fs::create_dir_all(root.join(STAGING)).map_err(io_err("create", &root))?;
        Ok(Self { root })
    }

    /// The directory the store lives in.
    pub fn root(&self) -> &Path {
        &self.root
    }

    fn path(&self, key: &str) -> Result<PathBuf, StoreError> {
        validate_key(key)?;
        // Joining validated segments one at a time, never the raw string, so
        // the platform's separator rules cannot reinterpret anything.
        let mut path = self.root.clone();
        path.extend(key.split('/'));
        Ok(path)
    }

    /// Writes `bytes` to a fresh staging file and returns its path.
    fn stage(&self, bytes: &[u8]) -> Result<PathBuf, StoreError> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let name = format!(
            "{}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        );
        let tmp = self.root.join(STAGING).join(name);
        let write = || -> io::Result<()> {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&tmp)?;
            f.write_all(bytes)?;
            // Data reaches the disk before the rename publishes it, so a
            // power cut cannot leave a complete-looking empty file.
            f.sync_all()
        };
        if let Err(e) = write() {
            let _ = fs::remove_file(&tmp);
            return Err(io_err("write", &tmp)(e));
        }
        Ok(tmp)
    }

    fn prepare_parent(&self, path: &Path) -> Result<(), StoreError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(io_err("create", parent))?;
        }
        Ok(())
    }

    fn walk(dir: &Path, key_prefix: &str, out: &mut Vec<String>) -> Result<(), StoreError> {
        let entries = match fs::read_dir(dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(io_err("list", dir)(e)),
        };
        for entry in entries {
            let entry = entry.map_err(io_err("list", dir))?;
            // Anything that is not a valid key segment (stray editor files,
            // non-UTF-8 names) is not an object; skip it rather than fail.
            let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            let key = format!("{key_prefix}{name}");
            let file_type = entry.file_type().map_err(io_err("list", &entry.path()))?;
            if file_type.is_dir() {
                if validate_prefix(&format!("{key}/")).is_ok() {
                    Self::walk(&entry.path(), &format!("{key}/"), out)?;
                }
            } else if file_type.is_file() && validate_key(&key).is_ok() {
                out.push(key);
            }
        }
        Ok(())
    }
}

impl ObjectStore for LocalStore {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, StoreError> {
        let path = self.path(key)?;
        match fs::metadata(&path) {
            Ok(m) if m.is_file() => {
                if m.len() > MAX_OBJECT_SIZE {
                    return Err(StoreError::TooLarge {
                        key: key.to_owned(),
                        limit: MAX_OBJECT_SIZE,
                    });
                }
            }
            Ok(_) => return Ok(None),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(io_err("stat", &path)(e)),
        }
        match fs::read(&path) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(io_err("read", &path)(e)),
        }
    }

    fn head(&self, key: &str) -> Result<Option<ObjectMeta>, StoreError> {
        let path = self.path(key)?;
        match fs::metadata(&path) {
            Ok(m) if m.is_file() => Ok(Some(ObjectMeta { size: m.len() })),
            Ok(_) => Ok(None),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(io_err("stat", &path)(e)),
        }
    }

    fn put(&self, key: &str, bytes: &[u8], _content_type: &str) -> Result<(), StoreError> {
        let path = self.path(key)?;
        check_size(key, bytes.len())?;
        self.prepare_parent(&path)?;
        let tmp = self.stage(bytes)?;
        fs::rename(&tmp, &path).map_err(|e| {
            let _ = fs::remove_file(&tmp);
            io_err("rename", &path)(e)
        })
    }

    fn put_if_absent(
        &self,
        key: &str,
        bytes: &[u8],
        _content_type: &str,
    ) -> Result<bool, StoreError> {
        let path = self.path(key)?;
        check_size(key, bytes.len())?;
        self.prepare_parent(&path)?;
        let tmp = self.stage(bytes)?;
        // `rename` would clobber; a hard link fails with AlreadyExists
        // instead, which is an atomic create-if-absent of a complete file.
        let result = fs::hard_link(&tmp, &path);
        let _ = fs::remove_file(&tmp);
        match result {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(io_err("link", &path)(e)),
        }
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>, StoreError> {
        validate_prefix(prefix)?;
        // Walk the deepest directory the prefix fully names, then filter by
        // the partial last segment (if any).
        let dir_part = match prefix.rfind('/') {
            Some(i) => &prefix[..=i],
            None => "",
        };
        let mut dir = self.root.clone();
        dir.extend(dir_part.split('/').filter(|s| !s.is_empty()));
        let mut out = Vec::new();
        if dir_part.is_empty() {
            // The root holds `.staging`; walk only the valid top-level names.
            Self::walk(&dir, "", &mut out)?;
        } else {
            Self::walk(&dir, dir_part, &mut out)?;
        }
        out.retain(|k| k.starts_with(prefix));
        out.sort();
        Ok(out)
    }

    fn delete(&self, key: &str) -> Result<(), StoreError> {
        let path = self.path(key)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(source) => Err(StoreError::Io {
                op: "remove",
                path,
                source,
            }),
        }
    }

    fn list_detailed(&self, prefix: &str) -> Result<Vec<ObjectInfo>, StoreError> {
        let mut out = Vec::new();
        for key in self.list(prefix)? {
            let path = self.path(&key)?;
            let Ok(meta) = fs::metadata(&path) else {
                continue;
            };
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            out.push(ObjectInfo {
                key,
                size: meta.len(),
                modified,
            });
        }
        Ok(out)
    }
}

/// A local cache in front of a remote store, for blobs only.
///
/// Blobs are immutable by hash, so a cached `blobs/sha256/<hex>` can never be
/// stale. Everything else (manifests, listings) always goes to the remote: a
/// manifest is small, and a cached listing would hide newly published
/// versions. Bytes are verified against the key's digest before they enter
/// the cache and again when they leave it, so a torn or rotted cache file is
/// treated as a miss and replaced instead of failing every later run.
#[derive(Debug)]
pub struct LayeredStore<C, R> {
    cache: C,
    remote: R,
}

impl<C: ObjectStore, R: ObjectStore> LayeredStore<C, R> {
    /// A cache in front of a remote.
    pub fn new(cache: C, remote: R) -> Self {
        Self { cache, remote }
    }

    /// The cache.
    pub fn cache(&self) -> &C {
        &self.cache
    }

    /// The remote.
    pub fn remote(&self) -> &R {
        &self.remote
    }
}

impl<C: ObjectStore, R: ObjectStore> ObjectStore for LayeredStore<C, R> {
    fn get(&self, key: &str) -> Result<Option<Vec<u8>>, StoreError> {
        validate_key(key)?;
        let Some(digest) = blob_digest(key) else {
            return self.remote.get(key);
        };
        if let Some(bytes) = self.cache.get(key)?
            && sha256_hex(&bytes) == digest
        {
            return Ok(Some(bytes));
        }
        let Some(bytes) = self.remote.get(key)? else {
            return Ok(None);
        };
        if sha256_hex(&bytes) == digest {
            self.cache.put(key, &bytes, "application/octet-stream")?;
        }
        // A remote blob that fails its digest is returned uncached; the
        // catalog's own verification reports it with both hashes.
        Ok(Some(bytes))
    }

    fn head(&self, key: &str) -> Result<Option<ObjectMeta>, StoreError> {
        validate_key(key)?;
        if blob_digest(key).is_some()
            && let Some(meta) = self.cache.head(key)?
        {
            return Ok(Some(meta));
        }
        self.remote.head(key)
    }

    fn put(&self, key: &str, bytes: &[u8], content_type: &str) -> Result<(), StoreError> {
        self.remote.put(key, bytes, content_type)?;
        if blob_digest(key).is_some_and(|d| d == sha256_hex(bytes)) {
            self.cache.put(key, bytes, content_type)?;
        }
        Ok(())
    }

    fn put_if_absent(
        &self,
        key: &str,
        bytes: &[u8],
        content_type: &str,
    ) -> Result<bool, StoreError> {
        self.remote.put_if_absent(key, bytes, content_type)
    }

    fn list(&self, prefix: &str) -> Result<Vec<String>, StoreError> {
        self.remote.list(prefix)
    }

    fn delete(&self, key: &str) -> Result<(), StoreError> {
        self.remote.delete(key)?;
        self.cache.delete(key)
    }

    fn list_detailed(&self, prefix: &str) -> Result<Vec<ObjectInfo>, StoreError> {
        self.remote.list_detailed(prefix)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use super::*;
    use crate::keys::blob_key;

    fn store() -> (tempfile::TempDir, LocalStore) {
        let dir = tempfile::tempdir().unwrap();
        let s = LocalStore::new(dir.path()).unwrap();
        (dir, s)
    }

    #[test]
    fn local_round_trip_and_listing() {
        let (_d, s) = store();
        assert_eq!(s.get("builtins/tsc/7.1.3.json").unwrap(), None);
        s.put("builtins/tsc/7.1.3.json", b"a", "application/json")
            .unwrap();
        s.put("builtins/tsc/7.1.4.json", b"bb", "application/json")
            .unwrap();
        s.put("builtins/tscx/1.0.0.json", b"c", "application/json")
            .unwrap();
        s.put("environments/node/1.0.0.json", b"d", "application/json")
            .unwrap();
        assert_eq!(s.get("builtins/tsc/7.1.3.json").unwrap().unwrap(), b"a");
        assert_eq!(s.head("builtins/tsc/7.1.4.json").unwrap().unwrap().size, 2);
        // A directory is not an object.
        assert_eq!(s.get("builtins/tsc").unwrap(), None);
        assert_eq!(s.head("builtins").unwrap(), None);
        assert_eq!(
            s.list("builtins/tsc/").unwrap(),
            ["builtins/tsc/7.1.3.json", "builtins/tsc/7.1.4.json"]
        );
        assert_eq!(s.list("builtins/tsc").unwrap().len(), 3);
        assert_eq!(s.list("").unwrap().len(), 4);
        assert!(s.list("nothing/").unwrap().is_empty());
        // The staging directory never shows up.
        assert!(s.list("").unwrap().iter().all(|k| !k.starts_with('.')));
        // Overwrite replaces.
        s.put("builtins/tsc/7.1.3.json", b"z", "application/json")
            .unwrap();
        assert_eq!(s.get("builtins/tsc/7.1.3.json").unwrap().unwrap(), b"z");
        assert!(
            fs::read_dir(s.root().join(STAGING))
                .unwrap()
                .next()
                .is_none()
        );
    }

    #[test]
    fn local_rejects_escaping_keys() {
        let (dir, s) = store();
        let outside = dir.path().parent().unwrap().join("escaped");
        for key in [
            "../escaped",
            "a/../../escaped",
            "/etc/passwd",
            ".staging/x",
            "a\\..\\b",
        ] {
            assert!(
                matches!(s.put(key, b"x", ""), Err(StoreError::InvalidKey { .. })),
                "{key}"
            );
            assert!(s.get(key).is_err(), "{key}");
            assert!(s.head(key).is_err(), "{key}");
        }
        assert!(s.list("../").is_err());
        assert!(!outside.exists());
    }

    #[test]
    fn local_put_if_absent() {
        let (_d, s) = store();
        assert!(s.put_if_absent("a/b", b"1", "").unwrap());
        assert!(!s.put_if_absent("a/b", b"2", "").unwrap());
        assert_eq!(s.get("a/b").unwrap().unwrap(), b"1");
        assert!(
            fs::read_dir(s.root().join(STAGING))
                .unwrap()
                .next()
                .is_none()
        );
    }

    /// Records which keys were fetched, to tell a cache hit from a miss.
    struct Counting {
        inner: LocalStore,
        gets: Mutex<Vec<String>>,
    }

    impl ObjectStore for Counting {
        fn get(&self, key: &str) -> Result<Option<Vec<u8>>, StoreError> {
            self.gets.lock().unwrap().push(key.to_owned());
            self.inner.get(key)
        }
        fn head(&self, key: &str) -> Result<Option<ObjectMeta>, StoreError> {
            self.inner.head(key)
        }
        fn put(&self, key: &str, bytes: &[u8], ct: &str) -> Result<(), StoreError> {
            self.inner.put(key, bytes, ct)
        }
        fn put_if_absent(&self, key: &str, bytes: &[u8], ct: &str) -> Result<bool, StoreError> {
            self.inner.put_if_absent(key, bytes, ct)
        }
        fn list(&self, prefix: &str) -> Result<Vec<String>, StoreError> {
            self.inner.list(prefix)
        }
        fn delete(&self, key: &str) -> Result<(), StoreError> {
            self.inner.delete(key)
        }
    }

    #[test]
    fn local_delete_and_detailed_listing() {
        let (_dir, store) = store();
        store
            .put("caches/o/r/s/entries/a.zst", b"12345", "x")
            .unwrap();
        store.put("caches/o/r/s/entries/b.zst", b"1", "x").unwrap();
        let listed = store.list_detailed("caches/o/").unwrap();
        assert_eq!(
            listed.iter().map(|o| o.size).collect::<Vec<_>>(),
            vec![5, 1]
        );
        assert!(listed.iter().all(|o| o.modified.is_some()));
        store.delete("caches/o/r/s/entries/a.zst").unwrap();
        store.delete("caches/o/r/s/entries/a.zst").unwrap();
        assert_eq!(
            store.list("caches/o/").unwrap(),
            vec!["caches/o/r/s/entries/b.zst".to_string()]
        );
        assert!(store.delete("../x").is_err());
    }

    #[test]
    fn layered_caches_only_verified_blobs() {
        let (_d1, cache) = store();
        let (_d2, remote) = store();
        let remote = Counting {
            inner: remote,
            gets: Mutex::new(Vec::new()),
        };
        let blob = b"wasm bytes";
        let key = blob_key(&sha256_hex(blob)).unwrap();
        remote.put(&key, blob, "").unwrap();
        remote.put("builtins/t/1.0.0.json", b"{}", "").unwrap();
        let bad_key = blob_key(&sha256_hex(b"other")).unwrap();
        remote.put(&bad_key, b"not other", "").unwrap();
        let layered = LayeredStore::new(cache, remote);

        assert_eq!(layered.get(&key).unwrap().unwrap(), blob);
        assert_eq!(layered.get(&key).unwrap().unwrap(), blob);
        // Second read came from the cache.
        assert_eq!(layered.remote().gets.lock().unwrap().len(), 1);
        assert!(layered.cache().head(&key).unwrap().is_some());

        // Manifests are never cached.
        layered.get("builtins/t/1.0.0.json").unwrap();
        layered.get("builtins/t/1.0.0.json").unwrap();
        assert!(
            layered
                .cache()
                .head("builtins/t/1.0.0.json")
                .unwrap()
                .is_none()
        );

        // A remote blob that fails its digest is passed through, not cached.
        assert_eq!(layered.get(&bad_key).unwrap().unwrap(), b"not other");
        assert!(layered.cache().head(&bad_key).unwrap().is_none());

        // A corrupted cache entry is a miss and gets repaired.
        layered.cache().put(&key, b"rotted", "").unwrap();
        let before = layered.remote().gets.lock().unwrap().len();
        assert_eq!(layered.get(&key).unwrap().unwrap(), blob);
        assert_eq!(layered.remote().gets.lock().unwrap().len(), before + 1);
        assert_eq!(layered.cache().get(&key).unwrap().unwrap(), blob);
    }
}
