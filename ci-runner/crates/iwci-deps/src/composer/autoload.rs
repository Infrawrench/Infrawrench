//! The files `composer dump-autoload` writes, from `vendor/composer/
//! installed.json` and the root `composer.json`: the PSR-0, PSR-4, class
//! map and `files` rules of every package, in Composer's order, and
//! `vendor/autoload.php`. Also the two other generated PHP files of an
//! install, `installed.php` and the `vendor/bin` proxies.
//!
//! The class map and file lists are Composer's own formats, and the loader
//! is Composer's `ClassLoader`, so a tool that reads them (PHPUnit's
//! exclusion list, `Composer\InstalledVersions`) sees what it would after
//! `composer install`. `autoload_real.php` fills the loader from those
//! lists rather than from a compiled `autoload_static.php`, which comes to
//! the same loader. Running Composer in the job (`composer dump-autoload`)
//! replaces them all with its own.

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::{Component, Path, PathBuf};

use iwci_vfs::{SnapshotBuilder, normalise};
use md5::{Digest, Md5};
use serde_json::Value;

use super::classmap::find_classes;
use super::{ComposerError, Dirs, Package, Result, read_root};

#[derive(Debug, Clone, Default)]
pub struct AutoloadReport {
    /// Entries in the class map.
    pub classes: usize,
    pub warnings: Vec<String>,
}

/// One package's autoload rules and where it is.
struct Entry {
    name: String,
    autoload: Value,
    /// Absolute; the root's is the repository directory.
    dir: PathBuf,
    requires: Vec<String>,
}

