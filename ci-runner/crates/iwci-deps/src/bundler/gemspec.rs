//! A gem's specification: read from the YAML in its `metadata.gz`, and
//! written back as the Ruby RubyGems puts in `specifications/` when it
//! installs a gem (`Gem::Specification#to_ruby_for_cache`).
//!
//! The YAML is Psych's dump of a `Gem::Specification`, with Ruby's own
//! tags on it:
//!
//! ```yaml
//! --- !ruby/object:Gem::Specification
//! name: rspec-core
//! version: !ruby/object:Gem::Version
//!   version: 3.13.7
//! dependencies:
//! - !ruby/object:Gem::Dependency
//!   name: rspec-support
//!   requirement: !ruby/object:Gem::Requirement
//!     requirements:
//!     - - "~>"
//!       - !ruby/object:Gem::Version
//!         version: 3.13.0
//!   type: :runtime
//! ```
//!
//! RubyGems loads it with `Psych.safe_load`, permitting only those classes
//! (and `Time`, `Date`, `Symbol`), so any other tag is refused here too.
//! Nothing in it is evaluated.

use base64::Engine;
use serde_yaml_ng::Value;

/// A Ruby value, as much of Ruby as a gemspec's YAML can hold.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum RValue {
    Nil,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(Vec<u8>),
    Array(Vec<RValue>),
    Hash(Vec<(RValue, RValue)>),
    Version(String),
    Requirement(Vec<(String, String)>),
    /// `Time` or `Date`, as its text.
    Time(String),
}

impl RValue {
    fn is_empty_array(&self) -> bool {
        matches!(self, RValue::Array(a) if a.is_empty())
    }

    /// The text of a string, or `None`.
    pub(crate) fn text(&self) -> Option<String> {
        match self {
            RValue::Str(s) => Some(String::from_utf8_lossy(s).into_owned()),
            _ => None,
        }
    }

    /// The strings of an array, a lone string as a list of one, or an
    /// empty list.
    pub(crate) fn texts(&self) -> Vec<String> {
        match self {
            RValue::Array(items) => items.iter().filter_map(RValue::text).collect(),
            RValue::Str(_) => self.text().into_iter().collect(),
            _ => Vec::new(),
        }
    }

    /// Ruby's `to_s`, for a hash value.
    fn to_s(&self) -> Vec<u8> {
        match self {
            RValue::Nil => Vec::new(),
            RValue::Bool(b) => b.to_string().into_bytes(),
            RValue::Int(i) => i.to_string().into_bytes(),
            RValue::Float(f) => float_inspect(*f).into_bytes(),
            RValue::Str(s) => s.clone(),
            RValue::Version(v) | RValue::Time(v) => v.clone().into_bytes(),
            RValue::Requirement(r) => as_list(r).join(", ").into_bytes(),
            RValue::Array(_) | RValue::Hash(_) => ruby_code(self).into_bytes(),
        }
    }
}

/// One `Gem::Dependency` of the specification.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Dependency {
    pub name: String,
    pub requirement: Vec<(String, String)>,
    /// `runtime` or `development`.
    pub kind: String,
}

/// A gem's specification, with each attribute as RubyGems holds it after
/// `Gem::Specification.from_yaml`.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Gemspec {
    pub name: String,
    pub version: String,
    pub platform: String,
    /// Every other attribute, by name, as the YAML has it.
    attributes: Vec<(String, RValue)>,
    pub dependencies: Vec<Dependency>,
}

/// `Gem::Specification`'s attributes in the order `to_ruby` visits them
/// (sorted by name), with their defaults. `None` is a default of `nil`.
const ATTRIBUTES: &[&str] = &[
    "authors",
    "autorequire",
    "bindir",
    "cert_chain",
    "date",
    "dependencies",
    "description",
    "email",
    "executables",
    "extensions",
    "extra_rdoc_files",
    "files",
    "homepage",
    "licenses",
    "metadata",
    "name",
    "platform",
    "post_install_message",
    "rdoc_options",
    "require_paths",
    "required_ruby_version",
    "required_rubygems_version",
    "requirements",
    "rubygems_version",
    "signing_key",
    "specification_version",
    "summary",
    "test_files",
    "version",
];

