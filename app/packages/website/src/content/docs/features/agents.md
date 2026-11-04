---
title: Agents
description: Start Codex or Claude Code on a cloud VM from any VM-capable account, then bring the agent's branch back to your local repository.
sidebar_order: 24
---

Agents gives a coding agent its own cloud VM. You pick an account that can create VMs, choose a repository, and Infrawrench sets up the machine with your coding tool and a fresh branch.

To start:

1. Open **Agents** from the sidebar.
2. Use the configuration menu in the header to choose a VM-capable account and save your defaults for the VM and the tool.
3. Create a named session from a repository. On the cloud you pick from your connected GitHub repos. You can also give a Git URL or, on desktop, a local path.

## Local and organization sessions

On the desktop app, Agents follows the org switcher, the same way [Workflows](./workflows.md) and [Deploy](./infrafile.md) do.

- **Local-only mode.** Sessions are stored on this machine and VMs are set up from here. You see the accounts you added to the desktop app. This is the only mode where you can use a **local folder** as the repository.
- **With an organization selected.** You get the organization's sessions, the same ones the web app shows. They use the organization's accounts, and the cloud sets up the VM, so a session keeps going even if your laptop sleeps. The GitHub repository picker is available here. Local folders are not, since the cloud can't reach your machine.

The two sets are separate and nothing is copied between them. If an account only exists in the organization (say a GCP project added on the web), select that organization to use it. It won't appear in local-only mode.

