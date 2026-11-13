//! What the app lends a run's jobs (`RunRequest::lent`): the credentials
//! of Infrawrench connections (a kubeconfig, an SSH host entry), SSH keys,
//! and infrastructure resources' outputs.
//!
//! The runner holds no stored credential of its own. Before a run the app
//! asks which names its jobs use (`POST /v1/concurrency`, each job's
//! `access`), checks who allowed what for this repository and branch,
//! mints or decrypts the material, and sends it here by name, or says per
//! name why not (`refused`). A job gets only what it names, when it
//! starts: files written into its own file system and variables in its
//! environment. Every secret value is masked wherever a job's text goes.
//! A name the request did not supply, or one it refused, fails the job at
//! start with the reason; it never runs with an empty value.

use std::collections::BTreeMap;
use std::path::PathBuf;

use iwci_spec::JobAccess;
use serde::Deserialize;

/// The most entries each of a request's `connections`, `ssh-keys` and
/// `resources` may have.
pub const MAX_ENTRIES: usize = 64;
/// The most files one connection or key may write.
pub const MAX_FILES: usize = 16;
/// The largest one value (a file's content, a variable, an output) may be.
pub const MAX_VALUE_BYTES: usize = 64 << 10;
/// The longest reason a refusal may give.
pub const MAX_REASON: usize = 1024;
/// A file's mode unless the request says.
pub const DEFAULT_MODE: u32 = 0o600;

/// Why a job of an untrusted run that names anything lent fails.
pub const UNTRUSTED: &str = "connections, SSH keys and resources are never lent to an untrusted run (a pull request from a fork)";

/// What a run is lent, by name.
#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct Lent {
    #[serde(default)]
    pub connections: BTreeMap<String, LentItem>,
    #[serde(default)]
    pub ssh_keys: BTreeMap<String, LentItem>,
    #[serde(default)]
    pub resources: BTreeMap<String, LentResource>,
}

/// Names only, so logging a request cannot print a value.
impl std::fmt::Debug for Lent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lent")
            .field("connections", &self.connections.keys().collect::<Vec<_>>())
            .field("ssh_keys", &self.ssh_keys.keys().collect::<Vec<_>>())
            .field("resources", &self.resources.keys().collect::<Vec<_>>())
            .finish()
    }
}

/// A connection's or an SSH key's material: files and variables, or why
/// the job may not have it.
#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct LentItem {
    #[serde(default)]
    pub env: BTreeMap<String, LentValue>,
    #[serde(default)]
    pub files: Vec<LentFile>,
    /// Set instead of the material: the job that names it fails with this.
    #[serde(default)]
    pub refused: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct LentFile {
    /// Absolute, such as `/root/.kube/config` or `/root/.ssh/id_deploy`.
    pub path: String,
    /// Octal, such as `"600"` or `"0644"`. Default `0600`.
    #[serde(default)]
    pub mode: Option<String>,
    pub content: LentValue,
}

/// A resource grant: the outputs `${{ resources.<name>.<output> }}` reads,
/// the variables `env-from:` sets, or why not.
#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct LentResource {
    #[serde(default)]
    pub outputs: BTreeMap<String, LentValue>,
    #[serde(default)]
    pub env: BTreeMap<String, LentValue>,
    #[serde(default)]
    pub refused: Option<String>,
    /// Outputs of a granted resource that are not granted, and why.
    #[serde(default)]
    pub refused_outputs: BTreeMap<String, String>,
}

/// A value: a string, which is secret as a whole, or a list of parts that
/// says which pieces are (`[{ "text": "server: " }, { "secret": "..." }]`),
/// so a kubeconfig's ordinary lines are not masked in every log.
#[derive(Clone, Deserialize)]
#[serde(untagged)]
pub enum LentValue {
    Secret(String),
    Parts(Vec<LentPart>),
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub enum LentPart {
    Text(String),
    Secret(String),
}

impl LentValue {
    /// The value as the job sees it.
    pub fn text(&self) -> String {
        match self {
            LentValue::Secret(s) => s.clone(),
            LentValue::Parts(parts) => parts
                .iter()
                .map(|p| match p {
                    LentPart::Text(t) | LentPart::Secret(t) => t.as_str(),
                })
                .collect(),
        }
    }

