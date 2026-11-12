//! `POST /v1/concurrency` and `POST /v1/runs/{id}/cancel`: what the runner
//! offers whoever keeps a repository's runs to their `concurrency:` groups.
//!
//! The runner only evaluates a group (it parses the pipelines) and stops a
//! run when told to. It sees one run at a time, so it cannot know which
//! other run holds a group; the app, which dispatches every run of a
//! repository, enforces them.

use serde_json::json;

use super::{Reply, Server, error, json_response};
use crate::runner::RunRequest;

impl Server {
    /// The pipelines `req` would run and each one's group, without a job
    /// slot: a clone and a parse, like reading schedules.
    pub(super) fn concurrency(&self, req: &RunRequest) -> Reply {
        if let Err(e) = req.owner().and_then(|_| req.repo_id()) {
            return error(400, e);
        }
        match self.runner.concurrency(req) {
            Ok(out) => json_response(200, &serde_json::to_value(out).unwrap_or_default()),
            Err(e) => error(422, e),
        }
    }

    /// Cancels a run on this runner, or the pipelines of `files`. A run
    /// that has already finished is left as it is.
    pub(super) fn cancel_run(&self, id: &str, files: Option<&[String]>) -> Reply {
        let control = self.controls.lock().unwrap().get(id).cloned();
        if let Some(control) = control {
            control.cancel(files);
            return json_response(202, &json!({ "id": id, "state": "cancelling" }));
        }
        match self.runs.lock().unwrap().get(id) {
            Some(entry) if entry.state != "running" => {
                json_response(200, &json!({ "id": id, "state": "finished" }))
            }
            // Admitted but its control not registered yet cannot happen:
            // `launch` registers both before the id is returned.
            _ => error(404, "no such run on this runner"),
        }
    }
}

#[cfg(test)]
mod tests {
    use crate::runner::RunControl;

    #[test]
    fn a_control_cancels_the_running_pipeline_and_those_not_started() {
        let control = RunControl::default();
        let test = control.start("test.yml");
        control.cancel(Some(&["lint.yml".to_string()]));
        assert!(!test.is_cancelled(), "another pipeline's cancel");
        assert!(control.is_cancelled("lint.yml"));
        assert!(!control.is_cancelled("test.yml"));
        control.cancel(Some(&["test.yml".to_string()]));
        assert!(test.is_cancelled(), "the running one is stopped");
        let deploy = control.start("deploy.yml");
        assert!(!deploy.is_cancelled());
        control.cancel(None);
        assert!(deploy.is_cancelled());
        assert!(control.is_cancelled("anything.yml"));
        assert!(control.start("later.yml").is_cancelled());
    }
}