/// What `to_ruby` writes on lines of their own, or not at all.
const HANDLED: &[&str] = &[
    "dependencies",
    "name",
    "platform",
    "require_paths",
    "required_rubygems_version",
    "specification_version",
    "version",
    "metadata",
    "signing_key",
];

/// Written even when they hold their default.
const REQUIRED: &[&str] = &[
    "rubygems_version",
    "specification_version",
    "name",
    "version",
    "date",
    "summary",
    "require_paths",
];

fn default_of(name: &str) -> RValue {
    match name {
        "authors" | "cert_chain" | "dependencies" | "executables" | "extensions"
        | "extra_rdoc_files" | "files" | "licenses" | "rdoc_options" | "requirements"
        | "test_files" => RValue::Array(Vec::new()),
        "bindir" => RValue::Str(b"bin".to_vec()),
        "metadata" => RValue::Hash(Vec::new()),
        "platform" => RValue::Str(b"ruby".to_vec()),
        "require_paths" => RValue::Array(vec![RValue::Str(b"lib".to_vec())]),
        "required_ruby_version" | "required_rubygems_version" => {
            RValue::Requirement(vec![(">=".to_string(), "0".to_string())])
        }
        _ => RValue::Nil,
    }
}

/// Attributes RubyGems resets to their default when the YAML has `nil`
/// (`reset_nil_attributes_to_default`).
fn non_nil(name: &str) -> bool {
    !matches!(default_of(name), RValue::Nil)
        || matches!(name, "rubygems_version" | "specification_version")
}

impl Gemspec {
    /// Reads a gem's `metadata` (YAML).
    pub(crate) fn from_yaml(text: &str) -> Result<Gemspec, String> {
        let value: Value =
            serde_yaml_ng::from_str(text).map_err(|e| format!("metadata is not YAML: {e}"))?;
        let Value::Tagged(tagged) = value else {
            return Err("metadata is not a Gem::Specification".to_string());
        };
        if tag_name(&tagged.tag) != "ruby/object:Gem::Specification" {
            return Err(format!(
                "metadata is a {}, not a Gem::Specification",
                tagged.tag
            ));
        }
        let Value::Mapping(map) = tagged.value else {
            return Err("metadata is not a Gem::Specification".to_string());
        };
        let mut attributes = Vec::new();
        let mut dependencies = Vec::new();
        let mut name = None;
        let mut version = None;
        let mut platform = None;
        for (key, value) in map {
            let Some(key) = key.as_str() else { continue };
            match key {
                "name" => name = convert(&value)?.text(),
                "version" => {
                    version = match convert(&value)? {
                        RValue::Version(v) => Some(v),
                        other => other.text(),
                    }
                }
                "platform" => platform = convert(&value)?.text(),
                "dependencies" => {
                    if let Value::Sequence(list) = &value {
                        for dep in list {
                            dependencies.push(dependency(dep)?);
                        }
                    }
                }
                _ => attributes.push((key.to_string(), convert(&value)?)),
            }
        }
        let name = name.ok_or("metadata has no name")?;
        let version = version.ok_or("metadata has no version")?;
        // `original_platform` is what a gem built for a platform keeps;
        // only `ruby` gems are installed here, which have none.
        let platform = platform.unwrap_or_else(|| "ruby".to_string());
        Ok(Gemspec {
            name,
            version,
            platform,
            attributes,
            dependencies,
        })
    }