    /// The pieces to mask.
    fn secrets(&self) -> Vec<&String> {
        match self {
            LentValue::Secret(s) => vec![s],
            LentValue::Parts(parts) => parts
                .iter()
                .filter_map(|p| match p {
                    LentPart::Secret(s) => Some(s),
                    LentPart::Text(_) => None,
                })
                .collect(),
        }
    }

    fn len(&self) -> usize {
        match self {
            LentValue::Secret(s) => s.len(),
            LentValue::Parts(parts) => parts
                .iter()
                .map(|p| match p {
                    LentPart::Text(t) | LentPart::Secret(t) => t.len(),
                })
                .sum(),
        }
    }
}

fn is_env_key(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && (b[0].is_ascii_alphabetic() || b[0] == b'_')
        && b.iter().all(|c| c.is_ascii_alphanumeric() || *c == b'_')
}

/// Paths a lent file may not take: the runner's own, the run's shared
/// scratch directory (every job of the run sees it), and devices.
const RESERVED: [&str; 6] = [
    "/iwci",
    "/dev",
    "/proc",
    "/usr/local/lib/iwci",
    iwci_spec::SCRATCH_PATH,
    "/etc/passwd",
];

/// `path`, normalised, if a lent file may be written there.
fn file_path(path: &str) -> Result<PathBuf, String> {
    let below_root = || format!("`{path}` must be an absolute path below `/`, without `..`");
    if !path.starts_with('/') || path.split('/').any(|c| c == "..") || path.len() > 512 {
        return Err(below_root());
    }
    let normal = iwci_vfs::normalise(path).map_err(|_| below_root())?;
    let shown = normal.display().to_string();
    if shown == "/" {
        return Err(below_root());
    }
    if RESERVED
        .iter()
        .any(|r| shown == *r || shown.starts_with(&format!("{r}/")))
    {
        return Err(format!("`{path}` is not a path a lent file may take"));
    }
    Ok(normal)
}

fn parse_mode(mode: Option<&str>) -> Result<u32, String> {
    match mode {
        None => Ok(DEFAULT_MODE),
        Some(text) => u32::from_str_radix(text, 8)
            .ok()
            .filter(|m| *m <= 0o777 && (1..=4).contains(&text.len()))
            .ok_or_else(|| format!("mode `{text}` is not an octal mode such as `600`")),
    }
}

impl Lent {
    pub fn is_empty(&self) -> bool {
        self.connections.is_empty() && self.ssh_keys.is_empty() && self.resources.is_empty()
    }

    /// Checks a request's material: names, sizes, variables and paths.
    pub fn check(&self) -> Result<(), String> {
        let name_ok =
            |n: &str| !n.is_empty() && n.chars().count() <= 128 && !n.chars().any(char::is_control);
        let value_ok = |what: &str, v: &LentValue| {
            if v.len() > MAX_VALUE_BYTES || v.text().contains('\0') {
                Err(format!(
                    "{what} is over {} KiB or contains a NUL byte",
                    MAX_VALUE_BYTES >> 10
                ))
            } else {
                Ok(())
            }
        };
        let env_ok = |what: &str, env: &BTreeMap<String, LentValue>| -> Result<(), String> {
            for (k, v) in env {
                if !is_env_key(k) || k.starts_with("IWCI_") {
                    return Err(format!("{what}: `{k}` is not a variable it may set"));
                }
                value_ok(&format!("{what}: `{k}`"), v)?;
            }
            Ok(())
        };
        let reason_ok = |what: &str, r: &str| {
            if r.trim().is_empty() || r.chars().count() > MAX_REASON {
                Err(format!(
                    "{what}: a refusal's reason has 1 to {MAX_REASON} characters"
                ))
            } else {
                Ok(())
            }
        };
        for (kind, items) in [
            ("connection", &self.connections),
            ("SSH key", &self.ssh_keys),
        ] {
            if items.len() > MAX_ENTRIES {
                return Err(format!("over {MAX_ENTRIES} {kind}s"));
            }
            for (name, item) in items {
                let what = format!("{kind} `{name}`");
                if !name_ok(name) {
                    return Err(format!("{what}: not a valid name"));
                }
                if let Some(reason) = &item.refused {
                    reason_ok(&what, reason)?;
                    if !item.env.is_empty() || !item.files.is_empty() {
                        return Err(format!("{what}: is refused and lent at once"));
                    }
                    continue;
                }
                env_ok(&what, &item.env)?;
                if item.files.len() > MAX_FILES {
                    return Err(format!("{what}: over {MAX_FILES} files"));
                }
                for file in &item.files {
                    file_path(&file.path).map_err(|e| format!("{what}: {e}"))?;
                    parse_mode(file.mode.as_deref()).map_err(|e| format!("{what}: {e}"))?;
                    value_ok(&format!("{what}: `{}`", file.path), &file.content)?;
                }
            }
        }
        if self.resources.len() > MAX_ENTRIES {
            return Err(format!("over {MAX_ENTRIES} resources"));
        }
        for (name, resource) in &self.resources {
            let what = format!("resource `{name}`");
            if !name_ok(name) {
                return Err(format!("{what}: not a valid name"));
            }
            if let Some(reason) = &resource.refused {
                reason_ok(&what, reason)?;
                if !resource.outputs.is_empty() || !resource.env.is_empty() {
                    return Err(format!("{what}: is refused and lent at once"));
                }
            }
            env_ok(&what, &resource.env)?;
            for (output, value) in &resource.outputs {
                value_ok(&format!("{what}: output `{output}`"), value)?;
            }
            for (output, reason) in &resource.refused_outputs {
                reason_ok(&format!("{what}: output `{output}`"), reason)?;
            }
        }
        Ok(())
    }

