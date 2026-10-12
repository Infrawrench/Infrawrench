# Infrawrench for VS Code

See what your Terraform actually manages, from the file that declares it.

- **Hover a `resource` block** to see the live resource(s) it manages, whether they drifted from state, the owning service, what they cost over the last 30 days, the list-price estimate, and any open posture findings. Links open the resource in Infrawrench or copy its ids.
- **CodeLens** above each block names the live resource and summarises cost, service and findings.
- **Estimate Cost of Working Tree Changes** runs your uncommitted `.tf`, Infrafile and Kubernetes changes (unsaved editors included) through the same check a pull request gets, and shows the monthly delta and blast radius.
- **Search Resources and Services** from the command palette.
- **Services** view in the activity bar: each service's on-call, cost, posture, scorecards and member resources.

Blocks are tied to live resources through the Terraform state you uploaded to Infrawrench (the IaC page). Without an uploaded state there is nothing to match.

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
