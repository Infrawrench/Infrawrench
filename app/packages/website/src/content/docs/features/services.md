---
title: Services and scorecards
description: Group resources across providers into the services you actually run, see each service's cost, reliability, findings, on-call and changes on one page, grade every service against your own production-readiness bar, and see one org grade over it all.
sidebar_order: 13
---

Your infrastructure is organised by provider and account. Your organisation is not: people talk
about the **checkout API**, which happens to be a load balancer and four containers on AWS, a
Neon database, a Cloudflare Worker and a queue. A **service** in Infrawrench names that set,
says who owns it and how critical it is, and links the reliability objects that already exist on
their own: [SLOs](./slos.md), [runbooks](./runbooks.md) and an [on-call schedule](./on-call.md).
A **scorecard** then grades every service against the bar your organisation sets: does it have an
owner, an on-call rotation, an SLO within budget, tested backups? Above the scorecards sits one
[org grade](#org-grade) for the whole organisation, with a 90-day trend.

<insert [The Services tab listing several services: name, Tier 1 / Tier 2 badges, owning team, member count and a Gold / Silver / Bronze level badge per scorecard] here>

Find it under **Services** in the sidebar on the web app and the desktop app (cloud mode). The
mobile app has a read-only list, service page and scorecard overview (with the org grade), and the
`infrawrench` [CLI](./cli.md) prints the same data with `infrawrench services` and
`infrawrench scorecards` (which prints the org grade first).

## Creating a service

Click **New service** and fill in what you know; everything except the name is optional and
every reference is a picker:

- **Name** and **slug**. The slug is the short handle the CLI and links use
  (`checkout-api`); it is derived from the name when you leave it empty.
- **Tier**, from 1 (critical, customer-facing) to 4 (experimental). Scorecards can apply to some
  tiers only.
- **Owners**: an owning team (free text, shown but never alerted) and owning members (people in
  your organisation).
- **Links** to dashboards, repositories and docs.
- **On-call schedule**, **SLOs** and **runbooks**, chosen from the ones you already have.
- **Monthly budget**, read by the _Cost within budget_ scorecard check.

### Members: picked by hand, or matched by rules

A service's resources come from two places, and you can use both:

- **Picked members.** Click **Add resources** on the service page and choose them from any
  account and provider.
- **Membership rules.** A rule adds every resource that matches it, now and in future, so a
  database tagged `service=checkout` joins the service the next time it syncs without anybody
  editing the service. A rule matches on:
  - a **tag**: a key, and optionally a value (keys are case-insensitive, values exact);
  - a **virtual tag**: one of your [virtual tags](./virtual-tags.md) and a value.
    Virtual tags are computed from billing data, so this only matches resources with
    per-resource cost rows in the last 30 days;
  - the **name**: contains, starts with, ends with, or is exactly a pattern.

  Any rule can be narrowed to one provider or one account.

Removing a resource that a rule matched **excludes** it rather than deleting it, because the rule
would otherwise add it straight back. Excluded resources are listed at the bottom of the members
table with a **Restore** button.

<insert [The service editor: name and tier filled in, the owners picker with two members chosen, the on-call schedule, SLO and runbook pickers, and the membership rules section with a tag rule "service = checkout" and a name rule "starts with checkout-" narrowed to the AWS provider] here>

## The service page

<insert [One service's page: the header with tier, owners and links; summary cards for 30-day cost by currency, SLO standing, who is on call now and next, and open findings; the members table with resource, provider, account, how it joined (rule or picked) and owner; and the scorecard section with a score, a Silver badge and the failing checks] here>

- **Cost**: the last 30 days of spend on the service's resources, per currency and per provider.
  Only resources with per-resource cost rows can be priced, and the page says how many were. If
  your role is limited to some costs by a [cost visibility scope](../team-and-billing/cost-visibility.md),
  the figure only includes spend your scope allows. If cost data cannot be read, the card says
  _unavailable_ rather than showing zero.
- **SLOs**: each linked SLO's status and remaining error budget.
- **On call**: who holds the linked schedule right now, until when, and who is next.
- **Runbooks** linked to the service.
- **Findings** on the service's resources: [posture](./posture-checks.md) findings by severity,
  [orphaned resources](./orphan-finder.md), and [backup coverage](./backup-coverage.md) gaps,
  including stateful resources without a recent passing restore drill.
- **Recent changes** to the service's resources over the last week, from the
  [change timeline](./change-timeline.md).
- **Members**, with each resource's own [owner](../core-concepts/resource-ownership.md) when one is
  recorded.

## Where else services show up

- **Alerts** about a resource (a metric alert, a probe watching an endpoint) add a line naming the
  service it belongs to, for example _Service: Checkout API_.
- **Declared incidents** list the services their affected resources belong to, in the incident
  view, the announcement and the [postmortem](./incident-mode.md).
- **The weekly digest** names the service of the week's biggest cost move.

## Scorecards

A scorecard is a list of **checks**, each with a **weight**, and a ladder of **levels**. Every
service the scorecard applies to gets a **score**, the weight of the checks it passes divided by
the weight of the checks that apply to it, and the highest **level** that score reaches.

New organisations start with a **Production readiness** scorecard that uses every built-in check
and three levels: **Bronze** at 50%, **Silver** at 75% and **Gold** at 90%. Edit it, add your own
scorecards, or delete it; a deleted default is not recreated.

<insert [The Scorecards view: a matrix with services down the side and two scorecards across the top, each cell showing a score percentage on the level's colour, filters for scorecard, tier, level and team above it] here>

### Built-in checks

| Check                        | Passes when                                                                                                                                  |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Has an owner                 | The service names an owning team or at least one owning member.                                                                              |
| Has an on-call schedule      | The service links an enabled on-call schedule.                                                                                               |
| SLO within budget            | At least one SLO is linked, and every linked SLO has more than the minimum share of its error budget left (0% by default).                   |
| Has a runbook                | At least one enabled runbook is linked.                                                                                                      |
| Backed up and restore-tested | Every stateful resource is within your backup policy and has a verified restore drill in the last 90 days (configurable).                    |
| No serious posture findings  | No resource has an open posture finding at the chosen severities (critical and high by default).                                             |
| No orphaned resources        | No resource is flagged by the orphan finder.                                                                                                 |
| Required tags present        | Every taggable resource carries the required tags: the ones you list on the check, or your organisation's tag policy when the list is empty. |
| Cost within budget           | The last 30 days of spend is within the service's monthly budget.                                                                            |
| No critical vulnerabilities  | No running resource has an open, undismissed [vulnerability](./vulnerabilities.md) at the chosen severities (critical by default).           |
| Change failure rate          | The service's [change failure rate](./dora-metrics.md) over the window is at or under the threshold (15% over 30 days by default).           |

A check that has nothing to judge is **not applicable** and does not count either way: a
stateless service is not marked down for lacking restore drills, a service without a budget
is not judged on cost, the vulnerability check waits until a scanner has reported, and the change
failure rate check waits until the service has shipped a production change in the window. A check whose data could not be read counts as **failing** and says so,
because a broken feed must not lift a service's level. A service where no check applies is
**not scored**, never zero.

### Editing a scorecard

<insert [The scorecard editor: name, the "Applies to" tier selector with Tier 1 and Tier 2 chosen, the checks list with weights and a parameter field (Restore drill within 90 days), and the levels list with Bronze, Silver and Gold, their minimum scores and colours] here>

- **Checks**: add any check type, set its weight from 1 to 10, rename it, and set its parameters.
- **Levels**: up to six, each with a name, a minimum score from 0 to 100 and a colour.
- **Applies to**: limit the scorecard to some tiers (for example, a stricter bar for Tier 1).
  Empty means every service.
- **Alert on level drop**: when a service drops a level (Gold to Silver, or below the lowest
  level), Infrawrench sends a **Scorecards** alert through your [alert routing](./alert-routing.md)
  rules. Rises are recorded but not announced.

Scores are recalculated every hour, and within a few minutes of any change to a service or a
scorecard. **Evaluate now** in the editor re-scores immediately; drops found that way are recorded
but not announced, since you just changed the bar yourself. Each service's page shows its score
history over the last 90 days.

## Org grade

The top of the **Scorecards** view answers "how are we doing overall?": one letter grade and a
score out of 100, a 90-day trend line, the pillar dragging the grade down hardest, and a card per
pillar. Each card says what it measured, what it would take to move it, and links to the page it
reads.

<insert [The top of the Scorecards view: the org grade header showing a B and 84, a 90-day trend sparkline, the "Biggest drag" callout naming Recoverability, and the grid of seven pillar cards (one marked "Not assessed"), with the service scorecard matrix starting below] here>

### The seven pillars

| Pillar            | Weight | Reads                                                            |
| ----------------- | -----: | ---------------------------------------------------------------- |
| Security posture  |     25 | [Posture checks](./posture-checks.md)                            |
| Recoverability    |     20 | [Backup coverage](./backup-coverage.md)                          |
| Service standards |     15 | The service scorecards on this page                              |
| Deadlines         |     15 | [Expiry radar](./expiry-radar.md)                                |
| Access hygiene    |     10 | [Access review](./access-review.md)                              |
| Headroom          |     10 | [Quota radar](./quota-radar.md), scored on the worst quota       |
| Ownership         |      5 | [Resource owner records](../core-concepts/resource-ownership.md) |

Nothing on the org grade is a new check. Each pillar reads exactly the feed its own page reads, so
a number here can never disagree with the page it links to. **Service standards** is the mean
score of every service on every scorecard that applies to it by tier, the same cells the matrix
below shows; services that are not scored (no check applies, or not evaluated yet) are left out.

The weights are fixed and encode a claim we are willing to defend: an exposed database is worse
than an unowned one, and losing data is worse than running out of a quota you can ask to have
raised. Service standards takes 15 because it carries what no other pillar measures (on-call,
SLOs, runbooks, vulnerabilities, change failure rate), and its weight came from posture,
recoverability and access, the pillars your default scorecard already partly re-checks per
service. If you disagree with the weights, the pillars are always on screen: the grade is never
the only thing you can see.

Grades: **A** from 90, **B** from 80, **C** from 65, **D** from 50, **F** below 50.

### Two rules that keep the number honest

**A pillar with nothing to measure is left out, never scored zero.** If no connected provider
reports quotas, you have no headroom score, not a headroom score of nought. An organisation with no
services has no service standards score.

**Weights are shared out over what was measured.** With four of seven pillars measurable, the
grade is the weighted mean of those four, so connecting a provider that reports quotas, or scoring
your first service, can never look like a sudden drop.

A brand new organisation shows no grade at all rather than an F. If a pillar fails to run, as
opposed to having nothing to measure, the page says so and leaves it out: "you have no
quota-reporting provider" and "we could not read your quotas" are different answers.

### The trend

A reading is recorded once a day, in the background, for every organisation with at least one
connected account. The page draws the last 90 days and keeps 400. The line is always plotted
against the full 0 to 100 range, so a two-point wobble does not look like a cliff. Days where
nothing could be graded are absent rather than stored as zero, and your first day has no line:
two readings are needed before one can be drawn.

The [compliance evidence](./compliance.md) for service scorecards includes the org grade's daily
readings over the pack's period.

### What is not on it

**Cost efficiency** is missing on purpose for now: waste and tag-policy compliance are computed over
billing data, and a pillar that could only be scored for organisations with cost collection
enabled would be unassessed for most people while looking like a gap.
[Potential savings](./orphan-finder.md) and [tag policy](./tag-policy-and-showback.md) remain their
own pages. **Terraform drift** is absent because reconciliation loads your whole inventory per
state document, which would make a daily grade the most expensive job we run. See
[IaC reconciliation](./iac-reconciliation.md).

### Over the API

`GET /api/org/{orgId}/scorecards/org` returns the pillars, the grade and the last 90 days of
history. `GET /api/org/{orgId}/scorecards/org/history?days=` returns just the history, up to 400
days, for a tile that only wants the sparkline. See the
[OpenAPI reference](../team-and-billing/openapi.md).

## Terraform

Services and scorecards can be managed with the
[Infrawrench Terraform provider](./terraform-provider.md) (`infrawrench_service`,
`infrawrench_scorecard`, and the `infrawrench_service` data source). Membership rules are the
Terraform-native way to define members; resources picked by hand are managed in the app.

## Permissions

Viewing services, scorecards and the org grade needs **Read resources**; creating and editing
services and scorecards needs **Write resources**, the same permissions as resource ownership and
SLOs. The org grade has nothing to configure.
