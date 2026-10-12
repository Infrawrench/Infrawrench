import {
  shellQuote,
  type RemediationCommand,
  type RemediationFinding,
  type RemediationPlaceholder,
  type SeatRemediationFinding,
} from "@infrawrench/plugin-base";

/**
 * Remediation for GitLab orphan findings, as `glab api` calls against the
 * REST API. glab authenticates with its own stored login, and `--hostname`
 * points it at gitlab.com or a self-managed instance; the host is an account
 * setting the row does not hold, so it is a placeholder. glab's dedicated
 * commands address projects by path rather than id and cover only some of
 * these objects, which is why every command uses `glab api` with the ids the
 * listers store.
 *
 * References (verified 2026-10):
 * https://gitlab.com/gitlab-org/cli/-/blob/main/docs/source/api/_index.md (`glab api <endpoint> -X <method> --hostname`)
 * https://docs.gitlab.com/api/project_import_export/ (POST /projects/:id/export)
 * https://docs.gitlab.com/api/projects/ (DELETE /projects/:id)
 * https://docs.gitlab.com/api/environments/ (DELETE /projects/:id/environments/:environment_id)
 * https://docs.gitlab.com/api/container_registry/ (DELETE /projects/:id/registry/repositories/:repository_id)
 * https://docs.gitlab.com/api/deploy_tokens/ (DELETE /projects|groups/:id/deploy_tokens/:token_id)
 * https://docs.gitlab.com/api/runners/ (DELETE /runners/:id)
 */
export function gitlabRemediationCommands(finding: RemediationFinding): RemediationCommand[] {
  if (finding.kind !== "orphan") return [];
  const { resource } = finding;
  const parts = (resource.externalId ?? "").trim().split("/");
  const [scope = "", id = ""] = parts;
  const single = parts.length === 1 && isId(scope);
  const scoped = parts.length === 2 && isId(scope) && isId(id);

  switch (resource.resourceTypeId) {
    case "project":
      if (!single) return [];
      return [
        api(
          "POST",
          `projects/${scope}/export`,
          "Schedule a full export of the project first; download it from projects/:id/export/download once it finishes.",
        ),
        api(
          "DELETE",
          `projects/${scope}`,
          "Delete the archived project with its repository, artifacts, packages and images (GitLab marks it for deletion and removes it after the retention period, 30 days on GitLab.com).",
          true,
        ),
      ];
    case "environment":
      if (!scoped) return [];
      return [
        api(
          "DELETE",
          `projects/${scope}/environments/${id}`,
          "Delete the stopped environment and its deployment history.",
          true,
        ),
      ];
    case "container-repository":
      if (!scoped) return [];
      return [
        api(
          "DELETE",
          `projects/${scope}/registry/repositories/${id}`,
          "Delete the empty container repository (GitLab removes it asynchronously).",
          true,
        ),
      ];
    case "deploy-token":
    case "group-deploy-token": {
      if (!scoped) return [];
      const owner = resource.resourceTypeId === "deploy-token" ? "projects" : "groups";
      return [
        api(
          "DELETE",
          `${owner}/${scope}/deploy_tokens/${id}`,
          "Delete the expired deploy token.",
          true,
        ),
      ];
    }
    case "runner":
      if (!single) return [];
      return [
        api(
          "DELETE",
          `runners/${scope}`,
          "Delete the stale runner's registration; the machine behind it, if any, keeps running until you remove it separately.",
          true,
        ),
      ];
    default:
      return [];
  }
}

/**
 * Commands for a GitLab.com seat finding: show where the member holds
 * memberships, then remove them as a billable member. Seats are only reported
 * for GitLab.com, so the host is literal. Downgrade findings are never raised
 * for GitLab (the plan is per group, not per seat), so they get nothing.
 *
 * https://docs.gitlab.com/api/members/#list-memberships-for-a-billable-member-of-a-group
 * https://docs.gitlab.com/api/members/#remove-a-billable-member-from-a-group
 */
export function gitlabSeatRemediationCommands(
  finding: SeatRemediationFinding,
): RemediationCommand[] {
  if (finding.reason === "downgrade") return [];
  const { seat } = finding;
  const groupId = seat.context["groupId"] ?? seat.seatKey;
  if (!isId(groupId ?? "") || !isId(seat.memberId)) return [];
  const path = `groups/${groupId}/billable_members/${seat.memberId}`;
  return [
    {
      tool: "glab",
      command: `glab api --hostname gitlab.com ${shellQuote(`${path}/memberships`)}`,
      description: "List the groups and projects the member belongs to directly.",
      destructive: false,
    },
    {
      tool: "glab",
      command: `glab api -X DELETE --hostname gitlab.com ${shellQuote(path)}`,
      description:
        "Remove the member from the group and all its subgroups and projects (GitLab finishes it in the background); they can be invited again later.",
      destructive: true,
    },
  ];
}

/** GitLab ids are integers; anything else is not something to put in a path. */
function isId(value: string): boolean {
  return /^\d+$/.test(value);
}

const HOST: RemediationPlaceholder = {
  name: "GITLAB_HOST",
  description: "The GitLab host this account uses, e.g. gitlab.com or gitlab.example.com",
};

function api(
  method: "POST" | "DELETE",
  endpoint: string,
  description: string,
  destructive = false,
): RemediationCommand {
  return {
    tool: "glab",
    command: `glab api -X ${method} --hostname "$GITLAB_HOST" ${shellQuote(endpoint)}`,
    description,
    destructive,
    placeholders: [HOST],
  };
}
