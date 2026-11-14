//! `iwci run`: runs every pipeline of one commit.
//!
//! ```text
//! iwci run --repo https://github.com/org/repo --sha <commit> --repo-id <id>
//!          [--branch main] [--event push|pull-request] [--base <sha>]
//!          [--pipeline <file.yml>] [--cpus <n>] [--memory <size>] [--json]
//!          [--stall-after 5m | --stall-after 0] [--module-memory 2GiB]
//!          [--pin-module-under 64MiB] [--pinned-module-memory 512MiB]
//!          [--default-branch main]
//!          [--store <dir>] [--cache <dir>] [--author "Name <email>"]
//!          [--keep-installs-unpacked 24h] [--var NAME=value]...
//!          [--no-task-cache]
//!          [--download-max-file 256MiB] [--download-max-run 1GiB]
//!          [--download-max-retention 90d]
//! ```
//!
//! A private repository's token comes from `IWCI_GIT_TOKEN`, never a flag,
//! and so do secrets: `IWCI_SECRET_<NAME>` becomes `${{ secrets.<NAME> }}`,
//! so a value never lands in shell history or a process listing. What a
//! request would lend the run (`lent`: connections, SSH keys, resource
//! outputs) comes from the JSON file `IWCI_LENT_FILE` names, for the same
//! reason; `--untrusted` runs as a fork's pull request would.

use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;

use super::{Args, style};
use crate::adapters::downloads::DownloadLimits;
use crate::runner::{PIPELINE_DIR, PipelineOutput, RunRequest, Runner};
use crate::schedule::{self, RunReport, Status};

#[derive(Serialize)]
struct Output<'a> {
    run_id: &'a str,
    commit: &'a str,
    pipelines: &'a [PipelineOutput],
}

