//! What the app lends a run's jobs (`RunRequest::lent`): the credentials
//! of Infrawrench connections (a kubeconfig, an SSH host entry), SSH keys,
//! infrastructure resources' outputs, GitHub tokens for the run's own
//! repository, and the variables of the repository's `.infraenv` files.
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
use std::time::Duration;

use iwci_spec::JobAccess;
use serde::Deserialize;

/// The most entries each of a request's `connections`, `ssh-keys`,
/// `resources` and `github-token` may have.
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
pub const UNTRUSTED: &str = "connections, SSH keys, resources, GitHub tokens and environment files are never lent to an untrusted run (a pull request from a fork)";

/// The longest key `lent.env-files` may have ([`iwci_spec::EnvFileUse::key`]).
pub const MAX_ENV_FILE_KEY: usize = 8 << 10;
/// The most variables one environment file may set.
pub const MAX_ENV_FILE_VARS: usize = 2000;

/// A lent value with less than this left when its job starts is refused
/// rather than handed to a job that could not use it.
pub const MIN_LIFETIME: Duration = Duration::from_secs(60);

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
    /// A token for the run's own repository per set of permissions jobs
    /// ask for, keyed as [`iwci_spec::JobAccess::github_token_key`] says
    /// (`contents=write,pull-requests=write`).
    #[serde(default)]
    pub github_token: BTreeMap<String, LentItem>,
    /// Each `env-file:` jobs use, keyed as [`iwci_spec::EnvFileUse::key`]
    /// says, resolved by the app from the file at the run's commit.
    #[serde(default)]
    pub env_files: BTreeMap<String, LentEnvFile>,
}

/// Names only, so logging a request cannot print a value.
impl std::fmt::Debug for Lent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Lent")
            .field("connections", &self.connections.keys().collect::<Vec<_>>())
            .field("ssh_keys", &self.ssh_keys.keys().collect::<Vec<_>>())
            .field("resources", &self.resources.keys().collect::<Vec<_>>())
            .field(
                "github_token",
                &self.github_token.keys().collect::<Vec<_>>(),
            )
            .field("env_files", &self.env_files.keys().collect::<Vec<_>>())
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
    /// When the material stops working, in seconds since the Unix epoch
    /// (an installation token's hour): a job that starts after it fails
    /// with that reason, and one whose timeout is later is told so.
    #[serde(default)]
    pub expires_at: Option<u64>,
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

