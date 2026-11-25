/**
 * The merge box: whether the pull request can merge and why not (reviews,
 * checks, conflicts, how far behind it is), then the merge itself. It draws
 * `deriveMergeBox` and holds only the form's state.
 */
import { useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import type { MergeMethod, PullRequest } from "@infrawrench/git-contract";
import { ApiError, api } from "../../api/client";
import { invalidate } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Checkbox, Field, Input, Select, Textarea } from "../../components/forms";
import { Icon, type IconName } from "../../components/icons";
import { Menu } from "../../components/Menu";
import { InlineError } from "../../components/states";
import { CheckStateIcon } from "../../components/StatusIcons";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { shortOid } from "../../lib/format";
import { paths } from "../../lib/paths";
import {
  MERGE_BUTTON,
  MERGE_METHOD_LABEL,
  deriveMergeBox,
  type CheckRow,
  type MergeRow,
  type RowTone,
} from "./merge-box";
import { refreshPull } from "./PullLayout";

const TONE_CLASS: Record<RowTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  neutral: "text-on-surface-muted",
};
const TONE_ICON: Record<RowTone, IconName> = {
  success: "checkCircle",
  warning: "clock",
  danger: "xCircle",
  neutral: "alertCircle",
};

function Row({
  row,
  children,
  actions,
}: {
  row: MergeRow;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="flex flex-wrap items-center gap-2.5">
        <Icon name={TONE_ICON[row.tone]} size={16} className={TONE_CLASS[row.tone]} />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-on-surface">{row.title}</p>
          {row.detail !== null ? (
            <p className="text-xs text-on-surface-muted">{row.detail}</p>
          ) : null}
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}

function CheckList({ rows }: { rows: ReadonlyArray<CheckRow> }) {
  return (
    <ul className="mt-2 overflow-hidden rounded border border-border">
      {rows.map((row) => (
        <li
          key={row.context}
          className="flex items-center gap-2 border-t border-border px-2.5 py-1.5 text-xs first:border-t-0"
        >
          <CheckStateIcon state={row.state} />
          <span className="min-w-0 truncate font-medium text-on-surface">{row.context}</span>
          <span className="min-w-0 flex-1 truncate text-on-surface-muted">{row.description}</span>
          {row.required ? <Badge tone="outline">Required</Badge> : null}
          {row.targetUrl !== null ? (
            <AppLink
              href={row.targetUrl}
              className="shrink-0 text-on-surface-secondary hover:underline"
            >
              Details
            </AppLink>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

export function MergeBox({ pull }: { pull: PullRequest }) {
  const repo = useRepoRef();
  const repository = useRepository();
  const params = { ...repo, number: pull.number };
  const { mergeability } = pull;
  const model = deriveMergeBox(mergeability, pull.baseRef);
  const [showChecks, setShowChecks] = useState(model.checks?.tone !== "success");
  const [method, setMethod] = useState<MergeMethod>(mergeability.defaultMethod);
  const [confirming, setConfirming] = useState(false);
  const [bypass, setBypass] = useState(false);
  const [deleteBranch, setDeleteBranch] = useState(repository.merge.deleteBranchOnMerge);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");

  const merge = useMutation({
    mutationFn: () =>
      api.pulls.merge({
        params,
        payload: {
          method,
          expectedHeadOid: pull.headOid,
          deleteBranch,
          ...(model.action.mode === "bypass" ? { bypass: true } : {}),
          ...(method !== "rebase" && title.trim() !== "" ? { commitTitle: title.trim() } : {}),
          ...(method !== "rebase" && message.trim() !== "" ? { commitMessage: message } : {}),
        },
      }),
    onSuccess: () => {
      setConfirming(false);
      refreshPull();
      void invalidate("contents");
      void invalidate("ci");
    },
    onError: (error) => {
      // The head moved under the reader: show them the new state before they try again.
      if (error instanceof ApiError && error.code === "head_moved") refreshPull();
    },
  });
  const update = useMutation({
    mutationFn: (how: "merge" | "rebase") =>
      api.pulls.updateBranch({
        params,
        payload: { method: how, expectedHeadOid: pull.headOid },
      }),
    onSuccess: () => {
      refreshPull();
      void invalidate("contents");
      void invalidate("ci");
    },
  });
  const ready = useMutation({
    mutationFn: () => api.pulls.setDraft({ params, payload: { draft: false } }),
    onSuccess: refreshPull,
  });
  const removeBranch = useMutation({
    mutationFn: () =>
      api.contents.deleteBranch({
        params: repo,
        query: { name: pull.headRef, expectedOid: pull.headOid },
      }),
    onSuccess: () => {
      refreshPull();
      void invalidate("contents");
    },
  });
  const restoreBranch = useMutation({
    mutationFn: () => api.pulls.restoreBranch({ params }),
    onSuccess: () => {
      refreshPull();
      void invalidate("contents");
    },
  });

  if (pull.state !== "open") {
    const merged = pull.state === "merged";
    return (
      <section
        aria-label="Merge status"
        className="rounded-md border border-border bg-surface-raised sm:ml-10"
      >
        <Row
          row={{
            tone: merged ? "success" : "neutral",
            title: merged ? "Merged" : "Closed without merging",
            detail:
              merged && pull.mergeCommitOid !== null
                ? `${MERGE_METHOD_LABEL[pull.mergeMethod ?? "merge"]} ${shortOid(pull.mergeCommitOid)} into ${pull.baseRef}`
                : null,
          }}
          actions={
            <>
              {pull.viewer.canDeleteHeadBranch ? (
                <Button busy={removeBranch.isPending} onClick={() => removeBranch.mutate()}>
                  Delete branch
                </Button>
              ) : null}
              {!pull.headRefExists && repository.viewer.canPush ? (
                <Button busy={restoreBranch.isPending} onClick={() => restoreBranch.mutate()}>
                  Restore branch
                </Button>
              ) : null}
            </>
          }
        >
          <InlineError error={removeBranch.error ?? restoreBranch.error} />
        </Row>
      </section>
    );
  }

  const allowed = mergeability.allowedMethods;
  const action = model.action;
  const canAct = action.mode === "merge" || (action.mode === "bypass" && bypass);

  return (
    <section
      aria-label="Merge"
      className="rounded-md border border-border bg-surface-raised sm:ml-10"
    >
      {pull.draft ? (
        <Row
          row={{ tone: "neutral", title: "This pull request is a draft", detail: null }}
          actions={
            pull.viewer.canEdit ? (
              <Button busy={ready.isPending} onClick={() => ready.mutate()}>
                Ready for review
              </Button>
            ) : undefined
          }
        >
          <InlineError error={ready.error} />
        </Row>
      ) : null}
      {model.reviews !== null ? <Row row={model.reviews} /> : null}
      {model.checks !== null ? (
        <Row
          row={model.checks}
          actions={
            <>
              <AppLink
                href={paths.pullTab(repo, pull.number, "checks")}
                className="text-xs text-on-surface-secondary hover:underline"
              >
                Checks
              </AppLink>
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={showChecks}
                onClick={() => setShowChecks(!showChecks)}
              >
                {showChecks ? "Hide" : "Show"}
              </Button>
            </>
          }
        >
          {showChecks ? <CheckList rows={model.checkRows} /> : null}
        </Row>
      ) : null}
      <Row
        row={model.branch}
        actions={
          mergeability.canUpdateBranch ? (
            <div className="flex">
              <Button
                className="rounded-r-none"
                busy={update.isPending}
                onClick={() => update.mutate("merge")}
              >
                <Icon name="refresh" size={12} />
                Update branch
              </Button>
              <Menu
                label="How to update"
                align="end"
                items={[
                  {
                    label: `Merge ${pull.baseRef} into it`,
                    onSelect: () => update.mutate("merge"),
                  },
                  { label: `Rebase onto ${pull.baseRef}`, onSelect: () => update.mutate("rebase") },
                ]}
                trigger={({ props }) => (
                  <button
                    {...props}
                    type="button"
                    aria-label="Choose how to update the branch"
                    aria-haspopup="menu"
                    className="inline-flex items-center h-[30px] rounded-r border border-l-0 border-border bg-surface-raised px-1.5 text-on-surface hover:bg-surface-sunken"
                  >
                    <Icon name="chevronDown" size={12} />
                  </button>
                )}
              />
            </div>
          ) : undefined
        }
      >
        {mergeability.conflictFiles.length > 0 ? (
          <ul className="mt-2 space-y-0.5 font-mono text-xs text-on-surface-secondary">
            {mergeability.conflictFiles.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
        ) : null}
        <InlineError error={update.error} />
      </Row>

      {action.mode === "none" ? null : (
        <div className="space-y-2.5 rounded-b-md bg-surface-inset px-3 py-2.5">
          {mergeability.protection !== null ? (
            <p className="flex items-center gap-1.5 text-xs text-on-surface-muted">
              <Icon name="shield" size={12} />
              <span>
                <span className="font-mono text-on-surface-secondary">
                  {mergeability.protection.pattern}
                </span>{" "}
                is protected
              </span>
            </p>
          ) : null}
          {action.mode === "blocked" || action.mode === "bypass" ? (
            <ul className="space-y-0.5 text-xs text-on-surface-secondary" aria-label="Blocked by">
              {action.reasons.map((reason) => (
                <li key={reason} className="flex items-center gap-1.5">
                  <Icon name="ban" size={12} className="text-danger" />
                  {reason}
                </li>
              ))}
            </ul>
          ) : null}
          {action.mode === "bypass" ? (
            <Checkbox
              label="Merge without waiting for the requirements"
              checked={bypass}
              onChange={(event) => setBypass(event.target.checked)}
            />
          ) : null}
          {action.mode === "blocked" ? null : confirming ? (
            <div className="space-y-2.5">
              {method === "rebase" ? null : (
                <>
                  <Field label="Commit title" optional>
                    {(control) => (
                      <Input
                        {...control}
                        value={title}
                        maxLength={256}
                        placeholder={
                          method === "squash"
                            ? `${pull.title} (#${pull.number})`
                            : `Merge pull request #${pull.number} from ${pull.headRef}`
                        }
                        onChange={(event) => setTitle(event.target.value)}
                      />
                    )}
                  </Field>
                  <Field label="Commit message" optional>
                    {(control) => (
                      <Textarea
                        {...control}
                        rows={3}
                        value={message}
                        onChange={(event) => setMessage(event.target.value)}
                      />
                    )}
                  </Field>
                </>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant={action.mode === "bypass" ? "danger" : "primary"}
                  busy={merge.isPending}
                  onClick={() => merge.mutate()}
                >
                  Confirm {MERGE_BUTTON[method].toLowerCase()}
                </Button>
                <Button onClick={() => setConfirming(false)}>Cancel</Button>
                <InlineError error={merge.error} />
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2.5">
              <Button
                variant={action.mode === "bypass" ? "danger" : "primary"}
                disabled={!canAct || allowed.length === 0}
                onClick={() => setConfirming(true)}
              >
                <Icon name="gitMerge" size={13} />
                {MERGE_BUTTON[method]}
              </Button>
              {allowed.length > 1 ? (
                <Select
                  aria-label="Merge method"
                  value={method}
                  onChange={(event) => setMethod(event.target.value as MergeMethod)}
                  className="!w-auto"
                >
                  {allowed.map((item) => (
                    <option key={item} value={item}>
                      {MERGE_METHOD_LABEL[item]}
                    </option>
                  ))}
                </Select>
              ) : null}
              <Checkbox
                label="Delete branch after merge"
                checked={deleteBranch}
                onChange={(event) => setDeleteBranch(event.target.checked)}
              />
            </div>
          )}
        </div>
      )}
    </section>
  );
}
