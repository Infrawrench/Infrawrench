---
title: Runbooks
description: The checklist somebody wrote at 03:00, kept where the steps are actually performed — with a record of who did what, which is the half a postmortem always misses.
sidebar_order: 11
---

Every team has procedures that live in three places: a wiki page nobody
updated, a Slack thread from the last incident, and one engineer's memory.
**Runbooks** puts them in the tool where the steps are actually performed.

Open it from the sidebar.

<insert [The Runbooks workspace tab on the Runbooks view, showing three runbooks with their step counts and "run N times" lines, one expanded to show its ordered steps] here>

## Writing one

A runbook is a name, a note about when to use it, and an ordered list of steps.
Each step is one of three kinds:

- **Manual** — something a person does, ticked off when it is done.
- **Workflow** — a button that starts one of your [workflows](./workflows.md).
- **Link** — an `https://` URL, for the provider console or the dashboard.

Three kinds and not a scripting language, on purpose. A runbook is written by
whoever is on call _for_ whoever is on call next, and the moment it needs a
language it stops being written. Anything genuinely automated belongs in a
workflow, which already has a sandbox, approvals, secrets and a run history.

Each step also takes a body in Markdown — the detail nobody remembers at 03:00.

You can say which **resource types** and which **tag** a runbook is about. That
is used to answer "which runbook applies here", never to restrict who can open
it: a runbook nobody can find is the failure this feature exists to fix.

## Running one

Press **Run**. Every step becomes a row you can mark done, skipped or failed,
with a note — the output, or why you skipped it.

<insert [A runbook run in progress, showing the progress bar, the "Next:" line, and per-step Done / Skipped / Failed buttons with a note field] here>

Three things about a run are worth knowing:

**A run is a snapshot.** Starting one copies every step's title into the run, so
if the runbook is rewritten next week, the record still says what you were
actually asked to do at 03:14.

**Two people can work the same run.** Each tick is a separate write, so
whoever is doing steps 3 and 4 will not clobber whoever just finished step 2.

**Closing a run does not settle its outstanding steps.** A run completed with
three steps still pending is a true and useful record — it says the incident
ended before the checklist did — and quietly marking them done would erase the
one thing a postmortem wants to know.

A closed run cannot be reopened. Start another one; a second attempt is a
second run, and that is the honest description of it.

Skipped steps count as settled but not as done, so the progress figure cannot
be reached by skipping everything.

## Permissions

**Reading and performing** a runbook needs **Resources: read**. The person who
can see the infrastructure is the person who will be woken up about it, and a
checklist nobody on call can open is worse than no checklist.

**Writing** one needs **Organization settings: write**. A procedure is an
org-wide statement about how something is done, and it is read by strangers
under pressure.

Ticking a step is not an act of configuration, so it takes the read permission
too — requiring an admin to tick a box mid-incident is how a team stops using
the checklist.

## Retiring one

Turn a runbook **off** rather than deleting it. Off hides it from the list of
things to run and keeps every run performed against it. Deleting takes that
history with it.

## What a workflow step does — and does not — do

A workflow step records **which workflow run** the responder started. It does
not run the workflow itself; that goes through the normal workflow routes with
their own permission, approvals and secrets. Anything else would make a runbook
a second way to execute code behind a weaker gate than the first.

## Not yet

Runbooks do not appear as a tab on a resource's own page, and there is no
snippet step that runs a command over SSH. Both are natural next steps; the
resource-type selector is already stored, so the "which runbooks apply here"
lookup exists and only wants a surface.

## Over the API

`/api/org/{orgId}/runbooks` for the documents,
`/api/org/{orgId}/runbooks/{id}/runs` to start one, and
`/api/org/{orgId}/runbooks/runs/*` for the runs and their steps. See the
[OpenAPI reference](../team-and-billing/openapi.md).
