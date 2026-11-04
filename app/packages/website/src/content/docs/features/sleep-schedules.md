---
title: Sleep/wake schedules
description: Stop non-prod resources outside working hours and start them back automatically (off at 19:00, on at 08:00, Mon to Fri), with a projected monthly saving quoted before you save.
sidebar_order: 11
---

A staging database that runs all night and all weekend costs the same as one doing real work. A sleep/wake schedule stops a resource at an off time and starts it again at an on time, on the days and in the timezone you choose. You see the projected monthly saving before you save it.

## Which resources can sleep

Any resource that has start and stop actions can have a schedule. That includes:

- **AWS:** EC2 instances, RDS instances
- **Google Cloud:** Compute Engine VM instances
- **Azure:** Virtual machines (stop = deallocate, the one that stops billing), AKS clusters, App Service and Function Apps, container instances, PostgreSQL and MySQL flexible servers, application gateways, Container Apps
- **DigitalOcean:** Droplets
- **Hetzner Cloud:** Servers
- **Crusoe Cloud:** VMs (stop ends compute billing; attached disks keep billing)
- **Scaleway:** Instances
- **Fly.io:** Machines
- **Neon:** Compute endpoints (stop = suspend; any incoming connection also wakes a suspended endpoint)
- **Together AI:** Dedicated inference endpoints
- **Baseten:** Deployments and environments (stop = deactivate; replicas stop and requests fail until reactivated)
- **ClickHouse Cloud:** Services
- **Databricks:** Clusters, SQL warehouses, apps
- **OVHcloud:** Public Cloud instances
- **CoreWeave:** CKS Node Pools (stop = scale to zero Nodes, start = restore the size it had)
- **Anyscale:** Workspaces (stop terminates the workspace cluster)

The same start and stop actions are buttons on each resource's detail page, so you can always override a schedule by hand.

A stopped resource isn't always free. DigitalOcean and Hetzner keep billing stopped servers, and disks and IPs attached to a stopped VM keep billing everywhere. The projected saving is an estimate based on your real recent spend, not a promise.

## Create a schedule

1. Open an eligible resource and go to its **Schedule** tab.
2. Pick the working days, the off time and the on time.
3. Pick the IANA timezone. The editor previews the next few changes so you can check the zone is right.
4. Check the projected monthly saving. It's based on the resource's spend over the last 30 days and how much of the week it would be off.
5. Save.

![Screenshot of the Schedule tab on an EC2 instance's detail page showing the editor modal with Mon to Fri selected, off 19:00 / on 08:00, Europe/London, and the projected monthly saving quote](https://agent-assets.infrawrench.com/docs-screenshots/features/sleep-schedules/schedule-tab-editor.png)

Each resource can have one schedule. Times are local to the chosen zone and stay correct across daylight saving changes.

## Manage schedules

Go to the Costs panel, **Savings** tab, **Sleep schedules** section. It lists every schedule in your organization with its window, next change, last run result and projected saving. From there you can pause, resume, edit or delete.

![Screenshot of the Sleep schedules section on the Costs panel with several schedules listed, one paused and one showing a "Skipped: freeze" badge](https://agent-assets.infrawrench.com/docs-screenshots/features/sleep-schedules/costs-panel-section.png)

Creating, editing and deleting schedules are recorded in the [audit log](../team-and-billing/audit-log.md).

## What happens when a schedule runs

Infrawrench runs the resource's own start or stop action from the cloud. There's nothing to install on the resource.

- **Change freezes win.** During an [org change freeze](../team-and-billing/change-freeze.md), changes are skipped and the schedule shows "Skipped: freeze". They don't run late when the freeze ends.
- **Changes show in the [change timeline](./change-timeline.md)** marked "via schedule", so a stopped staging VM never looks like unexplained drift.
- **Failures are visible.** A failed start or stop is retried for up to an hour, and the last error shows on the schedule wherever schedules are listed.
- **Missed windows catch up to the right state.** If a run was missed, only the most recent change runs, so the resource ends up in the state it should be in now.

## Other places to use schedules

- **Remediate** on a schedule row shows the provider CLI commands to stop and start that resource, so you can run them by hand or from your own cron. See [Remediation commands](./remediation-commands.md).
- **Mobile:** the Costs tab (under **Savings**) lists schedules with a pause/resume toggle and the same commands to copy. Creating and editing stay on web and desktop.
- **CLI:** `infrawrench schedules` lists windows, next changes and projected savings (`--json` for scripts).
- **MCP:** the `list_schedules` and `create_schedule` tools let agents read and create schedules with the same permissions as the UI. In the in-app [AI chat](./ai-chat.md), `create_schedule` waits for your approval, because it will stop the resource on a timer.

## Permissions

Viewing schedules needs `resources:read`. Creating, editing, pausing and deleting need `resources:write`, the same permission as running a resource's actions directly.
