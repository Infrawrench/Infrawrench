/**
 * What the forge asks of a T3 Code environment, through its MCP tools
 * (T3 Code 0.1.11; the shapes below are the ones its server declares):
 *
 * - `t3_thread_list`, `t3_project_list`: threads and projects, for pickers.
 * - `t3_project_clone` then `t3_project_create`: a repository the
 *   environment does not have yet. Both need the person to have approved
 *   this site for full access; T3 Code refuses otherwise, in a sentence
 *   that is passed on.
 * - `orchestrator_capabilities`: the providers and models a thread can run,
 *   for the model picker and for choosing one when nobody did (`models.ts`).
 * - `t3_thread_launch`: a thread on a new worktree for the branch, with the
 *   ask as its first message and the model as `modelSelection`.
 *   `clientRequestId` makes a retry find the thread the first try made.
 * - `t3_thread_send` (`mode: "auto"`): an instruction, to a thread that is
 *   idle (it starts), running (it is steered) or busy (it is queued).
 * - `t3_thread_read`: what the thread is doing, kept for a few seconds.
 *
 * What a tool answers is read leniently: a field that is not there is
 * absent, never a failure, since the environment is whatever version the
 * person runs. T3 Code 0.1 has no event subscriptions, so nothing is pushed
 * back to the forge: a thread's state is asked for when a page wants it.
 *
 * Nothing of the forge's is sent but what is written here: the ask, names,
 * addresses and commands. The thread pushes with the Git credentials on its
 * own machine. No token of the forge's ever goes to an environment: T3 Code
 * 0.1 gives an outside client no way to hand a thread a secret (no
 * environment variables on `t3_thread_launch`, and `request_secret` is the
 * thread's to call and its person's to answer), so a token sent would sit in
 * the thread's messages. The thread asks for its own instead
 * ({@link markerSetup}): a token for its one branch's markers, in exchange
 * for the Git credential its machine already has (`api/agent-token.ts`).
 */
import type { T3ModelChoice, T3Models, T3Thread } from "@infrawrench/git-contract";
import { branchPagePath, httpCloneUrl } from "@infrawrench/git-contract";
import { pageKey } from "../db/branch-pages";
import { getAgentLink, noteAgentLinkRef } from "../db/review";
import { type Env } from "../env";
import type { InstructionSender } from "../review/instructions";
import {
  type EnvironmentRow,
  type T3Deps,
  accessToken,
  errorSentence,
  getEnvironment,
  noteOutcome,
  t3Deps,
} from "./environments";
import { T3Error } from "./http";
import { McpClient } from "./mcp";
import { choiceName, choiceOf, pickModel, providersOf, selectionOf, wantsModel } from "./models";
import { MCP_PATH } from "./oauth";

type Json = Record<string, unknown>;

/** A branch's page on this site, by its key. */
const pagePath = (ref: { owner: string; repo: string }, key: string): string =>
  branchPagePath(ref.owner, ref.repo, key);

const rec = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const str = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.map(rec) : []);

/** Tools that wait on a machine doing work (a clone) get longer than a lookup. */
const SLOW_TOOL_MS = 60_000;

/**
 * Run `work` with a client of the environment, and note on its row how it
 * went: `last_error` is what the settings page shows.
 */
export const withEnvironment = async <A>(
  deps: T3Deps,
  row: EnvironmentRow,
  work: (client: McpClient) => Promise<A>,
): Promise<A> => {
  if (row.status === "pending") {
    throw new T3Error("not_signed_in", "Sign in to this environment first");
  }
  const client = new McpClient({
    http: deps.http,
    url: `${row.baseUrl}${MCP_PATH}`,
    token: () => accessToken(deps, row.id),
  });
  try {
    const result = await work(client);
    await noteOutcome(row, null, deps.now());
    return result;
  } catch (error) {
    await noteOutcome(row, error, deps.now());
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------

interface T3Project {
  readonly id: string;
  readonly title: string;
  /** Every way the project names its remote, normalised (`host/owner/name`). */
  readonly remotes: readonly string[];
  /** The model the project starts a thread with, when it sets one. */
  readonly defaultModel: T3ModelChoice | null;
}

/** `host/path` of a Git remote, lower case, without scheme, credentials or `.git`. */
export const remoteKey = (remote: string): string | null => {
  const text = remote.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(text);
  let host: string;
  let path: string;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const url = new URL(text);
      host = url.hostname;
      path = url.pathname;
    } catch {
      return null;
    }
  } else if (scp) {
    host = scp[1]!;
    path = scp[2]!;
  } else {
    return null;
  }
  const clean = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return clean === "" ? null : `${host}/${clean}`.toLowerCase();
};