/// Writes `vendor/autoload.php` and `vendor/composer/autoload_*.php` for
/// the install in `dir`, as `composer dump-autoload` would.
pub fn dump_autoload(builder: &SnapshotBuilder, dir: &str) -> Result<AutoloadReport> {
    let base = normalise(dir)?;
    let root = read_root(builder, &base)?;
    let dirs = Dirs::read(&base, &root)?;
    let composer_dir = dirs.vendor.join("composer");
    let installed_path = composer_dir.join("installed.json");
    let installed: Value =
        serde_json::from_slice(&builder.read(&installed_path)?).map_err(|e| {
            ComposerError::Lockfile {
                file: installed_path.display().to_string(),
                message: format!("not JSON: {e}"),
            }
        })?;
    let mut report = AutoloadReport::default();

    let root_name = root
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("__root__")
        .to_string();
    let requires_of = |v: &Value, dev: bool| -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for key in ["require"].into_iter().chain(dev.then_some("require-dev")) {
            if let Some(map) = v.get(key).and_then(Value::as_object) {
                out.extend(map.keys().cloned());
            }
        }
        out
    };
    let mut root_autoload = root.get("autoload").cloned().unwrap_or(Value::Null);
    merge_recursive(
        &mut root_autoload,
        root.get("autoload-dev").cloned().unwrap_or(Value::Null),
    );
    let root_entry = Entry {
        name: root_name.clone(),
        autoload: root_autoload,
        dir: base.clone(),
        requires: requires_of(&root, true),
    };
    let packages = installed
        .get("packages")
        .or(Some(&installed))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut entries = Vec::new();
    for p in &packages {
        let Some(name) = p.get("name").and_then(Value::as_str) else {
            continue;
        };
        // A package that is not installed (a metapackage) loads nothing.
        let Some(install_path) = p.get("install-path").and_then(Value::as_str) else {
            continue;
        };
        if p.get("include-path").is_some() {
            report.warnings.push(format!(
                "composer: {name}'s `include-path` is not set up; it is deprecated in Composer"
            ));
        }
        entries.push(Entry {
            name: name.to_string(),
            autoload: p.get("autoload").cloned().unwrap_or(Value::Null),
            dir: lexical(&composer_dir.join(install_path)),
            requires: requires_of(p, false),
        });
    }
    let mut sorted = sort_packages(entries);
    sorted.push(root_entry);
    let reversed: Vec<&Entry> = sorted.iter().rev().collect();
    let in_order: Vec<&Entry> = sorted.iter().collect();

    // The rules, as AutoloadGenerator::parseAutoloads collects them: the
    // root first for the namespaces and the class map, dependencies first
    // for the files.
    let mut psr0: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    let mut psr4: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    for entry in &reversed {
        for (psr, map) in [("psr-0", &mut psr0), ("psr-4", &mut psr4)] {
            let Some(rules) = entry.autoload.get(psr).and_then(Value::as_object) else {
                continue;
            };
            for (namespace, paths) in rules {
                let namespace = namespace.trim_start_matches('\\').to_string();
                for path in strings(paths) {
                    map.entry(namespace.clone())
                        .or_default()
                        .push(join_rule(&entry.dir, &path));
                }
            }
        }
    }
    let mut classmap_paths = Vec::new();
    for entry in &reversed {
        for path in entry
            .autoload
            .get("classmap")
            .map(strings)
            .unwrap_or_default()
        {
            classmap_paths.push(join_rule(&entry.dir, &path));
        }
    }
    let mut files: Vec<(String, PathBuf)> = Vec::new();
    let mut excluded: Vec<(PathBuf, String)> = Vec::new();
    for entry in &in_order {
        for path in entry.autoload.get("files").map(strings).unwrap_or_default() {
            let id = hex::encode(Md5::digest(format!("{}:{path}", entry.name).as_bytes()));
            if let Some(slot) = files.iter_mut().find(|(i, _)| *i == id) {
                slot.1 = join_rule(&entry.dir, &path);
            } else {
                files.push((id, join_rule(&entry.dir, &path)));
            }
        }
        for pattern in entry
            .autoload
            .get("exclude-from-classmap")
            .map(strings)
            .unwrap_or_default()
        {
            excluded.push(exclusion(&entry.dir, &pattern));
        }
    }

    // The class map: every classmap rule scanned, the first file to declare
    // a class winning, plus Composer's own InstalledVersions.
    let mut classmap: BTreeMap<String, PathBuf> = BTreeMap::new();
    let mut scanned = BTreeSet::new();
    for path in &classmap_paths {
        let candidates: Vec<PathBuf> = if builder.is_file(path) {
            vec![path.clone()]
        } else if builder.is_dir(path) {
            iwci_vfs::list_files(builder.fs(), path)
                .into_iter()
                .filter(|f| {
                    f.extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(|e| matches!(e, "php" | "inc" | "hh"))
                })
                // Scanning a directory that holds the vendor directory
                // leaves the vendor directory out, as Composer does.
                .filter(|f| {
                    !(dirs.vendor.starts_with(path)
                        && dirs.vendor != *path
                        && f.starts_with(&dirs.vendor))
                })
                .collect()
        } else {
            report.warnings.push(format!(
                "composer: no file or directory at {} (a `classmap` rule)",
                path.display()
            ));
            continue;
        };
        for file in candidates {
            if !scanned.insert(file.clone()) || excluded.iter().any(|(b, p)| excludes(b, p, &file))
            {
                continue;
            }
            let Ok(source) = builder.read(&file) else {
                continue;
            };
            for class in find_classes(&source) {
                classmap.entry(class).or_insert_with(|| file.clone());
            }
        }
    }
    classmap.insert(
        "Composer\\InstalledVersions".to_string(),
        composer_dir.join("InstalledVersions.php"),
    );
    report.classes = classmap.len();

    let code = PathCode::new(&dirs);
    let header = |what: &str| {
        format!(
            "<?php\n\n// {what} @generated by Composer\n\n$vendorDir = {};\n$baseDir = {};\n\nreturn array(\n",
            code.vendor_dir, code.base_dir
        )
    };
    let psr_file = |what: &str, map: &BTreeMap<String, Vec<PathBuf>>| {
        let mut out = header(what);
        // krsort: longer prefixes of the same start come first.
        for (namespace, paths) in map.iter().rev() {
            let paths: Vec<String> = paths.iter().map(|p| code.path(p)).collect();
            out.push_str(&format!(
                "    {} => array({}),\n",
                var_export(namespace),
                paths.join(", ")
            ));
        }
        out + ");\n"
    };
    builder.write(
        composer_dir.join("autoload_namespaces.php"),
        psr_file("autoload_namespaces.php", &psr0).as_bytes(),
    )?;
    builder.write(
        composer_dir.join("autoload_psr4.php"),
        psr_file("autoload_psr4.php", &psr4).as_bytes(),
    )?;
    let mut map_file = header("autoload_classmap.php");
    for (class, path) in &classmap {
        map_file.push_str(&format!(
            "    {} => {},\n",
            var_export(class),
            code.path(path)
        ));
    }
    map_file.push_str(");\n");
    builder.write(
        composer_dir.join("autoload_classmap.php"),
        map_file.as_bytes(),
    )?;
    if !files.is_empty() {
        let mut files_file = header("autoload_files.php");
        for (id, path) in &files {
            files_file.push_str(&format!("    {} => {},\n", var_export(id), code.path(path)));
        }
        files_file.push_str(");\n");
        builder.write(
            composer_dir.join("autoload_files.php"),
            files_file.as_bytes(),
        )?;
    }

    let lock = builder
        .read(dirs.base.join("composer.lock"))
        .unwrap_or_default();
    let suffix = serde_json::from_slice::<Value>(&lock)
        .ok()
        .and_then(|l| {
            l.get("content-hash")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .filter(|h| !h.is_empty() && h.bytes().all(|b| b.is_ascii_hexdigit()))
        .unwrap_or_else(|| hex::encode(Md5::digest(&lock)));
    let to_real = find_shortest_path_code(&dirs.vendor, &composer_dir, true, false);
    builder.write(
        dirs.vendor.join("autoload.php"),
        autoload_file(&to_real, &suffix).as_bytes(),
    )?;
    builder.write(
        composer_dir.join("autoload_real.php"),
        autoload_real(&suffix, !files.is_empty()).as_bytes(),
    )?;
    Ok(report)
}

/// `array_merge_recursive` of two autoload objects.
fn merge_recursive(into: &mut Value, from: Value) {
    match (into, from) {
        (_, Value::Null) => {}
        (into @ Value::Null, from) => *into = from,
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                match a.get_mut(&k) {
                    Some(existing) => merge_recursive(existing, v),
                    None => {
                        a.insert(k, v);
                    }
                }
            }
        }
        (Value::Array(a), Value::Array(b)) => a.extend(b),
        (into, from) => {
            let mut list = match std::mem::take(into) {
                Value::Array(a) => a,
                other => vec![other],
            };
            match from {
                Value::Array(b) => list.extend(b),
                other => list.push(other),
            }
            *into = Value::Array(list);
        }
    }
}