![Agents panel showing the header configuration menu, repo input, and a setting-up agent session with its VM id](https://agent-assets.infrawrench.com/docs-screenshots/features/agents/agents-panel-setting-up.png)

## Set your defaults

The header configuration menu lists every account that can create VMs. It saves the VM size, image, region and coding tool. These are the same options you see when you create a VM for that provider normally.

### Coding tool and interface

Choose **Codex** or **Claude Code**. Then choose an **Interface**, which is how you talk to the tool:

- **Terminal (SSH)** opens the tool's CLI in a terminal tab.
- **T3 Code** installs the [T3 Code](./t3-code.md) server to drive the tool. The session's button becomes **Authorize server**, and afterwards you use the machine from T3 Code's own app. T3 Code is a control surface, not an agent, so it still installs and signs in to the tool you picked.
- **Nibblets** installs a [Nibblets server](./nibblets.md), a host for long-running agents, which can start linked to your organization. There's no tool choice here, because Nibblets signs in its own agents.

With **Interface** set to **T3 Code**, the menu also holds your organization's **T3 Code policy**. It's installed on every T3 Code server so settings, permission modes and providers are managed in one place. See [Managing T3 Code with a policy](./t3-code.md#managing-t3-code-with-a-policy).

### What gets copied to the VM

Local-only desktop sessions copy your coding tool's sign-in and settings onto the VM. Organization sessions don't, because the cloud has no access to your machine.

- **Codex:** selected files from `~/.codex`, such as `auth.json`, `config.toml` and skills.
- **Claude Code:** selected settings and plugins from `~/.claude`, plus `~/.claude.json` when those paths exist.

Local sessions, logs, caches, temp files, downloads and package stores are skipped.

Local-only sessions also copy your `~/.gitconfig` so commits from the VM carry your identity. A few settings that only work on your own machine are removed on the way:

- GPG signing, since your keys aren't on the VM.
- Credential helpers like `osxkeychain`.
- `url.*.insteadOf` rewrites that point at SSH. The VM has no SSH key registered with GitHub, so these would break every HTTPS clone, even of public repos. Rewrites to a non-SSH target (an internal HTTPS mirror) are kept.

### Services

**Services** lists accounts that can install something on a server over SSH, the same ones the resource page's **Install service…** offers (today, [Tailscale](./tailscale.md)). Select one or more and every new session installs them once setup finishes.

- A Tailscale account adds the VM to your tailnet, and the session row shows its tailnet address.
- A failed install marks the session failed. **Retry setup** runs it again, and an install that already happened is skipped.
- Deleting the session undoes it, so the Tailscale device is removed from your tailnet.
- With Tailscale attached, a [T3 Code](./t3-code.md#reaching-the-server-over-tailscale-instead) session can be reached over the tailnet instead of T3 Connect.

### SSH key

Agent VMs use a dedicated Infrawrench-managed SSH key named `infrawrench-agent`. Organization sessions use the organization's copy of that key, and its private half stays on the server, never in your local key store. Local-only sessions keep the key in the desktop app's key store. Providers such as DigitalOcean attach the key when the VM is created, so the VM doesn't fall back to password access.

## Choose a repository

On the cloud, the session form shows a repository picker from your [GitHub App integration](./workflows.md#connecting-github), the same one workflow git triggers use.

- Pick any repository the installation can access. Private repos are marked in the list.
- Choose **Custom Git URL…** to type a clone URL for a repo hosted anywhere else.
- Click **+ repos** (or **Connect GitHub** if nothing is connected yet) to add repositories.

![Agents session form on the web app with the GitHub repository picker open, showing a private repo entry, the Custom Git URL option, and the + repos button](https://agent-assets.infrawrench.com/docs-screenshots/features/agents/github-repo-picker.png)

Private GitHub repos picked this way clone on the VM with a short-lived token, and no credential is left on the VM afterwards. To push the agent branch from the VM, you sign in to Git as usual.

The desktop app shows the same picker when an organization is selected. In local-only mode the form has a free-text **Git URL** field and a **Local folder** picker instead.

## Work with a session

When you create a session, Infrawrench saves the repo, session name, a generated branch name, the account and the tool, then asks the provider to create the VM. The session name is the label in the Agents list. The workspace folder is named after the repo, so `/Users/alex/infrawrench` opens as `~/infrawrench` whatever you called the session. Once the provider accepts, the VM's id shows in the session row.

For a local folder, the folder must exist and be a Git work tree, or the session fails before any VM is created. Infrawrench uses the folder's `origin` remote, if it has one, for the first pull on the VM. It also detects the runtimes and package managers you use:

- **Runtimes:** Node, PHP, Ruby and Go, from files such as `package.json`, `.nvmrc`, `composer.json`, `.php-version`, `Gemfile`, `.ruby-version`, `go.mod` and `.tool-versions`. An exact version is used as is. If you only give a range or no version, the current release is installed.
- **Package managers:** `pnpm`, `yarn`, `bun`, Composer, Bundler, npm and Go, from `packageManager`, lockfiles and manifests.

The session list refreshes on its own while the page is open, so you can watch setup move to ready. Setup installs the runtimes, package managers and your coding tool, prepares `~/<workspace name>`, pulls your code and checks out the new branch. The setup log shows what was planned and whether your tool's local config was found.

### Open a session

**Open** starts an SSH tab to the VM using the `infrawrench-agent` key and attaches to the agent's session. The first time, it starts `codex --yolo` or `claude --dangerously-skip-permissions` inside `~/<workspace name>`. After that, **Open** resumes the same session. Opening it again closes other SSH tabs for that VM, and attaching takes the session over from any other connected client.

For local-folder sessions, **Open** first refreshes the VM's workspace from your folder. Files ignored by Git are left out, and the `.git` metadata is included so the VM workspace stays a Git repo.

### If setup fails

A session stays in setup until the VM is fully ready. If the provider rejects the request, the session is marked failed and the log shows the provider's error.

## Bring the work back

Use **Reconcile** to fetch the agent's branch into your local repository as an `infrawrench/agent-*` branch. Your current working tree isn't changed. Review, merge, cherry-pick or discard the branch with normal Git tools.

This works for local-only desktop sessions, which have a checkout on your machine. Organization sessions have no local checkout, so **Reconcile** tells you to push the branch from the VM instead. Open the agent terminal and push from inside the workspace.

## Delete an agent

Use **Delete** on a session row. After you confirm, Infrawrench destroys the VM at the provider (which stops its billing), removes the session and closes any SSH tabs for that VM.

- Anything on the VM you haven't reconciled is lost, so reconcile first if you want the branch.
- If the provider refuses to delete the VM, the session is kept and the error is shown, so nothing is left running unseen.
- Deleting a Nibblets server also revokes its link to the organization and every agent it made.

## Configure sessions from your repository (`.infrawrench/`)

A repository can shape its agent sessions with two optional files.

### `.infrawrench/agent.json`

```json
{
  "env": { "APP_ENV": "agent" },
  "resources": [
    {
      "pluginId": "neon",
      "resourceTypeId": "branch",
      "name": "agent-db",
      "fields": { "parentBranchId": "main" },
      "env": { "DATABASE_URL": "{{outputs.connectionString}}" }
    }
  ]
}
```

- **`env`**: environment variables for the VM. They're written to `~/.infrawrench-agent/agent.env` and loaded before the coding tool starts, so the agent and everything it runs can see them.
- **`resources`**: resources Infrawrench creates once per session from your existing accounts, such as a database branch. Each entry is matched to an account by `pluginId`. If you have several, set `account` to the account's display name. Use `{{outputs.<key>}}` and `{{fields.<key>}}` to put the new resource's outputs and fields into env vars. These resources are destroyed when you delete the agent.

Today, `agent.json` resources and env are read for desktop local-folder sessions only. Git URL sessions get the setup script only.

### `.infrawrench/agent-setup.sh`

An optional bash script that runs on the VM after the runtimes, package managers and coding tool are installed and the workspace is ready, but before you connect. It runs inside the workspace with the session env loaded, so it's the place for `pnpm install`, database migrations or seeding. A non-zero exit fails setup (you can retry), so make it safe to run more than once.
