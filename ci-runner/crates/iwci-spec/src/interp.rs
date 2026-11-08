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
        let name = expr::parse_name(text).map_err(|_| {
            format!(
                "unknown expression `{text}`; available: `matrix`, `matrix.<axis>`, `needs.<job>.outputs.<name>`, `needs.<job>.result`, `commit.sha`, `commit.short-sha`, `commit.branch`, `repo.id`, `event`"
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
