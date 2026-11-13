//! The executor's side of cloud jobs (`crate::external`): what the app
//! calls to claim a cloud job, send its log, and finish it, and what the
//! job's machine calls, with the claim's token, for its artifacts.
//!
//! | Route | Does |
//! |-------|------|
//! | `GET /v1/runs/{id}/jobs` | the run's cloud jobs on this runner and their state, nothing secret |
//! | `GET /v1/runs/{id}/jobs/{job}` | one of them |
//! | `POST /v1/runs/{id}/jobs/{job}/claim` | `{ "executor"? }`: the spec, environment and files, and a claim token |
//! | `POST /v1/runs/{id}/jobs/{job}/log` | `{ "claim", "stream"?, "text"? }`: output; every call renews the lease |
//! | `POST /v1/runs/{id}/jobs/{job}/finish` | how it went ([`crate::external::Finish`]) |
//! | `GET /v1/runs/{id}/jobs/{job}/inputs?claim=` | its input artifacts, a tar archive (no key) |
//! | `PUT /v1/runs/{id}/jobs/{job}/artifacts?claim=` | its artifacts, a tar archive (no key) |
//!
//! `{job}` is the job's id, percent-encoded (`build%5Bapp%2Fweb%5D` for
//! `build[app/web]`).

use std::collections::HashMap;
use std::io::Read;

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::json;
use tiny_http::{Header, Method, Request, Response, ResponseBox};

use super::{MAX_BODY, Server, error, json_response};
use crate::external::{Finish, Refusal, percent_decode};

fn reply(result: Result<serde_json::Value, Refusal>) -> ResponseBox {
    match result {
        Ok(body) => json_response(200, &body).boxed(),
        Err((status, body)) => json_response(status, &body).boxed(),
    }
}

fn read_json<T: DeserializeOwned>(request: &mut Request) -> Result<T, String> {
    let mut body = Vec::new();
    request
        .as_reader()
        .take(MAX_BODY as u64 + 1)
        .read_to_end(&mut body)
        .map_err(|e| e.to_string())?;
    if body.len() > MAX_BODY {
        return Err(format!("the body is over {MAX_BODY} bytes"));
    }
    if body.iter().all(u8::is_ascii_whitespace) {
        body = b"{}".to_vec();
    }
    serde_json::from_slice(&body).map_err(|e| format!("body: {e}"))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ClaimBody {
    /// What the executor calls itself, shown on the job's report.
    #[serde(default)]
    executor: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LogBody {
    claim: String,
    /// `stdout` (the default) or `stderr`.
    #[serde(default)]
    stream: Option<String>,
    /// Output as it came, any number of lines; empty for a heartbeat.
    #[serde(default)]
    text: String,
}

impl Server {
    /// `GET .../inputs?claim=` and `PUT .../artifacts?claim=`, which the
    /// job's machine calls with the claim's token rather than the runner's
    /// key; `None` for any other request.
    pub(super) fn claim_route(
        &self,
        request: &mut Request,
        method: &Method,
        path: &str,
        query: &HashMap<String, String>,
    ) -> Option<ResponseBox> {
        let token = query.get("claim")?;
        let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        let (run, job, action) = match segments.as_slice() {
            ["v1", "runs", run, "jobs", job, action] => (*run, *job, *action),
            _ => return None,
        };
        let jobs = self.runner.external.as_ref()?;
        let Some(job) = percent_decode(job) else {
            return Some(error(400, "the job id is not percent-encoded UTF-8").boxed());
        };
        Some(match (method, action) {
            (Method::Get, "inputs") => match jobs.inputs(run, &job, token) {
                Ok(tar) => Response::from_data(tar)
                    .with_header(
                        Header::from_bytes(&b"Content-Type"[..], &b"application/x-tar"[..])
                            .expect("valid header"),
                    )
                    .boxed(),
                Err((status, body)) => json_response(status, &body).boxed(),
            },
            (Method::Put, "artifacts") => reply(jobs.upload(run, &job, token, request.as_reader())),
            _ => return None,
        })
    }

    /// The routes under `/v1/runs/{id}/jobs` that need the runner's key.
    pub(super) fn external_route(
        &self,
        request: &mut Request,
        method: &Method,
        run: &str,
        rest: &[&str],
    ) -> ResponseBox {
        let Some(jobs) = &self.runner.external else {
            return error(404, "this runner hands out no cloud jobs").boxed();
        };
        let job = match rest.first().map(|j| percent_decode(j)) {
            None => None,
            Some(Some(job)) => Some(job),
            Some(None) => return error(400, "the job id is not percent-encoded UTF-8").boxed(),
        };
        match (method, job.as_deref(), &rest[rest.len().min(1)..]) {
            (Method::Get, None, []) => {
                json_response(200, &json!({ "run": run, "jobs": jobs.list(run) })).boxed()
            }
            (Method::Get, Some(job), []) => reply(jobs.describe(run, job)),
            (Method::Post, Some(job), ["claim"]) => match read_json::<ClaimBody>(request) {
                Ok(body) => reply(jobs.claim(run, job, body.executor)),
                Err(e) => error(400, e).boxed(),
            },
            (Method::Post, Some(job), ["log"]) => match read_json::<LogBody>(request) {
                Ok(body) => reply(jobs.log(
                    run,
                    job,
                    &body.claim,
                    body.stream.as_deref().unwrap_or("stdout"),
                    &body.text,
                )),
                Err(e) => error(400, e).boxed(),
            },
            (Method::Post, Some(job), ["finish"]) => match read_json::<Finish>(request) {
                Ok(body) => reply(jobs.finish(run, job, body)),
                Err(e) => error(400, e).boxed(),
            },
            (Method::Get, Some(_), ["inputs"]) | (Method::Put, Some(_), ["artifacts"]) => {
                error(401, "give the claim's token as `?claim=`").boxed()
            }
            _ => error(404, "no such route for a cloud job").boxed(),
        }
    }
}
