---
title: Docker Hub
description: Manage Docker Hub repositories and tags, organizations with their members, teams and invites, personal and organization access tokens, the audit log and your pull rate limit.
sidebar_order: 50
---

Connect a Docker Hub account to manage the images you publish and the organizations you run. (To manage containers on a Docker engine, use the [Docker](./docker.md) plugin.)

## What you can manage

- **Namespaces**: your own account and each organization you pick, with repository counts, lifetime pulls and storage. For an organization also members, teams, and the **Restrict Images** setting (Business subscriptions), which you can change with **Edit**. An organization's **Logs** tab shows its audit log. The Metrics tab charts pulls, repositories and storage over time.
- **Repositories**: pulls, stars, storage, visibility, content types and the last push. **Create** a repository (public or private) in any namespace, **Edit** its short description, overview (README), visibility and immutable-tag rules, **Grant team access** (read, read & write or admin) in an organization, or delete it. The **Tags** tab browses every tag with its digest and size. The image reference is an output you can export as `IMAGE`. Public repositories show as a low-severity posture finding so nothing internal is published by accident.
- **Tags**: the 25 most recently pushed tags of each repository with digest, size, platforms and when they were last pushed and pulled. Delete a tag. Tags Docker Hub marks inactive (no push or pull for a month) appear under potential savings.
- **Teams**: description and members. Create, rename, change members (by Docker ID) or delete.
- **Members**: role, teams and, when the organization has insights enabled, last sign-in. Change a member's role (member, editor or owner) or remove them.
- **Invites**: pending invitations. **Create** invites for several Docker IDs or email addresses at once with a role and an optional team, **Resend**, or cancel.
- **Personal access tokens**: label, access, last use and expiry. Create one (the value is shown once and kept as a secret output), rename, **Deactivate** or **Reactivate**, or delete.
- **Organization access tokens**: which repositories each token reaches and what it may do there. Create one by picking repositories and permissions from lists, edit its label and description, deactivate, reactivate or delete it.
- **Pull rate limit**: on a Personal plan, the quota radar tracks pulls used in the current 6-hour window. Paid plans have no pull limit, so nothing is shown.

## Credentials

1. In Docker Hub, open **Account settings**, **Personal access tokens**, **Generate new token**. Choose **Read, Write & Delete** to manage repositories and tags (**Read-only** is enough to browse). Copy the token (`dckr_pat_…`).
2. In Infrawrench, enter your **Docker ID** and paste the token. The **Namespaces** picker lists your account and your organizations; pick the ones to manage, or leave it empty for all.
3. To connect a single organization with an **organization access token** instead (Admin Console, **Access tokens**), enter the organization's name as the Docker ID.

<insert [Docker Hub Add-account form with the Docker ID, access token and the Namespaces picker open] here>

<insert [Docker Hub repository detail page with the Tags tab open] here>

## Seats

Docker Hub accounts report the members of each organization they manage to the **Seats** page, which flags members who have not signed in for your inactivity threshold and adds up what removing them would save. Personal namespaces have no seats.

- **What is read**: every member of every organization in **Namespaces** (`GET /v2/orgs/{org}/members`, all pages). Owners, editors, members and guests each take a seat. Pending invitations take one too, but they are listed under invites, not here. Unlike the resource lists, an organization the token cannot read fails the whole read rather than being skipped, because a skipped organization would look as if all its seats had been removed; use an owner's token, or leave that organization out of **Namespaces**.
- **Activity**: the later of the member's **last sign-in** and **last seen** time. Docker only returns these when the organization has [Insights](https://docs.docker.com/accounts/organization/insights/) turned on, a Docker Business feature your Docker account executive enables. Without them every member shows activity unknown and is never flagged. Docker does not say when someone joined an organization, so a member with no sign-in on record is also shown as unknown rather than idle.
- **Price**: the **Seat price** you set under **Advanced options** on the account. The Hub API does not report your plan, so without it each seat is estimated at the lowest organization list price, $15 per seat per month for Team billed annually (Team monthly is $16, Business $24; docker.com/pricing, October 2026), and labelled as an estimate.
- **Remove** takes the member out of the organization and all its teams, which frees their seat; they can be invited again later. Docker bills for the seats you bought, not the members using them, so also reduce the seat count under **Billing**; that change applies from the next billing cycle. Docker refuses to remove an organization's last owner, so a sole owner is shown as not removable.
- **Cheaper tier**: never suggested; the API does not report the plan.
- **Permissions**: listing members and removing them need an organization owner's personal access token, or an organization access token allowed to manage members.
- [Remediation commands](../features/remediation-commands.md) for a flagged member get a bearer token, show the member's row, then remove them (`curl` and `jq`).

## Tips & limits

- Docker Hub only lets you list and manage **personal access tokens** when the connection signs in with your password; a token-based connection shows an error on that section. Accounts under enforced SSO cannot use a password.
- Team, member, invite and organization-token management needs an organization owner. Sections a token cannot read are skipped rather than failing the whole account.
- Docker Hub's API has no webhook, vulnerability scan or pull-history endpoints, so those are not shown. Pull counts are lifetime totals; the Metrics tab builds a trend from Infrawrench's own readings.
- Repository description, visibility and delete, and tag delete, use the routes Docker's own Terraform provider and Hub CLI use; Docker's API reference does not list them yet.
- Never-pulled repositories and inactive tags under potential savings carry [remediation commands](../features/remediation-commands.md) you can run yourself: `curl` calls that exchange your Docker ID and access token (`$DOCKERHUB_USERNAME`, `$DOCKERHUB_TOKEN`) for a bearer token, save the repository's settings and tag list (or pull the tag) and then delete it. They need `jq`, and the delete uses the same undocumented route as the in-app Delete action.
- Provider status comes from Docker's status page. Its incidents do not say which product they affect, so only incidents about Hub, the registry, pulls, pushes, images, tags or sign-in are shown.
- [Export to Terraform](../features/terraform-export.md) writes repositories, teams and members for Docker's `docker/docker` provider.
