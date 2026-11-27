import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { IssueImport } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { Badge, type BadgeTone } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Field, Input } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { RelativeTime } from "../../components/people";
import { SettingsSection } from "../../components/SideNav";
import { EmptyState, InlineError, QueryView } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { plural } from "../../lib/format";

const SOURCE_REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;

const isActive = (item: IssueImport): boolean =>
  item.status === "queued" || item.status === "running";

const STATUS: Record<IssueImport["status"], { label: string; tone: BadgeTone }> = {
  queued: { label: "Queued", tone: "outline" },
  running: { label: "Running", tone: "notice" },
  done: { label: "Done", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "outline" },
};

const PHASE: Record<IssueImport["phase"], string> = {
  labels: "Reading labels",
  milestones: "Reading milestones",
  issues: "Reading issues",
  comments: "Reading comments",
  finish: "Finishing",
};

function ImportForm({ disabled }: { disabled: boolean }) {
  const repo = useRepoRef();
  const [repository, setRepository] = useState("");
  const [token, setToken] = useState("");
  const start = useMutation({
    mutationFn: () =>
      api.issueImports.create({
        params: repo,
        payload: { source: "github", repository: repository.trim(), token: token.trim() },
      }),
    onSuccess: () => {
      setToken("");
      void invalidate("issueImports");
    },
  });
  const valid = SOURCE_REPOSITORY.test(repository.trim()) && token.trim() !== "";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid && !disabled) start.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3 px-3 py-3">
      <Field label="GitHub repository">
        {(control) => (
          <Input
            {...control}
            value={repository}
            required
            spellCheck={false}
            autoComplete="off"
            placeholder="owner/name"
            maxLength={141}
            onChange={(event) => setRepository(event.target.value)}
            className="max-w-sm font-mono"
          />
        )}
      </Field>
      <Field label="Token" hint="A fine-grained token with Issues: Read-only, plus Metadata">
        {(control) => (
          <Input
            {...control}
            type="password"
            value={token}
            required
            spellCheck={false}
            autoComplete="off"
            maxLength={512}
            onChange={(event) => setToken(event.target.value)}
            className="max-w-sm font-mono"
          />
        )}
      </Field>
      <div className="flex items-center justify-end gap-2">
        <InlineError error={start.error} />
        <Button
          type="submit"
          variant="primary"
          busy={start.isPending}
          disabled={!valid || disabled}
        >
          Start
        </Button>
      </div>
    </form>
  );
}

function ImportRow({ item }: { item: IssueImport }) {
  const repo = useRepoRef();
  const cancel = useMutation({
    mutationFn: () => api.issueImports.cancel({ params: { ...repo, importId: item.id } }),
    onSuccess: () => void invalidate("issueImports"),
  });
  const status = STATUS[item.status];
  const active = isActive(item);
  const { counts } = item;
  return (
    <li className="flex flex-wrap items-center gap-3 border-t border-border px-3 py-2.5 first:border-t-0">
      <Icon name="download" size={16} className="text-on-surface-muted" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 text-xs font-medium text-on-surface">
          <span className="truncate font-mono">{item.repository}</span>
          <Badge tone={status.tone}>{status.label}</Badge>
          {active ? (
            <span className="font-normal text-on-surface-muted">{PHASE[item.phase]}</span>
          ) : null}
        </p>
        <p className="text-xs text-on-surface-muted tabular-nums">
          {plural(counts.issues, "issue")} · {plural(counts.comments, "comment")} ·{" "}
          {plural(counts.labels, "label")} · {plural(counts.milestones, "milestone")}
        </p>
        <p className="text-xs text-on-surface-muted">
          Started <RelativeTime iso={item.createdAt} />
          {item.startedBy?.username ? ` by ${item.startedBy.username}` : ""}
          {item.finishedAt !== null ? (
            <>
              {" "}
              · ended <RelativeTime iso={item.finishedAt} />
            </>
          ) : null}
          {active && item.resumeAt !== null ? (
            <>
              {" "}
              · waiting for GitHub's rate limit, <RelativeTime iso={item.resumeAt} />
            </>
          ) : null}
        </p>
        {item.error !== null ? (
          <p role="alert" className="text-xs text-danger">
            {item.error}
          </p>
        ) : null}
        <InlineError error={cancel.error} />
      </div>
      {active ? (
        <Button
          size="sm"
          busy={cancel.isPending}
          aria-label={`Cancel the import of ${item.repository}`}
          onClick={() => cancel.mutate()}
        >
          Cancel
        </Button>
      ) : null}
    </li>
  );
}

/** Settings > Import: issues from a GitHub repository, with what each import has done. */
export function ImportPage() {
  const repo = useRepoRef();
  const imports = useQuery({
    ...queries.issueImports.list({ params: repo }),
    staleTime: 0,
    // While one runs, its counts move.
    refetchInterval: (query) => (query.state.data?.imports.some(isActive) ? 3000 : false),
  });
  const running = imports.data?.imports.some(isActive) ?? false;
  return (
    <SettingsSection title="Import issues">
      <Panel>
        <ImportForm disabled={running} />
      </Panel>
      <QueryView query={imports}>
        {({ imports: items }) => (
          <Panel>
            {items.length === 0 ? (
              <EmptyState>No imports</EmptyState>
            ) : (
              <ul>
                {items.map((item) => (
                  <ImportRow key={item.id} item={item} />
                ))}
              </ul>
            )}
          </Panel>
        )}
      </QueryView>
    </SettingsSection>
  );
}
