---
title: Infrastructure scorecard
description: One graded reading over the six checks you already have — posture, backups, deadlines, quota headroom, cloud access and ownership — plus the daily history that shows whether it is moving.
sidebar_order: 8
---

You already have six pages that each answer one question well. **Scorecard** is
the page that answers "how are we doing?" — one number, the six readings behind
it, and a trend line so it means something.

Open it from the sidebar.

<insert [The Scorecard workspace tab showing the overall grade and score, the 90-day trend sparkline, the "biggest drag" callout, and the grid of six pillar cards below] here>

## The six pillars

| Pillar           | Weight | Reads                                   |
| ---------------- | -----: | --------------------------------------- |
| Security posture |     30 | [Posture checks](./posture-checks.md)   |
| Recoverability   |     25 | [Backup coverage](./backup-coverage.md) |
| Deadlines        |     15 | [Expiry radar](./expiry-radar.md)       |
| Access hygiene   |     15 | [Access review](./access-review.md)     |
| Headroom         |     10 | [Quota radar](./quota-radar.md)         |
| Ownership        |      5 | Resource owner records                  |

Nothing here is a new check. Each pillar reads exactly the feed its own page
reads, so a number on the scorecard can never disagree with the page it links
to. Click a pillar's name to go there.

The weights are fixed and encode a claim we are willing to defend: an exposed
database is worse than an un-owned one, and losing data is worse than running
out of a quota you can ask to have raised. If you disagree, the pillars are
always on screen — the grade is never the only thing you can see.

## Two rules that keep the number honest

**A check with nothing to measure is left out, never scored zero.** If no
connected provider reports quotas, you have no headroom score — not a headroom
score of nought. Scoring the absence of evidence as failure is how a scorecard
teaches people to ignore it.

**Weights are shared out over what was measured.** With four of six pillars
measurable, the overall is the weighted mean of those four. That means
connecting a provider that reports quotas for the first time can never look like
a sudden drop.

A brand new organization shows no grade at all rather than an F. There is
nothing to grade yet, and saying so is more useful than a number.

If a check fails to run — as opposed to having nothing to measure — the page
says so and excludes it. "You have no quota-reporting provider" and "we could
not read your quotas" are different answers, and a summary that blurs them is
one you learn to distrust.

## The trend

A reading is recorded once a day, in the background, for every organization with
at least one connected account. The page draws the last 90 days and keeps 400.

The line is always plotted against the full 0–100 range. An auto-scaled axis
turns a two-point wobble into a cliff, which is the misreading a score is most
vulnerable to.

Days where nothing could be scored are absent from the history rather than
stored as zero — the trend line is a claim that something was measured.

**Your first day has no trend.** Two readings are needed before a line can be
drawn.

## What is not on it

Cost efficiency. It is the obvious seventh pillar, and it is missing on purpose
for now: tag-policy compliance and waste are computed over billing data in a
different part of the stack, and a pillar that could only be scored for
organizations with cost collection enabled would be unassessed for most people
while looking like a gap. [Potential savings](./orphan-finder.md) and [tag
policy](./tag-policy-and-showback.md) remain their own pages.

Terraform drift is absent for a different reason: reconciliation runs per state
document and loads your whole inventory each time, so a daily scorecard would
make it the most expensive job we run. See
[IaC reconciliation](./iac-reconciliation.md).

## Permissions

Reading the scorecard needs **Resources: read** — the same permission every
underlying feed needs, because gating a summary more tightly than its parts
would be a lock on a door with no walls. There is nothing to configure, so
there is no write permission.

## Over the API

`GET /api/org/{orgId}/scorecard` returns the pillars, the overall and the
history. `GET /api/org/{orgId}/scorecard/trend?days=…` returns just the history
— the cheap half, for a dashboard tile that only wants the sparkline. See the
[OpenAPI reference](../team-and-billing/openapi.md).
