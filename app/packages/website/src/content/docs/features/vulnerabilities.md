---
title: Vulnerabilities
description: CVE findings from each provider's own scanner, joined to what is actually running, so "a critical CVE in an image" becomes "a critical CVE in an image used by 3 running pods and 1 Lambda function".
sidebar_order: 12
---

Every container registry and code host already scans what you push. What none of them can tell you is whether the vulnerable thing is _running_: the scanner lives in one account, the cluster in another, the Lambda function in a third. Vulnerabilities reads the findings each connected provider's own scanner has produced and joins them to the resources Infrawrench already syncs, so a finding reads as "CVE-2024-3094 (critical) in `api`, running in 3 Pods and 1 Lambda Function" rather than one more row in a list of thousands.

It sits next to [Posture checks](./posture-checks.md): posture is misconfiguration over synced fields, this is known vulnerabilities in what you run.

## Where findings come from

Infrawrench never scans anything itself. It reads what your provider's scanner already found, with the credential the account already uses (plus, for some providers, one extra permission):

| Provider                       | Scanner                           | What it reports                                    | Setup                                                                        |
| ------------------------------ | --------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| [AWS](../plugins/aws.md)       | Amazon Inspector                  | ECR images, Lambda functions, EC2 instances        | Inspector enabled; `inspector2:ListFindings`                                 |
| [GCP](../plugins/gcp.md)       | Artifact Analysis                 | Artifact Registry images                           | Container Scanning API enabled; `roles/containeranalysis.occurrences.viewer` |
| [Azure](../plugins/azure.md)   | Microsoft Defender for Cloud      | Azure Container Registry images                    | Defender for Containers or Defender CSPM; Reader                             |
| [GitHub](../plugins/github.md) | Dependabot                        | Dependencies in repositories                       | Dependabot alerts on; token with Dependabot alerts read                      |
| [GitLab](../plugins/gitlab.md) | Dependency and container scanning | Dependencies in projects, scanned container images | GitLab Ultimate; Developer role or above                                     |
| [JFrog](../plugins/jfrog.md)   | JFrog Xray                        | Docker images and packages in indexed repositories | Xray subscription; Read on the indexed repositories                          |

Each plugin page lists the exact permissions. Docker Hub is not on the list: Docker documents no public API for per-CVE Docker Scout findings, only the dashboard and the CLI.

A provider with no scanner contributes **nothing**, never "0 vulnerabilities". The screen lists every account that can report findings with when it was last read, and when a read fails (Inspector not enabled, a missing scope, a plan that does not include scanning) it says why, with a link to the fix, instead of showing an empty list that looks like a clean bill of health.

Findings are collected every six hours by the poller. Reading the screen makes no provider calls.

## The join to what is running

A finding names what it affects: an image repository and digest, a function, a host. Resource types that run images (Kubernetes pods and workloads, Cloud Run services and jobs, Azure Container Apps, Container Instances, App Service and Function Apps running a container) declare which synced fields hold their image references, and Infrawrench matches the two:

- **By digest** first: a pod running exactly the scanned image digest. This is certain.
- **By the resource the scanner named**: an Inspector finding on a Lambda function joins that function. Also certain.
- **By tag**, only when the running resource has no digest to compare: same repository, and the running tag is one the scanned image carries. Shown as unconfirmed, because a tag can move.

A running resource whose digest differs from the scanned one does **not** match, even with the same tag: that tag has moved on and the vulnerable build is no longer what runs there. A stopped pod or a finished job does not count as running.

Findings in source repositories (Dependabot, GitLab dependency scanning) are never "running" by themselves; they stay in the inventory and filter as not running.

## The Vulnerabilities screen

Web, desktop and mobile all get a **Vulnerabilities** screen, reachable from the sidebar and from Posture:

- severity buckets (critical, high, medium, low and unscored) with how many of each are running;
- filters for severity, running or not, fix available, and known exploited;
- one row per finding: advisory, severity, CVSS, the package and the version that fixes it, the image, and which resources run it. Expand a row to see each resource and open it.

<insert [Web Vulnerabilities screen: severity buckets with running counts, the Running filter on, and a critical finding expanded to show the three pods and one Lambda function running the image] here>

**Unscored** findings are ones the scanner has not rated yet; they are never folded into low. "Fix available" follows the scanner: when it does not say, the screen says unknown rather than no.

### Known exploited

Infrawrench mirrors CISA's [Known Exploited Vulnerabilities catalog](https://www.cisa.gov/known-exploited-vulnerabilities-catalog) twice a day from its public feed. A finding whose CVE (or one of its aliases) is in the catalog is marked, with a note when CISA lists known ransomware use, and sorts above others of the same severity. Known exploited findings always alert, whatever the minimum severity.

## Dismissing a finding

Not every CVE matters: the vulnerable code path is not reachable, the package is only in a build stage. **Dismiss** takes an optional note and a scope:

- **This image or repository**: the advisory is accepted for that repository, including future rebuilds of it.
- **Everywhere**: the advisory is accepted across the organization.

A dismissed finding leaves the list, the counts and the alerts, and appears under **Dismissed** with who accepted it and why; restore it from there. Dismissing needs the `resources:write` permission and is recorded in the audit log, so members who can read the screen cannot silence it. Mobile dismisses without a note.

## Alerts

New findings that matter are sent through [alert routing](./alert-routing.md) under the **Vulnerabilities** trigger: by default, **critical findings in something that is running**, plus anything known exploited. Each finding is alerted once, when it first becomes alertable (first seen, or first deployed), never again daily; findings from one scan arrive as one message.

The settings on the screen (organization admins) change the threshold to high, include findings that are not running, or turn the alerts off. They are also the [`infrawrench_vulnerability_alert_settings`](./terraform-provider.md) Terraform resource.

## The CLI

```sh
infrawrench vulns                       # worst first, with what runs each one
infrawrench vulns --severity critical,high --running --kev
infrawrench vulns --json
infrawrench vulns sources               # which scanners are connected, and any read errors
infrawrench vulns dismiss CVE-2024-3094 'image:ghcr.io/acme/api' --reason "not reachable"
infrawrench vulns restore CVE-2024-3094 'image:ghcr.io/acme/api'
```

The CLI reads the cloud organization; there is no local mode, because findings are collected by the cloud poller.

## MCP

The MCP server exposes `list_vulnerabilities` (filters for severity, running, fix available, known exploited, provider, account and text; it always reports the whole-feed counts and how many findings are dismissed, so a quiet answer is distinguishable from a silenced one), `dismiss_vulnerability` and `restore_vulnerability`, with the same permissions as the screen.

## API

`GET /api/org/{orgId}/vulnerabilities` returns the joined feed, `POST` and `DELETE /vulnerabilities/dismissals` manage dismissals, and `GET`/`PUT /vulnerabilities/settings` the alert settings. See the [API reference](../team-and-billing/openapi.md).

## Caveats

- Findings are only as fresh as the scanner and the six-hourly read. A rebuild shows up after the scanner has scanned it and the next read.
- Several scanners are read in bounded pages (the most recent images, a capped number of pages per region or project). Those sources are marked as partial on the screen.
- The join needs the running resource to be synced. A workload in an account Infrawrench does not connect to cannot be matched, so a finding can read as not running when it runs somewhere we cannot see.
- AWS Lambda functions are matched by name within the scanning account; two functions with the same name in different regions of one account are not told apart.
