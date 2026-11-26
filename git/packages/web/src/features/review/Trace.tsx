/**
 * What an agent recorded about a version: the ask, its steps, decisions,
 * evidence and doubts. An entry is drawn the same above the lines it
 * explains, above its file, and in the list of what is about the whole
 * change.
 */
import type { ReactNode } from "react";
import type { TraceAnchor, TraceEntry, TraceKind } from "@infrawrench/git-contract";
import { AppLink } from "../../components/AppLink";
import { Badge } from "../../components/Badge";
import { diffFileId } from "../../components/DiffView";
import { Icon, type IconName } from "../../components/icons";
import { Markdown } from "../../components/Markdown";
import { useRepoRef } from "../../layout/RepoLayout";
import { showBidi } from "../../lib/bidi";
import { paths } from "../../lib/paths";
import { describeLines } from "./branch";

const KIND: Record<TraceKind, { icon: IconName; label: string; tone: string }> = {
  ask: { icon: "messageSquare", label: "Ask", tone: "text-on-surface-secondary" },
  step: { icon: "gitCommit", label: "Step", tone: "text-on-surface-secondary" },
  decision: { icon: "gitFork", label: "Decision", tone: "text-notice" },
  evidence: { icon: "terminal", label: "Evidence", tone: "text-success" },
  doubt: { icon: "alertCircle", label: "Doubt", tone: "text-warning" },
  note: { icon: "pencil", label: "Note", tone: "text-on-surface-secondary" },
};

function Evidence({ evidence }: { evidence: NonNullable<TraceEntry["evidence"]> }) {
  const repo = useRepoRef();
  const { command, exitCode, output, ciRunId, url } = evidence;
  const ran = command !== undefined && command !== null && command !== "";
  const said = output !== undefined && output !== null && output !== "";
  return (
    <div className="space-y-1">
      {ran || said ? (
        <div className="overflow-hidden rounded border border-border bg-surface">
          {ran ? (
            <div className="flex items-center gap-2 bg-surface-inset px-2 py-1 font-mono text-[11px]">
              <span aria-hidden="true" className="select-none text-on-surface-faint">
                $
              </span>
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-on-surface">
                {showBidi(command)}
              </code>
              {exitCode !== undefined && exitCode !== null ? (
                <Badge tone={exitCode === 0 ? "success" : "danger"}>exit {exitCode}</Badge>
              ) : null}
            </div>
          ) : null}
          {said ? (
            <pre className="max-h-44 overflow-auto px-2 py-1.5 font-mono text-[11px] leading-4 text-on-surface-secondary">
              {showBidi(output)}
            </pre>
          ) : null}
        </div>
      ) : null}
      {(ciRunId !== undefined && ciRunId !== null) || (url !== undefined && url !== null) ? (
        <p className="flex flex-wrap gap-x-3 text-xs">
          {ciRunId !== undefined && ciRunId !== null ? (
            <AppLink
              href={paths.ciRun(repo, ciRunId)}
              className="text-on-surface-secondary hover:underline"
            >
              CI run
            </AppLink>
          ) : null}
          {url !== undefined && url !== null ? (
            <AppLink href={url} className="truncate text-on-surface-secondary hover:underline">
              {showBidi(url)}
            </AppLink>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

export function TraceEntryView({
  entry,
  where = false,
  renderWhere,
  children,
}: {
  entry: TraceEntry;
  /** Name the files and lines it is about: wherever it is not drawn on them. */
  where?: boolean;
  /** How a file and its lines are named, when not as a link to the file's place in the diff. */
  renderWhere?: (anchor: TraceAnchor) => ReactNode;
  /** What goes under its text: the lines it is about. */
  children?: ReactNode;
}) {
  const look = KIND[entry.kind];
  return (
    <div className="flex gap-2 px-3 py-2 text-xs">
      <Icon name={look.icon} size={13} className={`mt-0.5 ${look.tone}`} />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="font-semibold text-on-surface">{look.label}</span>
          {where
            ? entry.anchors.map((anchor) => {
                if (renderWhere !== undefined) {
                  return (
                    <span key={`${anchor.path}:${anchor.startLine ?? ""}`} className="min-w-0">
                      {renderWhere(anchor)}
                    </span>
                  );
                }
                const lines = describeLines(anchor.startLine, anchor.endLine);
                return (
                  <a
                    key={`${anchor.path}:${anchor.startLine ?? ""}`}
                    href={`#${diffFileId(anchor.path)}`}
                    className="min-w-0 truncate font-mono text-[11px] text-on-surface-muted hover:underline"
                  >
                    {showBidi(anchor.path)}
                    {lines === null ? "" : `, ${lines.toLowerCase()}`}
                  </a>
                );
              })
            : null}
        </p>
        <Markdown source={entry.body} />
        {entry.evidence !== null ? <Evidence evidence={entry.evidence} /> : null}
        {children}
      </div>
    </div>
  );
}

/** Entries together, as one block with the agent's mark down its side. */
export function TraceBlock({
  entries,
  where = false,
  label = "From the agent's trace",
  idOf,
}: {
  entries: ReadonlyArray<TraceEntry>;
  where?: boolean;
  label?: string;
  /** An id for each entry's row, where something links to it. */
  idOf?: (entry: TraceEntry) => string;
}) {
  if (entries.length === 0) return null;
  return (
    <ul aria-label={label} className="divide-y divide-border border-l-2 border-notice bg-surface">
      {entries.map((entry) => (
        <li key={entry.id} {...(idOf === undefined ? {} : { id: idOf(entry) })}>
          <TraceEntryView entry={entry} where={where} />
        </li>
      ))}
    </ul>
  );
}
