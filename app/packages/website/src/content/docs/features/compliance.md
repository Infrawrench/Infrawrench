---
title: Compliance
description: Map the evidence Infrawrench already collects to SOC 2 and ISO 27001 controls, see which controls have evidence and which have gaps, give every control an owner, and produce evidence packs on demand or on a schedule.
sidebar_order: 13
---

Most of what an auditor asks for during a SOC 2 or ISO 27001 audit is something Infrawrench already records: who holds access in your clouds, who approved a time-boxed role, what changed and when, which resources are exposed, which vulnerabilities are running, whether backups exist and restore, which sessions were recorded, and how incidents were handled. Compliance maps that evidence onto framework controls, tells you which controls have evidence and which have gaps, and packages it into an **evidence pack** you can hand over.

Open it from the **Compliance** tile in the sidebar. It is a cloud feature: the evidence lives in your organization's data.

<insert [The Compliance tab with SOC 2 selected: count chips (evidence, gaps, not applicable, unowned), the controls table grouped by family with one control expanded to show its evidence sources] here>

## Frameworks

| Framework     | Edition                                                      | Controls covered |
| ------------- | ------------------------------------------------------------ | ---------------- |
| SOC 2         | Trust Services Criteria (2017, revised points of focus 2022) | 16               |
| ISO/IEC 27001 | 2022, Annex A                                                | 20               |

Each framework lists only the controls Infrawrench can evidence: for SOC 2, criteria in the monitoring (CC4), access (CC6), system operations (CC7), change management (CC8), risk mitigation (CC9) and availability (A1) families; for ISO 27001, Annex A organizational (5.x) and technological (8.x) controls. Control environment, people, physical security and management-system requirements need evidence from outside the product. Control titles in Infrawrench are short paraphrases; read the id against your own copy of the standard for the authoritative wording.

## Where the evidence comes from

Every control is mapped to one or more **evidence sources**. Each source reads data Infrawrench already holds; nothing calls a provider while the screen loads.

| Source                    | What it shows                                                                                                       | Kind     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------- |
| Access review             | Principals in your clouds, with stale, admin, unowned and past-rotation findings and accepted risks                 | Snapshot |
| Just-in-time access       | Role requests, approvals, durations, and grants that did not end cleanly                                            | Period   |
| Audit log                 | Every change made through Infrawrench, attributed to a member or API key                                            | Period   |
| Posture checks            | Exposure and configuration findings, and accepted risks                                                             | Snapshot |
| Vulnerability management  | Open findings by severity, running versus not running, age against fix targets, and fixes with their time to fix    | Snapshot |
| Backup coverage           | Stateful resources and whether a backup protects them against your recovery objectives                              | Snapshot |
| Restore drills            | Drills performed in the period, and which protected resources are untested, failing or overdue                      | Period   |
| Change timeline           | Resources created, changed and deleted across every account                                                         | Period   |
| Change freezes            | Freezes in effect during the period, and who opened them                                                            | Period   |
| Session recordings        | Whether recording is on, the retention applied, and the sessions recorded                                           | Period   |
| Incidents and postmortems | Declared incidents, time to mitigate and resolve, and whether each resolved incident has notes or a follow-up issue | Period   |

**Snapshot** sources describe your organization as it stands when the status is generated; the period does not filter them, and the evidence pack says so. **Period** sources are filtered to the dates you choose.

### Vulnerability management in detail

The vulnerability source answers the three questions auditors ask of a vulnerability programme:

- **What is open, and is it running?** Open findings per severity, split by whether the affected artifact runs on a synced resource, plus how many running resources carry a critical or high finding.
- **Is anything overdue?** Each open finding's age since the scanner first saw it, against fix targets of 15 days (critical), 30 (high), 90 (medium) and 180 (low). These are common remediation targets rather than a framework requirement, and they are printed beside the figures.
- **How long do fixes take?** Infrawrench records when a finding leaves your scanner's results, so the pack shows the findings fixed during the period and the median days to fix per severity.

A running critical or high finding past its target, a running finding on the CISA Known Exploited Vulnerabilities list, or a scanner whose last read failed counts as a gap. Findings on images nothing runs are reported as figures, not gaps. See [Vulnerabilities](./vulnerabilities.md).

## Control status

Every control has one of three statuses:

- **Evidence present**: at least one of its sources has evidence and none shows a gap.
- **Gaps**: a source shows a problem (for example, critical posture findings are open, or a protected database has never been restore-tested), or none of its sources produced any evidence. "We could not look" is a gap, never a pass. Expanding the control lists every reason.
- **Not applicable**: you marked it so, with a written justification. A justification is required, because it is the first thing an auditor reads on a statement of applicability.

A source can also be **unavailable** for you: if you lack the permission that reads it (for example `session-recordings:read`), the source says which permission it needs rather than hiding the whole screen.

## Owners, applicability and notes

Expand a control to set:

- **Applicable**: switch it off and write the justification.
- **Owner**: a member of your organization, or a free-text label such as a team or alias. If an owner later leaves, the control shows **Former member** so the gap is visible rather than silently unowned.
- **Notes**: anything the auditor should read next to the control.

**Reset** returns a control to applicable and unowned. Changing these needs `org:settings:write`, and every change is recorded in the [audit log](../team-and-billing/audit-log.md).

## Evidence packs

**Download evidence pack** builds a ZIP for the chosen framework and period:

| File                             | Contents                                                                    |
| -------------------------------- | --------------------------------------------------------------------------- |
| `summary.pdf`                    | Counts, the controls table, every control with gaps, every evidence source  |
| `controls.csv`, `controls.json`  | One row per control: status, owner, applicability, justification, reasons   |
| `controls/<id>.csv`, `.json`     | One control's evidence, source by source                                    |
| `evidence/<source>.csv`, `.json` | The rows behind each source (for example every audit log entry)             |
| `manifest.json`                  | Organization, framework, period, who generated it, and every file's SHA-256 |
| `SHA256SUMS`                     | The manifest's own hash, then every file's, in `sha256sum -c` format        |

To check a pack has not been altered, unzip it and run `sha256sum -c SHA256SUMS` (or `shasum -a 256 -c SHA256SUMS` on macOS). CSV cells that start with `=`, `+`, `-` or `@` are prefixed with a tab so a spreadsheet shows them as text. Period sources carry at most 10,000 rows each; the source's figures say when there were more.

Downloading a pack needs `audit:read` and is recorded in the audit log.

### Scheduled packs

Under **Pack schedules**, add a schedule to send a pack automatically:

- **Monthly** sends the previous calendar month's pack on the day you choose.
- **Quarterly** sends the previous quarter's pack in January, April, July and October.

Email recipients get the ZIP attached. Slack channels get a summary with the ZIP uploaded in the thread (this needs the `files:write` scope on your Slack app; without it the summary still arrives). Microsoft Teams gets the summary and a link, because Teams webhooks cannot carry files. **Send now** builds and sends the pack the next delivery would cover. Scheduled packs are built with full access to every source; creating one needs `org:settings:write`.

<insert [The Pack schedules section with a quarterly schedule to two email recipients, showing its next send time and last delivery status] here>

## Mobile

The mobile app shows each framework's control status read-only: counts, controls with their owners, and the evidence behind each. Editing controls, downloading packs and scheduling them stay on the web and desktop apps.

## CLI

```bash
infrawrench compliance                       # SOC 2 status for the last 90 days
infrawrench compliance status --framework iso27001 --gaps
infrawrench compliance export --framework soc2 --from 2026-07-01 --to 2026-09-30 --out q3.zip
infrawrench compliance frameworks --json
```

Every command takes `--json`. `export` writes the ZIP to `--out` (or the server's file name in the current directory).

## Terraform

Control decisions and pack schedules can be managed as code with the [Terraform provider](./terraform-provider.md):

```hcl
resource "infrawrench_compliance_control" "cc6_6" {
  framework_id = "soc2"
  control_id   = "CC6.6"
  applicable   = true
  owner_label  = "Platform security"
}

resource "infrawrench_compliance_control" "a1_3" {
  framework_id  = "soc2"
  control_id    = "A1.3"
  applicable    = false
  justification = "Availability criteria are out of scope for this report."
}

resource "infrawrench_compliance_pack_schedule" "quarterly" {
  framework_id      = "soc2"
  cadence           = "quarterly"
  send_day_of_month = 3
  hour              = 8
  timezone          = "Europe/London"
  email_recipients  = ["audit@example.com"]
}
```

## API

`GET /api/org/{orgId}/compliance`, `/compliance/pack`, `/compliance/controls/{frameworkId}/{controlId}` and `/compliance/schedules` are documented in the [OpenAPI reference](../team-and-billing/openapi.md) under **Compliance**.
