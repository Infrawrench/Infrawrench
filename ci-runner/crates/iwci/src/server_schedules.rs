//! `POST /v1/schedules/read`: a repository's scheduled pipelines.
//!
//! Scheduling itself lives in front of the runners (the proxy Worker, whose
//! Cron Trigger fires once a minute for the whole pool), so runners keep no
//! schedule state. What needs git and the pipeline parser is here: reading a
//! branch's pipelines and saying which have `on.schedule`, with their text,
//! so the proxy can start exactly that pipeline when a cron is due.

use iwci_spec::{Context, Event};
use serde_json::json;

use super::{Reply, Server, error, json_response};
use crate::runner::RunRequest;

impl Server {
    pub(super) fn read_schedules(&self, mut req: RunRequest) -> Reply {
        let (owner, repo_id) = match (req.owner(), req.repo_id()) {
            (Ok(o), Ok(r)) => (o, r),
            (Err(e), _) | (_, Err(e)) => return error(400, e),
        };
        // Schedules run the default branch.
        if req.branch.is_none() {
            req.branch = req.default_branch.clone();
        }
        let branch = req.branch.clone().unwrap_or_else(|| "main".into());
        req.branch = Some(branch.clone());
        let (commit, files) = match self.runner.branch_pipelines(&req) {
            Ok(found) => found,
            Err(e) => return error(422, e),
        };
        let ctx = Context {
            commit_sha: commit.clone(),
            branch: branch.clone(),
            repo_id: repo_id.as_str().to_string(),
            event: Event::Schedule,
            // Variables do not decide which pipelines have schedules, but
            // a concurrency group may read one.
            vars: req.vars.clone(),
            // Which packages a job runs in does not decide its schedule.
            packages: Default::default(),
            ..Default::default()
        };
        let mut pipelines = Vec::new();
        let mut problems = Vec::new();
        for (file, text) in files {
            match iwci_spec::parse(&text, &ctx) {
                Ok(plan) if !plan.triggers.schedule.is_empty() => pipelines.push(json!({
                    "file": file,
                    "name": plan.name,
                    "cron": plan.triggers.schedule.iter().map(|c| c.source()).collect::<Vec<_>>(),
                    "text": text,
                    // What a scheduled run's group is, for the proxy that
                    // fires it (it keeps its own fires to their groups).
                    "concurrency": plan.concurrency,
                })),
                Ok(_) => {}
                Err(e) => problems.push(format!("{file}: {e}")),
            }
        }
        json_response(
            200,
            &json!({
                "owner": owner.as_str(),
                "repo-id": repo_id.as_str(),
                "branch": branch,
                "commit": commit,
                "pipelines": pipelines,
                "problems": problems,
            }),
        )
    }
}
