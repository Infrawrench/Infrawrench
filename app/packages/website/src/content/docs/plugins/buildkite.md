---
title: Buildkite
description: Manage Buildkite pipelines and their YAML steps, builds, job logs, agents, clusters, queues, agent tokens, secrets, schedules, pipeline templates and Test Engine flaky tests.
sidebar_order: 52
---

## What you can manage

- **Organization**: monthly active users (the figure Buildkite bills user-based plans on), pipelines, connected and busy agents, running and scheduled builds, jobs waiting for an agent, the REST API rate limit, and the busiest pipelines right now. The Metrics tab charts builds, failed builds, pass rate, build duration (p50 and p95) and how long jobs wait for an agent (p95), across every pipeline.
- **Pipelines**: repository, cluster, branch filter, skip and cancel rules for intermediate builds, timeouts, visibility, tags, what is running or waiting, and the 15 most recent builds. **Create** a pipeline (pick its cluster, optionally a team and a pipeline template), **Edit** its settings, edit its YAML steps in the **Steps** tab, **Move to cluster**, **Archive** or **Unarchive** it, add the GitHub webhook, or delete it. The Metrics tab charts the same series as the organization, for this pipeline.
- **Builds**: the 50 most recent builds in the organization, with state, branch, commit, who started it, duration and the longest time a job waited for an agent. A build's page lists its jobs with **Retry** on failed jobs, **Unblock** on block steps and a **Logs** link, plus the build's annotations and artifacts. **Cancel** a running build, **Rebuild**, or **Retry failed jobs**. **Create** a build to start one: pick the pipeline (or start from its page), a branch, commit, message, environment variables, and whether to do a clean checkout.
- **Jobs**: command, state, exit status, agent, time spent waiting for an agent, and a **Logs** tab that tails the job's output. **Retry**, **Unblock**, or **Change priority** of a job that is still waiting.
- **Agents**: every connected agent with its host, IP address, version, platform, queue, tags and current job. **Pause** it (with a note and an automatic resume time), **Resume** it, **Stop** it after its current job, or **Stop now**, which cancels the running job.
- **Clusters**: their queues, agents, default queue and hosted-agent cache settings. **Create**, **Edit** or delete a cluster, choose its **Default queue**, and use **Get credentials** to mint an agent token.
- **Queues**: self-hosted or Buildkite hosted, with the instance shape for hosted queues, connected agents and whether dispatch is paused. **Create** one (pick an instance shape for hosted agents), **Edit** its description, retry affinity or instance shape, **Pause dispatch** with a note, **Resume dispatch**, **Make default**, or delete it.
- **Agent tokens**: description, allowed IP ranges, expiry and who created them. **Create** one: its value is kept as the token output, so you can export it to Kubernetes or a server as `BUILDKITE_AGENT_TOKEN`. **Edit** the description or IP ranges, or delete (revoke) it.
- **Cluster secrets**: key, description and access policy, and when a build last read it. **Create** one, **Edit** its description, policy or value (the value is write-only), or delete it.
- **Schedules**: cron line, branch, commit, message, environment, when the next build is due and whether the last attempt failed. **Create**, **Edit**, **Enable**, **Disable** or delete.
- **Pipeline templates** (Enterprise plan): **Create**, **Edit** the name, description and availability, edit the steps in the **Steps** tab, or delete.
- **Test suites** (Test Engine): default branch, application and number of flaky tests. **Create**, **Edit** or delete a suite. The suite's API token is an output you can export as `BUILDKITE_ANALYTICS_TOKEN`.
- **Flaky tests**: every test Test Engine labels flaky, with reliability, executions, failures and duration. **Mute**, **Skip** or **Enable** it.

Pipelines, clusters, queues, schedules, pipeline templates and cluster secrets can be exported to Terraform for the official `buildkite/buildkite` provider.

## Credentials

1. In Buildkite, open **Personal Settings**, then **API Access Tokens**, and create a token. The link under the token field in Infrawrench opens the form with every scope the plugin uses already ticked. Give the token access to the organization you are connecting.
2. In Infrawrench, paste the token. The **Organization** picker then lists every organization the token can access; pick one.

<insert [Buildkite Add-account form with the API access token filled in and the Organization picker open on the list of organizations] here>

The scopes each feature needs:

| Feature                                  | Scopes                                                |
| ---------------------------------------- | ----------------------------------------------------- |
| Organization, pipelines, builds and jobs | `read_organizations`, `read_pipelines`, `read_builds` |
| Edit pipelines and schedules             | `write_pipelines`                                     |
| Start, cancel and retry builds           | `write_builds`                                        |
| Job logs                                 | `read_build_logs`                                     |
| Artifacts                                | `read_artifacts`                                      |
| Agents                                   | `read_agents`, `write_agents`                         |
| Clusters, queues and agent tokens        | `read_clusters`, `write_clusters`                     |
| Cluster secrets                          | `read_secrets_details`, `write_secrets`               |
| Pipeline templates                       | `read_pipeline_templates`, `write_pipeline_templates` |
| Test Engine                              | `read_suites`, `write_suites`                         |
| Team pickers                             | `read_teams`                                          |

A read-only token works too: the matching actions then fail with a permission error. The account's credential check lists which features the token covers.

## Tips & limits

- Buildkite has no billing API, so Buildkite accounts do not feed cost graphs. The organization page shows monthly active users, which is what user-based plans are billed on.
- Buildkite's REST API allows 50 requests a minute per user and 200 per organization. Listing schedules reads each pipeline in turn, so a large organization takes a few minutes to sync fully; a token of its own for Infrawrench keeps it from competing with your other tools.
- Metrics are worked out from builds, because Buildkite has no metrics endpoint for API tokens: each chart reads up to 500 builds of the selected window.
- Buildkite only shows an agent token's value when it is created. Tokens created from Infrawrench keep it as an output; for other tokens, use **Get credentials** on the cluster to mint a new one.
- Pipelines that still use visual steps show their steps read-only; convert them to YAML steps in Buildkite to edit them here.
- Muting and skipping flaky tests needs test state management turned on for the suite (Pro and Enterprise plans).
- Bastion egress for Buildkite accounts allows `api.buildkite.com`.