const projectOf = (value: Json): T3Project | null => {
  const id = str(value["id"]);
  if (id === null || value["deletedAt"] != null) return null;
  const identity = rec(value["repositoryIdentity"]);
  const origin = rec(identity["origin"]);
  const remotes = [
    str(identity["canonicalKey"])?.toLowerCase() ?? null,
    str(origin["canonicalKey"])?.toLowerCase() ?? null,
    remoteKey(str(rec(identity["locator"])["remoteUrl"]) ?? ""),
    remoteKey(str(origin["remoteUrl"]) ?? ""),
  ].filter((each): each is string => each !== null);
  return {
    id,
    title: str(value["title"]) ?? id,
    remotes,
    defaultModel: choiceOf(value["defaultModelSelection"]),
  };
};

/** Pages of projects read before giving up on finding one. */
const PROJECT_PAGES = 5;

/** What of a client the work here uses: a tool, called. */
export type ToolCaller = Pick<McpClient, "callTool">;

const listProjects = async (client: ToolCaller): Promise<T3Project[]> => {
  const found: T3Project[] = [];
  let cursor: number | null = 0;
  for (let page = 0; page < PROJECT_PAGES && cursor !== null; page++) {
    const answer = rec(await client.callTool("t3_project_list", { cursor, limit: 100 }));
    for (const each of list(answer["projects"])) {
      const project = projectOf(each);
      if (project) found.push(project);
    }
    cursor = typeof answer["nextCursor"] === "number" ? answer["nextCursor"] : null;
  }
  return found;
};

/** The environment's threads, the most recent first, with each one's project named. */
export const listThreads = (
  deps: T3Deps,
  row: EnvironmentRow,
  query?: string,
): Promise<T3Thread[]> =>
  withEnvironment(deps, row, async (client) => {
    const title = query?.trim().slice(0, 256) ?? "";
    const [threads, projects] = await Promise.all([
      client.callTool("t3_thread_list", {
        allProjects: true,
        limit: 50,
        ...(title === "" ? {} : { titleContains: title }),
      }),
      // A picker without project names still picks: the names are best effort.
      listProjects(client).catch(() => [] as T3Project[]),
    ]);
    const names = new Map(projects.map((project) => [project.id, project.title]));
    return list(rec(threads)["threads"])
      .flatMap((thread): T3Thread[] => {
        const id = str(thread["threadId"]);
        if (id === null) return [];
        const projectId = str(thread["projectId"]);
        const updatedAt = str(thread["updatedAt"]);
        return [
          {
            id,
            title: str(thread["title"]) ?? id,
            projectId,
            projectName: projectId === null ? null : (names.get(projectId) ?? null),
            updatedAt:
              updatedAt !== null && !Number.isNaN(Date.parse(updatedAt))
                ? new Date(updatedAt).toISOString()
                : null,
          },
        ];
      })
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  });

// ---------------------------------------------------------------------------
// Starting work
// ---------------------------------------------------------------------------

export interface WorkRepository {
  readonly owner: string;
  readonly name: string;
}

const repositoryKey = (repository: WorkRepository, siteOrigin: string): string =>
  remoteKey(httpCloneUrl({ owner: repository.owner, repo: repository.name }, siteOrigin))!;

/**
 * The providers and models the environment can run a thread with, and the
 * default of its project for `repository`. A default whose provider cannot
 * run is no default; one the short list left out is added to it.
 */
