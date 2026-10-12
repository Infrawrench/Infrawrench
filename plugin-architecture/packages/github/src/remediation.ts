import {
  remediationField,
  remediationId,
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
  type RemediationResource,
  type SeatRemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Ready-to-run `gh` commands for savings findings (runners and codespaces;
 * Copilot seats are answered by {@link githubSeatRemediationCommands}). `gh` reads its token from
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

/**
 * Commands for a Copilot seat finding (see `seats.ts`). Inactive and
 * duplicate seats get the same answer: inspect the seat, then cancel it. A
 * seat granted through a team cannot be cancelled on its own (GitHub answers
 * 422), so it only gets the inspect command with what to change instead.
 * Downgrade findings are never raised for Copilot (nothing GitHub reports
 * shows a user would do with Business rather than Enterprise), so they get
 * nothing.
 *
 * https://docs.github.com/en/rest/copilot/copilot-user-management#get-copilot-seat-assignment-details-for-a-user
 * https://docs.github.com/en/rest/copilot/copilot-user-management#remove-users-from-the-copilot-subscription-for-an-organization
 * https://docs.github.com/en/enterprise-cloud@latest/rest/copilot/copilot-user-management#get-copilot-seat-assignment-details-for-an-enterprise-user
 * https://docs.github.com/en/enterprise-cloud@latest/rest/copilot/copilot-user-management#remove-users-from-the-copilot-subscription-for-an-enterprise
 * https://cli.github.com/manual/gh_api
 */
export function githubSeatRemediationCommands(
  finding: SeatRemediationFinding,
): RemediationCommand[] {
  if (finding.reason === "downgrade") return [];
  const { seat } = finding;
  const login = (seat.login ?? "").trim();
  if (!login) return [];
  const ctx = seat.context;
  // The organization that granted the seat, else the enterprise when the seat
  // was assigned at enterprise level, else a placeholder.
  let base: string;
  let placeholders: RemediationPlaceholder[] | undefined;
  if (ctx["organization"]) base = `/orgs/${encodeURIComponent(ctx["organization"])}`;
  else if (ctx["ownerKind"] === "enterprise" && ctx["owner"])
    base = `/enterprises/${encodeURIComponent(ctx["owner"])}`;
  else {
    base = "/orgs/$GITHUB_ORG";
    placeholders = [ORG_PLACEHOLDER];
  }
  const ph = placeholders ? { placeholders } : {};
  const user = encodeURIComponent(login);
  const inspect: RemediationCommand = {
    tool: "gh",
    command: `gh api ${apiPath(`${base}/members/${user}/copilot`)}`,
    description: "Show the seat's last activity and how it was assigned.",
    destructive: false,
    ...ph,
  };
  const team = ctx["team"];
  if (team) {
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
      command: `gh api --method DELETE ${apiPath(`${base}/copilot/billing/selected_users`)} -f ${shellQuote(`selected_usernames[]=${login}`)}`,
      description:
        "Cancel the seat; the user keeps Copilot until the end of the billing cycle and can be assigned a seat again later.",
      destructive: false,
      ...ph,
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