/// A rule's paths: a string, or a list of them (or an object's values).
fn strings(v: &Value) -> Vec<String> {
    match v {
        Value::String(s) => vec![s.clone()],
        Value::Array(list) => list.iter().flat_map(strings).collect(),
        Value::Object(map) => map.values().flat_map(strings).collect(),
        _ => Vec::new(),
    }
}

/// `dir/path` normalised; an empty path is the directory itself.
fn join_rule(dir: &Path, path: &str) -> PathBuf {
    lexical(&dir.join(path.replace('\\', "/")))
}

/// `.` and `..` resolved without touching a file system.
fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::from("/");
    for c in path.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::Normal(p) => out.push(p),
            _ => {}
        }
    }
    out
}

/// PackageSorter::sortPackages: packages more depended on come first, ties
/// by name.
fn sort_packages(entries: Vec<Entry>) -> Vec<Entry> {
    let mut users: HashMap<String, Vec<String>> = HashMap::new();
    for e in &entries {
        for r in &e.requires {
            users.entry(r.clone()).or_default().push(e.name.clone());
        }
    }
    fn importance(
        name: &str,
        users: &HashMap<String, Vec<String>>,
        computing: &mut BTreeSet<String>,
        computed: &mut HashMap<String, i64>,
    ) -> i64 {
        if let Some(w) = computed.get(name) {
            return *w;
        }
        if !computing.insert(name.to_string()) {
            return 0;
        }
        let mut weight = 0;
        for user in users.get(name).into_iter().flatten() {
            weight -= 1 - importance(user, users, computing, computed);
        }
        computing.remove(name);
        computed.insert(name.to_string(), weight);
        weight
    }
    let mut computing = BTreeSet::new();
    let mut computed = HashMap::new();
    let mut weighted: Vec<(i64, Entry)> = entries
        .into_iter()
        .map(|e| {
            (
                importance(&e.name, &users, &mut computing, &mut computed),
                e,
            )
        })
        .collect();
    weighted.sort_by(|(wa, a), (wb, b)| {
        wa.cmp(wb)
            .then_with(|| natural_cmp(&a.name.to_lowercase(), &b.name.to_lowercase()))
    });
    weighted.into_iter().map(|(_, e)| e).collect()
}

/// `strnatcmp`: runs of digits compare as numbers.
fn natural_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (mut a, mut b) = (a.as_bytes(), b.as_bytes());
    loop {
        match (a.first(), b.first()) {
            (None, None) => return std::cmp::Ordering::Equal,
            (None, _) => return std::cmp::Ordering::Less,
            (_, None) => return std::cmp::Ordering::Greater,
            (Some(x), Some(y)) if x.is_ascii_digit() && y.is_ascii_digit() => {
                let na = a.iter().take_while(|c| c.is_ascii_digit()).count();
                let nb = b.iter().take_while(|c| c.is_ascii_digit()).count();
                let (da, db) = (
                    std::str::from_utf8(&a[..na])
                        .unwrap_or("0")
                        .trim_start_matches('0'),
                    std::str::from_utf8(&b[..nb])
                        .unwrap_or("0")
                        .trim_start_matches('0'),
                );
                let o = da.len().cmp(&db.len()).then_with(|| da.cmp(db));
                if o != std::cmp::Ordering::Equal {
                    return o;
                }
                a = &a[na..];
                b = &b[nb..];
            }
            (Some(x), Some(y)) => {
                if x != y {
                    return x.cmp(y);
                }
                a = &a[1..];
                b = &b[1..];
            }
        }
    }
}

/// An `exclude-from-classmap` rule: the directory it is relative to and its
/// pattern, `*` and `**` as Composer reads them.
fn exclusion(dir: &Path, pattern: &str) -> (PathBuf, String) {
    let mut pattern = pattern.replace('\\', "/").trim_matches('/').to_string();
    while pattern.contains("//") {
        pattern = pattern.replace("//", "/");
    }
    let mut base = dir.to_path_buf();
    while let Some(rest) = pattern.strip_prefix("../") {
        base.pop();
        pattern = rest.to_string();
    }
    while let Some(rest) = pattern.strip_prefix("./") {
        pattern = rest.to_string();
    }
    (base, pattern)
}

/// Whether Composer's exclusion regex `base/pattern($|/)` matches `file`.
fn excludes(base: &Path, pattern: &str, file: &Path) -> bool {
    let Ok(rest) = file.strip_prefix(base) else {
        return false;
    };
    let rest = rest.to_string_lossy();
    glob_prefix(pattern.as_bytes(), rest.as_bytes())
}

