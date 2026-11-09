//! `iwci validate` and `iwci plan`: check pipeline files without running
//! anything, for editors, pre-commit hooks and the docs.

use std::process::ExitCode;

use iwci_spec::{Action, ChangePolicy, CloneDepth, Context, Plan};

use super::{Args, style};

pub fn validate(mut args: Args) -> Result<ExitCode, String> {
    let json = args.flag("--json");
    let files = args.rest();
    if files.is_empty() {
        return Err("usage: iwci validate <file.yml>... [--json]".into());
    }
    let mut all_ok = true;
    let mut results = Vec::new();
    for file in &files {
        let text = std::fs::read_to_string(file).map_err(|e| format!("{file}: {e}"))?;
        match iwci_spec::parse(&text, &placeholder_context(file)) {
            Ok(plan) => {
                if !json {
                    println!("{} {file}: {} job(s)", style::ok("ok"), plan.jobs.len());
                }
                results
                    .push(serde_json::json!({ "file": file, "ok": true, "jobs": plan.jobs.len() }));
            }
            Err(errors) => {
                all_ok = false;
                if !json {
                    println!("{} {file}", style::fail("invalid"));
                    for e in &errors.0 {
                        let at = if e.path.is_empty() {
                            String::new()
                        } else {
                            format!("{}: ", style::dim(&e.path))
                        };
                        println!("  {at}{}", e.message);
                    }
                }
                let errs: Vec<_> = errors
                    .0
                    .iter()
                    .map(|e| serde_json::json!({ "path": e.path, "message": e.message }))
                    .collect();
                results.push(serde_json::json!({ "file": file, "ok": false, "errors": errs }));
            }
        }
    }
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&results).expect("serialisable")
        );
    }
    Ok(if all_ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

pub fn plan(mut args: Args) -> Result<ExitCode, String> {
    let json = args.flag("--json");
    let sha = args.value("--sha")?;
    let branch = args.value("--branch")?;
    let repo_id = args.value("--repo-id")?;
    let files = args.rest();
    let [file] = files.as_slice() else {
        return Err(
            "usage: iwci plan <file.yml> [--sha <sha>] [--branch <name>] [--repo-id <id>] [--json]"
                .into(),
        );
    };
    let text = std::fs::read_to_string(file).map_err(|e| format!("{file}: {e}"))?;
    let mut ctx = placeholder_context(file);
    if let Some(sha) = sha {
        ctx.commit_sha = sha;
    }
    if let Some(branch) = branch {
        ctx.branch = branch;
    }
    if let Some(id) = repo_id {
        ctx.repo_id = id;
    }
    let plan = iwci_spec::parse(&text, &ctx).map_err(|e| format!("{file}:\n{e}"))?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&plan).expect("serialisable")
        );
    } else {
        print_plan(&plan);
    }
    Ok(ExitCode::SUCCESS)
}

/// Values that make `${{ commit.* }}` visible in a plan printed without a
/// real commit, rather than empty. `packages:` jobs expand over the
/// workspace of the git checkout `file` is in, as it is on disk; outside
/// one, over a placeholder package.
fn placeholder_context(file: &str) -> Context {
    Context {
        commit_sha: "0000000000000000000000000000000000000000".into(),
        branch: "main".into(),
        repo_id: "local".into(),
        event: iwci_spec::Event::Push,
        vars: Default::default(),
        packages: match repo_root(std::path::Path::new(file)) {
            Some(root) => iwci_spec::PackagesSource::from_discovery(
                iwci_spec::workspace::discover(&LocalFiles(root)),
            ),
            None => iwci_spec::PackagesSource::Unknown,
        },
    }
}

/// The nearest directory above `file` with a `.git`.
fn repo_root(file: &std::path::Path) -> Option<std::path::PathBuf> {
    let file = std::fs::canonicalize(file).ok()?;
    file.ancestors()
        .skip(1)
        .find(|d| d.join(".git").exists())
        .map(std::path::Path::to_path_buf)
}

/// A checkout on disk, for workspace discovery.
struct LocalFiles(std::path::PathBuf);

impl iwci_spec::workspace::RepoFiles for LocalFiles {
    fn read(&self, path: &str) -> Option<Vec<u8>> {
        std::fs::read(self.0.join(path)).ok()
    }
    fn list(&self, dir: &str) -> Vec<(String, bool)> {
        let Ok(entries) = std::fs::read_dir(self.0.join(dir)) else {
            return Vec::new();
        };
        let mut out: Vec<(String, bool)> = entries
            .flatten()
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                // `file_type` does not follow symlinks.
                let is_dir = e.file_type().is_ok_and(|t| t.is_dir());
                Some((name, is_dir))
            })
            .collect();
        out.sort();
        out
    }
}

fn print_plan(plan: &Plan) {
    println!("{}", style::bold(&plan.name));
    for (i, ws) in plan.workspaces.iter().enumerate() {
        let clone = match &ws.clone {
            None => "no clone".to_string(),
            Some(c) => {
                let depth = match c.depth {
                    CloneDepth::Shallow(n) => format!("depth {n}"),
                    CloneDepth::Full => "full history".to_string(),
                };
                format!("clone into {} ({depth})", c.into)
            }
        };
        let deps: Vec<String> = ws
            .deps
            .iter()
            .map(|d| format!("{} in {}", d.ecosystem.name(), d.dir))
            .collect();
        let deps = if deps.is_empty() {
            "no dependencies".to_string()
        } else {
            deps.join(", ")
        };
        println!(
            "  {} {clone}; {deps}",
            style::dim(&format!("workspace {i}:"))
        );
    }
    for template in plan.topological_order() {
        let mut header = style::bold(&template.key);
        if !template.needs.is_empty() {
            header.push_str(&style::dim(&format!(
                " needs {}",
                template.needs.join(", ")
            )));
        }
        println!("  {header}");
        if let Some(cond) = &template.condition_source {
            println!("    {}", style::dim(&format!("if {cond}")));
        }
        if !template.outputs.is_empty() {
            println!(
                "    {}",
                style::dim(&format!("outputs {}", template.outputs.join(", ")))
            );
        }
        let Some(jobs) = &template.instances else {
            println!(
                "    {} {}",
                template.tool,
                style::dim("(expands when its needs finish: it reads their outputs)")
            );
            continue;
        };
        for job in jobs {
            let what = match &job.action {
                Action::Args { args } => args.join(" "),
                Action::Script { script } => {
                    let first = script.lines().next().unwrap_or_default();
                    if script.lines().count() > 1 {
                        format!("{first} ...")
                    } else {
                        first.to_string()
                    }
                }
            };
            println!(
                "    {} {}",
                job.id,
                style::dim(&format!("({})", job.display_name))
            );
            println!("      {} {what}", job.tool);
            println!(
                "      {}",
                style::dim(&format!(
                    "in {} on workspace {}, {}s, {} MiB",
                    job.cwd,
                    job.workspace,
                    job.timeout.as_secs(),
                    job.memory_bytes >> 20
                ))
            );
            match &job.changes {
                ChangePolicy::Ignore => {}
                ChangePolicy::Fail => println!("      {}", style::dim("fails if it changes files")),
                ChangePolicy::Commit { message } => println!(
                    "      {}",
                    style::dim(&format!("commits changes as \"{message}\""))
                ),
            }
        }
    }
}
