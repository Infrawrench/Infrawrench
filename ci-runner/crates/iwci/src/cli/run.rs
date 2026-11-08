//! `iwci run`: runs every pipeline of one commit.
//!
//! ```text
//! iwci run --repo https://github.com/org/repo --sha <commit> --repo-id <id>
//!          [--branch main] [--event push|pull-request] [--base <sha>]
//!          [--pipeline <file.yml>] [--cpus <n>] [--memory <size>] [--json]
//!          [--store <dir>] [--cache <dir>] [--author "Name <email>"]
//! ```
//!
//! A private repository's token comes from `IWCI_GIT_TOKEN`, never a flag.

use std::process::ExitCode;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use iwci_spec::{Context, Event};
use iwci_vfs::SnapshotBuilder;
use serde::Serialize;

use super::{Args, style};
use crate::adapters::tools::{RuntimeExecutor, StoreTools};
use crate::adapters::workspace::{GitCommitter, GitWorkspaces};
use crate::schedule::{self, RunReport, Status};

/// Where pipeline files live in a repository.
pub const PIPELINE_DIR: &str = ".infrawrench/ci";

#[derive(Serialize)]
struct Output {
    commit: String,
    pipelines: Vec<PipelineOutput>,
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "kebab-case")]
enum PipelineOutput {
    Ran { file: String, report: RunReport },
    NotTriggered { file: String, name: String },
    Invalid { file: String, errors: Vec<String> },
}