/// Whether `pattern` matches a prefix of `text` that ends at a `/` or at
/// the end: `**` is `.+?`, `*` is `[^/]+?`, anything else literal.
fn glob_prefix(pattern: &[u8], text: &[u8]) -> bool {
    match pattern {
        [] => text.is_empty() || text[0] == b'/',
        [b'*', b'*', rest @ ..] => (1..=text.len()).any(|i| glob_prefix(rest, &text[i..])),
        [b'*', rest @ ..] => (1..=text.len())
            .take_while(|&i| text[i - 1] != b'/')
            .any(|i| glob_prefix(rest, &text[i..])),
        [c, rest @ ..] => text.first() == Some(c) && glob_prefix(rest, &text[1..]),
    }
}

/// PHP code for paths in the generated lists: `$vendorDir . '/x'` inside
/// the vendor directory, `$baseDir . '/x'` elsewhere in the repository.
struct PathCode {
    vendor: PathBuf,
    base: PathBuf,
    vendor_dir: String,
    base_dir: String,
}

impl PathCode {
    fn new(dirs: &Dirs) -> Self {
        let composer_dir = dirs.vendor.join("composer");
        PathCode {
            vendor: dirs.vendor.clone(),
            base: dirs.base.clone(),
            vendor_dir: find_shortest_path_code(&composer_dir, &dirs.vendor, true, false),
            base_dir: find_shortest_path_code(&dirs.vendor, &dirs.base, true, false)
                .replace("__DIR__", "$vendorDir"),
        }
    }

    fn path(&self, path: &Path) -> String {
        let text = path.to_string_lossy();
        let vendor = self.vendor.to_string_lossy();
        let base = self.base.to_string_lossy();
        let (prefix, rest) = if let Some(rest) = text
            .strip_prefix(vendor.as_ref())
            .filter(|r| r.is_empty() || r.starts_with('/'))
        {
            ("$vendorDir . ", rest.to_string())
        } else if let Some(rest) = text
            .strip_prefix(base.as_ref())
            .filter(|r| r.is_empty() || r.starts_with('/'))
        {
            (
                "$baseDir . ",
                if rest.is_empty() {
                    "/".to_string()
                } else {
                    rest.to_string()
                },
            )
        } else {
            ("", text.into_owned())
        };
        let phar = if rest.contains(".phar/") || rest.ends_with(".phar") {
            "'phar://' . "
        } else {
            ""
        };
        format!("{phar}{prefix}{}", var_export(&rest))
    }
}