export const modelsOf = async (
  client: ToolCaller,
  repository: WorkRepository | null,
  siteOrigin: string,
): Promise<T3Models> => {
  const [capabilities, projects] = await Promise.all([
    client.callTool("orchestrator_capabilities", {}),
    // The models still list without the projects: the default is best effort.
    repository === null ? [] : listProjects(client).catch(() => [] as T3Project[]),
  ]);
  const providers = providersOf(capabilities);
  const key = repository === null ? null : repositoryKey(repository, siteOrigin);
  const preset =
    key === null
      ? null
      : (projects.find((project) => project.remotes.includes(key))?.defaultModel ?? null);
  const provider = providers.find((each) => each.id === preset?.providerId);
  if (preset === null || provider === undefined) return { providers, default: null };
  const model = provider.models.find((each) => each.id === preset.model);
  if (model === undefined) {
    const added = { id: preset.model, label: preset.model, reasoning: null };
    return {
      providers: providers.map((each) =>
        each === provider ? { ...each, models: [added, ...each.models] } : each,
      ),
      default: { providerId: preset.providerId, model: preset.model },
    };
  }
  // A level the model does not list would be refused: the model's own default stands in.
  const level = preset.reasoning;
  const known =
    level !== undefined &&
    model.reasoning !== null &&
    model.reasoning.optionId === level.optionId &&
    model.reasoning.levels.includes(level.level);
  if (known) return { providers, default: preset };
  return {
    providers,
    default: {
      providerId: preset.providerId,
      model: preset.model,
      ...(model.reasoning === null || model.reasoning.default === null
        ? {}
        : {
            reasoning: { optionId: model.reasoning.optionId, level: model.reasoning.default },
          }),
    },
  };
};

/** {@link modelsOf}, asked of an environment. */
export const listModels = (
  deps: T3Deps,
  row: EnvironmentRow,
  repository: WorkRepository | null,
): Promise<T3Models> =>
  withEnvironment(deps, row, (client) => modelsOf(client, repository, deps.siteOrigin));

/**
 * The environment's project for a forge repository: the one whose remote is
 * the repository's clone address, or a new clone registered as a project.
 * Asked before anything is created on the forge, since it is the step most
 * likely to be refused (it needs full access, and Git credentials for the
 * forge on that machine).
 */
export const projectFor = (
  deps: T3Deps,
  row: EnvironmentRow,
  repository: WorkRepository,
): Promise<{ projectId: string }> =>
  withEnvironment(deps, row, async (client) => {
    const cloneUrl = httpCloneUrl(
      { owner: repository.owner, repo: repository.name },
      deps.siteOrigin,
    );
    const key = repositoryKey(repository, deps.siteOrigin);
    const known = (await listProjects(client)).find((project) => project.remotes.includes(key));
    if (known) return { projectId: known.id };

    const cloned = rec(
      await client.callTool(
        "t3_project_clone",
        {
          remoteUrl: cloneUrl,
          destinationPath: `~/infrawrench-git/${repository.owner}/${repository.name}`,
        },
        { timeoutMs: SLOW_TOOL_MS },
      ),
    );
    const cwd = str(cloned["cwd"]);
    if (cwd === null) throw new T3Error("bad_answer", "T3 Code did not say where it cloned to");
    const created = rec(
      await client.callTool("t3_project_create", {
        title: `${repository.owner}/${repository.name}`,
        workspaceRoot: cwd,
      }),
    );
    const projectId = str(created["id"]);
    if (projectId === null) throw new T3Error("bad_answer", "T3 Code did not name the project");
    return { projectId };
  });

export interface WorkToStart {
  readonly repository: WorkRepository;
  readonly pullRequestId: string;
  /** The page's key (`db/branch-pages.ts`). */
  readonly key: string;
  readonly title: string;
  readonly ask: string;
  readonly branch: string;
  readonly baseRef: string;
  /** The model the person chose. Without one the project's default runs, or one picked here. */
  readonly model?: T3ModelChoice | undefined;
}

/** The longest ask sent whole. T3 Code takes 120,000 characters of first message. */
const MAX_ASK = 100_000;

/** Where the skill that says the rest is. */
const SKILL_URL = "https://infrawrench.com/skills/infrawrench-git.md";

/** Where a thread keeps its token: its worktree's Git directory, which no commit and no push carries. */
const TOKEN_FILE = '"$(git rev-parse --git-dir)/infrawrench-git-token"';

export interface MarkerTarget {
  readonly repository: WorkRepository;
  /** The page's key (`db/branch-pages.ts`). */
  readonly key: string;
  readonly branch: string;
}

/**
 * The commands that give a thread the forge's tools for its branch: a token
 * for the branch's markers, asked for with the Git credential the machine
 * pushes with and kept in a file the agent never prints, then the MCP
 * server with that token as its header. Nothing here is a secret.
 */