pub fn run(mut args: Args) -> Result<ExitCode, String> {
    let json = args.flag("--json");
    let repo = args.value("--repo")?.ok_or("--repo <url> is required")?;
    let sha = args
        .value("--sha")?
        .ok_or("--sha <commit> is required")?
        .to_ascii_lowercase();
    let repo_id = args
        .value("--repo-id")?
        .unwrap_or_else(|| "local".to_string());
    let branch = args
        .value("--branch")?
        .unwrap_or_else(|| "main".to_string());
    let event = match args.value("--event")?.as_deref() {
        None | Some("push") => Event::Push,
        Some("pull-request") => Event::PullRequest,
        Some(other) => {
            return Err(format!(
                "--event is `push` or `pull-request`, not `{other}`"
            ));
        }
    };
    let base = args.value("--base")?;
    let local_pipeline = args.value("--pipeline")?;
    // The runner's own limits. Flags win over the environment, so a
    // service can set IWCI_CPUS and IWCI_MEMORY once for every run.
    let cpus = match args
        .value("--cpus")?
        .or_else(|| std::env::var("IWCI_CPUS").ok())
    {
        Some(n) => n
            .parse::<usize>()
            .ok()
            .filter(|&n| n > 0)
            .ok_or("--cpus takes a number of cores, at least 1")?,
        None => std::thread::available_parallelism().map_or(4, |n| n.get()),
    };
    let memory = match args
        .value("--memory")?
        .or_else(|| std::env::var("IWCI_MEMORY").ok())
    {
        Some(text) => Some(
            iwci_spec::parse_size(&text)
                .filter(|&b| b >= iwci_spec::MIN_MEMORY)
                .ok_or_else(|| {
                    format!("--memory takes a size of at least 16MiB, such as `8GiB`, not `{text}`")
                })?,
        ),
        None => None,
    };
    // Wasmer compiles modules on rayon's global pool; size it before the
    // first compile so `--cpus` holds there too.
    let _ = rayon::ThreadPoolBuilder::new()
        .num_threads(cpus)
        .build_global();
    let author = parse_author(
        args.value("--author")?
            .as_deref()
            .unwrap_or("Infrawrench CI <ci@infrawrench.com>"),
    )?;
    let cache = super::cache_dir(&mut args)?;
    let store = super::store::open(&mut args, &cache)?;
    if !args.rest().is_empty() {
        return Err("unexpected arguments; see `iwci help`".into());
    }

    let auth = std::env::var("IWCI_GIT_TOKEN")
        .ok()
        .map(iwci_git::Auth::token);
    let git = iwci_git::GitCache::new(cache.join("git")).map_err(|e| e.to_string())?;
    let remote = git.remote(&repo).map_err(|e| e.to_string())?;
    let ref_hint = format!("refs/heads/{branch}");
    remote
        .fetch_commit(
            &sha,
            iwci_git::Depth::Shallow(1),
            auth.as_ref(),
            Some(&ref_hint),
        )
        .map_err(|e| format!("fetch {sha}: {e}"))?;

    let pipelines = match local_pipeline {
        Some(path) => vec![(
            path.clone(),
            std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?,
        )],
        None => read_pipelines(&remote, &sha)?,
    };
    if pipelines.is_empty() && !json {
        println!(
            "{} no pipeline files in {PIPELINE_DIR}/",
            style::dim("nothing to run:")
        );
    }

    let changed_paths = match &base {
        Some(base) => {
            remote
                .fetch_commit(base, iwci_git::Depth::Shallow(1), auth.as_ref(), None)
                .map_err(|e| format!("fetch base {base}: {e}"))?;
            Some(
                remote
                    .changed_paths(base, &sha)
                    .map_err(|e| e.to_string())?,
            )
        }
        None => None,
    };

    let ctx = Context {
        commit_sha: sha.clone(),
        branch: branch.clone(),
        repo_id: repo_id.clone(),
        event,
    };
    let runtime = Arc::new(
        iwci_runtime::Runtime::with_threads(cache.join("modules"), Some(cpus))
            .map_err(|e| e.to_string())?,
    );
    let fetcher: Arc<dyn iwci_deps::fetch::Fetcher> =
        Arc::new(iwci_deps::fetch::HttpFetcher::new().with_cache_dir(cache.join("deps")));
    let repo_id_checked =
        iwci_store::RepoId::new(&repo_id).map_err(|e| format!("--repo-id: {e}"))?;
    let tools = StoreTools {
        catalog: iwci_store::Catalog::new(store),
        repo: repo_id_checked,
    };
    let executor = RuntimeExecutor { runtime };
    let workspaces = GitWorkspaces {
        remote: remote.clone(),
        commit: sha.clone(),
        auth: auth.clone(),
        ref_hint: Some(ref_hint),
        fetcher,
        layers: Arc::new(iwci_deps::cache::LayerCache::new(Some(
            cache.join("installs"),
        ))),
        threads: cpus,
    };
    let committer = GitCommitter {
        remote: remote.clone(),
        head: sha.clone(),
        identity: author,
    };
    let options = schedule::Options {
        parallelism: cpus,
        changed_paths: changed_paths.clone(),
        base_env: vec![
            ("CI".into(), "true".into()),
            ("IWCI".into(), "true".into()),
            ("IWCI_COMMIT".into(), sha.clone()),
            ("IWCI_BRANCH".into(), branch.clone()),
            ("IWCI_REPO_ID".into(), repo_id.clone()),
        ],
        memory: memory.map(|m| Arc::new(schedule::MemoryBudget::new(m))),
    };

    let mut outputs = Vec::new();
    let mut ok = true;
    for (file, text) in pipelines {
        let plan = match iwci_spec::parse(&text, &ctx) {
            Ok(plan) => plan,
            Err(errors) => {
                ok = false;
                if !json {
                    println!("{} {file}", style::fail("invalid"));
                    println!("{errors}");
                }
                outputs.push(PipelineOutput::Invalid {
                    file,
                    errors: errors
                        .0
                        .iter()
                        .map(|e| format!("{}: {}", e.path, e.message))
                        .collect(),
                });
                continue;
            }
        };
        if !plan
            .triggers
            .matches(event, &branch, changed_paths.as_deref())
        {
            if !json {
                println!("{} {} ({file})", style::dim("not triggered:"), plan.name);
            }
            outputs.push(PipelineOutput::NotTriggered {
                file,
                name: plan.name,
            });
            continue;
        }
        let report = schedule::run(&plan, &workspaces, &tools, &executor, &committer, &options);
        ok &= report.passed();
        if !json {
            print_report(&report);
        }
        outputs.push(PipelineOutput::Ran { file, report });
    }

    if json {
        let out = Output {
            commit: sha,
            pipelines: outputs,
        };
        println!(
            "{}",
            serde_json::to_string_pretty(&out).expect("serialisable")
        );
    }
    Ok(if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
}

/// Every `.yml`/`.yaml` in the commit's pipeline directory. Read through a
/// checkout into a scratch snapshot, because the cache has no work tree.
fn read_pipelines(
    remote: &iwci_git::RemoteCache,
    sha: &str,
) -> Result<Vec<(String, String)>, String> {
    let scratch = SnapshotBuilder::new();
    remote
        .checkout_into(sha, &scratch, "/src")
        .map_err(|e| format!("checkout: {e}"))?;
    let snapshot = scratch.freeze();
    let dir = format!("/src/{PIPELINE_DIR}");
    let mut out = Vec::new();
    for path in snapshot.list_files(&dir) {
        let name = path.display().to_string();
        let rel = name.trim_start_matches("/src/").to_string();
        // Only files directly in the directory; subdirectories are free
        // for shared snippets later.
        if path.parent().map(|p| p.display().to_string()) != Some(dir.clone()) {
            continue;
        }
        if !(rel.ends_with(".yml") || rel.ends_with(".yaml")) {
            continue;
        }
        let bytes = snapshot.read(&path).map_err(|e| e.to_string())?;
        out.push((
            rel,
            String::from_utf8(bytes).map_err(|_| format!("{name} is not UTF-8"))?,
        ));
    }
    Ok(out)
}

fn parse_author(text: &str) -> Result<iwci_git::Identity, String> {
    let (name, rest) = text.split_once('<').ok_or("--author is `Name <email>`")?;
    let email = rest.strip_suffix('>').ok_or("--author is `Name <email>`")?;
    let time = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs() as i64);
    Ok(iwci_git::Identity {
        name: name.trim().to_string(),
        email: email.trim().to_string(),
        time,
        utc_offset: 0,
    })
}