/// A `.infraenv` file as the app resolved it for the run: the variables it
/// set (a literal as shown text, a resource output as a secret), the ones
/// that read the repository's CI secrets by name, or why the job may not
/// have it.
#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case")]
pub struct LentEnvFile {
    #[serde(default)]
    pub env: BTreeMap<String, LentValue>,
    /// Variable to the name of the run's secret (`secrets`, the
    /// repository's CI secrets) it reads, filled in when the job starts:
    /// the app never reads those. One the run does not have fails the job.
    #[serde(default)]
    pub secrets: BTreeMap<String, String>,
    #[serde(default)]
    pub refused: Option<String>,
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
        self.connections.is_empty()
            && self.ssh_keys.is_empty()
            && self.resources.is_empty()
            && self.github_token.is_empty()
            && self.env_files.is_empty()
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
            ("GitHub token", &self.github_token),
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
        if self.env_files.len() > MAX_ENTRIES {
            return Err(format!("over {MAX_ENTRIES} environment files"));
        }
        for (key, file) in &self.env_files {
            let what = "environment file";
            if key.is_empty() || key.len() > MAX_ENV_FILE_KEY || key.chars().any(char::is_control) {
                return Err(format!("{what}: `{key}` is not a valid key"));
            }
            let what = format!("environment file `{key}`");
            if let Some(reason) = &file.refused {
                reason_ok(&what, reason)?;
                if !file.env.is_empty() || !file.secrets.is_empty() {
                    return Err(format!("{what}: is refused and lent at once"));
                }
                continue;
            }
            if file.env.len() + file.secrets.len() > MAX_ENV_FILE_VARS {
                return Err(format!("{what}: over {MAX_ENV_FILE_VARS} variables"));
            }
            env_ok(&what, &file.env)?;
            for (k, secret) in &file.secrets {
                if !is_env_key(k) || k.starts_with("IWCI_") || file.env.contains_key(k) {
                    return Err(format!("{what}: `{k}` is not a variable it may set"));
                }
                if !name_ok(secret) {
                    return Err(format!("{what}: `{k}` names no secret"));
                }
            }
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
        for item in self
            .connections
            .values()
            .chain(self.ssh_keys.values())
            .chain(self.github_token.values())
        {
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
        // A file's `secret()` values are the run's secrets, masked as those.
        for f in self.env_files.values() {
            for v in f.env.values() {
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
    /// The connections', keys' and GitHub token's variables, then
    /// `env-from:`'s, then `env-file:`'s: under the job's own `env:`.
    pub env: Vec<(String, String)>,
    /// Each path once: content from every item that writes it, in the
    /// order the job names them, and the strictest of their modes.
    pub files: Vec<(PathBuf, u32, Vec<u8>)>,
    /// What its report should say: lent material that stops working before
    /// the job's timeout.
    pub notes: Vec<String>,
}

/// Whole minutes, rounded up, for a reason a person reads.
fn minutes(secs: u64) -> String {
    match secs.div_ceil(60) {
        1 => "a minute".into(),
        n => format!("{n} minutes"),
    }
}

/// What `access` names, from `lent`, or the reason the job fails: a name
/// the request did not supply or refused, material that has expired (`now`
/// is seconds since the Unix epoch), an environment file's secret the run
/// does not have in `secrets`, or any name at all in an untrusted run.
/// Material that expires before `timeout` is up is given, with a note.
pub fn for_job(
    lent: &Lent,
    access: &JobAccess,
    trusted: bool,
    secrets: &BTreeMap<String, String>,
    now: u64,
    timeout: Duration,
) -> Result<ForJob, String> {
    if access.is_empty() {
        return Ok(ForJob::default());
    }
    if !trusted {
        return Err(UNTRUSTED.into());
    }
    let mut out = ForJob::default();
    let mut add = |kind: &str, name: &str, item: Option<&LentItem>| -> Result<(), String> {
        let what = if kind == "GitHub token" {
            format!("the GitHub token for `{name}`")
        } else {
            format!("{kind} `{name}`")
        };
        let item = item.ok_or_else(|| format!("{what} was not lent to this run"))?;
        if let Some(reason) = &item.refused {
            return Err(reason.clone());
        }
        if let Some(expires) = item.expires_at {
            let left = expires.saturating_sub(now);
            if left < MIN_LIFETIME.as_secs() {
                return Err(if expires <= now {
                    format!(
                        "{what} expired {} before this job started: it was minted when the run was sent, so a job that uses it has to start within its lifetime",
                        minutes(now - expires)
                    )
                } else {
                    format!("{what} expires in under a minute, before this job could use it")
                });
            }
            if left < timeout.as_secs() {
                out.notes.push(format!(
                    "{what} expires in {}, before this job's timeout of {}",
                    minutes(left),
                    minutes(timeout.as_secs())
                ));
            }
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
    if let Some(key) = access.github_token_key() {
        add("GitHub token", &key, lent.github_token.get(&key))?;
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
    if let Some(file) = &access.env_file {
        let key = file.key();
        let lent_file = lent
            .env_files
            .get(&key)
            .ok_or_else(|| format!("environment file `{}` was not lent to this run", file.path))?;
        if let Some(reason) = &lent_file.refused {
            return Err(reason.clone());
        }
        let mut vars: Vec<(String, String)> = lent_file
            .env
            .iter()
            .map(|(k, v)| (k.clone(), v.text()))
            .collect();
        for (k, name) in &lent_file.secrets {
            let value = secrets.get(name).ok_or_else(|| {
                format!(
                    "`{k}` in {} reads secret(\"{name}\"), which is not a CI secret of this repository or its organisation; set it with the CI secrets (CI reads those, not the organisation's secrets)",
                    file.path
                )
            })?;
            vars.push((k.clone(), value.clone()));
        }
        for (k, v) in vars {
            out.env.retain(|(e, _)| *e != k);
            out.env.push((k, v));
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

    const NOW: u64 = 1_800_000_000;
    const TEN_MINUTES: Duration = Duration::from_secs(600);

    /// [`super::for_job`] for a run with no secrets.
    fn for_job(
        lent: &Lent,
        access: &JobAccess,
        trusted: bool,
        now: u64,
        timeout: Duration,
    ) -> Result<ForJob, String> {
        super::for_job(lent, access, trusted, &BTreeMap::new(), now, timeout)
    }

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
            NOW,
            TEN_MINUTES,
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
            for_job(&lent, &access(&["staging"], &[]), true, NOW, TEN_MINUTES).unwrap_err(),
            "staging is not lent to CI for acme/web on feature/x"
        );
        assert_eq!(
            for_job(&lent, &access(&["nope"], &[]), true, NOW, TEN_MINUTES).unwrap_err(),
            "connection `nope` was not lent to this run"
        );
        assert_eq!(
            for_job(&lent, &access(&[], &["other"]), true, NOW, TEN_MINUTES).unwrap_err(),
            "SSH key `other` was not lent to this run"
        );
        assert_eq!(
            for_job(&lent, &access(&["web-1"], &[]), false, NOW, TEN_MINUTES).unwrap_err(),
            UNTRUSTED
        );
        // Nothing named, nothing to refuse.
        assert!(for_job(&lent, &JobAccess::default(), false, NOW, TEN_MINUTES).is_ok());
        let mut resources = JobAccess::default();
        resources
            .resources
            .entry("prod-db".into())
            .or_default()
            .insert("adminPassword".into());
        assert_eq!(
            for_job(&lent, &resources, true, NOW, TEN_MINUTES).unwrap_err(),
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
        assert_eq!(
            for_job(&lent, &env_from, true, NOW, TEN_MINUTES)
                .unwrap()
                .env
                .len(),
            2
        );
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

    /// A token as the app lends one: `GH_TOKEN`, `GITHUB_TOKEN` and `GH_REPO`,
    /// and Git's global configuration with the token as a header for the
    /// repository, expiring an hour after it was minted.
    fn github_lent(expires_at: u64) -> Lent {
        lent(&format!(
            r#"{{"github-token": {{
                "contents=write,pull-requests=write": {{
                    "env": {{
                        "GH_TOKEN": "installation-token-for-tests",
                        "GITHUB_TOKEN": "installation-token-for-tests",
                        "GH_REPO": [{{ "text": "acme/widgets" }}],
                        "GIT_CONFIG_GLOBAL": [{{ "text": "/root/.gitconfig" }}]
                    }},
                    "files": [{{ "path": "/root/.gitconfig", "mode": "600", "content": [
                        {{ "text": "[http \"https://github.com/acme/widgets\"]\n\textraheader = AUTHORIZATION: basic " }},
                        {{ "secret": "eC1hY2Nlc3MtdG9rZW46aW5zdGFsbGF0aW9uLXRva2VuLWZvci10ZXN0cw==" }},
                        {{ "text": "\n" }}
                    ] }}],
                    "expires-at": {expires_at}
                }},
                "issues=write": {{ "refused": "the Infrawrench GitHub App cannot have issues: write on acme/widgets" }}
            }}}}"#
        ))
    }

    fn github_access(permissions: &[(&str, &str)]) -> JobAccess {
        JobAccess {
            github_token: permissions
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn a_github_token_is_given_by_its_permissions_and_masked() {
        let lent = github_lent(NOW + 3600);
        let job = github_access(&[("pull-requests", "write"), ("contents", "write")]);
        assert_eq!(
            job.github_token_key().as_deref(),
            Some("contents=write,pull-requests=write")
        );
        let got = for_job(&lent, &job, true, NOW, TEN_MINUTES).unwrap();
        assert!(got.notes.is_empty());
        let env: BTreeMap<_, _> = got.env.iter().cloned().collect();
        assert_eq!(env["GH_TOKEN"], "installation-token-for-tests");
        assert_eq!(env["GH_REPO"], "acme/widgets");
        assert_eq!(env["GIT_CONFIG_GLOBAL"], "/root/.gitconfig");
        assert_eq!(got.files.len(), 1);
        assert_eq!(got.files[0].1, 0o600);
        let secrets = lent.secret_values();
        assert!(secrets.contains(&"installation-token-for-tests".to_string()));
        assert!(
            secrets.contains(
                &"eC1hY2Nlc3MtdG9rZW46aW5zdGFsbGF0aW9uLXRva2VuLWZvci10ZXN0cw==".to_string()
            )
        );
        assert!(!secrets.iter().any(|s| s.contains("acme/widgets")));
        assert!(!format!("{lent:?}").contains("installation-token-for-tests"));
        // Other permissions are another token, refused here; none is none.
        assert_eq!(
            for_job(
                &lent,
                &github_access(&[("issues", "write")]),
                true,
                NOW,
                TEN_MINUTES
            )
            .unwrap_err(),
            "the Infrawrench GitHub App cannot have issues: write on acme/widgets"
        );
        assert_eq!(
            for_job(
                &lent,
                &github_access(&[("contents", "read")]),
                true,
                NOW,
                TEN_MINUTES
            )
            .unwrap_err(),
            "the GitHub token for `contents=read` was not lent to this run"
        );
        assert_eq!(
            for_job(&lent, &job, false, NOW, TEN_MINUTES).unwrap_err(),
            UNTRUSTED
        );
    }

    #[test]
    fn an_expired_token_fails_the_job_and_one_expiring_soon_says_so() {
        let job = github_access(&[("contents", "write"), ("pull-requests", "write")]);
        // Minted an hour and five minutes before the job started.
        assert_eq!(
            for_job(&github_lent(NOW - 300), &job, true, NOW, TEN_MINUTES).unwrap_err(),
            "the GitHub token for `contents=write,pull-requests=write` expired 5 minutes before this job started: it was minted when the run was sent, so a job that uses it has to start within its lifetime"
        );
        assert!(
            for_job(&github_lent(NOW + 30), &job, true, NOW, TEN_MINUTES)
                .unwrap_err()
                .contains("expires in under a minute")
        );
        // Twenty minutes left of a job that may run for an hour: it runs,
        // and its report says the token may stop working first.
        let got = for_job(
            &github_lent(NOW + 1200),
            &job,
            true,
            NOW,
            Duration::from_secs(3600),
        )
        .unwrap();
        assert_eq!(
            got.notes,
            [
                "the GitHub token for `contents=write,pull-requests=write` expires in 20 minutes, before this job's timeout of 60 minutes"
            ]
        );
        // Within the timeout: nothing to say.
        assert!(
            for_job(&github_lent(NOW + 1200), &job, true, NOW, TEN_MINUTES)
                .unwrap()
                .notes
                .is_empty()
        );
    }

    fn env_file_access(path: &str, environment: Option<&str>) -> JobAccess {
        JobAccess {
            env_file: Some(iwci_spec::EnvFileUse {
                path: path.into(),
                environment: environment.map(str::to_string),
                vars: BTreeMap::new(),
            }),
            ..Default::default()
        }
    }

    /// As the app lends a `.infraenv`: literals as shown text, a granted
    /// resource's output as a secret, `secret()` by the CI secret's name.
    const ENV_FILES: &str = r#"{
        "env-files": {
            "{\"path\":\".infraenv\",\"environment\":\"staging\"}": {
                "env": {
                    "NODE_ENV": [{ "text": "staging" }],
                    "DATABASE_URL": "postgres://ci:file-db-pass@db/app"
                },
                "secrets": { "STRIPE_KEY": "STRIPE_SECRET_KEY" }
            },
            "{\"path\":\".infraenv\"}": {
                "refused": "`CACHE_URL` in .infraenv reads cache-1, which is not granted to CI for acme/web on main"
            }
        }
    }"#;

    #[test]
    fn an_env_file_is_given_by_its_key_with_ci_secrets_filled_in() {
        let lent: Lent = serde_json::from_str(ENV_FILES).unwrap();
        lent.check().unwrap();
        let job = env_file_access(".infraenv", Some("staging"));
        let secrets = BTreeMap::from([(
            "STRIPE_SECRET_KEY".to_string(),
            "stripe-ci-placeholder".to_string(),
        )]);
        let got = super::for_job(&lent, &job, true, &secrets, NOW, TEN_MINUTES).unwrap();
        let env: BTreeMap<_, _> = got.env.iter().cloned().collect();
        assert_eq!(env["NODE_ENV"], "staging");
        assert_eq!(env["DATABASE_URL"], "postgres://ci:file-db-pass@db/app");
        assert_eq!(env["STRIPE_KEY"], "stripe-ci-placeholder");
        // The resource output is masked; the literal is not; the CI
        // secret is masked as the run's secrets are.
        let masked = lent.secret_values();
        assert!(masked.contains(&"postgres://ci:file-db-pass@db/app".to_string()));
        assert!(!masked.contains(&"staging".to_string()));
        assert!(!format!("{lent:?}").contains("file-db-pass"));

        // A CI secret the run does not have fails the job, saying where
        // secrets come from in CI.
        let err =
            super::for_job(&lent, &job, true, &BTreeMap::new(), NOW, TEN_MINUTES).unwrap_err();
        assert!(
            err.contains("`STRIPE_KEY` in .infraenv reads secret(\"STRIPE_SECRET_KEY\")"),
            "{err}"
        );
        assert!(err.contains("not the organisation's secrets"), "{err}");
        // A refusal is the job's reason; another use of the file is another key.
        assert!(
            for_job(
                &lent,
                &env_file_access(".infraenv", None),
                true,
                NOW,
                TEN_MINUTES
            )
            .unwrap_err()
            .contains("not granted to CI")
        );
        assert_eq!(
            for_job(
                &lent,
                &env_file_access(".infraenv", Some("prod")),
                true,
                NOW,
                TEN_MINUTES
            )
            .unwrap_err(),
            "environment file `.infraenv` was not lent to this run"
        );
        assert_eq!(
            super::for_job(&lent, &job, false, &secrets, NOW, TEN_MINUTES).unwrap_err(),
            UNTRUSTED
        );
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
            (
                r#"{"env-files": {"k": {"env": {"IWCI_X": "x"}}}}"#,
                "is not a variable it may set",
            ),
            (
                r#"{"env-files": {"k": {"env": {"A": "x"}, "secrets": {"A": "S"}}}}"#,
                "is not a variable it may set",
            ),
            (
                r#"{"env-files": {"k": {"refused": "no", "secrets": {"A": "S"}}}}"#,
                "refused and lent at once",
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
