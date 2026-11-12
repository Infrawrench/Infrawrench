//! Edge.js's code cache for its built-in modules (#996).
//!
//! A `node` spent most of its start compiling the built-in modules it loads
//! from source: about 40 ms of the 55 ms a `node -e 0` took in a job.
//! Edge.js can read V8's code cache for them from one file, which
//! `env:bash-node`'s build turns on (`edgejs-builtins-cache.patch`): it
//! reads `edge.builtins` in [`crate::wasix::NODE_SUPPORT_DIR`] when the file
//! is there. V8 takes only a cache its own build wrote with the same flags
//! and the same read-only snapshot, and that is this process's V8, so the
//! runner makes the file itself: before the first job of an environment
//! with `node` (any that start meanwhile wait for it), a job of the
//! runner's own runs that environment's Edge.js over its built-ins with
//! `EDGE_BUILTINS_CACHE_RECORD` set, and keeps what it writes, for as long
//! as the process lives (4.3 MB for `env:bash-node` 24.0.8). Not when the
//! environment is warmed: warming only compiles to disk (#1035), and this
//! loads and runs Edge.js.
//!
//! Every job of that environment then gets the file read-only, shared
//! rather than copied. Nothing a job does reaches it: it is made from the
//! environment's pinned Edge.js running [`SCRIPT`], with no input from any
//! job, and a job that records a cache of its own (`EDGE_BUILTINS_CACHE`)
//! writes into its own file system, which no other job sees. A cache any
//! job could write would be code every later job ran.
//!
//! An environment without `node`, or an Edge.js without the patch (which
//! writes nothing), is remembered as having no cache, and its jobs run as
//! before.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use bytes::Bytes;
use wasmer_wasix::runtime::resolver::WebcHash;

/// The file in [`crate::wasix::NODE_SUPPORT_DIR`] that Edge.js reads.
pub(crate) const FILE: &str = "edge.builtins";

/// What the runner's job runs, in the environment's bash with Edge.js's
/// recording on: one `node` that loads every public built-in, every global
/// (which loads the lazy ones, such as `fetch`), a `vm` context and a
/// worker thread, then an ES module and `-e` and `-p`, which each load
/// built-ins of their own. Each `node` adds what it compiled to the file as
/// it exits. A built-in no job here loads is compiled as before.
#[cfg_attr(not(feature = "node"), allow(dead_code))]
const SCRIPT: &str = r#"cd /tmp
cat > all.js <<'JS'
const { builtinModules } = require("node:module");
for (const id of [...builtinModules, "node:sea", "node:sqlite", "node:test", "node:test/reporters"]) {
  try { require(id); } catch {}
}
for (const name of Object.getOwnPropertyNames(globalThis)) {
  try { void globalThis[name]; } catch {}
}
for (const name of ["stdout", "stderr"]) {
  try { void process[name]; } catch {}
}
require("node:vm").createContext({});
const { Worker } = require("node:worker_threads");
new Worker('require("node:fs"); require("node:path"); require("node:util")', { eval: true });
JS
node all.js
printf 'import "node:fs";\nawait import("node:path");\n' > esm.mjs
node esm.mjs
node -e 0
node -p 1 >/dev/null
test -s "$EDGE_BUILTINS_CACHE"
"#;

/// Where the runner's job has Edge.js write the file, in its own file
/// system.
#[cfg_attr(not(feature = "node"), allow(dead_code))]
const RECORD_TO: &str = "/edge.builtins";

/// What Edge.js's file starts with (`edge_builtin_bytecode.cc`).
#[cfg_attr(not(feature = "node"), allow(dead_code))]
const MAGIC: &[u8] = b"EDGEJSBB";

/// One environment's cache: made once, `None` when it has none.
type Made = Arc<OnceLock<Option<Bytes>>>;

/// The caches made in this process, by the digests of an environment's
/// packages.
#[derive(Default)]
pub(crate) struct Builtins {
    made: Mutex<HashMap<Vec<WebcHash>, Made>>,
}

#[cfg_attr(not(feature = "node"), allow(dead_code))]
impl Builtins {
    /// The cache for the environment `digests` names, made by `make` the
    /// first time it is asked for. A caller asking while another makes it
    /// waits for that one.
    pub(crate) fn get_or_make(
        &self,
        digests: Vec<WebcHash>,
        make: impl FnOnce() -> Option<Bytes>,
    ) -> Option<Bytes> {
        let cell = self
            .made
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(digests)
            .or_default()
            .clone();
        cell.get_or_init(make).clone()
    }
}

/// Makes the cache for an environment whose packages provide `node`, by
/// running [`SCRIPT`] with `run` (which runs a script job in the
/// environment over the file system it is given, with Node hooks of its
/// own). `None`, with the reason on the runner's stderr, when it could not.
#[cfg(feature = "node")]
pub(crate) fn make(
    run: impl FnOnce(&str, crate::Invocation) -> crate::Result<crate::Outcome>,
) -> Option<Bytes> {
    use std::time::Duration;

    let fs = iwci_vfs::SnapshotBuilder::new().freeze().fork();
    let inv = crate::Invocation {
        args: Vec::new(),
        env: vec![
            ("EDGE_BUILTINS_CACHE".into(), RECORD_TO.into()),
            ("EDGE_BUILTINS_CACHE_RECORD".into(), "1".into()),
            ("HOME".into(), "/tmp".into()),
        ],
        cwd: "/".into(),
        fs: fs.as_dyn(),
        limits: crate::Limits {
            timeout: Duration::from_secs(120),
            memory_bytes: 2 << 30,
        },
        log: None,
        scratch: None,
        commands: Vec::new(),
        internet: false,
        modes: fs.modes(),
        services: Vec::new(),
    };
    let started = std::time::Instant::now();
    let why = match run(SCRIPT, inv) {
        Err(e) => e.to_string(),
        Ok(outcome) if !outcome.success() => {
            let stderr = String::from_utf8_lossy(&outcome.stderr);
            let tail: Vec<&str> = stderr.lines().rev().take(5).collect();
            format!(
                "it exited with {}: {}",
                outcome.exit_code,
                tail.into_iter().rev().collect::<Vec<_>>().join(" | ")
            )
        }
        Ok(_) => match fs.read(RECORD_TO) {
            Ok(bytes) if bytes.starts_with(MAGIC) => {
                eprintln!(
                    "iwci: made Edge.js's built-ins cache ({} KiB) in {:.1} s",
                    bytes.len() >> 10,
                    started.elapsed().as_secs_f64()
                );
                return Some(Bytes::from(bytes));
            }
            Ok(_) => "the file it wrote is not one".into(),
            Err(e) => format!("it wrote no file ({e})"),
        },
    };
    eprintln!("iwci: no built-ins cache for Edge.js, so its `node`s compile them: {why}");
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cache_is_made_once_per_environment() {
        let builtins = Builtins::default();
        let a = vec![WebcHash::from_bytes([1; 32])];
        let b = vec![WebcHash::from_bytes([2; 32])];
        let mut made = 0;
        let mut make = |bytes: &'static [u8]| {
            made += 1;
            Some(Bytes::from_static(bytes))
        };
        assert_eq!(
            builtins.get_or_make(a.clone(), || make(b"a")).as_deref(),
            Some(&b"a"[..])
        );
        assert_eq!(
            builtins
                .get_or_make(a.clone(), || make(b"again"))
                .as_deref(),
            Some(&b"a"[..])
        );
        assert_eq!(builtins.get_or_make(b.clone(), || None), None);
        assert_eq!(builtins.get_or_make(b, || make(b"b")), None);
        assert_eq!(made, 1);
    }
}
