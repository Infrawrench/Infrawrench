use std::collections::HashMap;
use std::sync::Mutex;

use super::*;
use crate::machines::{MachineRun, ScriptOutcome};
use crate::schedule::{Execution, Restored};
use iwci_spec::VmOs;

/// Writes `/app/node_modules/a/built.txt` and deletes `/app/node_modules/a/stale`,
/// or fails, recording each script it was given.
#[derive(Default)]
struct FakeMachine {
    scripts: Mutex<Vec<String>>,
    fail: bool,
}

impl Machines for FakeMachine {
    fn platforms(&self) -> Vec<VmOs> {
        vec![VmOs::Linux]
    }
    fn overhead(&self, _os: VmOs) -> u64 {
        0
    }
    fn run(&self, _run: MachineRun<'_>) -> Result<Execution, String> {
        unreachable!("install scripts are not a job")
    }
    fn run_script(&self, run: ScriptRun<'_>) -> Result<ScriptOutcome, String> {
        self.scripts.lock().unwrap().push(run.script.to_string());
        // It starts from the workspace as installed.
        assert!(run.fs.read("/app/node_modules/a/package.json").is_ok());
        assert_eq!(run.collect, ["/app".to_string()]);
        if self.fail {
            return Ok(ScriptOutcome {
                exit_code: Some(1),
                stderr:
                    "> a@1.0.0 postinstall: node a.js\nboom\niwci: a@1.0.0 postinstall failed\n"
                        .into(),
                ..Default::default()
            });
        }
        Ok(ScriptOutcome {
            exit_code: Some(0),
            collected: Collected {
                deleted: vec!["/app/node_modules/a/stale".into()],
                entries: vec![(
                    Entry::File {
                        path: "/app/node_modules/a/built.txt".into(),
                        data: b"built".to_vec().into(),
                    },
                    Some(0o755),
                )],
            },
            ..Default::default()
        })
    }
}

/// A saved entry: its files and their modes.
type Saved = (Vec<Entry>, Vec<(PathBuf, u32)>);

#[derive(Default)]
struct MemoryCaches(Mutex<HashMap<String, Saved>>);

impl Caches for MemoryCaches {
    fn restore(&self, key: &str, _: &[String], _: u64) -> Result<Option<Restored>, String> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(key)
            .map(|(entries, modes)| Restored {
                key: key.into(),
                exact: true,
                entries: entries.clone(),
                modes: modes.clone(),
            }))
    }
    fn save_with_modes(
        &self,
        key: &str,
        _: &[String],
        entries: &[Entry],
        modes: &[(PathBuf, u32)],
    ) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .insert(key.into(), (entries.to_vec(), modes.to_vec()));
        Ok(())
    }
}

fn spec() -> WorkspaceSpec {
    let plan = iwci_spec::parse(
        "name: x\ninstall-scripts: true\nworkspace:\n  deps: [npm]\njobs:\n  t:\n    using: builtin:t@1\n",
        &iwci_spec::Context::default(),
    )
    .unwrap();
    let spec = plan.workspaces[0].clone();
    assert!(spec.install_scripts);
    assert_eq!(spec.deps[0].dir, "/app");
    spec
}

