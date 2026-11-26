---
title: Agents and MCP on git.infrawrench.com
description: Connect Claude Code, Codex, Cursor or any other MCP client to git.infrawrench.com so an agent can record its work on a branch, read what reviewers sent back and report findings.
sidebar_order: 9
---

[git.infrawrench.com](./git-getting-started.md) has a [Model Context Protocol](https://modelcontextprotocol.io/) server. An agent connected to it can record what it did on a branch, see how the branch stands, read what reviewers sent back and say which push answers it. An agent that reviews code can read a change and report what it found.

Every push to a branch makes a version of it. What an agent records before a push is attached to the version that push makes, so a reviewer reads the work and how it was done side by side.

## Connect

The server is one address:

```
https://git.infrawrench.com/mcp
```

It speaks Streamable HTTP, in the current protocol revision (2026-07-28) and the earlier `initialize` handshake.

### Claude Code

```sh
claude mcp add --transport http infrawrench-git https://git.infrawrench.com/mcp
```

Then run `/mcp` inside Claude Code, pick `infrawrench-git` and sign in.

### Codex

```sh
codex mcp add infrawrench-git --url https://git.infrawrench.com/mcp
codex mcp login infrawrench-git
```

### Cursor

Add the server to `~/.cursor/mcp.json`, or to `.cursor/mcp.json` in a project:

```json
{
  "mcpServers": {
    "infrawrench-git": {
      "url": "https://git.infrawrench.com/mcp"
    }
  }
}
```

### T3 Code

T3 Code runs other agents (Codex, Claude Code and others), and each uses its own MCP settings. Add the server to the agent you run there, as above.

### Anything else

Any client that speaks Streamable HTTP works. One that supports OAuth needs only the address. One that does not takes a token: see [Without a browser](#without-a-browser).

## Sign in

The first time a client connects, it opens your browser on git.infrawrench.com. Sign in if you are not signed in already. The page then shows:

- the name the application gave,
- what it will be able to do,
- where you are sent back to afterwards.

Click **Allow** to connect it, or **Deny**.

<insert [The authorization page on git.infrawrench.com for an MCP client: the application's name in the heading, the two things it will be able to do, "Signed in as" and "Sends you back to" with a 127.0.0.1 address, the warning about a program on this computer, and the Deny and Allow buttons] here>

A desktop application is sent back to an address on your own computer, and the name it shows is the one it gave itself. Allow it only when you started the sign-in yourself, just now.

A client asks for one or both of these:

| Scope        | What it allows                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `repo:read`  | Read the repositories you can read, with their branches, reviews and traces.                   |
| `repo:write` | Push, record traces, answer instructions, report findings, comment and start work, all as you. |

A connected application never does more than you can, and never administers a repository.

### End an application's access

Go to **Settings > Access tokens** on git.infrawrench.com. A connected application is listed with your tokens, under its name followed by `(MCP)`. Click **Revoke**. It stops working at once and has to sign in again.

The expiry shown for a connected application is when it lapses if it is left unused. It renews itself while it is in use, and lapses 30 days after it was last used.

### Without a browser

An agent that cannot open a browser sends a credential in the `Authorization` header instead:

- **A personal access token** (`iwg_`). Create one under **Settings > Access tokens**, with the `repo:write` scope if the agent records traces. See [Access tokens](./git-getting-started.md#access-tokens).
- **A CI job's token.** A job in [Infrawrench CI](./ci.md) can record traces on the branch its run is of. It cannot use the other tools, and a run of a fork's pull request cannot record.

```sh
claude mcp add --transport http infrawrench-git https://git.infrawrench.com/mcp \
  --header "Authorization: Bearer $IWG_TOKEN"
```

For Codex, set `bearer_token_env_var` on the server in `~/.codex/config.toml`. For Cursor, add `"headers": { "Authorization": "Bearer ${env:IWG_TOKEN}" }`.

## Tools

| Tool                         | What it does                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `whoami`                     | Says whose credential the connection uses and whether it can write.                                             |
| `list_my_branches`           | Lists open pull requests that involve you and have something you have not looked at.                            |
| `get_branch`                 | Reads a branch's pull request, its state, its versions, and how many instructions and findings are open.        |
| `get_version_diff`           | Reads a diff of a version: the whole change, what that version changed, or everything since an earlier version. |
| `record_trace`               | Records the ask, steps, decisions, evidence and doubts of the work on a branch.                                 |
| `list_instructions`          | Lists what reviewers sent to the agent that writes the branch.                                                  |
| `mark_instruction_delivered` | Says an instruction has reached the agent.                                                                      |
| `mark_instruction_answered`  | Says which version answers an instruction. Left out, it is the next push.                                       |
| `list_findings`              | Lists what review agents found on a branch.                                                                     |
| `report_finding`             | Reports a review agent's findings on a version.                                                                 |
| `start_work`                 | Creates a branch and a draft pull request from an ask, before any code exists.                                  |

Tools take a repository as `owner/name`, and a branch either by its name or by its pull request's number.

## What an agent records

`record_trace` takes one or more entries, each of a kind:

| Kind       | For                                                                                   |
| ---------- | ------------------------------------------------------------------------------------- |
| `ask`      | What the agent was asked to do.                                                       |
| `step`     | Something it did.                                                                     |
| `decision` | A choice between alternatives, and why.                                               |
| `evidence` | Something it ran or checked: the command, its exit code and the output that shows it. |
| `doubt`    | Something it is not sure of, or did not do.                                           |
| `note`     | Anything else a reviewer should know.                                                 |

An entry can point at files and lines, so it shows beside them in the diff.

Entries wait on the branch until the next push, and then belong to the version that push made. The branch does not have to exist yet. Entries nobody pushes after are dropped after 30 days.

Recording needs write access to the repository.

### Secrets

Tokens, keys and passwords in an entry are replaced with `***` before it is stored: known token formats, private key blocks, passwords in URLs, `Authorization` and `Cookie` headers, values given to names such as `TOKEN` or `PASSWORD`, and random-looking values given to configuration names. This catches common mistakes. It cannot recognise every secret, so do not record one on purpose.

### Limits

- An entry's text is at most 32 KB.
- Command output is an excerpt. Past 16 KB its start and end are kept, with a line saying how much was left out.
- A branch holds at most 1,000 entries waiting for a push.

## Reviewing with an agent

An agent that reviews reads the change with `get_branch` and `get_version_diff`, then calls `report_finding` with a severity for each problem: `must_fix`, `should_fix` or `note`. It needs write access to the repository.
