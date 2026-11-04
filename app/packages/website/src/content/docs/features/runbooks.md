---
title: Runbooks
description: Keep your team's checklists where the work happens, run them step by step, and keep a record of who did what.
sidebar_order: 11
---

Most teams keep their procedures in three places: a wiki page nobody updated, a Slack thread from the last incident, and one engineer's memory. **Runbooks** puts them in the tool where you actually do the steps, and records who did each one.

Open it from the sidebar.

<insert [The Runbooks workspace tab on the Runbooks view, showing three runbooks with their step counts and "run N times" lines, one expanded to show its ordered steps] here>

## Write a runbook

A runbook has a name, a note about when to use it, and an ordered list of steps. Each step is one of three kinds:

- **Manual:** something a person does and ticks off when it's done.
- **Workflow:** a button that starts one of your [workflows](./workflows.md).
- **Link:** an `https://` URL, for the provider console or a dashboard.

If a step needs real automation, put it in a workflow, which has its own sandbox, approvals, secrets and run history.

Each step can also have a Markdown body for the details nobody remembers at 03:00.

You can say which **resource types** and which **tag** a runbook is about. This helps people find the right runbook. It never restricts who can open it.

## Run a runbook

Press **Run**. Every step becomes a row you can mark done, skipped or failed, with an optional note (the output, or why you skipped it).

<insert [A runbook run in progress, showing the progress bar, the "Next:" line, and per-step Done / Skipped / Failed buttons with a note field] here>

A few things to know:

- **A run keeps the steps as they were when you started.** If someone rewrites the runbook next week, the record still shows what you were asked to do.
- **Several people can work the same run.** One person ticking step 2 won't overwrite someone else's step 3.
- **Closing a run leaves unfinished steps as they are.** A run closed with steps still pending is an accurate record that the incident ended before the checklist did.
- **A closed run can't be reopened.** Start a new run instead.
- **Skipped steps count as settled, not done**, so you can't reach full progress by skipping everything.

## Permissions

- **Reading and running** a runbook, including ticking steps, needs **Resources: read**. Anyone who can see the infrastructure can follow the checklist.
- **Writing** a runbook needs **Organization settings: write**.

## Retire a runbook

Turn a runbook **off** instead of deleting it. Off hides it from the list of things to run and keeps every past run. Deleting removes that history too.

## What a workflow step does

A workflow step records **which workflow run** the responder started. Starting the workflow itself still goes through the normal workflow permissions, approvals and secrets.

## Not available yet

Runbooks don't appear as a tab on a resource's own page, and there's no step type that runs a command over SSH.

## Use the API

- `/api/org/{orgId}/runbooks` for the runbooks
- `/api/org/{orgId}/runbooks/{id}/runs` to start a run
- `/api/org/{orgId}/runbooks/runs/*` for runs and their steps

See the [OpenAPI reference](../team-and-billing/openapi.md).
