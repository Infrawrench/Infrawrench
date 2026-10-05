import {
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
  type RemediationResource,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `gh` commands for savings findings. `gh` reads its token from
 * its own login (`gh auth login`); the token needs organization admin (plus
 * `manage_billing:copilot` for seats). The organization login is not on every
 * synced row, so it is a placeholder unless the row names it.
 *
 * Reference: https://cli.github.com/manual/
 */
export function githubRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan") return [];
  const { resource } = finding;
  switch (resource.resourceTypeId) {
    case "copilot-seat":
      return removeSeat(resource);
    case "runner":
      return removeRunner(resource);
    case "codespace":
      return deleteCodespace(resource);
    default:
      return [];
  }
}

const ORG_PLACEHOLDER: RemediationPlaceholder = {
  name: "GITHUB_ORG",
  description: "The GitHub organization login this account syncs (as in github.com/<org>)",
};

/** The org path segment: the row's own organization, else `$GITHUB_ORG`. */
function orgSegment(resource: RemediationResource): {
  org: string;
  placeholders?: RemediationPlaceholder[];
} {
  const org = remediationField(resource, "organization");
  if (org) return { org: encodeURIComponent(org) };
  return { org: "$GITHUB_ORG", placeholders: [ORG_PLACEHOLDER] };
}

/** `"…"` around an API path: lets `$GITHUB_ORG` expand while ids stay literal. */
function apiPath(path: string): string {
  return `"${path.replace(/["\\`]/g, "\\$&")}"`;
}

// https://docs.github.com/en/rest/copilot/copilot-user-management#get-copilot-seat-information-and-settings-for-an-organization-member
// https://docs.github.com/en/rest/copilot/copilot-user-management#remove-users-from-the-copilot-subscription-for-an-organization
// https://cli.github.com/manual/gh_api
function removeSeat(resource: RemediationResource): RemediationCommand[] {
  const login = remediationId(resource, "login");
  if (!login) return [];
  const { org, placeholders } = orgSegment(resource);
  const user = encodeURIComponent(login);
  const inspect: RemediationCommand = {
    tool: "gh",
    command: `gh api ${apiPath(`/orgs/${org}/members/${user}/copilot`)}`,
    description: "Show the seat's last activity and how it was assigned.",
    destructive: false,
    ...(placeholders ? { placeholders } : {}),
  };
  const team = remediationField(resource, "assigningTeam");
  if (team) {
    // GitHub refuses (422) to cancel a seat that comes from a team; the user
    // has to leave the team, or the team has to lose Copilot, instead.
    return [
      {
        ...inspect,
        description: `The seat comes from the ${team} team, so GitHub will not cancel it on its own; remove the user from that team or the team from Copilot.`,
      },
    ];
  }
  return [
    inspect,
    {
      tool: "gh",
      command: `gh api --method DELETE ${apiPath(`/orgs/${org}/copilot/billing/selected_users`)} -f ${shellQuote(`selected_usernames[]=${login}`)}`,
      description:
        "Cancel the seat; the user keeps Copilot until the end of the billing cycle and can be assigned a seat again later.",
      destructive: false,
      ...(placeholders ? { placeholders } : {}),
    },
  ];
}

// https://docs.github.com/en/rest/actions/self-hosted-runners#get-a-self-hosted-runner-for-an-organization
// https://docs.github.com/en/rest/actions/self-hosted-runners#delete-a-self-hosted-runner-from-an-organization
function removeRunner(resource: RemediationResource): RemediationCommand[] {
  const id = remediationId(resource);
  if (!/^\d+$/.test(id)) return [];
  const { org, placeholders } = orgSegment(resource);
  const path = apiPath(`/orgs/${org}/actions/runners/${id}`);
  const ph = placeholders ? { placeholders } : {};
  return [
    {
      tool: "gh",
      command: `gh api ${path}`,
      description: "Confirm the runner is still offline and not busy.",
      destructive: false,
      ...ph,
    },
    {
      tool: "gh",
      command: `gh api --method DELETE ${path}`,
      description:
        "Remove the runner's registration; the machine would need a new registration token to rejoin.",
      destructive: true,
      ...ph,
    },
  ];
}

// https://cli.github.com/manual/gh_codespace_delete
function deleteCodespace(resource: RemediationResource): RemediationCommand[] {
  const name = remediationField(resource, "codespaceName");
  const owner = remediationField(resource, "owner");
  if (!name || !owner) return [];
  const { org, placeholders } = orgSegment(resource);
  const orgArg = placeholders ? `"$GITHUB_ORG"` : shellQuote(decodeURIComponent(org));
  return [
    {
      tool: "gh",
      command: `gh codespace delete --org ${orgArg} --user ${shellQuote(owner)} --codespace ${shellQuote(name)}`,
      description:
        "Delete the unused codespace and its storage, including any changes that were never pushed.",
      destructive: true,
      ...(placeholders ? { placeholders } : {}),
    },
  ];
}
