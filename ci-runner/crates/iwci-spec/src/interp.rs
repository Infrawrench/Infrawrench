//! `${{ ... }}` substitution. An expression here is a single name (no
//! operators: those belong in `if:`), and every name is checked when the
//! file is parsed, so a typo is an error at push time rather than an empty
//! string at run time.
//!
//! `needs.<job>.outputs.<name>` and `needs.<job>.result` only exist once
//! that job has run. While parsing, [`Scope::needs`] is `None`: the
//! reference is validated, a placeholder is substituted, and
//! [`Scope::deferred`] records that the job has to be expanded again when
//! its needs finish.

use std::cell::Cell;
use std::collections::HashMap;

use crate::expr::{self, Name};
use crate::{Context, JobDecl, NeedsValues};

#[derive(Clone, Copy)]
pub(crate) enum MatrixScope<'a> {
    None,
    /// The list shorthand: `${{ matrix }}`.
    List(&'a str),
    /// Named axes: `${{ matrix.<axis> }}`.
    Axes(&'a [(String, String)]),
    /// A matrix that comes from another job's output, not known yet: either
    /// form is accepted now and checked when it is expanded.
    Pending,
}

pub(crate) struct Scope<'a> {
    pub ctx: &'a Context,
    pub matrix: MatrixScope<'a>,
    /// The job's own `needs:`.
    pub needs_list: &'a [String],
    pub decls: &'a HashMap<String, JobDecl>,
    pub needs: Option<&'a NeedsValues>,
    pub deferred: Cell<bool>,
    /// Set while substituting a cache key: `hashFiles()` is only meaningful
    /// there, and is left in place for the run to fill in.
    pub hash_files: Cell<bool>,
    /// The package of a job a `packages:` job made, for `package.*`.
    pub package: Option<&'a crate::PackageRef>,
}

/// The globs of a `hashFiles('a', 'b')` expression, or why it is malformed.
pub(crate) fn hash_files_globs(text: &str) -> Result<Vec<String>, String> {
    let inner = text
        .strip_prefix("hashFiles(")
        .and_then(|t| t.strip_suffix(')'))
        .ok_or_else(|| format!("`{text}` is not `hashFiles('glob', ...)`"))?;
    let mut globs = Vec::new();
    for part in inner.split(',') {
        let part = part.trim();
        let glob = part
            .strip_prefix('\'')
            .and_then(|p| p.strip_suffix('\''))
            .or_else(|| part.strip_prefix('"').and_then(|p| p.strip_suffix('"')))
            .ok_or_else(|| format!("`hashFiles()` takes quoted globs, not `{part}`"))?;
        if glob.is_empty() || glob.starts_with('/') || glob.split('/').any(|c| c == "..") {
            return Err(format!(
                "`{glob}` must be a glob relative to the clone, without `..`"
            ));
        }
        crate::glob::compile(glob).map_err(|e| format!("`{glob}`: {e}"))?;
        globs.push(glob.to_string());
    }
    Ok(globs)
}

/// A piece of an `env:` value that reads secrets.
pub(crate) enum RawPart {
    Text(String),
    Secret(String),
}

fn secret_name(text: &str) -> Option<&str> {
    text.strip_prefix("secrets.")
}

fn check_ref_name(kind: &str, name: &str) -> Result<(), String> {
    let ok = !name.is_empty()
        && name.len() <= 128
        && (name.as_bytes()[0].is_ascii_alphabetic() || name.as_bytes()[0] == b'_')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_');
    if ok {
        Ok(())
    } else {
        Err(format!(
            "`{kind}.{name}` is not a valid name (letters, digits and `_`, not starting with a digit, up to 128)"
        ))
    }
}

/// Splits `text` around its `${{ secrets.<name> }}` references, or `None`
/// when it has none. The text between them is substituted as usual by the
/// caller; secrets are kept by name and filled in when the job starts.
pub(crate) fn secret_parts(text: &str) -> Result<Option<Vec<RawPart>>, String> {
    let mut parts = Vec::new();
    let mut found = false;
    let mut text_start = 0;
    let mut search = 0;
    while let Some(rel) = text[search..].find("${{") {
        let start = search + rel;
        let after = start + 3;
        let Some(end_rel) = text[after..].find("}}") else {
            return Err("`${{` is never closed with `}}`".into());
        };
        let inner = text[after..after + end_rel].trim();
        let end = after + end_rel + 2;
        if let Some(name) = secret_name(inner) {
            check_ref_name("secrets", name)?;
            found = true;
            if text_start < start {
                parts.push(RawPart::Text(text[text_start..start].to_string()));
            }
            parts.push(RawPart::Secret(name.to_string()));
            text_start = end;
        }
        search = end;
    }
    if text_start < text.len() {
        parts.push(RawPart::Text(text[text_start..].to_string()));
    }
    Ok(found.then_some(parts))
}

