---
title: Push mirrors
description: Keep a repository on another Git host, such as GitHub, equal to a repository on git.infrawrench.com. Covers the token, what is mirrored, exclude patterns, the last result and what to do when a push is refused.
sidebar_order: 11
---

A push mirror keeps a repository on another Git host equal to one on [git.infrawrench.com](./git-getting-started.md). After every push here, the same branches and tags are pushed there, with the same commit ids. Use it to keep a GitHub repository as a copy while its workflows, releases or integrations still run from GitHub.

A mirror only pushes. Nothing is ever fetched from the target, so work pushed there directly is not brought back.

## Add a mirror

An administrator of the repository opens **Settings > Mirrors** and clicks **Add mirror**.

<insert [A repository's Settings > Mirrors page with the Add mirror form open: the Address field filled with "https://github.com/acme/widgets.git", User name "x-access-token", a masked Token field, an Exclude box holding "dependabot/**", and the checked box "Overwrite and delete branches and tags on the target"] here>

| Field                    | What to enter                                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Address**              | The target repository's HTTPS address, for example `https://github.com/acme/widgets.git`. It has to be a public address, with no user or token in it. |
| **User name**            | The user the token is sent with. `x-access-token` works for any GitHub token. Other hosts usually take your user name there.                          |
| **Token**                | A token the target accepts as a password over HTTPS, allowed to push. See below for GitHub.                                                           |
| **Exclude**              | Optional. Branches and tags the mirror leaves alone, one pattern a line.                                                                              |
| **Overwrite and delete** | On by default: the target is made equal, so a branch rewritten or deleted here is rewritten or deleted there. Off: only new commits and new refs go.  |

The target repository has to exist already. The first run starts at once and pushes everything; a long history is pushed in parts.

### A token for GitHub

Create a fine-grained personal access token with access to the one target repository and these repository permissions:

- **Contents: Read and write**, to push branches and tags.
- **Workflows: Read and write**, if the repository has files under `.github/workflows`. Without it GitHub refuses any push that changes one.
- **Metadata: Read-only**, which GitHub adds itself.

The token is kept encrypted and is never shown again. To replace it, click **Edit** and enter a new one. Changing the address asks for the token again.

GitHub starts workflows for pushes made with such a token, as it does for a person's push.

## What is mirrored

- Every branch and every tag, by default. Annotated tags keep their tag objects.
- Commits are sent as they are, never rewritten, so every commit and tag has the same id on both sides.
- Nothing else: issues, branch pages, review comments and settings stay here.

With **Overwrite and delete** on, branches and tags that exist only on the target are deleted from it, unless a pattern excludes them.

### Exclude patterns

A pattern excludes a ref on both sides: it is not pushed, and it is not deleted from the target.

- `*` matches within one part of a name, `**` across slashes.
- A pattern is compared with the short name of branches and tags alike: `dependabot/**` excludes every branch under `dependabot/`, and `v0.*` excludes the tag `v0.9` and a branch of that name.
- A pattern that starts with `refs/heads/` or `refs/tags/` is compared with the full name, to mean only branches or only tags: `refs/tags/nightly-*`.

Exclude the branches and tags that are created on the target itself, by a tool or a release workflow, so the mirror does not delete them. `refs/tags/**` leaves every tag alone.

## When it runs

- After every push, merge, and branch or tag deletion here, usually within seconds.
- When you click **Sync now**.
- Once an hour, as a check that the target is still equal.

Pushes are mirrored in order. When two pushes land close together, the target ends at the later one.

Tags are pushed at most three at a time, because GitHub does not start workflows for tags that arrive more than three in one push.

## The last result

Each mirror shows its state and what its last run did.

<insert [Settings > Mirrors listing two mirrors: one marked In sync with "In sync 2 minutes ago · 1 ref updated" and its exclude patterns, and one marked Failed with the message "The remote refused the credential" and "next try in 4 minutes", each with Sync now, Edit, Turn off and Remove buttons] here>

| State       | Meaning                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| **In sync** | The last run left the target equal to this repository.                          |
| **Waiting** | Something was pushed and a run is about to start.                               |
| **Pushing** | A run is under way.                                                             |
| **Failed**  | The last run did not finish. The message says why, and when the next try is.    |
| **Off**     | The mirror is turned off. Pushes here are not sent until it is turned on again. |

A failed mirror is tried again after a minute, then after twice as long each time, up to once an hour. A new push, **Sync now** or a change to the mirror tries at once.

Refs the target refused are listed with the target's own reason. Common ones:

| Message                                                | What to do                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| The remote refused the credential                      | The token is wrong, expired or revoked. **Edit** the mirror and enter a new one.                |
| The remote does not let this credential push           | The token lacks write access to the repository's contents.                                      |
| The remote has no such repository                      | Check the address, and that the token can see the repository.                                   |
| A ref refused with "protected branch" or a rule's name | A rule on the target blocks the push. Let the token's account bypass it, or exclude the branch. |
| A ref refused because of a workflow file               | Give the token **Workflows: Read and write**.                                                   |
| The remote answered with a redirect                    | The repository was renamed or moved. Enter its current address.                                 |

**Remove** stops the mirror and deletes its token. The target keeps everything it has.

## Limits

- Five mirrors a repository.
- HTTPS only, to a public address. Redirects are not followed.
- One push carries at most 1 GiB. A larger history is pushed in smaller parts along the branch; a single commit larger than that cannot be mirrored.
