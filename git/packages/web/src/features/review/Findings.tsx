/**
 * What review agents found: a finding as a card (under its line in the diff
 * and in the list), with its evidence, and what a person can do about it:
 * dismiss it with a reason, reopen it, or send it to the agent.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { FindingSeverity, ReviewFinding, ReviewRunStatus } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Badge, type BadgeTone } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/controls";
import { diffFileId } from "../../components/DiffView";
import { Field, Input } from "../../components/forms";
import { Icon, Spinner } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { Panel, PanelHeader } from "../../components/Panel";
import { UserLink } from "../../components/people";
import { EmptyState, InlineError } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { showBidi } from "../../lib/bidi";
import {
  SEVERITY_LABEL,
  describeLines,
  instructionFor,
  openBySeverity,
  sortFindings,
} from "./branch";
import { InstructionBadge, SendToAgentButton, useInstructions } from "./Instructions";

const SEVERITY_TONE: Record<FindingSeverity, BadgeTone> = {
  must_fix: "danger",
  should_fix: "warning",
  note: "neutral",
};

const EVIDENCE_LABEL: Record<string, string> = {
  code: "Code",
  command: "Command",
  test: "Test",
  ci: "CI",
  reference: "Reference",
};

/** Everything a change to a finding can show up in: the list, the header, the merge box. */
export function refreshFindings(): void {
  void invalidate("findings");
  void invalidate("versions", "branchState");
  void invalidate("pulls", "get");
}

function DismissButton({ finding, number }: { finding: ReviewFinding; number: number }) {
  const repo = useRepoRef();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const dismiss = useMutation({
    mutationFn: () =>
      api.findings.dismiss({
        params: { ...repo, number, findingId: finding.id },
        payload: { reason: reason.trim() },
      }),
    onSuccess: () => {
      setOpen(false);
      setReason("");
      refreshFindings();
    },
  });
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        Dismiss
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Dismiss finding"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              busy={dismiss.isPending}
              disabled={reason.trim() === ""}
              onClick={() => dismiss.mutate()}
            >
              Dismiss
            </Button>
          </>
        }
      >
        <p className="mb-2 text-xs font-medium text-on-surface">{finding.title}</p>
        <Field label="Reason">
          {(control) => (
            <Input
              {...control}
              value={reason}
              maxLength={1000}
              onChange={(event) => setReason(event.target.value)}
            />
          )}
        </Field>
        <InlineError error={dismiss.error} />
      </Dialog>
    </>
  );
}