export const markerSetup = (target: MarkerTarget, siteOrigin: string): string => {
  const { owner, name } = target.repository;
  const site = new URL(siteOrigin);
  const exchange = `${siteOrigin}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
    name,
  )}/branches/${encodeURIComponent(target.key)}/agent/token`;
  return [
    "```sh",
    "umask 077",
    `printf 'protocol=${site.protocol.replace(":", "")}\\nhost=${site.host}\\n\\n' | GIT_TERMINAL_PROMPT=0 git credential fill \\`,
    `  | sed -n 's/^password=\\(.*\\)$/header = "Authorization: Bearer \\1"/p' \\`,
    `  | curl -fsS -K - -X POST ${exchange} \\`,
    `  | sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p' > ${TOKEN_FILE}`,
    `claude mcp remove infrawrench-git 2>/dev/null`,
    `claude mcp add --transport http infrawrench-git ${siteOrigin}/mcp --header "Authorization: Bearer $(cat ${TOKEN_FILE})"`,
    "```",
  ].join("\n");
};

/** One call of a tool over HTTP, for a session that does not have the server's tools loaded. */
const exampleCall = (target: MarkerTarget, siteOrigin: string): string => {
  const { owner, name } = target.repository;
  const call = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "record_trace",
      arguments: {
        repository: `${owner}/${name}`,
        branch: target.branch,
        agent_name: "Claude Code",
        entries: [
          {
            kind: "decision",
            body: "Kept the retry in the client: the server cannot tell a timeout from a refusal. Ruled out a queue, which this path does not need.",
            anchors: [{ path: "src/client.ts", start_line: 40, end_line: 58 }],
            needs_code: true,
          },
          {
            kind: "evidence",
            body: "The client tests pass.",
            evidence: { command: "pnpm test client", exit_code: 0, output: "12 passed" },
          },
        ],
      },
    },
  };
  return [
    "```sh",
    `curl -fsS ${siteOrigin}/mcp -H "Authorization: Bearer $(cat ${TOKEN_FILE})" \\`,
    `  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \\`,
    // Inside single quotes for the shell: a quote in a name closes them, is escaped, and opens them again.
    `  -d '${JSON.stringify(call).replaceAll("'", "'\\''")}'`,
    "```",
  ].join("\n");
};

/**
 * How a thread reports to the reviewers: the tools' setup, what to record
 * and when, instructions, findings and a CI job's notes. Sent with the ask,
 * and what an instruction's message points back to.
 */
export const reportingGuide = (target: MarkerTarget, siteOrigin: string): string => {
  const { owner, name } = target.repository;
  const host = new URL(siteOrigin).host;
  return [
    `Reviewers read how the work was made beside each version. Record it with the forge's MCP server, \`infrawrench-git\` (${siteOrigin}/mcp). If its tools already answer (\`whoami\`), use them. If not, run this once in the worktree:`,
    markerSetup(target, siteOrigin),
    [
      `The first command asks the forge for a token with the Git credential this machine has for ${host}. The token is for this branch's trace, instructions and findings and nothing else (it cannot clone or push), lasts six hours, and stays in that file: never print it, and never put it in a message, a commit or a trace. When a call answers 401, run the commands again. If the first command writes an empty file, this machine has no HTTPS credential for ${host}: say so and carry on with the work.`,
      `The tools load when your session next starts. Until then, and in any agent that is not Claude Code, call them over HTTP, one request each. \`tools/list\` in place of \`tools/call\` describes every tool. This is \`record_trace\`:`,
    ].join("\n\n"),
    exampleCall(target, siteOrigin),
    [
      `What to record, with \`repository\` \`${owner}/${name}\` and \`branch\` \`${target.branch}\`:`,
      "",
      `1. \`ask\`, once, before you start: what you were asked, as you understood it.`,
      `2. \`step\`, after each piece of work: what you changed and why, with \`anchors\` (\`path\`, \`start_line\`, \`end_line\`) to the code.`,
      `3. \`decision\`, whenever you choose: what you chose, the reason, and what you ruled out.`,
      `4. \`evidence\`, for every test, build or check you run, failures too: \`evidence.command\`, \`evidence.exit_code\` and the lines of \`evidence.output\` that show the result.`,
      `5. \`doubt\`, for what you are unsure of, skipped or could not verify. Reviewers read these first. \`note\` for anything else they should know.`,
      `6. Set \`needs_code: true\` only when the entry cannot be understood without seeing the anchored lines. Most decisions and doubts stand on their own.`,
      `7. Record before \`git push\`: entries are attached to the version the next push makes.`,
      `8. Reviewers' instructions arrive here as messages, and \`list_instructions\` lists them. Call \`mark_instruction_delivered\` when you take one on, do it, record it, and call \`mark_instruction_answered\` before the push that answers it. If you decide not to do it, record a \`decision\` saying why, then mark it answered.`,
      `9. If you are asked to review rather than write, report with \`report_finding\` under a \`reviewer\` name of your own: \`must_fix\` only for what must not merge, \`should_fix\`, or \`note\`, each with \`path\`, lines and evidence, and \`complete: true\` when the list is everything you found.`,
      `10. A CI job you write reports by printing a line, with no token: \`::must-fix file=src/db.ts,line=42,title=Unbounded query::This read has no LIMIT.\` The commands are \`::must-fix\`, \`::should-fix\`, \`::note\`, \`::doubt\`, \`::decision\`, \`::step\` and \`::evidence\`.`,
      "",
      `The rest is in the skill: ${SKILL_URL}`,
    ].join("\n"),
  ].join("\n\n");
};