/// PHP's `var_export` of a string.
pub(crate) fn var_export(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn depth_below(common: &Path, path: &Path) -> usize {
    path.strip_prefix(common)
        .map_or(0, |r| r.components().count())
}

fn common_prefix(a: &Path, b: &Path) -> PathBuf {
    a.components()
        .zip(b.components())
        .take_while(|(x, y)| x == y)
        .map(|(x, _)| x)
        .collect()
}

/// Composer's `Filesystem::findShortestPathCode`: PHP code for `to`
/// relative to `from` (a directory when `directories`, else a file).
fn find_shortest_path_code(from: &Path, to: &Path, directories: bool, static_code: bool) -> String {
    if from == to {
        return if directories { "__DIR__" } else { "__FILE__" }.to_string();
    }
    let common = common_prefix(from, to);
    if let Ok(rest) = to.strip_prefix(from)
        && !rest.as_os_str().is_empty()
    {
        return format!(
            "__DIR__ . {}",
            var_export(&format!("/{}", rest.to_string_lossy()))
        );
    }
    // The file's own directory does not count when `from` is a file.
    let depth = depth_below(&common, from) - usize::from(!directories);
    let common_code = if static_code {
        format!("__DIR__ . '{}'", "/..".repeat(depth))
    } else {
        format!("{}__DIR__{}", "dirname(".repeat(depth), ")".repeat(depth))
    };
    let rest = to
        .strip_prefix(&common)
        .map(|r| r.to_string_lossy().into_owned())
        .unwrap_or_default();
    if rest.is_empty() {
        common_code
    } else {
        format!("{common_code}.{}", var_export(&format!("/{rest}")))
    }
}

/// Composer's `Filesystem::findShortestPath` from the file `from` to `to`.
fn find_shortest_path(from: &Path, to: &Path) -> String {
    if from.parent() == to.parent() {
        return format!("./{}", to.file_name().unwrap_or_default().to_string_lossy());
    }
    let common = common_prefix(from, to);
    let depth = depth_below(&common, from) - 1;
    let rest = to
        .strip_prefix(&common)
        .map(|r| r.to_string_lossy().into_owned())
        .unwrap_or_default();
    format!("{}{rest}", "../".repeat(depth))
}

fn autoload_file(to_composer_dir: &str, suffix: &str) -> String {
    // `__DIR__ . '/composer'` becomes `__DIR__ . '/composer/autoload_real.php'`.
    let path = match to_composer_dir.strip_suffix('\'') {
        Some(open) => format!("{open}/autoload_real.php'"),
        None => format!("{to_composer_dir} . '/autoload_real.php'"),
    };
    format!(
        r#"<?php

// autoload.php @generated by Composer

if (PHP_VERSION_ID < 50600) {{
    if (!headers_sent()) {{
        header('HTTP/1.1 500 Internal Server Error');
    }}
    $err = 'Composer 2.3.0 dropped support for autoloading on PHP <5.6 and you are running '.PHP_VERSION.', please upgrade PHP or use Composer 2.2 LTS via "composer self-update --2.2". Aborting.'.PHP_EOL;
    if (!ini_get('display_errors')) {{
        if (PHP_SAPI === 'cli' || PHP_SAPI === 'phpdbg') {{
            fwrite(STDERR, $err);
        }} elseif (!headers_sent()) {{
            echo $err;
        }}
    }}
    throw new RuntimeException($err);
}}

require_once {path};

return ComposerAutoloaderInit{suffix}::getLoader();
"#
    )
}

fn autoload_real(suffix: &str, include_files: bool) -> String {
    let files = if include_files {
        r#"        $filesToLoad = require __DIR__ . '/autoload_files.php';
        $requireFile = \Closure::bind(static function ($fileIdentifier, $file) {
            if (empty($GLOBALS['__composer_autoload_files'][$fileIdentifier])) {
                $GLOBALS['__composer_autoload_files'][$fileIdentifier] = true;

                require $file;
            }
        }, null, null);
        foreach ($filesToLoad as $fileIdentifier => $file) {
            $requireFile($fileIdentifier, $file);
        }

"#
    } else {
        ""
    };
    format!(
        r#"<?php

// autoload_real.php @generated by Composer (written by iwci from the lists beside it)

class ComposerAutoloaderInit{suffix}
{{
    private static $loader;

    public static function loadClassLoader($class)
    {{
        if ('Composer\Autoload\ClassLoader' === $class) {{
            require __DIR__ . '/ClassLoader.php';
        }}
    }}

    /**
     * @return \Composer\Autoload\ClassLoader
     */
    public static function getLoader()
    {{
        if (null !== self::$loader) {{
            return self::$loader;
        }}

        spl_autoload_register(array('ComposerAutoloaderInit{suffix}', 'loadClassLoader'), true, true);
        self::$loader = $loader = new \Composer\Autoload\ClassLoader(\dirname(__DIR__));
        spl_autoload_unregister(array('ComposerAutoloaderInit{suffix}', 'loadClassLoader'));

        $map = require __DIR__ . '/autoload_namespaces.php';
        foreach ($map as $namespace => $path) {{
            $loader->set($namespace, $path);
        }}

        $map = require __DIR__ . '/autoload_psr4.php';
        foreach ($map as $namespace => $path) {{
            $loader->setPsr4($namespace, $path);
        }}

        $classMap = require __DIR__ . '/autoload_classmap.php';
        if ($classMap) {{
            $loader->addClassMap($classMap);
        }}

        $loader->register(true);

{files}        return $loader;
    }}
}}
"#
    )
}

/// Composer's `VersionParser::normalize` for the versions a lock carries.
fn normalize_version(pretty: &str) -> String {
    let v = pretty.trim();
    if v.starts_with("dev-") {
        return v.to_string();
    }
    let v = v
        .strip_prefix(['v', 'V'])
        .filter(|r| r.starts_with(|c: char| c.is_ascii_digit()))
        .unwrap_or(v);
    let (v, _build) = v.split_once('+').unwrap_or((v, ""));
    let digits: String = v
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == 'x' || *c == '*')
        .collect();
    let rest = &v[digits.len()..];
    let mut parts: Vec<String> = digits
        .trim_end_matches('.')
        .split('.')
        .filter(|p| !p.is_empty())
        .map(|p| {
            if p == "x" || p == "*" {
                "9999999".to_string()
            } else {
                p.to_string()
            }
        })
        .collect();
    if parts.is_empty() || parts.len() > 4 || parts.iter().any(|p| p.parse::<u64>().is_err()) {
        return pretty.to_string();
    }
    let wildcard = digits.contains(['x', '*']);
    while parts.len() < 4 {
        parts.push(if wildcard {
            "9999999".to_string()
        } else {
            "0".to_string()
        });
    }
    let mut out = parts.join(".");
    let rest = rest.trim_start_matches(['-', '_', '.']);
    if rest.is_empty() {
        return out;
    }
    let lower = rest.to_ascii_lowercase();
    if lower == "dev" {
        return out + "-dev";
    }
    for (word, canonical) in [
        ("stable", ""),
        ("beta", "beta"),
        ("b", "beta"),
        ("rc", "RC"),
        ("alpha", "alpha"),
        ("a", "alpha"),
        ("patch", "patch"),
        ("pl", "patch"),
        ("p", "patch"),
    ] {
        if let Some(n) = lower.strip_prefix(word)
            && n.trim_start_matches(['.', '-'])
                .chars()
                .all(|c| c.is_ascii_digit() || c == '.' || c == '-')
            && !n.starts_with(|c: char| c.is_ascii_alphabetic())
        {
            if canonical.is_empty() {
                return out;
            }
            let (number, dev) = match n.strip_suffix("dev") {
                Some(n) => (n.trim_end_matches(['.', '-']), true),
                None => (n, false),
            };
            out = format!("{out}-{canonical}{}", number.trim_start_matches(['.', '-']));
            if dev {
                out.push_str("-dev");
            }
            return out;
        }
    }
    pretty.to_string()
}

