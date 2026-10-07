---
title: JFrog
description: Manage a JFrog Platform (cloud or self-hosted) - Artifactory repositories with an artifact browser, builds, Xray watches, policies and violations, users, groups, permissions and access tokens - and chart its storage.
sidebar_order: 50
---

Connect a JFrog Platform, on JFrog Cloud or self-hosted, to manage its Artifactory repositories, security scanning and identities from one place.

## What you can manage

- **Platform**: the account opens on the platform itself, with the Artifactory version, license and add-ons, the storage summary (artifacts, binaries, deduplication savings, file store capacity and usage) and the largest repositories. **Refresh storage summary** asks Artifactory to recalculate it. The Metrics tab charts the same figures.
- **Repositories**: local, remote, virtual and federated repositories with their package type, patterns, Xray indexing and storage use. **Create** a repository (pick the class and package type; a remote one takes its upstream URL, a virtual one its member repositories from a list), **Edit** its description, notes, include and exclude patterns, Xray indexing, blackout, upstream URL, offline mode, cache period, members and default deployment repository, or delete it. The **Files** tab browses its artifacts and lets you upload files, create folders and delete paths (a remote repository shows its cache). **Zap cache** clears a remote repository's cached metadata, and **Recalculate index** rebuilds the index of npm, PyPI, Helm, Debian, RPM, NuGet, Alpine, Cargo, Conda, CRAN, Conan, CocoaPods, Terraform, Pub, Swift and Opkg repositories. The repository URL is an output you can export as `ARTIFACTORY_REPOSITORY_URL`.
- **Builds and build runs**: build info your CI publishes. Each build shows its 25 most recent runs; a run shows when it started, how long it took, the agent, the commit and branch, and its modules and artifacts. Delete a run or a whole build (artifacts are kept).
- **Xray watches**: the repositories and builds each watch scans and the policies it applies. **Enable**, **Disable**, edit the description or delete.
- **Xray policies**: security, license and operational-risk policies with each rule's criteria and actions (block downloads, fail builds, notify). Edit the description or delete. A policy no watch uses is flagged under potential savings, because it is never enforced.
- **Xray violations**: the 100 most recent violations with severity, issue, the watch that raised them, infected components and impacted artifacts.
- **Access tokens**: every token (with an admin token) or your own: subject, scope, issue, expiry and last use. **Create** a token for a user you pick, with a scope (user, admin, or one group's permissions), lifetime and refreshability; the value is shown once and kept as a secret output. **Revoke** a token. Expiring tokens appear on the expiry radar, and an admin token that never expires is flagged as a posture finding.
- **Users**: email, admin, realm, status, groups and last login. Create users, edit email, admin, groups, password, UI access and profile settings, or delete them.
- **Groups**: members, auto-join and admin privileges. Create, edit (including adding and removing members) or delete.
- **Permissions**: every permission target with its repository, build and release-bundle targets and the actions it grants to each user and group. Delete a permission.

## Credentials

1. Copy the **Platform URL** from your browser, for example `https://acme.jfrog.io` (a trailing `/ui` or `/artifactory` is removed for you).
2. Create an access token. For full coverage, open **Administration**, **User Management**, **Access Tokens**, **Generate Token**, choose **Admin** as the scope and copy the token. A user's identity token (**Edit Profile**, **Generate an Identity Token**) also works but sees only what that user may see; users, groups, permissions and the storage summary need an admin token.
3. For a self-hosted platform signed by a private CA, paste the CA certificate under **Advanced options**.

<insert [JFrog Add-account form with the platform URL and access token filled in] here>

**Check credentials** probes repositories, storage, builds, Xray, users and groups, permissions and tokens separately, so you can see which parts a narrower token reaches.

<insert [JFrog platform detail page showing the storage summary and the largest repositories table] here>

<insert [JFrog repository Files tab browsing a Maven repository's folders] here>

## Tips & limits

- Storage figures are a snapshot Artifactory recalculates periodically, so the Metrics tab builds its history from Infrawrench's own readings.
- Listing folder sizes needs Artifactory Pro or higher; on other editions the Files tab still lists folders and files, without sizes.
- Builds need Artifactory Pro or JFrog Container Registry; Xray needs it in your subscription. Without them those sections are simply empty.
- JFrog never shows a token's value again after creation, so only tokens created from Infrawrench have a value to export.
- Watches and policies are edited by sending the whole object back with the changed description or state. Build rules and resource filters in JFrog.
- JFrog has no public billing API, so there is no cost data.
- Provider status comes from JFrog Cloud's status page and only concerns JFrog Cloud; a self-hosted platform is never affected by those incidents.
- Bastion egress has no fixed host list for JFrog, because the platform URL is yours; a platform reachable only through a bastion is not supported yet.
- [Export to Terraform](../features/terraform-export.md) writes repositories (as the per-package-type `artifactory_local_*`, `artifactory_remote_*` and `artifactory_virtual_*` resources) and internal users for the `jfrog/artifactory` provider, with import ids.