    /// Every secret value it holds, for the run's masker.
    pub fn secret_values(&self) -> Vec<String> {
        let mut out = Vec::new();
        for item in self.connections.values().chain(self.ssh_keys.values()) {
            for v in item
                .env
                .values()
                .chain(item.files.iter().map(|f| &f.content))
            {
                out.extend(v.secrets().into_iter().cloned());
            }
        }
        for r in self.resources.values() {
            for v in r.outputs.values().chain(r.env.values()) {
                out.extend(v.secrets().into_iter().cloned());
            }
        }
        out
    }

    /// The value of `${{ resources.<name>.<output> }}`, or why the job
    /// may not have it.
    pub fn output(&self, name: &str, output: &str) -> Result<String, String> {
        let resource = self
            .resources
            .get(name)
            .ok_or_else(|| format!("resource `{name}` was not lent to this run"))?;
        if let Some(reason) = &resource.refused {
            return Err(reason.clone());
        }
        if let Some(reason) = resource.refused_outputs.get(output) {
            return Err(reason.clone());
        }
        resource
            .outputs
            .get(output)
            .map(LentValue::text)
            .ok_or_else(|| format!("resource `{name}` has no output `{output}` lent to this run"))
    }
}

/// What a job is given of what the run was lent.
#[derive(Debug, Default)]
pub struct ForJob {
    /// The connections' and keys' variables, then `env-from:`'s: under the
    /// job's own `env:`.
    pub env: Vec<(String, String)>,
    /// Each path once: content from every item that writes it, in the
    /// order the job names them, and the strictest of their modes.
    pub files: Vec<(PathBuf, u32, Vec<u8>)>,
}

/// What `access` names, from `lent`, or the reason the job fails: a name
/// the request did not supply or refused, or any name at all in an
/// untrusted run.
pub fn for_job(lent: &Lent, access: &JobAccess, trusted: bool) -> Result<ForJob, String> {
    if access.is_empty() {
        return Ok(ForJob::default());
    }
    if !trusted {
        return Err(UNTRUSTED.into());
    }
    let mut out = ForJob::default();
    let mut add = |kind: &str, name: &str, item: Option<&LentItem>| -> Result<(), String> {
        let item = item.ok_or_else(|| format!("{kind} `{name}` was not lent to this run"))?;
        if let Some(reason) = &item.refused {
            return Err(reason.clone());
        }
        for (k, v) in &item.env {
            out.env.retain(|(e, _)| e != k);
            out.env.push((k.clone(), v.text()));
        }
        for file in &item.files {
            let path = file_path(&file.path)?;
            let mode = parse_mode(file.mode.as_deref())?;
            let content = file.content.text().into_bytes();
            match out.files.iter_mut().find(|(p, _, _)| *p == path) {
                Some((_, m, data)) => {
                    *m &= mode;
                    if !data.is_empty() && !data.ends_with(b"\n") {
                        data.push(b'\n');
                    }
                    data.extend_from_slice(&content);
                }
                None => out.files.push((path, mode, content)),
            }
        }
        Ok(())
    };
    for c in &access.connections {
        add("connection", &c.name, lent.connections.get(&c.name))?;
    }
    for k in &access.ssh_keys {
        add("SSH key", k, lent.ssh_keys.get(k))?;
    }
    for name in &access.env_from {
        let resource = lent
            .resources
            .get(name)
            .ok_or_else(|| format!("resource `{name}` was not lent to this run"))?;
        if let Some(reason) = &resource.refused {
            return Err(reason.clone());
        }
        for (k, v) in &resource.env {
            out.env.retain(|(e, _)| e != k);
            out.env.push((k.clone(), v.text()));
        }
    }
    // Every output the job reads, checked now, so a refusal fails the job
    // before anything starts rather than when its value is filled in.
    for (name, outputs) in &access.resources {
        for output in outputs {
            lent.output(name, output)?;
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use iwci_spec::ConnectionUse;

    fn lent(json: &str) -> Lent {
        let lent: Lent = serde_json::from_str(json).unwrap();
        lent.check().unwrap();
        lent
    }

    fn access(connections: &[&str], keys: &[&str]) -> JobAccess {
        JobAccess {
            connections: connections
                .iter()
                .map(|n| ConnectionUse {
                    name: n.to_string(),
                    namespace: None,
                })
                .collect(),
            ssh_keys: keys.iter().map(|k| k.to_string()).collect(),
            ..Default::default()
        }
    }

    const LENT: &str = r#"{
        "connections": {
            "Production cluster": {
                "env": { "KUBECONFIG": [{ "text": "/root/.kube/config" }] },
                "files": [{ "path": "/root/.kube/config", "content": [
                    { "text": "apiVersion: v1\nusers:\n- user:\n    token: " },
                    { "secret": "kube-token-value" }
                ] }]
            },
            "web-1": { "files": [
                { "path": "/root/.ssh/config", "mode": "644", "content": [{ "text": "Host web-1\n  User deploy" }] },
                { "path": "/root/.ssh/known_hosts", "content": [{ "text": "web-1 ssh-ed25519 AAAA" }] }
            ] },
            "staging": { "refused": "staging is not lent to CI for acme/web on feature/x" }
        },
        "ssh-keys": {
            "deploy": { "files": [
                { "path": "/root/.ssh/id_deploy", "content": "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----\n" },
                { "path": "/root/.ssh/config", "content": [{ "text": "Host *\n  IdentityFile /root/.ssh/id_deploy\n" }] }
            ] }
        },
        "resources": {
            "prod-db": {
                "outputs": { "connectionString": "postgres://u:pw-value@db/app" },
                "refused-outputs": { "adminPassword": "adminPassword of prod-db is not granted to CI" }
            },
            "r2-assets": { "env": { "AWS_ACCESS_KEY_ID": "r2-key-id", "AWS_SECRET_ACCESS_KEY": "r2-secret" } }
        }
    }"#;

    #[test]
    fn a_job_gets_what_it_names_merged_by_path() {
        let lent = lent(LENT);
        let got = for_job(
            &lent,
            &access(&["web-1", "Production cluster"], &["deploy"]),
            true,
        )
        .unwrap();
        assert_eq!(
            got.env,
            [("KUBECONFIG".to_string(), "/root/.kube/config".to_string())]
        );
        let file = |p: &str| {
            got.files
                .iter()
                .find(|(path, _, _)| path == std::path::Path::new(p))
                .map(|(_, mode, data)| (*mode, String::from_utf8(data.clone()).unwrap()))
                .unwrap()
        };
        // The connection's host entry, then the key's catch-all, in the
        // order the job names them, and the stricter mode.
        assert_eq!(
            file("/root/.ssh/config"),
            (
                0o600 & 0o644,
                "Host web-1\n  User deploy\nHost *\n  IdentityFile /root/.ssh/id_deploy\n".into()
            )
        );
        assert_eq!(file("/root/.ssh/id_deploy").0, 0o600);
        assert!(
            file("/root/.kube/config")
                .1
                .ends_with("token: kube-token-value")
        );
        assert_eq!(got.files.len(), 4);
    }

    #[test]
    fn a_refused_missing_or_untrusted_name_fails_the_job_with_its_reason() {
        let lent = lent(LENT);
        assert_eq!(
            for_job(&lent, &access(&["staging"], &[]), true).unwrap_err(),
            "staging is not lent to CI for acme/web on feature/x"
        );
        assert_eq!(
            for_job(&lent, &access(&["nope"], &[]), true).unwrap_err(),
            "connection `nope` was not lent to this run"
        );
        assert_eq!(
            for_job(&lent, &access(&[], &["other"]), true).unwrap_err(),
            "SSH key `other` was not lent to this run"
        );
        assert_eq!(
            for_job(&lent, &access(&["web-1"], &[]), false).unwrap_err(),
            UNTRUSTED
        );
        // Nothing named, nothing to refuse.
        assert!(for_job(&lent, &JobAccess::default(), false).is_ok());
        let mut resources = JobAccess::default();
        resources
            .resources
            .entry("prod-db".into())
            .or_default()
            .insert("adminPassword".into());
        assert_eq!(
            for_job(&lent, &resources, true).unwrap_err(),
            "adminPassword of prod-db is not granted to CI"
        );
        assert_eq!(
            lent.output("prod-db", "connectionString").unwrap(),
            "postgres://u:pw-value@db/app"
        );
        assert_eq!(
            lent.output("prod-db", "host").unwrap_err(),
            "resource `prod-db` has no output `host` lent to this run"
        );
        assert_eq!(
            lent.output("cache", "x").unwrap_err(),
            "resource `cache` was not lent to this run"
        );
        let env_from = JobAccess {
            env_from: vec!["r2-assets".into()],
            ..Default::default()
        };
        assert_eq!(for_job(&lent, &env_from, true).unwrap().env.len(), 2);
    }

    #[test]
    fn only_secret_parts_are_masked_and_debug_shows_names() {
        let lent = lent(LENT);
        let secrets = lent.secret_values();
        assert!(secrets.contains(&"kube-token-value".to_string()));
        assert!(secrets.iter().any(|s| s.contains("OPENSSH PRIVATE KEY")));
        assert!(secrets.contains(&"r2-secret".to_string()));
        assert!(secrets.contains(&"postgres://u:pw-value@db/app".to_string()));
        assert!(!secrets.iter().any(|s| s.contains("apiVersion")));
        assert!(!secrets.iter().any(|s| s.contains("Host web-1")));
        let shown = format!("{lent:?}");
        assert!(shown.contains("Production cluster") && !shown.contains("kube-token-value"));
    }

    #[test]
    fn a_request_is_checked_before_the_run_starts() {
        for (json, needle) in [
            (
                r#"{"connections": {"a": {"files": [{"path": "/iwci/output", "content": "x"}]}}}"#,
                "is not a path a lent file may take",
            ),
            (
                r#"{"connections": {"a": {"files": [{"path": "/tmp/workflow/k", "content": "x"}]}}}"#,
                "is not a path a lent file may take",
            ),
            (
                r#"{"connections": {"a": {"files": [{"path": "root/.ssh/k", "content": "x"}]}}}"#,
                "must be an absolute path",
            ),
            (
                r#"{"connections": {"a": {"files": [{"path": "/root/../etc/k", "content": "x"}]}}}"#,
                "must be an absolute path",
            ),
            (
                r#"{"connections": {"a": {"files": [{"path": "/root/k", "mode": "999", "content": "x"}]}}}"#,
                "not an octal mode",
            ),
            (
                r#"{"connections": {"a": {"env": {"IWCI_JOB": "x"}}}}"#,
                "is not a variable it may set",
            ),
            (
                r#"{"connections": {"a": {"refused": "no", "env": {"A": "x"}}}}"#,
                "refused and lent at once",
            ),
            (
                r#"{"resources": {"r": {"refused": ""}}}"#,
                "reason has 1 to",
            ),
        ] {
            let lent: Lent = serde_json::from_str(json).unwrap();
            let err = lent.check().unwrap_err();
            assert!(err.contains(needle), "{json}: {err}");
        }
        assert!(serde_json::from_str::<Lent>(r#"{"keys": {}}"#).is_err());
        assert!(
            serde_json::from_str::<Lent>(
                r#"{"connections": {"a": {"env": {"A": [{"plain": "x"}]}}}}"#
            )
            .is_err()
        );
    }
}
