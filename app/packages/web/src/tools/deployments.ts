/**
 * Deployment tools — let MCP clients and the chat agent read deploy history,
 * preview what an Infrafile would do, and put a known-good image back.
 *
 * There is deliberately NO `deploy` tool. Building and shipping a release is
 * slow, expensive, and lands bytes on real infrastructure that nothing here can
 * take back; a model deciding on its own that now is a good time to deploy is
 * exactly the failure this omission prevents. A human starts a deploy from the
 * UI or the CLI, where the interactive `select(...)` round trip lives anyway.
 * What the model gets instead is everything needed to *reason* about a deploy —
 * the history, one run in full, the repo list, and a plan-only preview — plus
 * rollback, which is the one deploy-shaped action that makes things safer
 * rather than riskier.
 *
 * Everything routes through services/deployments.ts, the same module behind the
 * HTTP routes and the websocket session, so the surfaces can't drift.
 */
import { z } from "zod";

import {
  DeploymentError,
  getDeploymentRun,
  listDeployableRepos,
  listDeploymentRuns,
  rollbackDeployment,
  runDeployment,
} from "../services/deployments";
import { PlanRequiredError } from "../services/entitlements";
import { logAudit } from "../services/audit";
import { denyUnlessPermitted } from "./permissions";
import { ok, err, type ToolDefinition, type ToolResult } from "./types";

/**
 * Turn a service-level failure into a tool error result. Mirrors the `fail`
 * helper on the HTTP routes: the two failures a caller can actually act on are
 * a bad request/missing thing and "your plan does not include this", and both
 * read better as a message than as a thrown 500.
 */
function toolError(e: unknown): ToolResult {
  if (e instanceof DeploymentError) return err(e.message);
  if (e instanceof PlanRequiredError) return err(e.message);
  throw e;
}