fn print_report(report: &RunReport) {
    println!("{}", style::bold(&report.pipeline));
    for install in &report.installs {
        println!("  {}", style::dim(install));
    }
    for w in &report.warnings {
        println!("  {} {w}", style::warn("warning:"));
    }
    for job in &report.jobs {
        let secs = job.duration_ms as f64 / 1000.0;
        let (mark, detail) = match &job.status {
            Status::Passed => (style::ok("pass"), String::new()),
            Status::Failed { reason } => (style::fail("FAIL"), reason.clone()),
            Status::Skipped { reason } => (style::dim("skip"), reason.clone()),
            Status::Error { message } => (style::fail("ERR "), message.clone()),
        };
        println!(
            "  {mark} {} {} {}",
            job.name,
            style::dim(&format!("{secs:.2}s")),
            style::dim(&detail)
        );
        if let Some(commit) = &job.commit {
            println!("       {} {commit}", style::dim("committed its changes as"));
        }
        if matches!(job.status, Status::Failed { .. }) {
            if let Some(exec) = &job.execution {
                for line in tail(&exec.stdout, 40).chain(tail(&exec.stderr, 40)) {
                    println!("       {line}");
                }
            }
            for change in job.changes.iter().take(20) {
                println!("       {} {}", style::dim(change.kind), change.path);
            }
        }
    }
    println!(
        "  {}",
        style::dim(&format!("{:.2}s", report.duration_ms as f64 / 1000.0))
    );
}

fn tail(text: &str, n: usize) -> impl Iterator<Item = &str> {
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines.into_iter().skip(start)
}
