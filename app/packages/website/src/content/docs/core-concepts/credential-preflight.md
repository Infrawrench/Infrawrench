---
title: Credential preflight
description: Verify what a credential can actually do — per capability — and generate a least-privilege policy to paste into the provider console.
sidebar_order: 6
---

A pasted credential can be valid and still be the wrong credential: an AWS key without `ce:GetCostAndUsage` connects fine, lists resources fine, and then the cost graphs silently stay empty forever. Credential preflight closes that gap. For plugins that support it, infrawrench probes the provider with your credential and shows a per-capability checklist — before you save the account, and again any time from account settings.

## The checklist

In the **Add account** form, once the credential fields are filled, a **Check credentials** button appears for supported plugins. Running it shows one row per capability:

- **✓ Ready** — the probe confirmed the credential grants what this capability needs.
- **✗ Missing permissions** — with the exact provider permission strings to grant (e.g. `ce:GetCostAndUsage`, `monitoring.timeSeries.list`, `Billing Read`) and, where possible, a deep link to the provider console page that fixes it.
- **? Couldn't verify** — the probe couldn't decide (provider unreachable, probe not permitted); the account still works, the checklist just can't vouch for it.

![Add-account modal for AWS with the credential check run: resources ✓, metrics ✓, costs ✗ with ce:GetCostAndUsage listed as missing](https://agent-assets.infrawrench.com/docs-screenshots/core-concepts/credential-preflight/add-account-check.png)

Preflight never blocks saving. A missing non-essential capability (costs, metrics) just means that feature stays dark until you grant the permission — the checklist is there so you find out now instead of from an empty graph next week.

To re-run it later — after rotating a token or tightening a policy — open the account page and click **Check credentials** next to **Update credentials**.

![Account settings page with the Check credentials button and the preflight modal showing the per-capability checklist](https://agent-assets.infrawrench.com/docs-screenshots/core-concepts/credential-preflight/account-page-modal.png)

## The least-privilege policy generator

The same panel generates the exact credential template for the capabilities you want, ready to paste into the provider console. Tick the capabilities the account should have and copy the result:

- **AWS** — an IAM policy JSON document. Attach it as an inline policy on the IAM user or role whose keys you entered.
- **GCP** — a custom role definition in YAML for `gcloud iam roles create --file`, then grant the role to the service account. Cost reporting also needs the role or BigQuery Data Viewer on the billing export dataset.
- **Cloudflare** — a token template with the permission-group list and a link to Cloudflare's token creator.
- **Grafana Cloud** — the scopes to give the access policy that mints the token (Security → Access policies in the Grafana Cloud portal).
- **Sentry** — scopes for an internal integration or personal token. Leave out `:write` scopes for a read-only connection.
- **Coralogix** — API key presets and the permission names behind them, under Settings → API Keys.
- **Fastly** — the token scope and the role the token owner needs, with a link to Fastly's token page.
- **Confluent Cloud** — Confluent CLI commands that bind selected organization roles to the service account that owns the Cloud API key.
- **GitHub** — fine-grained token permissions for organization accounts or classic token scopes for enterprise accounts.
- **CoreWeave** — IAM roles to grant the token owner in an IAM access policy.
- **Linode** — personal access token scopes such as `linodes:read_write` and `account:read_only`.

![Least-privilege template generator with the costs capability deselected and the generated AWS IAM policy JSON shown with a Copy button](https://agent-assets.infrawrench.com/docs-screenshots/core-concepts/credential-preflight/policy-template-generator.png)

Deselecting a capability removes its permissions from the template. The generated AWS template also includes `iam:SimulatePrincipalPolicy` so future preflights can report exact per-permission results instead of falling back to sample probes.

## Which plugins support it

[AWS](../plugins/aws.md), [Google Cloud](../plugins/gcp.md), [Cloudflare](../plugins/cloudflare.md), [Grafana Cloud](../plugins/grafana-cloud.md), [Sentry](../plugins/sentry.md), [Coralogix](../plugins/coralogix.md), [Fastly](../plugins/fastly.md), [Confluent Cloud](../plugins/confluent-cloud.md), [GitHub](../plugins/github.md), [CoreWeave](../plugins/coreweave.md) and [Linode](../plugins/linode.md) ship a checklist and policy generator. [Cursor](../plugins/cursor.md) checks whether its key works and whether the plan includes Enterprise Analytics API access. [Temporal Cloud](../plugins/temporal-cloud.md) shows the checklist without a generator because access is granted by account role.

## How it works

- Probes are **read-only**. AWS uses `sts:GetCallerIdentity` and `iam:SimulatePrincipalPolicy`; GCP uses `projects.testIamPermissions`; Cloudflare verifies the token and issues a minimal read per capability; Grafana Cloud reads the organization and makes one minimal read per capability (write scopes cannot be probed without making a change); Sentry reads the organization then probes each capability; Coralogix issues one minimal read per capability; Fastly reads the token's scope and owner's role, then tries one billing read; Confluent Cloud reads the organization then probes each capability; GitHub reads the token's user and probes the organization or enterprise; CoreWeave probes its Cloud API, usage export and metrics service; Linode reads your profile and issues one minimal list call per capability; Cursor lists team members and makes one Analytics API read; Temporal Cloud checks capabilities against the account role.
- On the web app, probes run server-side against submitted or stored credentials. Credentials never round-trip to the browser. On desktop, probes run locally, in-process.
- Preflight results are computed on demand and not stored.
