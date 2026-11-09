//! `iwci run`: runs every pipeline of one commit.
//!
//! ```text
//! iwci run --repo https://github.com/org/repo --sha <commit> --repo-id <id>
//!          [--branch main] [--event push|pull-request] [--base <sha>]
//!          [--pipeline <file.yml>] [--cpus <n>] [--memory <size>] [--json]
//!          [--default-branch main]
//!          [--store <dir>] [--cache <dir>] [--author "Name <email>"]
//!          [--var NAME=value]...
//! ```
//!
//! A private repository's token comes from `IWCI_GIT_TOKEN`, never a flag,
//! and so do secrets: `IWCI_SECRET_<NAME>` becomes `${{ secrets.<NAME> }}`,
//! so a value never lands in shell history or a process listing.

use std::process::ExitCode;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::{Args, style};
use crate::runner::{PIPELINE_DIR, PipelineOutput, RunRequest, Runner};
use crate::schedule::{self, RunReport, Status};

#[derive(Serialize)]
struct Output<'a> {
    commit: &'a str,
    pipelines: &'a [PipelineOutput],
}

/// The runner's limits from flags, falling back to the environment so a
/// service can set `IWCI_CPUS` and `IWCI_MEMORY` once for every run.
pub(super) struct Limits {
    pub cpus: usize,
    pub jobs_per_cpu: usize,
    pub memory: Option<u64>,
}

pub(super) fn limits(args: &mut Args) -> Result<Limits, String> {
    let cpus = match args
        .value("--cpus")?
        .or_else(|| std::env::var("IWCI_CPUS").ok())
    {
        Some(n) => n
            .parse::<usize>()
            .ok()
            .filter(|&n| n > 0)
            .ok_or("--cpus takes a number of vCPUs, at least 1")?,
        None => std::thread::available_parallelism().map_or(4, |n| n.get()),
    };
    // Four jobs share a vCPU unless told otherwise: CI work waits on its
    // own subprocesses and file reads often enough that a core interleaves
    // several jobs better than it runs one.
    let jobs_per_cpu = match args
        .value("--jobs-per-cpu")?
        .or_else(|| std::env::var("IWCI_JOBS_PER_CPU").ok())
    {
        Some(n) => n
            .parse::<usize>()
            .ok()
            .filter(|n| (1..=64).contains(n))
            .ok_or("--jobs-per-cpu takes a number from 1 to 64")?,
        None => 4,
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
    Ok(Limits {
        cpus,
        jobs_per_cpu,
        memory,
    })
}

pub(super) fn storage_quota(args: &mut Args) -> Result<Option<u64>, String> {
    match args.value("--storage-quota")? {
        Some(text) => iwci_spec::parse_size(&text)
            .map(Some)
            .ok_or_else(|| format!("--storage-quota takes a size such as `10GiB`, not `{text}`")),
        None => Ok(None),
    }
}

/// Builds the long-lived parts of a runner under the cache directory.
pub(super) fn open_runner(
    args: &mut Args,
    limits: &Limits,
    shared_slots: bool,
    default_storage_quota: Option<u64>,
) -> Result<Runner, String> {
    let author = parse_author(
        args.value("--author")?
            .as_deref()
            .unwrap_or("Infrawrench CI <ci@infrawrench.com>"),
    )?;
    let cache = super::cache_dir(args)?;
    let store = super::store::open(args, &cache)?;
    let runtime = iwci_runtime::Runtime::with_threads(cache.join("modules"), Some(limits.cpus))
        .map_err(|e| e.to_string())?;
    let slots = limits.cpus * limits.jobs_per_cpu;
    Ok(Runner {
        runtime: Arc::new(runtime),
        store,
        git: iwci_git::GitCache::new(cache.join("git")).map_err(|e| e.to_string())?,
        fetcher: Arc::new(iwci_deps::fetch::HttpFetcher::new().with_cache_dir(cache.join("deps"))),
        layers: Arc::new(iwci_deps::cache::LayerCache::new(Some(
            cache.join("installs"),
        ))),
        cpus: limits.cpus,
        jobs_per_cpu: limits.jobs_per_cpu,
        slots: shared_slots.then(|| Arc::new(schedule::Slots::new(slots))),
        memory: limits
            .memory
            .map(|m| Arc::new(schedule::MemoryBudget::new(m))),
        author,
        default_storage_quota,
    })
}

pub fn run(mut args: Args) -> Result<ExitCode, String> {
    let json = args.flag("--json");
    let repo = args.value("--repo")?.ok_or("--repo <url> is required")?;
    let local_pipeline = args.value("--pipeline")?;
    let request = RunRequest {
        repo,
        sha: args.value("--sha")?,
        branch: args.value("--branch")?,
        event: args.value("--event")?,
        base: args.value("--base")?,
        repo_id: args.value("--repo-id")?,
        owner: args.value("--owner")?,
        default_branch: args.value("--default-branch")?,
        pipeline: match local_pipeline {
            Some(path) => Some(std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?),
            None => None,
        },
        storage_quota: None,
        // From the environment only, never a flag (see `Runner::resolve`).
        token: None,
        git_ref: args.value("--ref")?,
        secrets: crate::runner::Secrets(
            std::env::vars()
                .filter_map(|(k, v)| {
                    k.strip_prefix("IWCI_SECRET_")
                        .filter(|name| !name.is_empty())
                        .map(|name| (name.to_string(), v))
                })
                .collect(),
        ),
        vars: {
            let mut vars = std::collections::BTreeMap::new();
            while let Some(pair) = args.value("--var")? {
                let (name, value) = pair
                    .split_once('=')
                    .ok_or_else(|| format!("--var takes NAME=value, not `{pair}`"))?;
                vars.insert(name.to_string(), value.to_string());
            }
            vars
        },
    };
    if request.sha.is_none() && request.branch.is_none() {
        return Err("give --sha <commit>, --branch <name>, or both".into());
    }
    let limits = limits(&mut args)?;
    let quota = storage_quota(&mut args)?;
    // One run uses the machine's jobs-per-cpu share too, so a local run
    // behaves the way the same run would on a server.
    let runner = open_runner(&mut args, &limits, true, quota)?;
    if !args.rest().is_empty() {
        return Err("unexpected arguments; see `iwci help`".into());
    }

    let output = runner.run(&request)?;
    if json {
        let out = Output {
            commit: &output.commit,
            pipelines: &output.pipelines,
        };
        println!(
            "{}",
            serde_json::to_string_pretty(&out).expect("serialisable")
        );
    } else {
        if output.pipelines.is_empty() {
            println!(
                "{} no pipeline files in {PIPELINE_DIR}/",
                style::dim("nothing to run:")
            );
        }
        for pipeline in &output.pipelines {
            match pipeline {
                PipelineOutput::Ran { report, .. } => print_report(report),
                PipelineOutput::NotTriggered { file, name } => {
                    println!("{} {name} ({file})", style::dim("not triggered:"));
                }
                PipelineOutput::Invalid { file, errors } => {
                    println!("{} {file}", style::fail("invalid"));
                    for e in errors {
                        println!("  {e}");
                    }
                }
            }
        }
    }
    Ok(if output.passed {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    })
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
        for line in &job.caches {
            println!("       {}", style::dim(line));
        }
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
