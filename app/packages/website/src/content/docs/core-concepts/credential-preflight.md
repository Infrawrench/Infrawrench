---
title: Credential preflight
description: Check what a credential can actually do, capability by capability, and generate a least-privilege policy to paste into the provider console.
sidebar_order: 6
---

A credential can be valid and still be the wrong one. An AWS key without `ce:GetCostAndUsage` connects fine and lists resources fine, but your cost graphs stay empty. Credential preflight catches that. For plugins that support it, you can check a credential and see a checklist of what it can and can't do, before you save the account and any time after.

## Check a credential

1. In the **Add account** form, fill in the credential fields.
2. Click **Check credentials** (it appears for supported plugins).
3. Read the checklist. Each capability gets one row:
   - **✓ Ready**: the credential grants what this capability needs.
   - **✗ Missing permissions**: lists the exact provider permissions to grant (for example `ce:GetCostAndUsage`, `monitoring.timeSeries.list`, `Billing Read`) and, where possible, links to the provider console page that fixes it.
   - **? Couldn't verify**: the check couldn't decide (for example, the provider was unreachable). The account still works.

![Add-account modal for AWS with the credential check run: resources ✓, metrics ✓, costs ✗ with ce:GetCostAndUsage listed as missing](https://agent-assets.infrawrench.com/docs-screenshots/core-concepts/credential-preflight/add-account-check.png)

Preflight never stops you saving. If a non-essential capability like costs or metrics is missing, that feature just stays empty until you grant the permission. The point is to find out now, not from a blank graph next week.

## Re-check later

After you rotate a token or tighten a policy, open the account page and click **Check credentials** next to **Update credentials**.

![Account settings page with the Check credentials button and the preflight modal showing the per-capability checklist](https://agent-assets.infrawrench.com/docs-screenshots/core-concepts/credential-preflight/account-page-modal.png)

## Generate a least-privilege policy

The same panel builds the exact credential template for the capabilities you want. Tick the capabilities the account should have, then copy the result:

- **AWS**: an IAM policy JSON document. Attach it as an inline policy on the IAM user or role whose keys you entered.
- **GCP**: a custom role definition in YAML for `gcloud iam roles create --file`. Then grant the role to the service account. Cost reporting also needs the role or BigQuery Data Viewer on the billing export dataset.
- **Cloudflare**: a token template with the permission-group list and a link to Cloudflare's token creator.
- **Datadog**: the scopes to grant a scoped application key (Organization Settings, Application Keys, Edit Scopes). The key's owner must hold the same permissions through their role.
- **Grafana Cloud**: the scopes for the access policy that mints the token (Security > Access policies in the Grafana Cloud portal).
- **Sentry**: scopes for an internal integration or personal token. Leave out `:write` scopes for a read-only connection.
- **Coralogix**: API key presets and the permission names behind them, under Settings > API Keys.
- **Fastly**: the token scope and the role the token owner needs, with a link to Fastly's token page.
- **Confluent Cloud**: Confluent CLI commands that bind selected organization roles to the service account that owns the Cloud API key.
- **GitHub**: fine-grained token permissions for organization accounts, or classic token scopes for enterprise accounts.
- **CoreWeave**: IAM roles to grant the token owner in an IAM access policy.
- **Linode**: personal access token scopes such as `linodes:read_write` and `account:read_only`.

![Least-privilege template generator with the costs capability deselected and the generated AWS IAM policy JSON shown with a Copy button](https://agent-assets.infrawrench.com/docs-screenshots/core-concepts/credential-preflight/policy-template-generator.png)

Untick a capability and its permissions drop out of the template. The AWS template also includes `iam:SimulatePrincipalPolicy`, so later checks can report exact per-permission results.

## Supported plugins

[AWS](../plugins/aws.md), [Google Cloud](../plugins/gcp.md), [Cloudflare](../plugins/cloudflare.md), [Datadog](../plugins/datadog.md), [Grafana Cloud](../plugins/grafana-cloud.md), [Sentry](../plugins/sentry.md), [Coralogix](../plugins/coralogix.md), [Fastly](../plugins/fastly.md), [Confluent Cloud](../plugins/confluent-cloud.md), [GitHub](../plugins/github.md), [CoreWeave](../plugins/coreweave.md) and [Linode](../plugins/linode.md) have both the checklist and the policy generator. [Cursor](../plugins/cursor.md) checks whether its key works and whether your plan includes Enterprise Analytics API access. [Temporal Cloud](../plugins/temporal-cloud.md) shows the checklist without a generator, because access comes from the account role.

## Is it safe to run?

- Checks are **read-only**. They make small read calls against the provider. One exception: on a Cloudflare account connected with OAuth, the cost check creates a temporary billing-read token, uses it and deletes it.
- Some write scopes (for example on Grafana Cloud) can't be checked without making a change, so they may show as unverified.
- On the web app, checks run on the server against the credentials you submitted or saved. Your credentials are never sent back to the browser. On desktop, checks run locally on your machine.
- Results aren't stored.
