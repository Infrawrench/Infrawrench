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
        match iwci_spec::parse(&text, &placeholder_context()) {
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
    let mut ctx = placeholder_context();
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
/// real commit, rather than empty.
fn placeholder_context() -> Context {
    Context {
        commit_sha: "0000000000000000000000000000000000000000".into(),
        branch: "main".into(),
        repo_id: "local".into(),
        event: iwci_spec::Event::Push,
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