/** The first message of a thread started from an ask. */
export const workPrompt = (work: WorkToStart, siteOrigin: string): string => {
  const { owner, name } = work.repository;
  const host = new URL(siteOrigin).host;
  const page = `${siteOrigin}${pagePath({ owner, repo: name }, work.key)}`;
  const ask =
    work.ask.length > MAX_ASK
      ? `${work.ask.slice(0, MAX_ASK)}\n\n(The ask is longer than this; read the rest at ${page})`
      : work.ask;
  return [
    `You are working on ${owner}/${name} on ${host}, on the branch \`${work.branch}\`: ${work.title}`,
    page,
    "## The ask",
    ask,
    "## Where the work goes",
    [
      `- Work on the branch \`${work.branch}\`, which this worktree is on, and push to it: \`git push -u origin ${work.branch}\`. The branch already exists on the remote, at the commit \`${work.baseRef}\` was at.`,
      `- Every push is recorded as a version (v1, v2, ...) that reviewers read on the branch's page. Push when a step is worth reading, not only at the end.`,
      `- Do not start another branch for this work and do not push to \`${work.baseRef}\`.`,
      `- Pushing uses the Git credentials this machine already has for ${host}: none were sent with this message. If a push is refused for lack of them, stop and say so.`,
    ].join("\n"),
    "## Reporting to the reviewers",
    reportingGuide(work, siteOrigin),
  ].join("\n\n");
};

/** The model a thread runs, in the words a page shows. */
export interface StartedModel {
  readonly providerId: string;
  readonly modelId: string;
  /** "Claude, Opus 5.5": the environment's names where it gave them. */
  readonly name: string;
  readonly reasoningLevel: string | null;
  /** Picked here, because nobody chose and the project had no default. */
  readonly picked: boolean;
}

export interface StartedThread {
  readonly threadId: string;
  readonly projectId: string;
  /** Where a person opens the thread. */
  readonly link: string | null;
  /** Null when the environment did not say and none was sent. */
  readonly model: StartedModel | null;
}

/**
 * Start a thread for the work, on a worktree of its own. The worktree
 * starts from the base branch as the remote has it and is named for the
 * work's branch, which the forge made at that same commit, so the thread's
 * first push moves it forward.
 *
 * The model is the one chosen. With none, the launch is tried without, which
 * runs the project's default; refused for want of one, a model is picked
 * (`pickModel`) and the launch sent again. Every try carries the same
 * `clientRequestId`, so whichever of them made a thread, a later one finds it.
 */
