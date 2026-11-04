---
title: Vulnerabilities
description: See CVE findings from each provider's own scanner next to what is actually running, so "a critical CVE in an image" becomes "a critical CVE in an image used by 3 running pods and 1 Lambda function".
sidebar_order: 12
---

Your container registries and code hosts already scan what you push. What they can't tell you is whether the vulnerable thing is actually _running_, because the scanner sits in one account, the cluster in another and the Lambda function in a third.

Vulnerabilities pulls in the findings from each connected provider's scanner and matches them to your resources. Instead of one more row in a list of thousands, you see "CVE-2024-3094 (critical) in `api`, running in 3 Pods and 1 Lambda Function".

It sits next to [Posture checks](./posture-checks.md). Posture covers misconfiguration; this page covers known vulnerabilities in what you run.

## Connect a scanner

Infrawrench doesn't scan anything itself. It reads what your provider's scanner has already found, using the credential the account already has (plus one extra permission for some providers):

| Provider                       | Scanner                           | What it reports                                    | Setup                                                                        |
| ------------------------------ | --------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| [AWS](../plugins/aws.md)       | Amazon Inspector                  | ECR images, Lambda functions, EC2 instances        | Inspector enabled; `inspector2:ListFindings`                                 |
| [GCP](../plugins/gcp.md)       | Artifact Analysis                 | Artifact Registry images                           | Container Scanning API enabled; `roles/containeranalysis.occurrences.viewer` |
| [Azure](../plugins/azure.md)   | Microsoft Defender for Cloud      | Azure Container Registry images                    | Defender for Containers or Defender CSPM; Reader                             |
| [GitHub](../plugins/github.md) | Dependabot                        | Dependencies in repositories                       | Dependabot alerts on; token with Dependabot alerts read                      |
| [GitLab](../plugins/gitlab.md) | Dependency and container scanning | Dependencies in projects, scanned container images | GitLab Ultimate; Developer role or above                                     |
| [JFrog](../plugins/jfrog.md)   | JFrog Xray                        | Docker images and packages in indexed repositories | Xray subscription; Read on the indexed repositories                          |

Each plugin page lists the exact permissions. Docker Hub isn't supported, because Docker offers no public API for per-CVE Docker Scout findings.

An account with no scanner shows **nothing**, never "0 vulnerabilities". The screen lists every account that can report findings and when each was last read. If a read fails (Inspector not enabled, a missing scope, a plan without scanning), it tells you why and links to the fix, so an empty list never looks like a clean bill of health.

Findings are refreshed every six hours.

## How findings are matched to what's running

A finding names what it affects: an image and digest, a function or a host. Infrawrench matches that to running resources such as Kubernetes pods and workloads, Cloud Run services and jobs, Azure Container Apps, Container Instances, and App Service and Function Apps running a container:

- **By digest**: a pod running exactly the scanned image digest. This is certain.
- **By the resource the scanner named**: an Inspector finding on a Lambda function matches that function. Also certain.
- **By tag**, only when the running resource has no digest to compare: same repository, and the running tag is one the scanned image carries. This is shown as unconfirmed, because a tag can move.

If a resource runs a different digest from the scanned one, it does **not** match, even with the same tag. The tag has moved on and the vulnerable build is no longer what runs there. Stopped pods and finished jobs don't count as running.

Findings in source repositories (Dependabot, GitLab dependency scanning) are never "running" by themselves. They stay in the list and show up under the not running filter.

## Use the Vulnerabilities screen

Open **Vulnerabilities** from the sidebar or from Posture, on web, desktop or mobile. You get:

- severity buckets (critical, high, medium, low and unscored) with how many of each are running;
- filters for severity, running or not, fix available, known exploited, account and [service](./services.md);
- one row per finding: advisory, severity, CVSS, the package and the version that fixes it, the image, which resources run it, and the services those resources belong to. Expand a row to see each resource and open it. Click a service to open it in the Services tab.

<insert [Web Vulnerabilities screen: severity buckets with running counts, the Running filter on, and a critical finding expanded to show the three pods and one Lambda function running the image] here>

**Unscored** findings are ones the scanner hasn't rated yet. They are never counted as low. "Fix available" follows the scanner: if it doesn't say, the screen shows unknown rather than no.

### See which services are affected

When the resources running a vulnerable artifact belong to a [service](./services.md), the finding names it. A critical CVE in an image used by pods in **Checkout** and **Payments** shows both, most critical tier first. A newly tagged resource is picked up on the next refresh.