/// `vendor/composer/installed.php`, which `Composer\InstalledVersions`
/// answers from.
pub(crate) fn installed_php(
    root: &Value,
    root_path: &str,
    packages: &[(&Package, Option<&str>)],
) -> String {
    let root_name = root
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("__root__");
    let root_pretty = root
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("1.0.0+no-version-set");
    let root_type = root
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("library");
    let entry = |pretty: &str,
                 reference: Option<&str>,
                 kind: &str,
                 path: Option<&str>,
                 last: (&str, bool)| {
        format!(
            "array(\n            'pretty_version' => {},\n            'version' => {},\n            'reference' => {},\n            'type' => {},\n            'install_path' => {},\n            'aliases' => array(),\n            '{}' => {},\n        )",
            var_export(pretty),
            var_export(&normalize_version(pretty)),
            reference.map_or("NULL".to_string(), var_export),
            var_export(kind),
            path.map_or("NULL".to_string(), |p| format!(
                "__DIR__ . {}",
                var_export(&format!("/{p}"))
            )),
            last.0,
            if last.1 { "true" } else { "false" },
        )
    };
    let mut versions: BTreeMap<String, String> = BTreeMap::new();
    versions.insert(
        root_name.to_string(),
        entry(
            root_pretty,
            None,
            root_type,
            Some(root_path),
            ("dev_requirement", false),
        ),
    );
    let mut virtual_: BTreeMap<String, (BTreeMap<&str, Vec<String>>, bool)> = BTreeMap::new();
    for (package, path) in packages {
        let raw = &package.raw;
        let reference = raw
            .get("source")
            .and_then(|s| s.get("reference"))
            .or_else(|| raw.get("dist").and_then(|d| d.get("reference")))
            .and_then(Value::as_str);
        let kind = raw.get("type").and_then(Value::as_str).unwrap_or("library");
        versions.insert(
            package.name.clone(),
            entry(
                &package.version,
                reference,
                kind,
                path.map(|p| p.trim_start_matches("../"))
                    .map(|p| format!("../{p}"))
                    .as_deref(),
                ("dev_requirement", package.dev),
            ),
        );
        for (key, label) in [("replace", "replaced"), ("provide", "provided")] {
            let Some(map) = raw.get(key).and_then(Value::as_object) else {
                continue;
            };
            for (target, constraint) in map {
                let constraint = constraint.as_str().unwrap_or("*");
                let constraint = if constraint == "self.version" {
                    package.version.as_str()
                } else {
                    constraint
                };
                let slot = virtual_
                    .entry(target.to_lowercase())
                    .or_insert_with(|| (BTreeMap::new(), true));
                slot.0
                    .entry(label)
                    .or_default()
                    .push(constraint.to_string());
                slot.1 &= package.dev;
            }
        }
    }
    for (name, (lists, dev)) in virtual_ {
        if versions.contains_key(&name) {
            continue;
        }
        let mut body = format!(
            "array(\n            'dev_requirement' => {},\n",
            if dev { "true" } else { "false" }
        );
        for (label, list) in lists {
            body.push_str(&format!("            '{label}' => array(\n"));
            for (i, c) in list.iter().enumerate() {
                body.push_str(&format!("                {i} => {},\n", var_export(c)));
            }
            body.push_str("            ),\n");
        }
        body.push_str("        )");
        versions.insert(name, body);
    }
    let root_entry = entry(root_pretty, None, root_type, Some(root_path), ("dev", true)).replace(
        "array(\n            'pretty_version'",
        &format!(
            "array(\n            'name' => {},\n            'pretty_version'",
            var_export(root_name)
        ),
    );
    let mut out = format!(
        "<?php return array(\n    'root' => {},\n    'versions' => array(\n",
        root_entry.replace("\n        ", "\n    ")
    );
    for (name, body) in versions {
        out.push_str(&format!("        {} => {},\n", var_export(&name), body));
    }
    out.push_str("    ),\n);\n");
    out
}

