/**
 * The agent that writes a branch: who it is, what it is doing, and where its
 * session or thread can be opened. Without one, how any agent connects.
 *
 * A T3 Code thread the forge could not start is shown as that, in T3 Code's
 * own sentence (`externalRefs.launchError`), with Try again for the person
 * whose environment it is: the same ask, with a model chosen. "Idle" is only
 * ever a thread that exists. An instruction that did not reach the thread
 * (`sendError`) is said too; it stays queued and is sent again.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  SITE_ORIGIN,
  type AgentKind,
  type AgentLink,
  type BranchPageState,
  type T3Environment,
} from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { Button } from "../../components/Button";
import { invalidate, queries } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { CopyButton } from "../../components/controls";
import { Icon, Spinner } from "../../components/icons";
import { UserLink } from "../../components/people";
import { InlineError } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { plural } from "../../lib/format";
import { webUrl } from "../../lib/safe-url";
import { useSession } from "../../lib/session";
import { optional } from "./optional";
import { levelLabel, useT3ModelFields } from "./T3Model";

export const AGENT_KIND_LABEL: Record<AgentKind, string> = {
  infrawrench: "Infrawrench",
  t3: "T3 Code",
  mcp: "MCP",
};

/** The forge's MCP server, which any agent can be pointed at. */
export const MCP_URL = `${SITE_ORIGIN}/mcp`;

export interface McpClientSetup {
  readonly client: string;
  /** The file a snippet goes in, for a client set up by a file. */
  readonly file?: string;
  /** What to run or paste, in order. Each has a copy button. */
  readonly snippets: ReadonlyArray<string>;
}

export const MCP_CLIENTS: ReadonlyArray<McpClientSetup> = [
  {
    client: "Claude Code",
    snippets: [`claude mcp add --transport http infrawrench-git ${MCP_URL}`],
  },
  {
    client: "Codex",
    snippets: [`codex mcp add infrawrench-git --url ${MCP_URL}`, "codex mcp login infrawrench-git"],
  },
  {
    client: "Cursor",
    file: "~/.cursor/mcp.json",
    snippets: [JSON.stringify({ mcpServers: { "infrawrench-git": { url: MCP_URL } } }, null, 2)],
  },
];

/** How each client installs the forge's MCP server: every command or file with a copy button. */
export function McpSetup() {
  return (
    <ul className="space-y-2">
      {MCP_CLIENTS.map(({ client, file, snippets }) => (
        <li key={client} className="space-y-1">
          <p className="flex flex-wrap items-baseline gap-x-2 text-xs font-medium text-on-surface-secondary">
            {client}
            {file !== undefined ? (
              <code className="font-mono text-[11px] font-normal text-on-surface-muted">
                {file}
              </code>
            ) : null}
          </p>
          {snippets.map((snippet, index) => {
            const block = snippet.includes("\n");
            const label =
              file !== undefined
                ? `Copy the ${client} configuration`
                : snippets.length === 1
                  ? `Copy the ${client} command`
                  : `Copy ${client} command ${index + 1}`;
            return (
              <div
                key={snippet}
                className={`flex gap-1 rounded border border-border bg-surface-inset py-1 pr-1 pl-2 ${
                  block ? "items-start" : "items-center"
                }`}
              >
                {block ? (
                  <pre className="min-w-0 flex-1 overflow-x-auto py-0.5 font-mono text-[11px] leading-4 text-on-surface">
                    {snippet}
                  </pre>
                ) : (
                  <code className="min-w-0 flex-1 overflow-x-auto font-mono text-[11px] whitespace-nowrap text-on-surface">
                    {snippet}
                  </code>
                )}
                <CopyButton text={snippet} label={label} />
              </div>
            );
          })}
        </li>
      ))}
    </ul>
  );
}

/**
 * Where an agent's session or thread opens: the address it gave, else the
 * T3 Code environment it runs in (when it is one of the viewer's), else the
 * app for an Infrawrench agent.
 */
export function sessionLink(
  agent: AgentLink,
  environments: ReadonlyArray<T3Environment>,
  appUrl: string | null,
): { href: string; label: string } | null {
  // `threadUrl` is what the forge keeps for a thread it started.
  const given = agent.externalRefs["url"] ?? agent.externalRefs["threadUrl"];
  if (given !== undefined && webUrl(given) !== null) {
    return { href: given, label: agent.kind === "t3" ? "Open thread" : "Open session" };
  }
  if (agent.kind === "t3") {
    const environment = environments.find((item) => item.id === agent.t3EnvironmentId);
    return environment === undefined
      ? null
      : { href: environment.baseUrl, label: `Open ${environment.label}` };
  }
  if (agent.kind === "infrawrench" && appUrl !== null) {
    return { href: appUrl, label: "Open in Infrawrench" };
  }
  return null;
}