fn installed(scripts: bool) -> SnapshotBuilder {
    let b = SnapshotBuilder::new();
    b.write("/app/package.json", br#"{"name":"app","version":"1.0.0"}"#)
        .unwrap();
    let a = if scripts {
        r#"{"name":"a","version":"1.0.0","scripts":{"postinstall":"node a.js"}}"#
    } else {
        r#"{"name":"a","version":"1.0.0"}"#
    };
    b.write("/app/node_modules/a/package.json", a.as_bytes())
        .unwrap();
    b.write("/app/node_modules/a/stale", b"old").unwrap();
    b
}

fn host(machine: &Arc<FakeMachine>, caches: &Arc<MemoryCaches>) -> ScriptHost {
    let machines: Arc<dyn Machines> = machine.clone();
    let caches: Arc<dyn Caches> = caches.clone();
    ScriptHost {
        machines: Some(machines),
        caches: Some(caches),
        commit: "c0ffee".into(),
    }
}

#[test]
fn nothing_to_run_starts_no_machine() {
    let machine = Arc::new(FakeMachine::default());
    let caches = Arc::new(MemoryCaches::default());
    let b = installed(false);
    let mut lines = Vec::new();
    run(Some(&host(&machine, &caches)), &b, &spec(), &mut lines).unwrap();
    assert!(machine.scripts.lock().unwrap().is_empty());
    assert_eq!(lines, vec!["install scripts: none to run"]);
    // Nor does a runner without machines mind.
    run(None, &installed(false), &spec(), &mut Vec::new()).unwrap();
}

#[test]
fn scripts_without_machines_are_an_error_naming_them() {
    let e = run(None, &installed(true), &spec(), &mut Vec::new()).unwrap_err();
    assert!(
        e.contains("a@1.0.0") && e.contains("no Linux virtual machines"),
        "{e}"
    );
}

#[test]
fn what_the_scripts_changed_is_kept_and_cached() {
    let machine = Arc::new(FakeMachine::default());
    let caches = Arc::new(MemoryCaches::default());
    let b = installed(true);
    let mut lines = Vec::new();
    run(Some(&host(&machine, &caches)), &b, &spec(), &mut lines).unwrap();
    let scripts = machine.scripts.lock().unwrap().clone();
    assert_eq!(scripts.len(), 1);
    assert!(
        scripts[0].contains("iwci_step '/app' 'npm/iwci node linux' '/app/node_modules/a' 'a' '1.0.0' 'postinstall' 'node a.js'"),
        "{}",
        scripts[0]
    );
    let snap = b.freeze();
    assert_eq!(
        snap.read("/app/node_modules/a/built.txt").unwrap(),
        b"built"
    );
    assert_eq!(snap.mode("/app/node_modules/a/built.txt"), Some(0o755));
    assert!(snap.read("/app/node_modules/a/stale").is_err());
    assert!(
        lines[0].starts_with("install scripts: ran 1 package's in a virtual machine"),
        "{lines:?}"
    );

    // The same commit again: from the cache, with no machine.
    let again = installed(true);
    let mut lines = Vec::new();
    run(Some(&host(&machine, &caches)), &again, &spec(), &mut lines).unwrap();
    assert_eq!(machine.scripts.lock().unwrap().len(), 1);
    assert_eq!(
        lines,
        vec!["install scripts: 1 package's from the cache (a@1.0.0)"]
    );
    let snap = again.freeze();
    assert_eq!(
        snap.read("/app/node_modules/a/built.txt").unwrap(),
        b"built"
    );
    assert_eq!(snap.mode("/app/node_modules/a/built.txt"), Some(0o755));
    assert!(snap.read("/app/node_modules/a/stale").is_err());
    assert!(snap.read(DELETED).is_err());

    // Another commit misses.
    let mut other = host(&machine, &caches);
    other.commit = "beef".into();
    run(Some(&other), &installed(true), &spec(), &mut Vec::new()).unwrap();
    assert_eq!(machine.scripts.lock().unwrap().len(), 2);
}

#[test]
fn a_failing_script_fails_the_workspace_with_its_output() {
    let machine = Arc::new(FakeMachine {
        fail: true,
        ..Default::default()
    });
    let caches = Arc::new(MemoryCaches::default());
    let e = run(
        Some(&host(&machine, &caches)),
        &installed(true),
        &spec(),
        &mut Vec::new(),
    )
    .unwrap_err();
    assert!(e.starts_with("install scripts exited with 1:"), "{e}");
    assert!(e.contains("a@1.0.0 postinstall failed"), "{e}");
    assert!(caches.0.lock().unwrap().is_empty());
}

#[test]
fn the_script_quotes_every_word() {
    let plan = Plan {
        steps: vec![iwci_deps::scripts::Step {
            dir: "/app/node_modules/o'k".into(),
            name: "o'k".into(),
            version: "1.0.0".into(),
            project: false,
            events: vec![iwci_deps::scripts::Event {
                name: "install".into(),
                command: "echo '$HOME' && node-gyp rebuild".into(),
            }],
        }],
        ..Default::default()
    };
    let s = script(&[("/app".into(), Manager::Pnpm, plan)]);
    assert!(s.starts_with("set -euo pipefail\n"));
    assert!(s.contains(
        r#"iwci_step '/app' 'pnpm/iwci node linux' '/app/node_modules/o'\''k' 'o'\''k' '1.0.0' 'install' 'echo '\''$HOME'\'' && node-gyp rebuild'"#
    ), "{s}");
    assert!(s.contains("npm_config_node_gyp='/usr/local/lib/node_modules/npm/node_modules/node-gyp/bin/node-gyp.js'"));
}
