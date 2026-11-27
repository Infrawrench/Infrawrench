---
title: Agents on git.infrawrench.com
description: Start work from an ask in a T3 Code thread or with any agent over MCP, send reviewer instructions to the agent that wrote a branch, and connect a T3 Code environment.
sidebar_order: 9
---

On [git.infrawrench.com](./git-getting-started.md) a branch can name the agent that writes it. Work starts from an ask, the agent pushes versions, and reviewers send it instructions from the branch's page.

## Start work from an ask

Open **Start work** in a repository's **Branches** and pick who does the work.

| Agent                 | Where it runs                                | How it starts                                                               |
| --------------------- | -------------------------------------------- | --------------------------------------------------------------------------- |
| **T3 Code** (default) | A thread in one of your T3 Code environments | You write the ask and the forge launches the thread itself                  |
| **Another agent**     | Wherever you run it                          | You install the forge's MCP server in it, and it starts the work when asked |

With **T3 Code**, pick the environment, write what you want done, and choose the branch to start from. The forge creates a branch at the base branch's commit and opens the branch's page as a draft, with the ask as its description. The agent's first push is version 1.

<insert [Start work on git.infrawrench.com with T3 Code selected under Agent: the Environment, Thread and Project pickers, the Ask editor with a few lines written, Start from set to main, the Branch field holding the name made from the ask, and the Start work button] here>

With **Another agent**, the page shows how to install the forge's [MCP server](./git-agents-and-mcp.md) in Claude Code, Codex and Cursor, each with a copy button, and there is nothing to submit. Ask the agent for the change in its own session. It creates the branch and its page with its `start_work` tool.

<insert [Start work on git.infrawrench.com with Another agent selected under Agent: the Claude Code command, the two Codex commands and the Cursor mcp.json block, each with a copy button, the line about start_work, and no ask box or Start work button] here>

Start work does not start an [agent session](./agents.md#work-on-a-branch-from-gitinfrawrenchcom) in the Infrawrench app.

## Send an instruction

On a branch's page, send the agent a review comment, a finding, or a note of your own. What the agent is told is fixed when you send it: the comment thread or the finding as it read then, with your words after it.

An instruction is **queued** until it reaches the agent, **delivered** once it has, and **answered** when the agent says which version answers it. That version shows "answered" beside the instruction, and a review comment you sent shows the same on its thread. You can **withdraw** an instruction until a version answers it.

- A **T3 Code** thread gets the instruction as a message straight away. If the environment is asleep, the instruction stays queued and is sent when it is back.
- An **Infrawrench** agent and **any other agent** read their instructions themselves, through the forge's API or MCP server, and mark them delivered.

Sending and withdrawing an instruction need write access to the repository.

## Connect a T3 Code environment

[T3 Code](https://github.com/pingdotgg/t3code) runs agents in environments on your own machines. To let git.infrawrench.com start threads in one and send them instructions, connect it under **Settings > T3 Code**.

<insert [Settings > T3 Code on git.infrawrench.com: three environments in a list, one Connected with a "T3 Connect" badge and its sign-in date, one "Sign-in ended" with its last error in red and a "Sign in again" button, one "Not signed in"] here>

1. In T3 Code, open **Settings > Sharing & access**, sign in and turn on **T3 Connect**. On a headless host, run `t3 connect`.
2. Still in T3 Code, open **Settings > Environments**, open the environment's menu and choose **Copy MCP URL**.
3. On git.infrawrench.com, open **Settings > T3 Code** and click **Add environment**. **T3 Connect** is already selected.
4. Give the environment a name and paste the MCP URL.
5. Click **Add and sign in**. You are sent to T3 Code's approval page, where you approve git.infrawrench.com with your T3 Connect account, then back.

<insert [The Add environment form on Settings > T3 Code with "T3 Connect" selected under "Connect through": a Name field, an MCP URL field holding a T3 Connect address ending in /mcp, the hint under it, and the Add and sign in button] here>

git.infrawrench.com connects to the environment's own T3 Connect address. It does not sign in to your T3 Connect account and cannot see your other environments, so each one you want to use is added the same way.

### Use an address instead

If the environment is published some other way, for example behind your own reverse proxy, choose **Use an address** in the form and type its address.

<insert [The Add environment form on Settings > T3 Code with "Use an address" selected: a Name field, an Address field holding an https address, and the Add and sign in button] here>

The address has to be `https` and reachable from the internet. An environment on `localhost`, on your local network or on a tailnet cannot be reached, because git.infrawrench.com connects to it from its own servers. Use T3 Connect for those.

### What to approve in T3 Code

T3 Code asks which access to give git.infrawrench.com. What works at each level:

| T3 Code access                      | Listing threads | Launching threads and sending instructions | Cloning a repository the environment does not have |
| ----------------------------------- | --------------- | ------------------------------------------ | -------------------------------------------------- |
| Read only                           | Yes             | No                                         | No                                                 |
| Supervised, Auto-accept edits, Auto | Yes             | Yes                                        | No                                                 |
| Full access                         | Yes             | Yes                                        | Yes                                                |

Without full access, add the repository as a project in T3 Code yourself first. The forge finds it by its remote address.

### What happens when work starts in T3 Code

- If the environment has no project for the repository, the forge has T3 Code clone it to `~/infrawrench-git/<owner>/<repository>` and register it.
- A thread is launched on a new worktree for the branch, with the project's default model. Its first message is the ask, the branch to push to, and how to add the forge's MCP server so the agent can record its trace and read instructions.
- The thread pushes with the Git credentials already on that machine. git.infrawrench.com sends no credentials to T3 Code. Make sure the machine can push to the repository, with an [SSH key or an access token](./git-getting-started.md).
- If T3 Code refuses the launch (for example, the project has no default model), the branch and its page are kept and the page says why. Fix it in T3 Code and connect the agent again.

### Sign-ins

A sign-in to an environment lasts thirty days. After that the environment shows **Sign-in ended**: click **Sign in again**. git.infrawrench.com stores the sign-in encrypted and never shows it.

**Remove** forgets the environment and its sign-in on git.infrawrench.com. T3 Code keeps listing the sign-in until you remove git.infrawrench.com there too. Branches whose threads ran in a removed environment stop being sent instructions; the agent can still read them itself.