export function AgentPanel({
  state,
  branchKey,
  canEdit,
}: {
  state: BranchPageState;
  branchKey: string;
  canEdit: boolean;
}) {
  const repo = useRepoRef();
  const session = useSession();
  const { agent } = state;
  const environments = useQuery({
    ...optional(queries.t3.list()),
    enabled: agent?.kind === "t3" && session.data?.user != null,
  });
  const disconnect = useMutation({
    mutationFn: () => api.agents.remove({ params: { ...repo, branch: branchKey } }),
    onSuccess: () => {
      void invalidate("agents");
      void invalidate("versions", "branchState");
    },
  });
  const retry = useMutation({
    mutationFn: (model: Parameters<typeof api.agents.set>[0]["payload"]["t3Model"]) =>
      api.agents.set({
        params: { ...repo, branch: branchKey },
        payload: {
          kind: "t3",
          displayName: agent?.displayName ?? "T3 Code",
          t3EnvironmentId: agent?.t3EnvironmentId ?? null,
          ...(model === undefined ? {} : { t3Model: model }),
        },
      }),
    onSuccess: () => {
      void invalidate("agents");
      void invalidate("versions", "branchState");
    },
  });
  const working = state.state === "agent_working";
  const refs = agent?.externalRefs ?? {};
  const isT3 = agent?.kind === "t3";
  const hasThread = !isT3 || refs["threadId"] !== undefined;
  const launchError = isT3 && !hasThread ? (refs["launchError"] ?? null) : null;
  // Only the person whose environment it is can ask it again.
  const ownEnvironment =
    (environments.data?.environments ?? []).find(
      (item) => item.id === agent?.t3EnvironmentId && item.status === "connected",
    ) ?? null;
  const canRetry = canEdit && isT3 && !hasThread && ownEnvironment !== null;
  const model = useT3ModelFields({
    environmentId: ownEnvironment?.id ?? null,
    repo,
    enabled: canRetry,
  });
  const modelName = refs["modelName"] ?? refs["modelId"] ?? null;
  const link =
    agent === null
      ? null
      : sessionLink(agent, environments.data?.environments ?? [], session.data?.appUrl ?? null);
  return (
    <section aria-labelledby="branch-agent" className="border-b border-border pb-3">
      <h2 id="branch-agent" className="mb-1.5 text-xs font-semibold text-on-surface-secondary">
        Agent
      </h2>
      {agent === null ? (
        <div className="space-y-2">
          <p className="text-xs text-on-surface-muted">No agent connected</p>
          {canEdit ? (
            <details className="text-xs">
              <summary className="cursor-pointer text-on-surface-secondary hover:text-on-surface">
                Connect one over MCP
              </summary>
              <div className="pt-2">
                <McpSetup />
              </div>
            </details>
          ) : null}
        </div>
      ) : (
        <div className="space-y-1.5 text-xs">
          <p className="flex items-center gap-1.5">
            <Icon name="bot" size={14} className="text-on-surface-secondary" />
            <span className="min-w-0 truncate font-medium text-on-surface">
              {agent.displayName}
            </span>
            <span className="shrink-0 text-on-surface-muted">{AGENT_KIND_LABEL[agent.kind]}</span>
          </p>
          {!hasThread ? (
            <div className="space-y-1.5">
              <p role="status" className="flex items-center gap-1.5 font-medium text-danger">
                <Icon name="alertCircle" size={12} />
                {launchError !== null ? "The thread did not start" : "No thread started"}
              </p>
              {launchError !== null ? (
                <p className="break-words text-on-surface-secondary">{launchError}</p>
              ) : null}
              {canRetry ? (
                <form
                  className="space-y-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (model.ready) retry.mutate(model.choice);
                  }}
                >
                  {model.fields}
                  <Button type="submit" size="sm" busy={retry.isPending} disabled={!model.ready}>
                    Try again
                  </Button>
                  <InlineError error={retry.error} />
                </form>
              ) : null}
            </div>
          ) : (
            <p role="status" className="flex items-center gap-1.5 text-on-surface-secondary">
              {working ? (
                <>
                  <Spinner size={12} className="text-notice" />
                  {state.workingOnVersion === null
                    ? "Working"
                    : `Working on v${state.workingOnVersion}`}
                </>
              ) : (
                <>
                  <Icon name="circleDot" size={12} className="text-on-surface-muted" />
                  Idle
                </>
              )}
            </p>
          )}
          {hasThread && isT3 && modelName !== null ? (
            <p className="text-on-surface-muted">
              {modelName}
              {refs["reasoningLevel"] !== undefined
                ? `, ${levelLabel(refs["reasoningLevel"]).toLowerCase()} reasoning`
                : ""}
              {refs["modelPickedBy"] === "forge" ? " (picked automatically)" : ""}
            </p>
          ) : null}
          {hasThread && isT3 && refs["sendError"] !== undefined ? (
            <p className="break-words text-danger">
              The last instruction did not reach the thread and will be sent again:{" "}
              {refs["sendError"]}
            </p>
          ) : null}
          {state.pendingTraceEntries > 0 ? (
            <p className="text-on-surface-muted">
              {plural(state.pendingTraceEntries, "trace entry", "trace entries")} not pushed yet
            </p>
          ) : null}
          {agent.connectedBy !== null ? (
            <p className="flex flex-wrap items-center gap-x-1 text-on-surface-muted">
              Connected by <UserLink user={agent.connectedBy} />
            </p>
          ) : null}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {link !== null ? (
              <AppLink
                href={link.href}
                target="_blank"
                className="inline-flex items-center gap-1 text-on-surface-secondary hover:underline"
              >
                {link.label}
                <Icon name="externalLink" size={11} />
              </AppLink>
            ) : null}
            {canEdit ? (
              <button
                type="button"
                disabled={disconnect.isPending}
                onClick={() => disconnect.mutate()}
                className="text-on-surface-muted hover:text-on-surface hover:underline disabled:opacity-60"
              >
                Disconnect
              </button>
            ) : null}
          </p>
          <InlineError error={disconnect.error} />
        </div>
      )}
    </section>
  );
}