    /// An attribute after `from_yaml`: its YAML value, or its default when
    /// the YAML has none (or `nil`, for the attributes RubyGems resets).
    pub(crate) fn get(&self, name: &str) -> RValue {
        let value = self
            .attributes
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.clone());
        match value {
            Some(RValue::Nil) | None if non_nil(name) => match name {
                "rubygems_version" => RValue::Nil,
                "specification_version" => RValue::Int(-1),
                _ => default_of(name),
            },
            Some(v) => v,
            None => RValue::Nil,
        }
    }

    pub(crate) fn full_name(&self) -> String {
        if self.platform == "ruby" {
            format!("{}-{}", self.name, self.version)
        } else {
            format!("{}-{}-{}", self.name, self.version, self.platform)
        }
    }

    pub(crate) fn bindir(&self) -> String {
        self.get("bindir")
            .text()
            .unwrap_or_else(|| "bin".to_string())
    }

    pub(crate) fn executables(&self) -> Vec<String> {
        self.get("executables").texts()
    }

    pub(crate) fn extensions(&self) -> Vec<String> {
        self.get("extensions").texts()
    }

    pub(crate) fn require_paths(&self) -> Vec<String> {
        flatten(&self.get("require_paths"))
    }

    /// The Ruby RubyGems writes to `specifications/<full name>.gemspec`:
    /// `to_ruby_for_cache` once `installed_by_version` is set, which is
    /// `to_ruby` with `files` and `test_files` emptied. `rubygems` is the
    /// version of the RubyGems doing the install (`Gem::VERSION`).
    pub(crate) fn to_ruby_for_cache(&self, rubygems: &str) -> Vec<u8> {
        let mut out: Vec<Vec<u8>> = Vec::new();
        let line = |s: String| s.into_bytes();
        let require_paths = self.require_paths();
        out.push(line("# -*- encoding: utf-8 -*-".to_string()));
        out.push(line(format!(
            "# stub: {} {} {} {}",
            self.name,
            self.version,
            self.platform,
            require_paths.join("\0")
        )));
        let extensions = self.extensions();
        if !extensions.is_empty() {
            out.push(line(format!("# stub: {}", extensions.join("\0"))));
        }
        out.push(Vec::new());
        out.push(line("Gem::Specification.new do |s|".to_string()));
        out.push(line(format!(
            "  s.name = {}",
            ruby_code(&RValue::Str(self.name.clone().into_bytes()))
        )));
        out.push(line(format!(
            "  s.version = {}",
            ruby_code(&RValue::Str(self.version.clone().into_bytes()))
        )));
        out.push(Vec::new());
        out.push(line(format!(
            "  s.required_rubygems_version = {} if s.respond_to? :required_rubygems_version=",
            ruby_code(&self.get("required_rubygems_version"))
        )));
        let metadata = self.get("metadata");
        if matches!(&metadata, RValue::Hash(h) if !h.is_empty()) {
            out.push(line(format!(
                "  s.metadata = {} if s.respond_to? :metadata=",
                ruby_code(&metadata)
            )));
        }
        out.push(line(format!(
            "  s.require_paths = {}",
            ruby_code(&self.get("require_paths"))
        )));
        for &attr in ATTRIBUTES {
            if HANDLED.contains(&attr) {
                continue;
            }
            let value = match attr {
                "files" => self.cached_files(),
                "test_files" => RValue::Array(Vec::new()),
                "date" => RValue::Time(date_of(&self.get("date"))),
                // Reset to the installing RubyGems' own when the YAML has
                // none.
                "rubygems_version" => match self.get(attr) {
                    RValue::Nil => RValue::Str(rubygems.as_bytes().to_vec()),
                    v => v,
                },
                other => self.get(other),
            };
            if !same(&value, &default_of(attr)) || REQUIRED.contains(&attr) {
                out.push(line(format!("  s.{attr} = {}", ruby_code(&value))));
            }
        }
        if let RValue::Str(key) = self.get("signing_key") {
            out.push(line(format!(
                "  s.signing_key = {}",
                ruby_code(&RValue::Str(key))
            )));
        }
        out.push(Vec::new());
        out.push(line(format!(
            "  s.installed_by_version = {}",
            ruby_code(&RValue::Str(rubygems.as_bytes().to_vec()))
        )));
        if !self.dependencies.is_empty() {
            out.push(Vec::new());
            let version = match self.get("specification_version") {
                RValue::Int(i) => i.to_string(),
                other => String::from_utf8_lossy(&other.to_s()).into_owned(),
            };
            out.push(line(format!("  s.specification_version = {version}")));
            out.push(Vec::new());
            for dep in &self.dependencies {
                let list = RValue::Array(
                    as_list(&dep.requirement)
                        .into_iter()
                        .map(|r| RValue::Str(r.into_bytes()))
                        .collect(),
                );
                out.push(line(format!(
                    "  s.add_{}_dependency(%q<{}>.freeze, {})",
                    dep.kind,
                    dep.name,
                    ruby_code(&list)
                )));
            }
        }
        out.push(line("end".to_string()));
        out.push(Vec::new());
        out.join(&b'\n')
    }

    /// `files` once `for_cache` has emptied the list: what the getter adds
    /// back, the executables (under `bindir`), `extra_rdoc_files` and
    /// `extensions`, without repeats and sorted.
    fn cached_files(&self) -> RValue {
        let bindir = self.bindir();
        let mut files: Vec<Vec<u8>> = self
            .executables()
            .into_iter()
            .map(|e| file_join(&bindir, &e).into_bytes())
            .collect();
        for name in ["extra_rdoc_files", "extensions"] {
            files.extend(flatten(&self.get(name)).into_iter().map(String::into_bytes));
        }
        files.sort();
        files.dedup();
        RValue::Array(files.into_iter().map(RValue::Str).collect())
    }
}

