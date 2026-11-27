---
title: Introducing Infrawrench Git
description: Git hosting built around reviewing agents' work. Every branch has a page, every push is a version, an agent's doubts and decisions come before its code, and CI, review agents and Terraform costs sit on the same page.
date: 2026-11-27
author: The Infrawrench team
---

[git.infrawrench.com](https://git.infrawrench.com) is Git hosting for teams whose changes increasingly come from agents. It is in beta from today, and the Infrawrench monorepo moved there this afternoon.

Reviewing an agent's work is not like reviewing a colleague's. The diff is often the least interesting part: what matters is what the agent was unsure of, what it decided, what it checked, and whether the second attempt answered what you said about the first. Infrawrench Git puts those on the page first.

## Home

Home is what your team is working on: your branches, the team's, and the ones waiting for your review. Each row says what changed in a sentence and who or which agent made it.

![Home: your changes, the team's changes and suggested reviews](/blog/infrawrench-git/01-home.jpg)

## Every branch has a page

There are no pull requests. A branch's page is the review: the ask that started it, its versions, its notes, findings from reviewers and checks from CI, and the files it changes. Merging happens there too.

![A branch page: the ask, the checks and the version strip](/blog/infrawrench-git/02-branch-page.jpg)

## Every push is a version

Each push to a branch is numbered: v1, v2, v3. A forced push is a version like any other and is marked as one, so nothing a reviewer saw disappears. **Since you last looked** shows only what changed after the version you reviewed.

![The version strip with a forced push marked](/blog/infrawrench-git/03-versions.jpg)

## Notes before code

An agent connected over [MCP](/docs/features/git-agents-and-mcp) records its doubts, decisions and the steps it took while it works. They come before the diff, each with the file and line it is about, and with the code shown only where the note needs it to make sense.

![Doubts and decisions above the diff, with the lines they are about](/blog/infrawrench-git/04-notes.jpg)

Work can start on the forge too: write the ask and it launches a [T3 Code](/docs/features/git-agents) thread itself, or hand it to Claude Code, Codex, Cursor or any other MCP client.

## Review agents

Each repository chooses its review agents. They leave findings on the lines they are about: **must fix**, **should fix** or a **note**, each with its evidence (the code, a command that reproduces it, or the failing check). An open must-fix holds the merge until it is fixed in a later version, or an administrator merges past it and says why.

![A must-fix finding with its code and the reference it cites](/blog/infrawrench-git/05-must-fix.jpg)

## Diffs that keep to the point

Open a file and the diff is folded to the lines the notes and findings are about. **Show full diff** brings back every line.

![A file's diff folded around the notes, with Show full diff](/blog/infrawrench-git/06-file.jpg)

## Send it back to the agent

A review comment can go straight to the agent with **Send to agent**, with a note if it needs one. The agent picks it up, pushes the next version, and the comment says which version answered it.

![Sending a review comment to the agent](/blog/infrawrench-git/07-send-to-agent.jpg)

![The comment answered by the next version](/blog/infrawrench-git/08-answered.jpg)

## CI on every commit

[Infrawrench CI](/blog/introducing-infrawrench-ci) runs on every push, with each commit's checks a click away. A job can leave notes on the branch page too, with `::must-fix` and its kin, so a linter's complaint lands next to the code it is about.

![A commit's checks](/blog/infrawrench-git/09-ci-checks.jpg)

![A CI note on the branch page](/blog/infrawrench-git/10-ci-notes.jpg)

## Terraform, with what it costs

The **Infrastructure** tab finds every Terraform configuration in a repository, managed by Infrawrench or not, and estimates what each costs a month from list prices. Repositories can keep their [Terraform state](/docs/features/git-terraform) here as well.

![Detected Terraform configurations with monthly estimates](/blog/infrawrench-git/11-terraform.jpg)

A branch that changes Terraform shows the resources it creates, changes and destroys, and what that does to the monthly bill.

![A branch's Terraform changes and their cost](/blog/infrawrench-git/12-branch-cost.jpg)

## Moving in

- **Push over HTTPS** with an access token. SSH is coming soon.
- **Keep another host in sync** with [push mirrors](/docs/features/git-mirrors): branches and tags are pushed there after every push, with the same commit ids.
- **Bring your issues** across from GitHub, with their labels, milestones and comments.

That is how we moved: the monorepo lives on Infrawrench Git now, and its old repository is a read-only mirror that our release workflows still run from.

## Pricing

Your own repositories are free: unlimited public repositories, three private ones and 1 GiB of private storage. An organization's namespace is part of the paid plan (Pro, $20 per seat per month), with unlimited private repositories and 10 GiB of storage included. CI and review agents run on an organization's plan. [Git in the app](/docs/features/git) has the details.

## Try it

Sign in at [git.infrawrench.com](https://git.infrawrench.com) with your Infrawrench account, pick a username and push. [Getting started](/docs/features/git-getting-started) walks through it.