/// The runner's limits from flags, falling back to the environment so a
/// service can set `IWCI_CPUS` and `IWCI_MEMORY` once for every run.
pub(super) struct Limits {
    pub cpus: usize,
    pub jobs_per_cpu: usize,
    pub memory: Option<u64>,
    /// Stop a job after this long with no output and no CPU use; `None`
    /// leaves hung jobs to their timeout.
    pub stall_after: Option<Duration>,
    /// How compiled modules stay in memory (`iwci_runtime::cache`).
    pub modules: iwci_runtime::ModuleLimits,
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
    // V8's background threads (GC, compilation) for Node jobs, within the
    // same vCPU limit as everything else.
    iwci_runtime::set_node_worker_threads(cpus);
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
    // A job that neither prints nor computes for this long is hung (#938);
    // `0` turns the check off.
    let stall_after = match args
        .value("--stall-after")?
        .or_else(|| std::env::var("IWCI_STALL_AFTER").ok())
    {
        Some(text) if text.trim() == "0" => None,
        Some(text) => Some(
            iwci_spec::parse_duration_secs(&text)
                .filter(|&s| s >= 10)
                .map(Duration::from_secs)
                .ok_or_else(|| {
                    format!("--stall-after takes a duration of at least 10s, such as `5m`, or 0 for none, not `{text}`")
                })?,
        ),
        None => Some(iwci_runtime::DEFAULT_STALL_AFTER),
    };
    // Small compiled modules stay in memory for good; the rest in an LRU
    // whose least recently used idle modules are freed past its budget.
    let mut size = |flag: &str, var: &str, default: u64| -> Result<u64, String> {
        match args.value(flag)?.or_else(|| std::env::var(var).ok()) {
            Some(text) => iwci_spec::parse_size(&text)
                .ok_or_else(|| format!("{flag} takes a size such as `1GiB`, not `{text}`")),
            None => Ok(default),
        }
    };
    let modules = iwci_runtime::ModuleLimits {
        lru_budget: size(
            "--module-memory",
            "IWCI_MODULE_MEMORY",
            iwci_runtime::DEFAULT_MODULE_MEMORY,
        )?,
        pin_under: size(
            "--pin-module-under",
            "IWCI_PIN_MODULE_UNDER",
            iwci_runtime::DEFAULT_PIN_UNDER,
        )?,
        pinned_budget: size(
            "--pinned-module-memory",
            "IWCI_PINNED_MODULE_MEMORY",
            iwci_runtime::DEFAULT_PINNED_MEMORY,
        )?,
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
        stall_after,
        modules,
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
    let download_limits = download_limits(args)?;
    // How long a cached install stays unpacked on disk after its last use
    // before it is packed (`iwci_deps::cache`).
    let keep_unpacked = match args.value("--keep-installs-unpacked")? {
        None => iwci_deps::cache::DEFAULT_KEEP_UNPACKED,
        Some(text) => iwci_spec::parse_duration_secs(&text)
            .map(Duration::from_secs)
            .ok_or_else(|| {
                format!("--keep-installs-unpacked takes a duration such as `24h`, not `{text}`")
            })?,
    };
    // Jobs reach the public internet (registries, APIs), never the host's
    // loopback or private addresses; see iwci-runtime's network.rs.
    let runtime = iwci_runtime::Runtime::with_threads(cache.join("modules"), Some(limits.cpus))
        .map_err(|e| e.to_string())?
        .with_internet()
        .with_stall_after(limits.stall_after)
        .with_module_limits(limits.modules);
    let slots = limits.cpus * limits.jobs_per_cpu;
    Ok(Runner {
        runtime: Arc::new(runtime),
        store,
        git: iwci_git::GitCache::new(cache.join("git")).map_err(|e| e.to_string())?,
        fetcher: Arc::new(iwci_deps::fetch::HttpFetcher::new().with_cache_dir(cache.join("deps"))),
        layers: Arc::new(
            iwci_deps::cache::LayerCache::new(Some(cache.join("installs")))
                .with_keep_unpacked(keep_unpacked),
        ),
        cpus: limits.cpus,
        jobs_per_cpu: limits.jobs_per_cpu,
        slots: shared_slots.then(|| Arc::new(schedule::Slots::new(slots))),
        memory: limits
            .memory
            .map(|m| Arc::new(schedule::MemoryBudget::new(m))),
        author,
        default_storage_quota,
        download_limits,
        external: None,
    })
}

/// What `downloads:` may keep on this runner.
fn download_limits(args: &mut Args) -> Result<DownloadLimits, String> {
    let mut limits = DownloadLimits::default();
    let size = |flag: &str, text: String, max: u64| {
        iwci_spec::parse_size(&text)
            .filter(|&b| b > 0 && b <= max)
            .ok_or_else(|| {
                format!(
                    "{flag} takes a size up to {} MiB, such as `100MiB`, not `{text}`",
                    max >> 20
                )
            })
    };
    if let Some(text) = args.value("--download-max-file")? {
        limits.max_file = size("--download-max-file", text, iwci_store::MAX_OBJECT_SIZE)?;
    }
    if let Some(text) = args.value("--download-max-run")? {
        limits.max_run = size("--download-max-run", text, 1 << 40)?;
    }
    if let Some(text) = args.value("--download-max-retention")? {
        limits.max_retention_secs = iwci_spec::parse_duration_secs(&text)
            .filter(|s| (3600..=iwci_spec::MAX_DOWNLOAD_RETENTION_SECS).contains(s))
            .ok_or_else(|| {
                format!("--download-max-retention takes a duration from 1h to 365d, such as `90d`, not `{text}`")
            })?;
    }
    Ok(limits)
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
        trusted: args.flag("--untrusted").then_some(false),
        lent: match std::env::var("IWCI_LENT_FILE") {
            Ok(path) if !path.is_empty() => {
                let text =
                    std::fs::read_to_string(&path).map_err(|e| format!("IWCI_LENT_FILE: {e}"))?;
                serde_json::from_str(&text)
                    .map_err(|e| format!("IWCI_LENT_FILE: not what `lent` takes: {e}"))?
            }
            _ => Default::default(),
        },
        pipeline: match local_pipeline {
            Some(path) => Some(std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))?),
            None => None,
        },
        storage_quota: None,
        // From the environment only, never a flag (see `Runner::resolve`).
        token: None,
        git_ref: args.value("--ref")?,
        no_task_cache: args.flag("--no-task-cache"),
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
    // Installs not used for `--keep-installs-unpacked` are packed now; a
    // server does this in the background instead.
    runner.layers.compact();
    if json {
        let out = Output {
            run_id: &output.run_id,
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
                PipelineOutput::Cancelled { file, name } => {
                    println!("{} {name} ({file}): cancelled", style::dim("cancelled"));
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
            Status::Cancelled { reason } => (style::warn("STOP"), reason.clone()),
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
        for file in &job.downloads {
            println!(
                "       {} {} {}",
                style::dim("download:"),
                file.path,
                style::dim(&format!("{} bytes, {}", file.size, file.key))
            );
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
