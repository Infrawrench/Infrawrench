# Infrawrench for VS Code

See what your Terraform actually manages, from the file that declares it.

- **Hover a `resource` block** to see the live resource(s) it manages, whether they drifted from state, the owning service, what they cost over the last 30 days, the list-price estimate, and any open posture findings. Links open the resource in Infrawrench or copy its ids.
- **CodeLens** above each block names the live resource and summarises cost, service and findings.
- **Estimate Cost of Working Tree Changes** runs your uncommitted `.tf` and Kubernetes changes (unsaved editors included) through the same check a pull request gets, and shows the monthly delta and blast radius.
- **Search Resources and Services** from the command palette.
- **Services** view in the activity bar: each service's on-call, cost, posture, scorecards and member resources.
- **`.infraenv` files**: syntax highlighting, problems as you type, and a hover on each `resource(...)` or `secret(...)` saying what it resolves to. See below.

Blocks are tied to live resources through the Terraform state you uploaded to Infrawrench (the IaC page). Without an uploaded state there is nothing to match.

## `.infraenv` files

An `.infraenv` is the committed half of a project's environment: every variable as a literal, a resource output, or an organization secret, never a value. The extension checks a local copy before you commit it.

- **Problems**: syntax errors show as you type, offline. Signed in, every reference is also looked up in your organization (on open, on save and after you stop typing), and one that points at nothing (a missing or ambiguous resource, an output the type does not have, a secret with no value) shows as a warning. Signed out, the status bar says only syntax is checked.
- **Hover** a reference to see the resource it finds (provider, type, name, account, output, whether the output is sensitive), or why it finds none. A reference with `${...}` substitutions gets one line per environment.
- **Infrawrench: Check .infraenv** checks the references now and opens the Problems view.
- **Infrawrench: Pull .env** resolves the file for the environment you pick (or Shared) and writes the `.env` beside it, where its `output` setting says, readable only by you. A `.env` that Infrawrench did not generate is replaced only after you confirm. Values are never shown.
- **Infrawrench: Insert Resource Reference** (also in the editor's context menu) picks a resource and one of its outputs and inserts a reference by name, with a comment naming what it points at.

Checking references needs `resources:read`; pulling needs `secrets:read`.

## Sign in

Run **Infrawrench: Sign In** and pick:

- **Browser**: your Infrawrench account; choose any organization you belong to.
- **API key**: an `iwk_` key from Settings > API keys, kept in VS Code's secret storage. Paste any Infrawrench address from inside the organization (or its id) when asked which organization the key is for.

The hover and the lenses need `iac:read`, `resources:read` and `costs:read`; a section you lack access to is simply left out.

## Settings

| Setting                               | Default                       | What it does                                             |
| ------------------------------------- | ----------------------------- | -------------------------------------------------------- |
| `infrawrench.cloudUrl`                | `https://app.infrawrench.com` | Your Infrawrench origin.                                 |
| `infrawrench.openIn`                  | `web`                         | Open resources in the web app or the desktop app.        |
| `infrawrench.codeLens.enabled`        | `true`                        | Show lenses above resource blocks.                       |
| `infrawrench.costEstimate.repository` | (from `origin`)               | `owner/name` whose pull request check settings to apply. |
