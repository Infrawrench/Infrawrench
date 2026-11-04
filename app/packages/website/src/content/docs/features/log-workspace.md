---
title: Log workspace
description: Tail several resources' logs in one pane, search across all of them, save the set-up as a named query, and optionally alert when a line matches.
sidebar_order: 12
---

Following a request across a pod, the deployment behind it and the managed database it talks to usually means three browser tabs and a lot of squinting. The Log workspace tails several resources in one pane, either interleaved with a colour label per resource or split into stacked panes, with one search box that filters every stream at once. Save the set-up as a named query to reopen it in one click, and optionally get alerted when a matching line appears.

## Open the workspace and add resources

Click **Logs** in the sidebar (web and desktop). Add resources with the picker, which lists every resource Infrawrench can fetch logs for. Typical sources are Kubernetes pods, deployments, jobs and other workloads, GCP Cloud Run services and Cloud Functions, and DigitalOcean managed databases.

The picker also lists pods and workloads _inside_ managed clusters (GKE, DOKS and other managed Kubernetes), labelled with the cluster they belong to (`api-0 · prod-cluster · My GCP`). You don't need to connect the cluster as a separate Kubernetes account. If a cluster can't be reached when you open the picker, its entries won't appear until you reopen it.

![Screenshot of the Log workspace with three streams added (two Kubernetes pods and a Cloud Run service), interleaved view, showing colour-coded resource labels on each line](https://agent-assets.infrawrench.com/docs-screenshots/features/log-workspace/three-streams-interleaved.png)

Streams refresh every few seconds. For each stream you can pick the container (if there's more than one) or remove it. For the whole workspace you get:

- **Pause / Resume:** freeze the pane while you read, then catch up.
- **Interleaved / Split view:** one merged stream in arrival order, or a stacked pane per resource.
- **Tail length:** how many lines to keep per stream.
- **Search:** one expression that filters every stream instantly.

## Search syntax

Search is kept simple, like grep:

- `timeout upstream`: every term must appear in the line (case-insensitive).
- `"connection reset"`: quotes keep a phrase together.
- `error -healthcheck`: a leading `-` excludes lines containing that term.
- `/HTTP [45]\d\d/`: wrap the whole expression in slashes for a regular expression (`/…/i` for case-insensitive).

Alerts use exactly the same matching, so what you see in the filter box is what an alert would fire on.

Two limits apply to regular expressions. Patterns that can get very slow, such as a repeated group that itself contains a quantifier or an alternation (`(a+)+`, `(a?){20}` or `(a|aa)*`), are rejected with an inline error. And for alerts, a pattern that takes longer than about two seconds on a stream is stopped, and the saved query shows an error instead of alerting.

## Save a query

Name the workspace and click **Save query**. The name, the streams (including chosen containers) and the search expression are saved for your organization, so anyone with resource access can reopen it from the dropdown. Saving, editing and deleting are recorded in the [audit log](../team-and-billing/audit-log.md).

![Screenshot of the saved-query bar with the dropdown open showing several saved queries, one marked (alert), and the name field + Save button](https://agent-assets.infrawrench.com/docs-screenshots/features/log-workspace/saved-query-bar.png)

Saved queries need Infrawrench Cloud. On desktop they appear when you're signed in to an organization. In local-only desktop mode you still get the full multi-resource log pane, just without saved queries or alerts.

## Alert on a match

Tick **Alert on match** on a saved query and it's checked every few minutes. Infrawrench reads the last few hundred lines from each resource in the query, runs your search, and notifies you if any line matches. Notifications go to [mobile push](./mobile-push-notifications.md), Slack and Microsoft Teams under the **Log matches** trigger, which every channel and member can turn on or off in notification settings.

What to expect:

- **Limited lookback:** only recent lines are checked, and counts stop at a cap, so an alert might say "25+ lines".
- **Cooldown:** at most one notification per query every 30 minutes. A service that keeps logging errors reports "still matching" after the cooldown instead of alerting on every check.
- **Errors are shown:** if a check fails (a resource was deleted, credentials expired), the error appears on the query wherever it's listed.

An alert needs a search expression. An empty query would match every line.

You can alert on cluster streams too. Pods get replaced, though, so if a saved query tails a pod that no longer exists, that stream shows an error until you pick the new pod. Tailing the deployment instead avoids this, since its logs follow whichever pod is running.

## On mobile and the API

- **Mobile** lists your organization's saved queries (from the Accounts tab) and opens a read-only viewer that tails a query's streams with its filter applied. Log match pushes open here. Creating queries happens on web and desktop.
- **API:** saved queries live under `/api/org/{orgId}/log-workspaces`. See the [OpenAPI spec](../team-and-billing/openapi.md).

## Permissions

- Viewing the workspace and saved queries needs `resources:read`, the same as each resource's own Logs tab.
- Saving, editing and deleting queries (including the alert toggle) needs `resources:write`.
