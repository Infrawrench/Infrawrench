# Connecting the forge's MCP server

The server is one address, `https://git.infrawrench.com/mcp`, over Streamable HTTP. A client that supports OAuth needs only the address: the first call opens the user's browser on git.infrawrench.com to sign in and allow the application. Adding a server is the user's to do; give them the command for their client.

## Claude Code

```sh
claude mcp add --transport http infrawrench-git https://git.infrawrench.com/mcp
```

Then `/mcp` inside Claude Code, pick `infrawrench-git` and sign in.

## Codex

```sh
codex mcp add infrawrench-git --url https://git.infrawrench.com/mcp
codex mcp login infrawrench-git
```

## Cursor

In `~/.cursor/mcp.json`, or `.cursor/mcp.json` in the project:

```json
{
  "mcpServers": {
    "infrawrench-git": {
      "url": "https://git.infrawrench.com/mcp"
    }
  }
}
```

## Without a browser

A client that cannot open a browser sends a personal access token (`iwg_...`, made under **Settings > Access tokens** on git.infrawrench.com, with the `repo:write` scope to record traces and report findings) in the `Authorization` header:

```sh
claude mcp add --transport http infrawrench-git https://git.infrawrench.com/mcp \
  --header "Authorization: Bearer $IWG_TOKEN"
```

Read the token from the environment. Never write it into a file that is committed, a trace entry or a note.

## What a connection may do

| Scope        | Allows                                                                                 |
| ------------ | -------------------------------------------------------------------------------------- |
| `repo:read`  | Read the repositories the user can read, with their branches, reviews and traces.      |
| `repo:write` | Push, record traces, answer instructions, report findings and start work, as the user. |

A connection never does more than its user can, and never administers a repository. `whoami` says whose credential it is and whether it can write.

## The tools

| Tool                         | Use                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `whoami`                     | Whose credential this is, and whether it can write.                                  |
| `list_my_branches`           | Open branches that involve the user and have something new.                          |
| `get_branch`                 | A branch's page, state, versions, and how many instructions and findings are open.   |
| `get_version_diff`           | A version's diff: the whole change, that version alone, or since an earlier version. |
| `record_trace`               | Record the ask, steps, decisions, evidence and doubts of the work on a branch.       |
| `list_instructions`          | What reviewers sent to the agent that writes the branch.                             |
| `mark_instruction_delivered` | Say an instruction has reached you.                                                  |
| `mark_instruction_answered`  | Say which version answers an instruction. Left out, it is the next push.             |
| `list_findings`              | What reviewers and CI jobs found on a branch.                                        |
| `report_finding`             | Report a reviewer's findings on a version.                                           |
| `start_work`                 | Create a branch and its page, as a draft, from an ask, before any code exists.       |
