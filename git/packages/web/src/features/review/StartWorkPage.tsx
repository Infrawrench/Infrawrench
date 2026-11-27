/**
 * Starting work: the agent that will write the branch, then what the forge
 * needs to start it. For T3 Code that is the model a new thread runs, the
 * ask, the branch to start from and the new branch's name: the forge makes
 * the branch and its page, starts the thread and goes to the page. The model
 * is always asked for (`T3Model.tsx`): the project's default to begin with,
 * and a choice the Start button waits for when the project has none. Another agent starts work itself, with
 * the MCP server's `start_work`, so that choice shows how to install the
 * server and nothing to submit.
 *
 * The app's own agent sessions are not offered here. A page one of them
 * already writes still names it (`Agent.tsx`), and the app still starts a
 * session from `/agents?git=&branch=`.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { AgentLinkSet } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { AppLink, useGo } from "../../components/AppLink";
import { Button, ButtonLink, buttonClass } from "../../components/Button";
import { Field, Input, RadioCards, Select } from "../../components/forms";
import { Icon } from "../../components/icons";
import { MarkdownEditor } from "../../components/MarkdownEditor";
import { Page, PageHeader } from "../../components/Panel";
import { RefPicker } from "../../components/RefPicker";
import { EmptyState, InlineError, Loading } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { paths } from "../../lib/paths";
import { signInHref, useSession } from "../../lib/session";
import { McpSetup } from "./Agent";
import { branchNameFor } from "./branch";
import { isUnavailable, optional } from "./optional";
import { useT3ModelFields } from "./T3Model";

type Choice = "t3" | "mcp";

const NEW_THREAD = "";

export function StartWorkPage() {
  const repo = useRepoRef();
  const repository = useRepository();
  const session = useSession();
  const go = useGo();
  const signedIn = session.data?.user != null;

  const [ask, setAsk] = useState("");
  const [base, setBase] = useState(repository.defaultBranch);
  const [branch, setBranch] = useState("");
  const [named, setNamed] = useState(false);
  const [picked, setPicked] = useState<Choice | null>(null);
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState(NEW_THREAD);
  const [projectId, setProjectId] = useState("");

  const environments = useQuery({ ...optional(queries.t3.list()), enabled: signedIn });
  // T3 Code first; a server without it leaves the one choice.
  const t3Offered = !isUnavailable(environments.error);
  const choice: Choice = t3Offered ? (picked ?? "t3") : "mcp";
  const connected = (environments.data?.environments ?? []).filter(
    (item) => item.status === "connected",
  );
  const environment = connected.find((item) => item.id === environmentId) ?? connected[0] ?? null;
  const threads = useQuery({
    ...optional(queries.t3.listThreads({ params: { environmentId: environment?.id ?? "" } })),
    enabled: choice === "t3" && environment !== null,
  });
  const thread = (threads.data?.threads ?? []).find((item) => item.id === threadId) ?? null;
  const projects = [
    ...new Map(
      (threads.data?.threads ?? []).flatMap((item) =>
        item.projectId === null ? [] : [[item.projectId, item.projectName ?? item.projectId]],
      ),
    ),
  ] as Array<[string, string]>;

  // A thread that already runs has its model: only a new one is given one.
  const model = useT3ModelFields({
    environmentId: environment?.id ?? null,
    repo,
    enabled:
      choice === "t3" && environment !== null && threads.data !== undefined && thread === null,
  });

  // Until the person names the branch, it follows the ask's first line.
  const name = named ? branch : branchNameFor(ask);

  const agentOf = (): AgentLinkSet | undefined => {
    if (choice === "t3" && environment !== null) {
      const project = thread?.projectId ?? (projectId === "" ? projects[0]?.[0] : projectId);
      return {
        kind: "t3",
        displayName: thread?.title ?? `T3 Code on ${environment.label}`,
        t3EnvironmentId: environment.id,
        externalRefs: {
          ...(thread === null ? {} : { threadId: thread.id }),
          ...(project === undefined ? {} : { projectId: project }),
        },
        ...(thread === null && model.choice !== undefined ? { t3Model: model.choice } : {}),
      };
    }
    return undefined;
  };

  const start = useMutation({
    mutationFn: () => {
      const agent = agentOf();
      return api.agents.startWork({
        params: repo,
        payload: {
          ask: ask.trim(),
          base,
          ...(name.trim() === "" ? {} : { branch: name.trim() }),
          ...(agent === undefined ? {} : { agent }),
        },
      });
    },
    onSuccess: (made) => {
      void invalidate("branches");
      void invalidate("repositories", "get");
      void invalidate("contents", "listBranches");
      void invalidate("review", "inbox");
      go(paths.branchPage(repo, made.page.key));
    },
  });

  if (session.data === undefined) return <Loading shape="page" />;
  if (!signedIn) {
    return (
      <Page>
        <EmptyState
          action={
            <a href={signInHref()} className={buttonClass("primary")}>
              Sign in
            </a>
          }
        >
          Sign in to start work
        </EmptyState>
      </Page>
    );
  }
  if (!repository.viewer.canPush || repository.archived) {
    return (
      <Page>
        <EmptyState action={<ButtonLink href={paths.branches(repo)}>Branches</ButtonLink>}>
          {repository.archived
            ? "This repository is archived"
            : "Only people who can push here can start work"}
        </EmptyState>
      </Page>
    );
  }

  const ready = choice === "t3" && environment !== null && ask.trim() !== "" && model.ready;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (ready) start.mutate();
  };

  return (
    <Page width="narrow">
      <PageHeader title="Start work" />
      <form onSubmit={submit} className="space-y-4">
        <RadioCards<Choice>
          legend="Agent"
          name="agent"
          value={choice}
          onChange={setPicked}
          options={[
            ...(t3Offered
              ? [{ value: "t3" as const, label: "T3 Code", icon: <Icon name="code" size={13} /> }]
              : []),
            { value: "mcp", label: "Another agent", icon: <Icon name="terminal" size={13} /> },
          ]}
        />

        {choice === "mcp" ? (
          <div className="space-y-3">
            <McpSetup />
            <p className="text-xs text-on-surface-muted">
              The agent starts work itself with its <code className="font-mono">start_work</code>{" "}
              tool.
            </p>
          </div>
        ) : (
          <>
            {environments.data === undefined ? (
              <Loading shape="rows" count={2} />
            ) : environment === null ? (
              <p className="flex flex-wrap items-center gap-x-2 text-xs text-on-surface-muted">
                No T3 Code environment connected
                <AppLink
                  href={paths.settings("t3")}
                  className="font-medium text-on-surface hover:underline"
                >
                  Connect one
                </AppLink>
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Environment">
                  {(control) => (
                    <Select
                      {...control}
                      value={environment.id}
                      onChange={(event) => {
                        setEnvironmentId(event.target.value);
                        setThreadId(NEW_THREAD);
                        setProjectId("");
                      }}
                    >
                      {connected.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.label}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                {threads.data !== undefined ? (
                  <Field label="Thread">
                    {(control) => (
                      <Select
                        {...control}
                        value={threadId}
                        onChange={(event) => setThreadId(event.target.value)}
                      >
                        <option value={NEW_THREAD}>New thread</option>
                        {threads.data.threads.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.projectName === null
                              ? item.title
                              : `${item.projectName}: ${item.title}`}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                ) : null}
                {threads.data !== undefined && thread === null && projects.length > 0 ? (
                  <Field label="Project">
                    {(control) => (
                      <Select
                        {...control}
                        value={projectId === "" ? projects[0]![0] : projectId}
                        onChange={(event) => setProjectId(event.target.value)}
                      >
                        {projects.map(([id, label]) => (
                          <option key={id} value={id}>
                            {label}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                ) : null}
                {model.fields}
              </div>
            )}
            <MarkdownEditor
              label="Ask"
              placeholder="What should change"
              value={ask}
              onChange={setAsk}
              rows={7}
              autoFocus
              onSubmit={() => ready && start.mutate()}
            />
            <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)]">
              <div className="space-y-1">
                <span className="block text-xs font-medium text-on-surface">Start from</span>
                <RefPicker
                  repo={repo}
                  value={base}
                  branchesOnly
                  label="base"
                  onSelect={(picked) => setBase(picked)}
                />
              </div>
              <Field
                label="Branch"
                error={
                  start.error !== null && isRefExists(start.error) ? start.error.message : undefined
                }
              >
                {(control) => (
                  <Input
                    {...control}
                    value={name}
                    maxLength={255}
                    spellCheck={false}
                    autoComplete="off"
                    className="font-mono"
                    onChange={(event) => {
                      setNamed(true);
                      setBranch(event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" variant="primary" busy={start.isPending} disabled={!ready}>
                Start work
              </Button>
              <ButtonLink href={paths.branches(repo)}>Cancel</ButtonLink>
              {start.error !== null && !isRefExists(start.error) ? (
                <InlineError error={start.error} />
              ) : null}
            </div>
          </>
        )}
      </form>
    </Page>
  );
}

const isRefExists = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: unknown }).code === "ref_exists";
