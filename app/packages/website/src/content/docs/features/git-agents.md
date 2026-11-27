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

With **T3 Code**, pick the environment and the model, write what you want done, and choose the branch to start from. The forge creates a branch at the base branch's commit and opens the branch's page as a draft, with the ask as its description. The agent's first push is version 1.

**Model** lists the environment's providers and their models by name. It starts at the default model of the environment's project for the repository. A project with no default model starts with nothing chosen, and **Start work** waits until you pick one. **Reasoning** appears beside it for a model that has reasoning levels, starts at the project's level or the model's own, and offers only the levels that model supports. Neither field is shown when you pick an existing thread under **Thread**, because that thread already has its model.

<insert [Start work on git.infrawrench.com with T3 Code selected under Agent: the Environment, Thread and Project pickers, the Model picker open with models grouped under Codex and Claude, the Reasoning picker beside it set to High, the Ask editor with a few lines written, Start from set to main, the Branch field holding the name made from the ask, and the Start work button] here>

With **Another agent**, the page shows how to install the forge's [MCP server](./git-agents-and-mcp.md) in Claude Code, Codex and Cursor, each with a copy button, and there is nothing to submit. Ask the agent for the change in its own session. It creates the branch and its page with its `start_work` tool.

<insert [Start work on git.infrawrench.com with Another agent selected under Agent: the Claude Code command, the two Codex commands and the Cursor mcp.json block, each with a copy button, the line about start_work, and no ask box or Start work button] here>

Start work does not start an [agent session](./agents.md#work-on-a-branch-from-gitinfrawrenchcom) in the Infrawrench app.

## Send an instruction

On a branch's page, send the agent a review comment, a finding, or a note of your own. What the agent is told is fixed when you send it: the comment thread or the finding as it read then, with your words after it.

An instruction is **queued** until it reaches the agent, **delivered** once it has, and **answered** when the agent says which version answers it. That version shows "answered" beside the instruction, and a review comment you sent shows the same on its thread. You can **withdraw** an instruction until a version answers it.

- A **T3 Code** thread gets the instruction as a message straight away. If the environment is asleep, the instruction stays queued and is sent when it is back. Until then the **Agent** panel says the last instruction did not reach the thread, with the reason.
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
- A thread is launched on a new worktree for the branch, with the model and reasoning level you chose. Its first message is the ask, the branch to push to, and how to record its work for the reviewers. The branch page's **Agent** panel names the model the thread runs.
- The thread pushes with the Git credentials already on that machine. git.infrawrench.com sends no credentials to T3 Code. Make sure the machine can push to the repository, with an [SSH key or an access token](./git-getting-started.md).
- If T3 Code refuses the launch, the branch and its page are kept. The **Agent** panel says **The thread did not start** with T3 Code's own reason, instead of a state such as **Idle**, which is only shown for a thread that exists. Fix what the reason names, pick a model and click **Try again**: the same ask is sent again, and if the first attempt did make a thread after all, that thread is found rather than a second one started. Only the person who connected the environment sees **Try again**, since the environment is theirs.
- A thread started without a model chosen (through the API, or by trying again on a branch from before the model picker) runs the project's default model. If the project has none, git.infrawrench.com picks one: a Claude model when the environment offers one, otherwise the first model of the first provider. The **Agent** panel then shows the model with **picked automatically**.

<insert [The Agent panel on a branch page after a failed launch: the agent's name with "T3 Code" beside it, "The thread did not start" in red, T3 Code's reason under it, a Model picker, a Reasoning picker and a Try again button] here>

### How the thread records its work

The thread's first message tells the agent to record its trace as it works: the ask as it understood it, each step, each decision with its reason and what it ruled out, evidence (the command, its exit code and the output that shows the result), doubts and notes, each pointing at the code it is about. It also tells the agent to mark a reviewer's instruction delivered when it takes it on and answered before the push that answers it, how to report findings if it is asked to review, and the [note commands](./git-branches.md#notes-from-ci) for a CI job it writes. An instruction sent to the thread repeats the part about marking it.

The agent does this through the forge's MCP server, with a token it asks for itself. The thread runs a command that hands the access token in the machine's Git credential helper to git.infrawrench.com and gets back a token for that one branch:

| The branch token can                                               | It cannot                                             |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| Record the branch's trace                                          | Clone, fetch or push                                  |
| List the branch's instructions and mark them delivered or answered | Send or withdraw an instruction, or dismiss a finding |
| List and report findings on the branch                             | Reach another branch or another repository            |
|                                                                    | Read or change anything else, settings included       |

It lasts six hours. The agent keeps it in a file inside the worktree's Git directory, which is never committed or pushed, and asks again when it runs out. git.infrawrench.com never sends a token to T3 Code, so none appears in the thread's messages.

For this to work the machine needs an [access token](./git-getting-started.md) with the `repo:write` scope stored for `https://git.infrawrench.com` in its Git credential helper. A machine that pushes over SSH only has none: there the agent says so and carries on, and you can sign the `infrawrench-git` MCP server in yourself from the thread (T3 Code shows a **Sign in** notice for it).

### Sign-ins

A sign-in to an environment lasts thirty days. After that the environment shows **Sign-in ended**: click **Sign in again**. git.infrawrench.com stores the sign-in encrypted and never shows it.

**Remove** forgets the environment and its sign-in on git.infrawrench.com. T3 Code keeps listing the sign-in until you remove git.infrawrench.com there too. Branches whose threads ran in a removed environment stop being sent instructions; the agent can still read them itself.