export const launchThread = async (
  client: ToolCaller,
  projectId: string,
  work: WorkToStart,
  siteOrigin: string,
): Promise<StartedThread> => {
  const launch = (model: T3ModelChoice | null): Promise<unknown> =>
    client.callTool(
      "t3_thread_launch",
      {
        projectId,
        title: work.title.slice(0, 200),
        message: workPrompt(work, siteOrigin),
        workspaceStrategy: {
          type: "worktree",
          baseRef: `origin/${work.baseRef}`,
          branch: work.branch,
          startFromOrigin: true,
        },
        ...(model === null ? {} : { modelSelection: selectionOf(model) }),
        // One thread per pull request, however often this is retried.
        clientRequestId: `infrawrench-git:work:${work.pullRequestId}`,
      },
      { timeoutMs: SLOW_TOOL_MS },
    );
  const capabilitiesOrNull = (): Promise<unknown> =>
    client.callTool("orchestrator_capabilities", {}).catch(() => null);

  let capabilities: unknown;
  let sent = work.model ?? null;
  let picked = false;
  let answer: unknown;
  try {
    answer = await launch(sent);
  } catch (error) {
    if (sent !== null || !(error instanceof T3Error) || !wantsModel(error.message)) throw error;
    capabilities = await capabilitiesOrNull();
    sent = pickModel(capabilities);
    // Nothing to pick from: T3 Code's own sentence says what is missing.
    if (sent === null) throw error;
    picked = true;
    answer = await launch(sent);
  }
  const launched = rec(answer);
  const threadId = str(launched["threadId"]);
  if (threadId === null) throw new T3Error("bad_answer", "T3 Code did not name the thread");
  const link = str(launched["link"]);

  // What the thread runs is what the environment says it got: a retry that
  // found the first try's thread has that thread's model, whatever was sent now.
  const runs = choiceOf(launched["modelSelection"]) ?? sent;
  let model: StartedModel | null = null;
  if (runs !== null) {
    // The names are best effort: the thread is started either way.
    capabilities ??= await capabilitiesOrNull();
    model = {
      providerId: runs.providerId,
      modelId: runs.model,
      name: choiceName(runs, providersOf(capabilities)),
      reasoningLevel: runs.reasoning?.level ?? null,
      picked:
        picked && sent !== null && runs.providerId === sent.providerId && runs.model === sent.model,
    };
  }
  return {
    threadId,
    projectId: str(launched["projectId"]) ?? projectId,
    // Only an https address is kept as a link: it is shown as one.
    link: link !== null && /^https:\/\//i.test(link) ? link : null,
    model,
  };
};

/** {@link launchThread}, in an environment. */
export const startThread = (
  deps: T3Deps,
  row: EnvironmentRow,
  projectId: string,
  work: WorkToStart,
): Promise<StartedThread> =>
  withEnvironment(deps, row, (client) => launchThread(client, projectId, work, deps.siteOrigin));

// ---------------------------------------------------------------------------
// Instructions and state
// ---------------------------------------------------------------------------

/** What `git_agent_links.external_refs` holds for a T3 Code thread. */
export const T3_REFS = {
  thread: "threadId",
  project: "projectId",
  link: "threadUrl",
  /** Why there is no thread: T3 Code's sentence, or one written here. */
  launchError: "launchError",
  /** The model the thread was started with: its provider, its id, both in words, its reasoning level. */
  modelProvider: "modelProviderId",
  model: "modelId",
  modelName: "modelName",
  reasoning: "reasoningLevel",
  /** `forge` when the model was picked here rather than chosen or the project's default. */
  modelPickedBy: "modelPickedBy",
  /** Why the last instruction did not reach the thread. Gone once one does. */
  sendError: "sendError",
} as const;

/** The refs only the forge writes: never taken from what a client sends. */
export const FORGE_REFS: readonly string[] = [
  T3_REFS.launchError,
  T3_REFS.modelProvider,
  T3_REFS.model,
  T3_REFS.modelName,
  T3_REFS.reasoning,
  T3_REFS.modelPickedBy,
  T3_REFS.sendError,
  "startUrl",
  "threadStatus",
];

const environmentOfLink = async (link: {
  readonly t3EnvironmentId: string | null;
  readonly connectedByUserId: string | null;
}): Promise<EnvironmentRow> => {
  // The environment is its connector's: a link whose person or environment is gone reaches nothing.
  const row =
    link.t3EnvironmentId && link.connectedByUserId
      ? await getEnvironment(link.connectedByUserId, link.t3EnvironmentId)
      : null;
  if (!row) throw new T3Error("not_signed_in", "The branch's T3 Code environment was removed");
  return row;
};

/**
 * What a thread is told when a reviewer sends an instruction. It carries the
 * tools' setup again: the thread may be one a person named, which never got
 * the first message, and a token asked for hours ago has run out.
 */