export function deploymentTools(): ToolDefinition[] {
  return [
    {
      name: "list_deployments",
      title: "List deployments",
      description:
        "List recent deployment runs (newest first) with their environment, repo, branch, commit, " +
        "status, image, and how long they took. Runs started from the CLI appear here too — one " +
        "history across both origins. Logs and the rendered Dockerfile are omitted; use " +
        "get_deployment for those.",
      inputSchema: {
        env: z
          .string()
          .optional()
          .describe("Only runs for this environment, e.g. 'production'. Omit for all."),
        limit: z.number().optional().describe("How many runs to return. Default 50, max 200."),
      },
      risk: "read",
      permission: "deployments:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "deployments:read");
        if (denied) return denied;
        try {
          const env = input["env"] as string | undefined;
          const limit = input["limit"] as number | undefined;
          return ok(
            await listDeploymentRuns(auth.organizationId, {
              ...(env ? { env } : {}),
              ...(limit !== undefined ? { limit } : {}),
            }),
          );
        } catch (e) {
          return toolError(e);
        }
      },
    },

    {
      name: "get_deployment",
      title: "Get deployment",
      description:
        "Fetch one deployment run in full: its log lines, the plan it computed, the rendered " +
        "Dockerfile, the image it produced, the stage it reached, and the error if it failed. " +
        "This is the tool to reach for when someone asks why a deploy broke.",
      inputSchema: {
        runId: z.string().describe("A run id from list_deployments."),
      },
      risk: "read",
      permission: "deployments:read",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "deployments:read");
        if (denied) return denied;
        try {
          return ok(await getDeploymentRun(auth.organizationId, input["runId"] as string));
        } catch (e) {
          return toolError(e);
        }
      },
    },

    {
      name: "list_deployable_repos",
      title: "List deployable repositories",
      description:
        "List the repositories this organization's GitHub App installations can see, with each " +
        "one's default branch. These are the repos a deployment can be planned or rolled back " +
        "from. An empty list means no GitHub App is connected — that is done under " +
        "Settings → GitHub, not from here. Note that a repo appearing here does not mean it has " +
        "an Infrafile; plan_deployment says so if it doesn't.",
      inputSchema: {},
      risk: "read",
      permission: "deployments:read",
      handler: async (_input, auth) => {
        const denied = await denyUnlessPermitted(auth, "deployments:read");
        if (denied) return denied;
        return ok(await listDeployableRepos(auth.organizationId));
      },
    },

    {
      name: "plan_deployment",
      title: "Plan a deployment",
      description:
        "Preview a deployment WITHOUT building or shipping anything: fetch the repo's Infrafile at " +
        "a branch head, run its `plan()` for one environment, and render the Dockerfile it would " +
        "build from. Returns the plan, the Dockerfile, and the log lines. Nothing is built, " +
        "pushed, or deployed. Use this to answer 'what would deploying this do' and to check an " +
        "Infrafile change before a human runs it for real. " +
        "Non-interactive: an Infrafile that calls `select(key, …)` cannot ask, so pass the choices " +
        "up front in `answers` keyed by the same key — otherwise the run fails saying which key it " +
        "needed. There is no tool that actually deploys; a human starts that from the app or the CLI.",
      inputSchema: {
        repo: z
          .string()
          .describe("'owner/name' (a GitHub URL works too). Get one from list_deployable_repos."),
        branch: z
          .string()
          .optional()
          .describe("Branch to read the Infrafile from. Defaults to 'main'."),
        env: z
          .string()
          .optional()
          .describe(
            "Which environment to plan for, e.g. 'staging'. Must be one the Infrafile declares in " +
              "`envs`. Omit to let the Infrafile pick its default.",
          ),
        answers: z
          .record(z.string(), z.string())
          .optional()
          .describe("Pre-supplied answers for `select(key, …)` prompts, keyed by prompt key."),
      },
      // Destructive-tier despite building nothing. `plan()` is arbitrary code
      // from the repository, executed in the isolate against this org's full
      // `infra` host — it can create or delete real resources on the way to
      // returning a plan. Same reasoning as run_workflow: the risk tier tracks
      // what the code *can* do, not what the stage is named. The separate
      // `deployments:plan` permission is the orthogonal axis, sitting between
      // read and write because a plan executes code but ships nothing.
      risk: "destructive",
      permission: "deployments:plan",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "deployments:plan");
        if (denied) return denied;
        try {
          const env = input["env"] as string | undefined;
          const answers = input["answers"] as Record<string, string> | undefined;
          const { runId, result } = await runDeployment({
            organizationId: auth.organizationId,
            userId: auth.userId,
            repo: input["repo"] as string,
            branch: (input["branch"] as string | undefined) ?? "main",
            ...(env ? { env } : {}),
            ...(answers ? { answers } : {}),
            planOnly: true,
            interactive: false,
          });
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "deployment.plan",
            entityType: "deployment",
            entityId: runId,
            metadata: {
              repo: input["repo"] as string,
              env: result.env,
              status: result.status,
              source: auth.source,
            },
          });
          return ok({
            runId,
            status: result.status,
            env: result.env,
            plan: result.plan,
            dockerfile: result.dockerfile,
            reachedStage: result.reachedStage,
            notes: result.notes,
            logs: result.logs,
            ...(result.error ? { error: result.error } : {}),
          });
        } catch (e) {
          return toolError(e);
        }
      },
    },

    {
      name: "rollback_deployment",
      title: "Roll back a deployment",
      description:
        "Ship a previous run's image again. The Infrafile is re-read at the commit that run " +
        "deployed (not at the branch head) and its `deploy()` re-run with the recorded plan and " +
        "image, so nothing is planned or built and the exact known-good artifact is what lands. " +
        "Only a successful run that produced an image can be rolled back to. This changes what is " +
        "running in the environment — the chat surface confirms with the user before invoking. " +
        "Audit-logged.",
      inputSchema: {
        runId: z
          .string()
          .describe("The successful run whose image should be redeployed, from list_deployments."),
      },
      risk: "destructive",
      permission: "deployments:write",
      handler: async (input, auth) => {
        const denied = await denyUnlessPermitted(auth, "deployments:write");
        if (denied) return denied;
        const fromRunId = input["runId"] as string;
        try {
          const { runId, result } = await rollbackDeployment({
            organizationId: auth.organizationId,
            runId: fromRunId,
            userId: auth.userId,
          });
          void logAudit({
            organizationId: auth.organizationId,
            userId: auth.userId,
            action: "deployment.rollback",
            entityType: "deployment",
            entityId: runId,
            metadata: {
              fromRunId,
              env: result.env,
              status: result.status,
              image: result.image ?? null,
              source: auth.source,
            },
          });
          return ok({
            runId,
            fromRunId,
            status: result.status,
            env: result.env,
            image: result.image,
            reachedStage: result.reachedStage,
            notes: result.notes,
            logs: result.logs,
            ...(result.error ? { error: result.error } : {}),
          });
        } catch (e) {
          return toolError(e);
        }
      },
    },
  ];
}
