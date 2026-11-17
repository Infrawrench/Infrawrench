/**
 * GitHub issue tools: the MCP/chat view of filing findings as GitHub issues
 * and opening IaC pull requests, over the same server-core functions the
 * routes call. Filing dedupes by finding fingerprint exactly as the button
 * does (a repeat comments on the open issue), and a pull request is still
 * gated by the org's `pullRequestsEnabled` and never merged.
 */
import { Schema } from "effect";
import { minLength, maxLength } from "@infrawrench/api-contract/schemas";
import { GITHUB_ISSUE_SOURCE_KINDS } from "@infrawrench/client-core";
import { GithubApiError } from "@infrawrench/server-core/github/issues-api";
import {
  getGithubIssueSettings,
  listInstallationAccess,
} from "@infrawrench/server-core/github-issues/settings";
import {
  GithubFilingError,
  fileFindingToGithub,
  listGithubIssueLinks,
} from "@infrawrench/server-core/github-issues/filing";
import {
  IacPullRequestRefused,
  openIacPullRequest,
  previewIacPullRequest,
} from "@infrawrench/server-core/github-issues/pull-request";
import { err, ok, type ToolDefinition } from "./types";

const sourceKind = Schema.Literals(GITHUB_ISSUE_SOURCE_KINDS).annotate({
  description: "Which detector produced the finding: orphan, oversized, cost_anomaly, …",
});

function failure(e: unknown) {
  if (
    e instanceof GithubApiError ||
    e instanceof GithubFilingError ||
    e instanceof IacPullRequestRefused
  ) {
    return err(e.message);
  }
  throw e;
}

const pullRequestInput = {
  sourceKind: Schema.Literals(["orphan", "oversized"]).annotate({
    description: "orphan (remove the block) or oversized (resize)",
  }),
  sourceId: Schema.String.check(minLength(1)).annotate({
    description: "The finding id; for orphan and oversized, the resource id.",
  }),
  resourceId: Schema.String.check(minLength(1)).annotate({
    description: "The Infrawrench resource id.",
  }),
  recommendedSizeId: Schema.optionalKey(
    Schema.String.annotate({
      description: "For oversized: the recommended size id from list_oversized_resources.",
    }),
  ),
};

function pullRequestArgs(input: {
  sourceKind: "orphan" | "oversized";
  sourceId: string;
  resourceId: string;
  recommendedSizeId?: string;
}) {
  return {
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    resourceId: input.resourceId,
    change:
      input.sourceKind === "oversized"
        ? { kind: "resize" as const, recommendedSizeId: input.recommendedSizeId ?? "" }
        : { kind: "remove" as const },
  };
}

export function githubIssueTools(): ToolDefinition[] {
  return [
    {
      name: "get_github_issue_settings",
      title: "Get GitHub issue settings",
      description:
        "The organization's GitHub issue filing settings (default repository, labels, " +
        "assignees, cost-centre and tag routes, what happens when a finding resolves, whether " +
        "IaC pull requests are enabled and which repositories hold the Terraform) plus, per " +
        "GitHub App installation, whether it has accepted the issues / contents / " +
        "pull_requests permissions filing needs.",
      inputSchema: {},
      risk: "read",
      permission: "github-issues:read",
      handler: async (_input, auth) => {
        const [settings, installations] = await Promise.all([
          getGithubIssueSettings(auth.organizationId),
          listInstallationAccess(auth.organizationId),
        ]);
        return ok({ settings, installations });
      },
    },
    {
      name: "list_github_issue_links",
      title: "List findings filed as GitHub issues",
      description:
        "Findings that have been filed as GitHub issues, newest first, with the issue URL, " +
        "whether it is still open, whether a routing rule filed it, and any pull request.",
      inputSchema: {
        sourceKind: Schema.optionalKey(sourceKind),
        state: Schema.optionalKey(Schema.Literals(["open", "closed"])),
      },
      risk: "read",
      permission: "github-issues:read",
      handler: async (input, auth) => {
        const i = input as {
          sourceKind?: (typeof GITHUB_ISSUE_SOURCE_KINDS)[number];
          state?: "open" | "closed";
        };
        return ok(
          await listGithubIssueLinks(auth.organizationId, {
            sourceKind: i.sourceKind,
            state: i.state,
          }),
        );
      },
    },
    {
      name: "file_github_issue",
      title: "File a finding as a GitHub issue",
      description:
        "File one finding (an orphaned or oversized resource from the savings tools, a cost " +
        "anomaly, …) as a GitHub issue in the repository the organization's routing picks. " +
        "If an open issue already exists for the same finding, comments on it instead of " +
        "opening another. Provide the evidence as label/value details and the monthly cost " +
        "when known.",
      inputSchema: {
        sourceKind,
        sourceId: Schema.String.check(minLength(1)).annotate({
          description: "The finding id; for orphan and oversized, the resource id.",
        }),
        title: Schema.String.check(minLength(1), maxLength(240)).annotate({
          description: "One-line headline.",
        }),
        details: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              label: Schema.String,
              value: Schema.Union([Schema.String, Schema.Finite]),
            }),
          ).check(maxLength(30)),
        ),
        note: Schema.optionalKey(Schema.String.check(maxLength(5000))),
        resourceId: Schema.optionalKey(
          Schema.String.annotate({ description: "The resource, used for routing." }),
        ),
        monthlyCost: Schema.optionalKey(
          Schema.Struct({
            amount: Schema.Finite,
            currency: Schema.String.check(minLength(3), maxLength(3)),
          }),
        ),
      },
      risk: "write",
      openWorld: true,
      permission: "github-issues:write",
      handler: async (input, auth) => {
        const i = input as unknown as Parameters<typeof fileFindingToGithub>[1];
        try {
          return ok(
            await fileFindingToGithub(auth.organizationId, i, {
              userId: auth.agentRegistrationId ? null : auth.userId,
              autoFiled: false,
            }),
          );
        } catch (e) {
          return failure(e);
        }
      },
    },
    {
      name: "preview_iac_pull_request",
      title: "Preview a Terraform pull request for a finding",
      description:
        "For an orphaned or oversized resource managed by Terraform in a mapped repository, " +
        "show the one-file diff a pull request would make (resize: the size attribute; " +
        "orphan: remove the resource block), or the reason the change is not mechanical.",
      inputSchema: pullRequestInput,
      risk: "read",
      openWorld: true,
      permission: "github-issues:write",
      handler: async (input, auth) => {
        try {
          return ok(
            await previewIacPullRequest(
              auth.organizationId,
              pullRequestArgs(input as Parameters<typeof pullRequestArgs>[0]),
            ),
          );
        } catch (e) {
          return failure(e);
        }
      },
    },
    {
      name: "open_iac_pull_request",
      title: "Open a Terraform pull request for a finding",
      description:
        "Open the pull request preview_iac_pull_request describes: a branch, one commit, and " +
        "a PR against the mapped base branch. Requires the organization to have enabled IaC " +
        "pull requests. Never merged automatically; a person reviews it.",
      inputSchema: pullRequestInput,
      risk: "write",
      openWorld: true,
      permission: "github-issues:write",
      handler: async (input, auth) => {
        try {
          return ok(
            await openIacPullRequest(
              auth.organizationId,
              pullRequestArgs(input as Parameters<typeof pullRequestArgs>[0]),
            ),
          );
        } catch (e) {
          return failure(e);
        }
      },
    },
  ];
}