export const instructionMessage = (
  target: MarkerTarget,
  instruction: { readonly id: string; readonly body: string },
  siteOrigin: string,
): string => {
  const { owner, name } = target.repository;
  const page = `${siteOrigin}${pagePath({ owner, repo: name }, target.key)}`;
  const id = instruction.id;
  return [
    `A reviewer sent an instruction for the branch \`${target.branch}\` (${page}). Its id is ${id}.`,
    instruction.body,
    [
      `With the \`infrawrench-git\` tools (\`repository\` \`${owner}/${name}\`, \`branch\` \`${target.branch}\`, \`instruction_id\` \`${id}\`):`,
      "",
      `1. \`mark_instruction_delivered\` now, so the reviewer sees you have it.`,
      `2. Do the work. Record it with \`record_trace\`: a \`step\` for what you changed, a \`decision\` with its reason and what you ruled out, \`evidence\` for each check you ran (command, exit code, the output that shows the result), a \`doubt\` for what you could not verify.`,
      `3. \`mark_instruction_answered\`, then \`git push origin ${target.branch}\`. If you decide not to do what was asked, record a \`decision\` saying why, then mark it answered.`,
    ].join("\n"),
    `If the tools are missing or answer 401 (the token lasts six hours), run this in the worktree, then go on. It asks the forge for a token for this branch's trace, instructions and findings with the Git credential this machine has; never print the token or the file.`,
    markerSetup(target, siteOrigin),
    `How to call a tool over HTTP when the tools are not loaded, and everything else: ${SKILL_URL}`,
  ].join("\n\n");
};

/**
 * Tell a T3 Code thread an instruction (`review/instructions.ts`
 * `InstructionSender`). One that does not get there stays queued and is sent
 * again; why is left on the link (`sendError`) for the branch's page to say,
 * and taken away by the next that arrives.
 */
export const sendInstructionToThread: InstructionSender = async (env, target, instruction) => {
  const threadId = target.link.externalRefs[T3_REFS.thread];
  // A thread that never started says so itself (`launchError`).
  if (!threadId) throw new T3Error("unsupported", "The branch's agent has no T3 Code thread yet");
  const noted = target.link.externalRefs[T3_REFS.sendError];
  try {
    await sendToThread(env, target, instruction, threadId);
  } catch (error) {
    const sentence = errorSentence(error);
    if (noted !== sentence) {
      await noteAgentLinkRef(target.link.pullRequestId, T3_REFS.sendError, sentence);
    }
    throw error;
  }
  if (noted !== undefined) {
    await noteAgentLinkRef(target.link.pullRequestId, T3_REFS.sendError, null);
  }
};

const sendToThread = async (
  env: Parameters<InstructionSender>[0],
  target: Parameters<InstructionSender>[1],
  instruction: Parameters<InstructionSender>[2],
  threadId: string,
): Promise<void> => {
  const deps = t3Deps(env);
  const row = await environmentOfLink(target.link);
  const { owner, repository } = target.repo;
  const key = await pageKey(target.pull.pull);
  const message = instructionMessage(
    {
      repository: { owner: owner.slug, name: repository.name },
      key,
      branch: target.pull.pull.headRef,
    },
    instruction,
    deps.siteOrigin,
  );
  await withEnvironment(deps, row, (client) =>
    client.callTool("t3_thread_send", {
      threadId,
      message: message.slice(0, 120_000),
      mode: "auto",
      // A retry after an answer that was lost is the same message, not a second one.
      clientRequestId: `infrawrench-git:instruction:${instruction.id}`,
    }),
  );
};

/** How long a thread's state is kept. A cache per isolate: nothing depends on it being shared. */
const STATE_TTL_MS = 15_000;
const stateCache = new Map<string, { at: number; state: string | null }>();

/**
 * What a branch's T3 Code thread is doing: `idle`, or its run's status
 * (`running`, `waiting`, `completed`, ...). Null when it cannot be asked;
 * that is never an error for the page that wants it.
 */
export const threadState = async (env: Env, pullRequestId: string): Promise<string | null> => {
  const link = await getAgentLink(pullRequestId);
  const threadId = link?.kind === "t3" ? link.externalRefs[T3_REFS.thread] : undefined;
  if (!link || !threadId) return null;
  const deps = t3Deps(env);
  const key = `${link.t3EnvironmentId}\0${threadId}`;
  const kept = stateCache.get(key);
  const now = deps.now().getTime();
  if (kept && now - kept.at < STATE_TTL_MS) return kept.state;
  let state: string | null = null;
  try {
    const row = await environmentOfLink(link);
    const read = rec(
      await withEnvironment(deps, row, (client) =>
        client.callTool("t3_thread_read", { threadId, limit: 1 }),
      ),
    );
    state = str(rec(read["thread"])["status"]);
  } catch {
    state = null;
  }
  if (stateCache.size > 500) stateCache.clear();
  stateCache.set(key, { at: now, state });
  return state;
};