/// Ruby's `File.join` of two parts.
fn file_join(a: &str, b: &str) -> String {
    if a.is_empty() {
        return b.to_string();
    }
    format!("{}/{}", a.trim_end_matches('/'), b.trim_start_matches('/'))
}

/// The strings of a possibly nested array, flattened.
fn flatten(value: &RValue) -> Vec<String> {
    match value {
        RValue::Array(items) => items.iter().flat_map(flatten).collect(),
        RValue::Nil => Vec::new(),
        other => other.text().into_iter().collect(),
    }
}

/// `YYYY-MM-DD` of a gemspec's date: the date part of the timestamp, as
/// `date=` keeps it. A missing or unreadable one is left as it came.
fn date_of(value: &RValue) -> String {
    let text = match value {
        RValue::Time(t) => t.clone(),
        other => other.text().unwrap_or_default(),
    };
    let date: String = text.chars().take(10).collect();
    let b = date.as_bytes();
    if b.len() == 10 && b[4] == b'-' && b[7] == b'-' {
        date
    } else {
        text
    }
}

/// Ruby `==` between an attribute's value and its default, as far as the
/// two kinds of value that can differ in form and still be equal go.
fn same(a: &RValue, b: &RValue) -> bool {
    match (a, b) {
        (RValue::Requirement(x), RValue::Requirement(y)) => {
            let key = |r: &[(String, String)]| {
                let mut k: Vec<(String, Vec<String>)> = r
                    .iter()
                    .map(|(op, v)| (op.clone(), canonical_version(v)))
                    .collect();
                k.sort();
                k
            };
            key(x) == key(y)
        }
        (RValue::Array(x), RValue::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        _ => a == b || a.is_empty_array() && b.is_empty_array(),
    }
}

/// A version's segments with trailing zeros dropped: how `Gem::Version`
/// compares, so `0` and `0.0` are equal.
fn canonical_version(v: &str) -> Vec<String> {
    let mut parts: Vec<String> = v.split('.').map(str::to_string).collect();
    while parts.len() > 1 && parts.last().is_some_and(|p| p.parse::<u64>() == Ok(0)) {
        parts.pop();
    }
    if parts.len() == 1 && parts[0].parse::<u64>() == Ok(0) {
        parts[0] = "0".to_string();
    }
    parts
}

/// `Gem::Requirement#as_list`.
fn as_list(requirement: &[(String, String)]) -> Vec<String> {
    requirement
        .iter()
        .map(|(op, version)| format!("{op} {version}"))
        .collect()
}

/// `Gem::Specification#ruby_code`.
pub(crate) fn ruby_code(value: &RValue) -> String {
    match value {
        RValue::Str(s) => format!("{}.freeze", dump(s)),
        RValue::Array(items) => format!(
            "[{}]",
            items.iter().map(ruby_code).collect::<Vec<_>>().join(", ")
        ),
        RValue::Hash(pairs) => {
            let mut pairs: Vec<(Vec<u8>, Vec<u8>)> =
                pairs.iter().map(|(k, v)| (k.to_s(), v.to_s())).collect();
            pairs.sort_by(|a, b| a.0.cmp(&b.0));
            let segments: Vec<String> = pairs
                .iter()
                .map(|(k, v)| format!("{} => {}", dump(k), dump(v)))
                .collect();
            format!("{{ {} }}", segments.join(", "))
        }
        RValue::Version(v) => ruby_code(&RValue::Str(v.clone().into_bytes())),
        RValue::Time(t) => dump(date_of(&RValue::Time(t.clone())).as_bytes()),
        RValue::Int(i) => i.to_string(),
        RValue::Float(f) => float_inspect(*f),
        RValue::Bool(b) => b.to_string(),
        RValue::Nil => "nil".to_string(),
        RValue::Requirement(r) => {
            let list = as_list(r);
            let inner = if list.len() == 1 {
                RValue::Str(list[0].clone().into_bytes())
            } else {
                RValue::Array(
                    list.into_iter()
                        .map(|s| RValue::Str(s.into_bytes()))
                        .collect(),
                )
            };
            format!("Gem::Requirement.new({})", ruby_code(&inner))
        }
    }
}

fn float_inspect(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e16 {
        format!("{f:.1}")
    } else {
        f.to_string()
    }
}

/// Ruby's `String#dump` for a UTF-8 string (or, when `bytes` is not UTF-8,
/// a binary one): printable ASCII as it is, the usual escapes, `#` before
/// `{`, `$` or `@` escaped so it cannot interpolate, other characters as
/// `\u` escapes and stray bytes as `\x`.
pub(crate) fn dump(bytes: &[u8]) -> String {
    let utf8 = std::str::from_utf8(bytes).ok();
    let mut out = String::with_capacity(bytes.len() + 2);
    out.push('"');
    let push_ascii = |out: &mut String, b: u8, next: Option<u8>| match b {
        b'"' => out.push_str("\\\""),
        b'\\' => out.push_str("\\\\"),
        b'\n' => out.push_str("\\n"),
        b'\r' => out.push_str("\\r"),
        b'\t' => out.push_str("\\t"),
        0x0c => out.push_str("\\f"),
        0x0b => out.push_str("\\v"),
        0x08 => out.push_str("\\b"),
        0x07 => out.push_str("\\a"),
        0x1b => out.push_str("\\e"),
        b'#' if matches!(next, Some(b'{' | b'$' | b'@')) => out.push_str("\\#"),
        0x20..=0x7e => out.push(b as char),
        _ => out.push_str(&format!("\\x{b:02X}")),
    };
    match utf8 {
        Some(text) => {
            let mut chars = text.chars().peekable();
            while let Some(c) = chars.next() {
                let next = chars.peek().and_then(|n| u8::try_from(*n as u32).ok());
                if c.is_ascii() {
                    push_ascii(&mut out, c as u8, next);
                } else if (c as u32) > 0xFFFF {
                    out.push_str(&format!("\\u{{{:X}}}", c as u32));
                } else {
                    out.push_str(&format!("\\u{:04X}", c as u32));
                }
            }
        }
        None => {
            for (i, &b) in bytes.iter().enumerate() {
                if b >= 0x80 {
                    out.push_str(&format!("\\x{b:02X}"));
                } else {
                    push_ascii(&mut out, b, bytes.get(i + 1).copied());
                }
            }
        }
    }
    out.push('"');
    out
}

fn tag_name(tag: &serde_yaml_ng::value::Tag) -> String {
    tag.to_string().trim_start_matches('!').to_string()
}

/// A YAML value as the Ruby object Psych would load, refusing any class
/// RubyGems does not permit.
fn convert(value: &Value) -> Result<RValue, String> {
    Ok(match value {
        Value::Null => RValue::Nil,
        Value::Bool(b) => RValue::Bool(*b),
        Value::Number(n) => match n.as_i64() {
            Some(i) => RValue::Int(i),
            None => RValue::Float(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => {
            // Psych reads an unquoted timestamp as a `Time`; only `date`
            // holds one, and it is written the same either way.
            RValue::Str(s.clone().into_bytes())
        }
        Value::Sequence(items) => {
            RValue::Array(items.iter().map(convert).collect::<Result<_, _>>()?)
        }
        Value::Mapping(map) => RValue::Hash(
            map.iter()
                .map(|(k, v)| Ok((convert(k)?, convert(v)?)))
                .collect::<Result<_, String>>()?,
        ),
        Value::Tagged(tagged) => {
            let tag = tag_name(&tagged.tag);
            let field = |name: &str| match &tagged.value {
                Value::Mapping(map) => map.get(name).cloned(),
                _ => None,
            };
            match tag.as_str() {
                "ruby/object:Gem::Version" => {
                    RValue::Version(version_text(&field("version").unwrap_or(Value::Null)))
                }
                "ruby/object:Gem::Requirement" | "ruby/object:Gem::Version::Requirement" => {
                    RValue::Requirement(requirement(&field("requirements").unwrap_or(Value::Null))?)
                }
                // An old gem built for a platform: `cpu-os-version`, which
                // is never `ruby`, so the gem is refused as not the build
                // the lock names.
                "ruby/object:Gem::Platform" => {
                    let parts: Vec<String> = ["cpu", "os", "version"]
                        .iter()
                        .filter_map(|k| field(k).and_then(|v| v.as_str().map(str::to_string)))
                        .collect();
                    RValue::Str(parts.join("-").into_bytes())
                }
                "binary" | "tag:yaml.org,2002:binary" => {
                    let text = tagged
                        .value
                        .as_str()
                        .ok_or("a !binary value that is not a string")?;
                    let compact: String = text.chars().filter(|c| !c.is_whitespace()).collect();
                    RValue::Str(
                        base64::engine::general_purpose::STANDARD
                            .decode(compact)
                            .map_err(|e| format!("a !binary value that is not base64: {e}"))?,
                    )
                }
                "ruby/sym" | "ruby/symbol" => {
                    RValue::Str(tagged.value.as_str().unwrap_or("").as_bytes().to_vec())
                }
                "timestamp" => RValue::Time(tagged.value.as_str().unwrap_or("").to_string()),
                _ => {
                    return Err(format!(
                        "metadata holds a !{tag}, which RubyGems does not load"
                    ));
                }
            }
        }
    })
}

fn version_text(value: &Value) -> String {
    match value {
        Value::String(s) => s.trim().to_string(),
        Value::Number(n) => n.to_string(),
        Value::Null => "0".to_string(),
        _ => String::new(),
    }
}

/// `requirements:` of a `Gem::Requirement`: a list of `[op, version]`.
fn requirement(value: &Value) -> Result<Vec<(String, String)>, String> {
    let Value::Sequence(list) = value else {
        return Ok(vec![(">=".to_string(), "0".to_string())]);
    };
    let mut out = Vec::new();
    for pair in list {
        let Value::Sequence(pair) = pair else {
            return Err("a requirement that is not [op, version]".to_string());
        };
        let op = pair
            .first()
            .and_then(Value::as_str)
            .unwrap_or("=")
            .to_string();
        let version = match pair.get(1) {
            Some(Value::Tagged(t)) if tag_name(&t.tag) == "ruby/object:Gem::Version" => {
                version_text(match &t.value {
                    Value::Mapping(map) => map.get("version").unwrap_or(&Value::Null),
                    other => other,
                })
            }
            Some(other) => version_text(other),
            None => "0".to_string(),
        };
        out.push((op, version));
    }
    Ok(out)
}

/// One `!ruby/object:Gem::Dependency`. Old gems name the requirement
/// `version_requirements`; RubyGems falls back on it, and so does this.
fn dependency(value: &Value) -> Result<Dependency, String> {
    let Value::Tagged(tagged) = value else {
        return Err("a dependency that is not a Gem::Dependency".to_string());
    };
    if tag_name(&tagged.tag) != "ruby/object:Gem::Dependency" {
        return Err(format!("a dependency that is a {}", tagged.tag));
    }
    let Value::Mapping(map) = &tagged.value else {
        return Err("a dependency that is not a mapping".to_string());
    };
    let name = map
        .get("name")
        .and_then(Value::as_str)
        .ok_or("a dependency without a name")?
        .to_string();
    let requirement = match map
        .get("requirement")
        .filter(|v| !v.is_null())
        .or_else(|| map.get("version_requirements"))
    {
        Some(v) => match convert(v)? {
            RValue::Requirement(r) => r,
            _ => vec![(">=".to_string(), "0".to_string())],
        },
        None => vec![(">=".to_string(), "0".to_string())],
    };
    let kind = match map.get("type") {
        Some(Value::String(s)) => s.trim_start_matches(':').to_string(),
        Some(Value::Tagged(t)) => t.value.as_str().unwrap_or("runtime").to_string(),
        _ => "runtime".to_string(),
    };
    if kind != "runtime" && kind != "development" {
        return Err(format!("{name}: a dependency of type {kind:?}"));
    }
    Ok(Dependency {
        name,
        requirement,
        kind,
    })
}
