//! A project's `.npmrc`, as npm and pnpm both read it: `key=value` lines,
//! `#` and `;` comments, quoted values. Only the project's own file is
//! read; a job has no user or global configuration at install time.

use std::collections::BTreeMap;
use std::path::Path;

/// The settings of one `.npmrc`, in file order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Npmrc {
    values: Vec<(String, String)>,
}

impl Npmrc {
    /// The `.npmrc` in `root`, empty when there is none.
    pub fn read(read: &dyn Fn(&Path) -> Option<Vec<u8>>, root: &Path) -> Npmrc {
        read(&root.join(".npmrc"))
            .map(|bytes| Npmrc::parse(&String::from_utf8_lossy(&bytes)))
            .unwrap_or_default()
    }

    /// A value that names an environment variable (`${NPM_REGISTRY}`) is
    /// left out: nothing expands it when the install runs, before any job,
    /// so the key falls back to its default.
    pub fn parse(text: &str) -> Npmrc {
        let mut values = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
                continue;
            }
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let value = value.trim().trim_matches('"').trim_matches('\'');
            if value.contains("${") {
                continue;
            }
            values.push((key.trim().to_string(), value.to_string()));
        }
        Npmrc { values }
    }

    /// Every `key=value`, in file order.
    pub fn values(&self) -> impl Iterator<Item = (&str, &str)> {
        self.values.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }

    /// The last value of `key`, as npm reads a repeated key.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.values()
            .filter(|(k, _)| *k == key)
            .map(|(_, v)| v)
            .last()
    }

    /// `registry`.
    pub fn registry(&self) -> Option<&str> {
        self.get("registry")
    }

    /// `@scope:registry` entries, by `@scope`.
    pub fn scoped_registries(&self) -> BTreeMap<String, String> {
        self.values()
            .filter_map(|(key, value)| {
                let scope = key.strip_suffix(":registry")?;
                scope
                    .starts_with('@')
                    .then(|| (scope.to_string(), value.to_string()))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registries_come_from_the_file() {
        let npmrc = Npmrc::parse(
            "# comment\n; another\nregistry = \"https://one.example.com/\"\n\
             @corp:registry=https://corp.example.com/npm/\n\
             //corp.example.com/npm/:_authToken=${TOKEN}\n\
             @env:registry=${ENV_REGISTRY}\n\
             not-a-scope:registry=https://x.example.com/\n\
             registry=https://two.example.com/\n",
        );
        assert_eq!(npmrc.registry(), Some("https://two.example.com/"));
        assert_eq!(
            npmrc.scoped_registries(),
            BTreeMap::from([(
                "@corp".to_string(),
                "https://corp.example.com/npm/".to_string()
            )])
        );
        assert_eq!(npmrc.get("//corp.example.com/npm/:_authToken"), None);
        assert_eq!(Npmrc::read(&|_| None, Path::new("/app")), Npmrc::default());
    }

    /// A tarball of one package and its `sha512-` integrity.
    fn package(name: &str) -> (Vec<u8>, String) {
        use base64::Engine;
        use sha2::Digest;
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        let mut builder = tar::Builder::new(encoder);
        let manifest = format!("{{\"name\":\"{name}\",\"version\":\"1.0.0\"}}");
        let mut header = tar::Header::new_gnu();
        header.set_size(manifest.len() as u64);
        header.set_mode(0o644);
        builder
            .append_data(&mut header, "package/package.json", manifest.as_bytes())
            .unwrap();
        let bytes = builder.into_inner().unwrap().finish().unwrap();
        let sri = format!(
            "sha512-{}",
            base64::engine::general_purpose::STANDARD.encode(sha2::Sha512::digest(&bytes))
        );
        (bytes, sri)
    }

    /// What the workspace adapter does for a pnpm project: its `.npmrc`'s
    /// registries become the installer's, so a package comes from the
    /// registry the project names, and a scoped one from its scope's.
    #[test]
    fn a_pnpm_install_fetches_from_the_npmrc_registries() {
        use crate::fetch::MemoryFetcher;
        use crate::pnpm::{PnpmOptions, install};
        let (plain, plain_sri) = package("plain");
        let (scoped, scoped_sri) = package("@corp/lib");
        let lock = format!(
            "lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      plain:\n        specifier: 1.0.0\n        version: 1.0.0\n      '@corp/lib':\n        specifier: 1.0.0\n        version: 1.0.0\n\npackages:\n\n  plain@1.0.0:\n    resolution: {{integrity: {plain_sri}}}\n\n  '@corp/lib@1.0.0':\n    resolution: {{integrity: {scoped_sri}}}\n\nsnapshots:\n\n  plain@1.0.0: {{}}\n\n  '@corp/lib@1.0.0': {{}}\n"
        );
        let builder = iwci_vfs::SnapshotBuilder::new();
        builder
            .write("/app/pnpm-lock.yaml", lock.as_bytes())
            .unwrap();
        builder
            .write(
                "/app/.npmrc",
                b"registry=https://mirror.example.com/npm/\n@corp:registry=https://corp.example.com\n",
            )
            .unwrap();
        let npmrc = Npmrc::read(&|path| builder.read(path).ok(), Path::new("/app"));
        let options = PnpmOptions {
            registry: npmrc.registry().unwrap().to_string(),
            scoped_registries: npmrc.scoped_registries(),
            ..PnpmOptions::default()
        };
        let fetcher = MemoryFetcher::new();
        fetcher.insert(
            "https://mirror.example.com/npm/plain/-/plain-1.0.0.tgz",
            plain,
        );
        fetcher.insert("https://corp.example.com/@corp/lib/-/lib-1.0.0.tgz", scoped);
        let report = install(&builder, "/app", &fetcher, &options).unwrap();
        assert_eq!(report.tarballs, 2);
        let mut requests = fetcher.requests();
        requests.sort();
        assert_eq!(
            requests,
            [
                "https://corp.example.com/@corp/lib/-/lib-1.0.0.tgz",
                "https://mirror.example.com/npm/plain/-/plain-1.0.0.tgz"
            ]
        );
    }
}