/// The `vendor/bin` file Composer's BinaryInstaller writes for a package's
/// bin: a PHP proxy that includes a PHP script, a shell one otherwise.
pub(crate) fn bin_proxy(link: &Path, target: &Path, vendor: &Path, head: &[u8]) -> String {
    let bin_path = find_shortest_path(link, target);
    let head = String::from_utf8_lossy(head);
    if let Some(shebang) = php_head(&head) {
        let caller = shebang.and_then(shebang_caller);
        let proxy_shebang = match (shebang, caller) {
            (Some(line), Some(c)) if is_php_interpreter(&c) => line.to_string(),
            _ => "#!/usr/bin/env php".to_string(),
        };
        let exported = find_shortest_path_code(link, target, false, true);
        let comment = bin_path.replace(['\r', '\n'], " ").replace("*/", "* /");
        let mut globals = String::from("$GLOBALS['_composer_bin_dir'] = __DIR__;\n");
        globals.push_str(&format!(
            "$GLOBALS['_composer_autoload_path'] = {};\n",
            find_shortest_path_code(link, &vendor.join("autoload.php"), false, true)
        ));
        let (mut hack1, mut hack2) = ("", String::new());
        if target == vendor.join("phpunit/phpunit/phpunit") {
            globals.push_str(&format!(
                "$GLOBALS['__PHPUNIT_ISOLATION_EXCLUDE_LIST'] = $GLOBALS['__PHPUNIT_ISOLATION_BLACKLIST'] = array(realpath({exported}));\n"
            ));
            hack1 = "'phpvfscomposer://'.";
            hack2 = "\n                $data = str_replace('__DIR__', var_export(dirname($this->realpath), true), $data);\n                $data = str_replace('__FILE__', var_export($this->realpath, true), $data);".to_string();
        }
        let (hint, stream) = if shebang.is_some() {
            (
                " using a stream wrapper to prevent the shebang from being output on PHP<8\n *",
                stream_proxy(hack1, &hack2, &exported),
            )
        } else {
            ("", String::new())
        };
        return format!(
            "{proxy_shebang}\n<?php\n\n/**\n * Proxy PHP file generated by Composer\n *\n * This file includes the referenced bin path ({comment})\n *{hint}\n * @generated\n */\n\nnamespace Composer;\n\n{globals}\n{stream}\nreturn include {exported};\n"
        );
    }
    let quote = |s: &str| format!("'{}'", s.replace('\'', "'\\''"));
    let (dir, file) = match bin_path.rsplit_once('/') {
        Some((d, f)) => (d.to_string(), f.to_string()),
        None => (".".to_string(), bin_path.clone()),
    };
    let (dir, file) = (quote(&dir), quote(&file));
    format!(
        r#"#!/usr/bin/env sh

# Support bash to support `source` with fallback on $0 if this does not run with bash
# https://stackoverflow.com/a/35006505/6512
selfArg="$BASH_SOURCE"
if [ -z "$selfArg" ]; then
    selfArg="$0"
fi

self=$(realpath "$selfArg" 2> /dev/null)
if [ -z "$self" ]; then
    self="$selfArg"
fi

dir=$(cd "${{self%[/\\]*}}" > /dev/null; cd {dir} && pwd)

if [ -d /proc/cygdrive ]; then
    case $(which php) in
        $(readlink -n /proc/cygdrive)/*)
            # We are in Cygwin using Windows php, so the path must be translated
            dir=$(cygpath -m "$dir");
            ;;
    esac
fi

export COMPOSER_RUNTIME_BIN_DIR="$(cd "${{self%[/\\]*}}" > /dev/null; pwd)"

# If bash is sourcing this file, we have to source the target as well
bashSource="$BASH_SOURCE"
if [ -n "$bashSource" ]; then
    if [ "$bashSource" != "$0" ]; then
        source "${{dir}}/"{file} "$@"
        return
    fi
fi

exec "${{dir}}/"{file} "$@"
"#
    )
}

/// `^(#!.*\r?\n)?[\r\n\t ]*<\?php`: `Some(shebang line)` for a PHP script.
fn php_head(head: &str) -> Option<Option<&str>> {
    let (shebang, rest) = if head.starts_with("#!") {
        let end = head.find('\n')?;
        (
            Some(head[..end].trim_end_matches([' ', '\t', '\r'])),
            &head[end + 1..],
        )
    } else {
        (None, head)
    };
    rest.trim_start_matches(['\r', '\n', '\t', ' '])
        .starts_with("<?php")
        .then_some(shebang)
}

fn shebang_caller(shebang: &str) -> Option<String> {
    let rest = shebang.strip_prefix("#!")?;
    // `(?:/[a-zA-Z0-9_.+-]+)*/` then the command and its arguments.
    let (path, args) = match rest.find([' ', '\t']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    let command = path.rsplit('/').next()?;
    if !path.starts_with('/') || command.is_empty() {
        return None;
    }
    let caller = format!("{command}{args}");
    let caller = caller
        .strip_prefix("env")
        .filter(|r| r.starts_with([' ', '\t']))
        .map(|r| {
            let r = r.trim_start();
            r.strip_prefix("-S").map_or(r, str::trim_start).to_string()
        })
        .unwrap_or(caller);
    (!caller.is_empty() && caller != "env").then_some(caller)
}

fn is_php_interpreter(caller: &str) -> bool {
    caller.strip_prefix("php").is_some_and(|r| {
        let r = r.trim_start_matches(|c: char| c.is_ascii_digit() || c == '.');
        r.is_empty() || r.starts_with([' ', '\t'])
    })
}

fn stream_proxy(hack1: &str, hack2: &str, exported: &str) -> String {
    format!(
        r#"if (PHP_VERSION_ID < 80000) {{
    if (!class_exists('Composer\BinProxyWrapper')) {{
        /**
         * @internal
         */
        final class BinProxyWrapper
        {{
            private $handle;
            private $position;
            private $realpath;

            public function stream_open($path, $mode, $options, &$opened_path)
            {{
                // get rid of phpvfscomposer:// prefix for __FILE__ & __DIR__ resolution
                $opened_path = substr($path, 17);
                $this->realpath = realpath($opened_path) ?: $opened_path;
                $opened_path = {hack1}$this->realpath;
                $this->handle = fopen($this->realpath, $mode);
                $this->position = 0;

                return (bool) $this->handle;
            }}

            public function stream_read($count)
            {{
                $data = fread($this->handle, $count);

                if ($this->position === 0) {{
                    $data = preg_replace('{{^#!.*\r?\n}}', '', $data);
                }}{hack2}

                $this->position += strlen($data);

                return $data;
            }}

            public function stream_cast($castAs)
            {{
                return $this->handle;
            }}

            public function stream_close()
            {{
                fclose($this->handle);
            }}

            public function stream_lock($operation)
            {{
                return $operation ? flock($this->handle, $operation) : true;
            }}

            public function stream_seek($offset, $whence)
            {{
                if (0 === fseek($this->handle, $offset, $whence)) {{
                    $this->position = ftell($this->handle);
                    return true;
                }}

                return false;
            }}

            public function stream_tell()
            {{
                return $this->position;
            }}

            public function stream_eof()
            {{
                return feof($this->handle);
            }}

            public function stream_stat()
            {{
                return array();
            }}

            public function stream_set_option($option, $arg1, $arg2)
            {{
                return true;
            }}

            public function url_stat($path, $flags)
            {{
                $path = substr($path, 17);
                if (file_exists($path)) {{
                    return stat($path);
                }}

                return false;
            }}
        }}
    }}

    if (
        (function_exists('stream_get_wrappers') && in_array('phpvfscomposer', stream_get_wrappers(), true))
        || (function_exists('stream_wrapper_register') && stream_wrapper_register('phpvfscomposer', 'Composer\BinProxyWrapper'))
    ) {{
        return include("phpvfscomposer://" . {exported});
    }}
}}
"#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_code() {
        let p = |s: &str| PathBuf::from(s);
        assert_eq!(
            find_shortest_path_code(&p("/app/vendor/composer"), &p("/app/vendor"), true, false),
            "dirname(__DIR__)"
        );
        assert_eq!(
            find_shortest_path_code(&p("/app/vendor"), &p("/app"), true, false),
            "dirname(__DIR__)"
        );
        assert_eq!(
            find_shortest_path_code(&p("/app/vendor"), &p("/app/vendor/composer"), true, false),
            "__DIR__ . '/composer'"
        );
        assert_eq!(
            find_shortest_path_code(
                &p("/app/vendor/bin/phpunit"),
                &p("/app/vendor/phpunit/phpunit/phpunit"),
                false,
                true
            ),
            "__DIR__ . '/..'.'/phpunit/phpunit/phpunit'"
        );
        assert_eq!(
            find_shortest_path_code(
                &p("/app/vendor/bin/phpunit"),
                &p("/app/vendor/autoload.php"),
                false,
                true
            ),
            "__DIR__ . '/..'.'/autoload.php'"
        );
        assert_eq!(
            find_shortest_path(
                &p("/app/vendor/bin/phpunit"),
                &p("/app/vendor/phpunit/phpunit/phpunit")
            ),
            "../phpunit/phpunit/phpunit"
        );
        assert!(
            autoload_file("__DIR__ . '/composer'", "abc")
                .contains("require_once __DIR__ . '/composer/autoload_real.php';")
        );
    }

    #[test]
    fn versions() {
        assert_eq!(normalize_version("11.5.3"), "11.5.3.0");
        assert_eq!(normalize_version("v1.2"), "1.2.0.0");
        assert_eq!(normalize_version("1.0.0-beta1"), "1.0.0.0-beta1");
        assert_eq!(normalize_version("2.0.0-RC2"), "2.0.0.0-RC2");
        assert_eq!(normalize_version("dev-main"), "dev-main");
        assert_eq!(
            normalize_version("1.x-dev"),
            "1.9999999.9999999.9999999-dev"
        );
    }

    #[test]
    fn exclusions_and_order() {
        let (base, pattern) = exclusion(Path::new("/v/p"), "/Tests/");
        assert!(excludes(&base, &pattern, Path::new("/v/p/Tests/A.php")));
        assert!(!excludes(&base, &pattern, Path::new("/v/p/TestsX/A.php")));
        let (base, pattern) = exclusion(Path::new("/v/p"), "src/**/Fixtures");
        assert!(excludes(
            &base,
            &pattern,
            Path::new("/v/p/src/a/b/Fixtures/x.php")
        ));
        let (base, pattern) = exclusion(Path::new("/v/p"), "src/*Test.php");
        assert!(excludes(&base, &pattern, Path::new("/v/p/src/FooTest.php")));
        assert!(!excludes(
            &base,
            &pattern,
            Path::new("/v/p/src/a/FooTest.php")
        ));
        assert_eq!(natural_cmp("a2", "a10"), std::cmp::Ordering::Less);
        let e = |name: &str, requires: &[&str]| Entry {
            name: name.into(),
            autoload: Value::Null,
            dir: PathBuf::from("/"),
            requires: requires.iter().map(|s| s.to_string()).collect(),
        };
        let sorted = sort_packages(vec![
            e("a/top", &["c/base", "b/mid"]),
            e("b/mid", &["c/base"]),
            e("c/base", &[]),
        ]);
        let names: Vec<&str> = sorted.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["c/base", "b/mid", "a/top"]);
    }
}
