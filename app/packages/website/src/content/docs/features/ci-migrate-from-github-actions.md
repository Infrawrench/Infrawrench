---
title: Migrate from GitHub Actions
description: Move a repository's GitHub Actions workflows to Infrawrench CI with a coding agent, using the migration skill, and what to set up in Infrawrench before switching over.
sidebar_order: 14
---

A coding agent can move a repository's CI from GitHub Actions to [Infrawrench CI](./ci.md) for you. The migration skill teaches it how: it reads your `.github/workflows/`, writes a pipeline in `.infrawrench/ci/` for each workflow, and reports which jobs moved, which became cloud jobs and which have to stay on GitHub Actions.

<skill id="migrate-github-actions" />

## Use it

1. Add the skill to your agent from the card above: **Add it to your agent** shows the files for Claude Code, Cursor, GitHub Copilot and Codex. In Claude Code it is one command that puts the skill in `.claude/skills/migrate-github-actions/`; any other agent can be pointed at the single-file version.
2. Ask the agent to migrate the repository's GitHub Actions workflows to Infrawrench CI. It lists what it found and where each job will go before writing anything.
3. Review the pipelines it writes, push them to a branch and open a pull request. Both systems run on the same commits until you switch.

## What it does

- **Turns steps into scripts.** A job runs one script in its own sandbox, so a GitHub job's `run` steps become one script and its setup, checkout and install steps disappear: dependencies are installed once per commit from your lockfile.
- **Splits monorepo jobs.** A job that runs every package's tests or type checks becomes a job per package, in dependency order, with the [task cache](./ci.md#monorepos-a-job-per-package) skipping the packages a change cannot affect.
- **Replaces actions.** Setup, cache and artifact actions become pipeline settings; cloud logins become [lent connections](./ci.md#connections); Docker builds become [cloud jobs](./ci.md#cloud-jobs) on your own accounts.
- **Flags what does not move.** macOS and Windows runners, and events Infrawrench CI does not run on, such as releases and tag pushes, stay on GitHub Actions. The agent says which and why.

## Before you switch

The agent cannot change your organization's settings, so its report lists what you need to do in the **CI** tab:

- Add each secret and variable the pipelines read, under [Secrets and variables](./ci.md#secrets-and-variables).
- Turn on what jobs borrow under [CI access](./ci.md#ci-access): cloud connections that run jobs, connections and SSH keys lent to them.
- Tick **Run CI** for the repository's GitHub account, if it is not on yet.

Once the Infrawrench runs pass, delete the workflows that moved and change your branch protection rule to require **Infrawrench CI / pull request**, which covers every job of the run.