The **Service** column and filter appear once at least one finding runs inside a service, and the filter only offers services that have findings. On mobile, services show on each row and as filter chips.

<insert [Web Vulnerabilities screen with the Service column showing Checkout and Payments chips on a critical finding, and the service filter open] here>

### Known exploited

Infrawrench checks CISA's [Known Exploited Vulnerabilities catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) twice a day. A finding whose CVE (or one of its aliases) is in the catalog is marked, with a note when CISA lists known ransomware use, and sorts above others of the same severity. Known exploited findings always alert, whatever your minimum severity.

## Dismiss a finding

Not every CVE matters. Maybe the vulnerable code path isn't reachable, or the package only lives in a build stage. Click **Dismiss**, add an optional note, and pick a scope:

- **This image or repository**: the advisory is accepted for that repository, including future rebuilds.
- **Everywhere**: the advisory is accepted across the organization.

A dismissed finding drops out of the list, the counts and the alerts. You'll find it under **Dismissed** with who accepted it and why, and you can restore it from there. Dismissing needs the `resources:write` permission and is recorded in the audit log, so people who can only read the screen can't silence a finding. On mobile you can dismiss, but without a note.

## Get alerts

New findings that matter go out through [alert routing](./alert-routing.md) under the **Vulnerabilities** trigger. By default that means **critical findings in something that is running**, plus anything known exploited. Each finding alerts once, when it first becomes alertable (first seen, or first deployed), not daily. Findings from one scan arrive as one message.

Organization admins can use the settings on the screen to lower the threshold to high, include findings that aren't running, or turn alerts off. You can also manage these settings with the [`infrawrench_vulnerability_alert_settings`](./terraform-provider.md) Terraform resource.

## Compliance evidence

The [Compliance](./compliance.md) tab uses these findings as vulnerability management evidence for SOC 2 and ISO 27001 controls: open findings by severity, running versus not running, age against fix targets, and findings fixed during a period with their time to fix. Infrawrench records when a finding disappears from your scanner's results so time to fix can be measured.

## CLI

```sh
infrawrench vulns                       # worst first, with what runs each one
infrawrench vulns --severity critical,high --running --kev
infrawrench vulns --service checkout     # only what runs in one service (id, slug or name)
infrawrench vulns --resource <resourceId> # only what runs on one resource
infrawrench vulns --json
infrawrench vulns sources               # which scanners are connected, and any read errors
infrawrench vulns dismiss CVE-2024-3094 'image:ghcr.io/acme/api' --reason "not reachable"
infrawrench vulns restore CVE-2024-3094 'image:ghcr.io/acme/api'
```

The table gains a `service` column when any finding runs inside a service, and `--json` includes each finding's `services`. The CLI reads your cloud organization; there is no local mode.

## MCP

The MCP server offers three tools, with the same permissions as the screen:

- `list_vulnerabilities`: filter by severity, running, fix available, known exploited, provider, account, service, resource and text. Each finding names its services. It always reports the total counts and how many findings are dismissed, so you can tell a quiet answer from a silenced one.
- `dismiss_vulnerability`
- `restore_vulnerability`

## API

`GET /api/org/{orgId}/vulnerabilities` returns the findings, each with the `services` its running resources belong to. Use `?serviceId=` to narrow to one service, or `?resourceId=` (repeatable, up to 100) for findings running on those resources. Both recompute the counts. `POST` and `DELETE /vulnerabilities/dismissals` manage dismissals, and `GET`/`PUT /vulnerabilities/settings` the alert settings. See the [API reference](../team-and-billing/openapi.md).

## In your editor and launcher

The [VS Code extension](./vscode-extension.md) adds a **Vulnerabilities** line to the Terraform hover ("2 critical, 1 high (1 known exploited)"), and the [Raycast extension](./raycast-extension.md) adds a row to each resource's detail. Both link here. Neither shows anything when no connected account runs a scanner.

## Limits

- Findings are only as fresh as your scanner and the six-hourly refresh. A rebuild shows up once the scanner has scanned it and the next refresh runs.
- Some scanners are read in limited pages (the most recent images, a capped number of pages per region or project). Those sources are marked as partial on the screen.
- Matching only works for resources in accounts you've connected. A finding can read as not running when it runs somewhere Infrawrench can't see.
- AWS Lambda functions are matched by name within the scanning account, so two functions with the same name in different regions of one account aren't told apart.