export function FindingCard({
  finding,
  number,
  where = true,
  startOpen,
}: {
  finding: ReviewFinding;
  number: number;
  /** Name the file and lines: everywhere but under its own line. */
  where?: boolean;
  startOpen?: boolean;
}) {
  const repo = useRepoRef();
  const sent = useInstructions();
  const [open, setOpen] = useState(
    startOpen ?? (finding.status === "open" && finding.severity === "must_fix"),
  );
  const reopen = useMutation({
    mutationFn: () => api.findings.reopen({ params: { ...repo, number, findingId: finding.id } }),
    onSuccess: refreshFindings,
  });
  const instruction =
    sent === null || sent.instructions === null
      ? null
      : instructionFor(sent.instructions, { findingId: finding.id });
  const lines = describeLines(finding.startLine, finding.endLine);
  const settled = finding.status !== "open";
  return (
    <div className="bg-surface-raised text-xs">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5">
        <button
          type="button"
          aria-expanded={open}
          aria-label={open ? "Hide finding" : "Show finding"}
          onClick={() => setOpen(!open)}
          className="inline-flex size-5 items-center justify-center rounded text-on-surface-muted hover:bg-surface-sunken"
        >
          <Icon name={open ? "chevronDown" : "chevronRight"} />
        </button>
        <Badge tone={settled ? "outline" : SEVERITY_TONE[finding.severity]}>
          {SEVERITY_LABEL[finding.severity]}
        </Badge>
        <span
          className={`min-w-0 font-medium ${settled ? "text-on-surface-muted" : "text-on-surface"}`}
        >
          {finding.title}
        </span>
        <span className="text-on-surface-muted">{finding.reviewerKind}</span>
        {where && finding.path !== null ? (
          <a
            href={`#${diffFileId(finding.path)}`}
            className="min-w-0 truncate font-mono text-[11px] text-on-surface-muted hover:underline"
          >
            {showBidi(finding.path)}
            {lines === null ? "" : `, ${lines.toLowerCase()}`}
          </a>
        ) : null}
        <span className="flex-1" />
        {finding.status === "fixed" ? (
          <Badge tone="success">
            <Icon name="check" size={10} />
            {finding.fixedInVersion === null ? "Fixed" : `Fixed in v${finding.fixedInVersion}`}
          </Badge>
        ) : null}
        {finding.status === "dismissed" ? <Badge tone="outline">Dismissed</Badge> : null}
        {finding.overridden && finding.status === "open" ? (
          <Badge tone="warning">Merge allowed past it</Badge>
        ) : null}
        {instruction !== null ? <InstructionBadge instruction={instruction} /> : null}
      </div>
      {open ? (
        <div className="space-y-2 px-3 pb-2.5 pl-10">
          {finding.body.trim() !== "" ? <Markdown source={finding.body} /> : null}
          {finding.evidence.map((item, index) => (
            <div key={index} className="overflow-hidden rounded border border-border bg-surface">
              <div className="flex items-center gap-2 bg-surface-inset px-2 py-1 text-[11px] text-on-surface-muted">
                <span className="font-medium">{EVIDENCE_LABEL[item.kind] ?? item.kind}</span>
                {item.url !== undefined && item.url !== null ? (
                  <AppLink href={item.url} className="min-w-0 truncate hover:underline">
                    {showBidi(item.url)}
                  </AppLink>
                ) : null}
              </div>
              {item.kind === "reference" ? (
                <div className="px-2 py-1.5 text-on-surface-secondary">
                  <Markdown source={item.text} />
                </div>
              ) : (
                <pre className="max-h-44 overflow-auto px-2 py-1.5 font-mono text-[11px] leading-4 text-on-surface-secondary">
                  {showBidi(item.text)}
                </pre>
              )}
            </div>
          ))}
          {finding.status === "dismissed" ? (
            <p className="flex flex-wrap items-center gap-x-1 text-on-surface-secondary">
              Dismissed
              {finding.dismissedBy !== null ? (
                <>
                  {" "}
                  by <UserLink user={finding.dismissedBy} />
                </>
              ) : null}
              {finding.dismissalReason !== null ? `: ${finding.dismissalReason}` : null}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            {finding.status === "open" && instruction === null ? (
              <SendToAgentButton from={{ source: "finding", findingId: finding.id }} />
            ) : null}
            {finding.status === "open" && finding.viewerCanDismiss ? (
              <DismissButton finding={finding} number={number} />
            ) : null}
            {finding.status === "dismissed" && finding.viewerCanDismiss ? (
              <Button size="sm" busy={reopen.isPending} onClick={() => reopen.mutate()}>
                Reopen
              </Button>
            ) : null}
            <InlineError error={reopen.error} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

const RUN_LABEL: Record<ReviewRunStatus, string> = {
  queued: "Review queued",
  running: "Reviewing",
  done: "Reviewed",
  failed: "Review failed",
};

/** Every finding of the branch, the open ones first. */
export function FindingsPanel({
  findings,
  number,
  version,
  run,
  canRun,
}: {
  findings: ReadonlyArray<ReviewFinding>;
  number: number;
  /** The newest version: what "Review again" reviews. */
  version: number | null;
  /** The newest review run of that version. */
  run: ReviewRunStatus | null;
  canRun: boolean;
}) {
  const repo = useRepoRef();
  const again = useMutation({
    mutationFn: () => api.findings.requestRun({ params: { ...repo, number }, payload: {} }),
    onSuccess: refreshFindings,
  });
  const busy = run === "queued" || run === "running";
  const summary = openBySeverity(findings);
  return (
    <Panel id="findings" className="scroll-mt-24">
      <PanelHeader
        actions={
          <>
            {run !== null ? (
              <span className="inline-flex items-center gap-1.5" role="status">
                {busy ? <Spinner size={12} /> : null}
                {RUN_LABEL[run]}
                {version !== null && !busy ? ` v${version}` : ""}
              </span>
            ) : null}
            {canRun && version !== null && !busy ? (
              <Button
                size="sm"
                variant="ghost"
                busy={again.isPending}
                onClick={() => again.mutate()}
              >
                <Icon name="refresh" size={11} />
                Review again
              </Button>
            ) : null}
          </>
        }
      >
        <Icon name="shield" />
        <h2 className="font-medium text-on-surface">Findings</h2>
        {summary !== "" ? <span>{summary}</span> : null}
      </PanelHeader>
      {again.error ? (
        <div className="px-3 py-2">
          <InlineError error={again.error} />
        </div>
      ) : null}
      {findings.length === 0 ? (
        <EmptyState>No findings</EmptyState>
      ) : (
        <ul className="divide-y divide-border">
          {sortFindings(findings).map((finding) => (
            <li key={finding.id}>
              <FindingCard finding={finding} number={number} />
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