/// Checks a name against the job's `needs:` and the needed job's
/// `outputs:`.
pub(crate) fn check_name(
    name: &Name,
    needs_list: &[String],
    decls: &HashMap<String, JobDecl>,
) -> Result<(), String> {
    let job = match name {
        Name::NeedsResult { job } | Name::NeedsOutput { job, .. } => job,
        _ => return Ok(()),
    };
    if !needs_list.contains(job) {
        return Err(format!(
            "`{name}` reads job `{job}`, which is not in this job's `needs:`"
        ));
    }
    if let Name::NeedsOutput { output, .. } = name {
        let decl = decls
            .get(job)
            .ok_or_else(|| format!("no job named `{job}`"))?;
        if !decl.outputs.contains(output) {
            return Err(format!(
                "job `{job}` declares no output `{output}` (add it to its `outputs:`)"
            ));
        }
    }
    Ok(())
}

impl Scope<'_> {
    fn lookup(&self, text: &str) -> Result<String, String> {
        if text.starts_with("hashFiles(") {
            if !self.hash_files.get() {
                return Err(
                    "`hashFiles()` only works in a cache's `key:` and `restore-keys:`".into(),
                );
            }
            hash_files_globs(text)?;
            return Ok(format!("${{{{ {text} }}}}"));
        }
        if text == "matrix" || text.starts_with("matrix.") {
            return self.matrix_value(text);
        }
        if let Some(field) = text.strip_prefix("package.") {
            let Some(p) = self.package else {
                return Err(format!("`{text}` only exists in a job with `packages:`"));
            };
            return match field {
                "dir" => Ok(p.dir.clone()),
                "name" => Ok(p.name.clone()),
                _ => Err(format!(
                    "a package has `package.dir` and `package.name`, not `{text}`"
                )),
            };
        }
        if let Some(name) = text.strip_prefix("vars.") {
            check_ref_name("vars", name)?;
            // A variable that is not set reads as empty, as an unset
            // environment variable would.
            return Ok(self.ctx.vars.get(name).cloned().unwrap_or_default());
        }
        if secret_name(text).is_some() {
            return Err(
                "secrets can only be used in `env:` values, so they never appear in arguments, scripts or names; set one there and read the variable"
                    .into(),
            );
        }
        let name = expr::parse_name(text).map_err(|_| {
            format!(
                "unknown expression `{text}`; available: `matrix`, `matrix.<axis>`, `needs.<job>.outputs.<name>`, `needs.<job>.result`, `commit.sha`, `commit.short-sha`, `commit.branch`, `repo.id`, `event`, `vars.<name>`, `secrets.<name>` (in `env:`)"
            )
        })?;
        check_name(&name, self.needs_list, self.decls)?;
        Ok(match &name {
            Name::CommitSha => self.ctx.commit_sha.clone(),
            Name::CommitShortSha => self.ctx.commit_sha.chars().take(12).collect(),
            Name::CommitBranch => self.ctx.branch.clone(),
            Name::RepoId => self.ctx.repo_id.clone(),
            Name::Event => self.ctx.event.as_str().to_string(),
            Name::NeedsResult { job } => match self.needs {
                Some(values) => values.result(job).as_str().to_string(),
                None => {
                    self.deferred.set(true);
                    String::new()
                }
            },
            Name::NeedsOutput { job, output } => match self.needs {
                Some(values) => values.output(job, output).unwrap_or_default(),
                None => {
                    self.deferred.set(true);
                    String::new()
                }
            },
        })
    }

    fn matrix_value(&self, text: &str) -> Result<String, String> {
        let axis = text.strip_prefix("matrix.");
        match (&self.matrix, axis) {
            (MatrixScope::Pending, _) => Ok(String::new()),
            (MatrixScope::None, _) => Err("`matrix` is used but the job has no matrix".into()),
            (MatrixScope::List(v), None) => Ok(v.to_string()),
            (MatrixScope::List(_), Some(axis)) => Err(format!(
                "this matrix is a plain list; write `${{{{ matrix }}}}`, not `matrix.{axis}`"
            )),
            (MatrixScope::Axes(_), None) => {
                Err("this matrix has named axes; write `${{ matrix.<axis> }}`".into())
            }
            (MatrixScope::Axes(entry), Some(axis)) => entry
                .iter()
                .find(|(k, _)| k == axis)
                .map(|(_, v)| v.clone())
                .ok_or_else(|| format!("the matrix has no axis `{axis}`")),
        }
    }
}

pub(crate) fn substitute(text: &str, scope: &Scope<'_>) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("${{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 3..];
        let Some(end) = after.find("}}") else {
            return Err("`${{` is never closed with `}}`".into());
        };
        out.push_str(&scope.lookup(after[..end].trim())?);
        rest = &after[end + 2..];
    }
    out.push_str(rest);
    Ok(out)
}
