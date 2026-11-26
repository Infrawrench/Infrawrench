/**
 * A diff, file by file: unified or split, with the unchanged lines between
 * hunks revealed on demand from the file's text.
 *
 * Pages that add to a diff (review comments on a pull request) do it through
 * `renderAfterLine`, `renderBeforeLine` and `lineAction` rather than by
 * copying this file.
 */
import { Fragment, useMemo, useState, type ReactNode } from "react";
import type { DiffFile, DiffHunk, DiffLine } from "@infrawrench/git-contract";
import { api } from "../api/client";
import { queryClient } from "../api/queries";
import { expandGap, gapAt, hunkHeader, sideText, splitRows } from "../lib/diff-rows";
import { plural } from "../lib/format";
import { languageOfPath, useHighlight, type Token } from "../lib/highlight";
import { paths, type RepoRef } from "../lib/paths";
import { AppLink } from "./AppLink";
import { Badge } from "./Badge";
import { Button } from "./Button";
import { CodeLine, linesOf } from "./CodeView";
import { Icon } from "./icons";
import { Panel } from "./Panel";
import { showBidi } from "../lib/bidi";

export type DiffLayout = "unified" | "split";

/** `+12 -3` in the status colours, with the words for a screen reader. */
export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap font-mono text-[11px]">
      <span className="text-success">
        <span className="sr-only">{plural(additions, "addition")}</span>
        <span aria-hidden="true">+{additions}</span>
      </span>
      <span className="text-danger">
        <span className="sr-only">{plural(deletions, "deletion")}</span>
        <span aria-hidden="true">-{deletions}</span>
      </span>
    </span>
  );
}

const STATUS_LABEL: Record<DiffFile["status"], string | null> = {
  added: "Added",
  modified: null,
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  type_changed: "Type changed",
};

/** The DOM id of a file's section, for the file list's links. */
export const diffFileId = (path: string): string => `diff-${encodeURIComponent(path)}`;

export interface DiffViewProps {
  readonly repo: RepoRef;
  readonly files: ReadonlyArray<DiffFile>;
  /** The commit of the new side: where hidden lines and "View file" come from. */
  readonly headOid: string;
  readonly layout: DiffLayout;
  /** Fetches one file with its hunks, for a file left out as too large. */
  readonly loadFile?: (path: string) => Promise<DiffFile | undefined>;
  /** A row under a line: a review thread. Return null for none. */
  readonly renderAfterLine?: (file: DiffFile, line: DiffLine) => ReactNode;
  /** A row above a line: what explains the lines that follow. Return null for none. */
  readonly renderBeforeLine?: (file: DiffFile, line: DiffLine) => ReactNode;
  /** A control in a line's number gutter: "comment on this line". */
  readonly lineAction?: (file: DiffFile, line: DiffLine) => ReactNode;
}

export function DiffView(props: DiffViewProps) {
  return (
    <div className="space-y-4">
      {props.files.map((file) => (
        <DiffFileView key={`${file.oldPath ?? ""}:${file.path}`} {...props} file={file} />
      ))}
    </div>
  );
}

function useSideTokens(
  hunks: ReadonlyArray<DiffHunk>,
  side: "old" | "new",
  language: string | null,
) {
  const { text, numbers } = useMemo(() => sideText(hunks, side), [hunks, side]);
  const tokens = useHighlight(text, language);
  return useMemo(() => {
    const byLine = new Map<number, ReadonlyArray<Token>>();
    if (tokens) numbers.forEach((number, index) => byLine.set(number, tokens[index] ?? []));
    return byLine;
  }, [tokens, numbers]);
}

function DiffFileView({
  file: initial,
  repo,
  headOid,
  layout,
  loadFile,
  renderAfterLine,
  renderBeforeLine,
  lineAction,
}: DiffViewProps & { file: DiffFile }) {
  const [loadedFile, setLoadedFile] = useState<DiffFile | null>(null);
  const file = loadedFile ?? initial;
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<DiffHunk[] | null>(null);
  const [newText, setNewText] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const hunks = expanded ?? file.hunks;
  const language = languageOfPath(file.path);
  const oldTokens = useSideTokens(hunks, "old", language);
  const newTokens = useSideTokens(hunks, "new", language);
  const canExpand = file.status !== "added" && file.status !== "deleted" && !file.binary;

  const reveal = async (gapIndex: number, direction: "up" | "down" | "all") => {
    let text = newText;
    if (text === null) {
      setBusy(true);
      try {
        const request = { params: repo, query: { ref: headOid, path: file.path } };
        const blob = await queryClient.fetchQuery({
          queryKey: ["contents", "blob", request],
          queryFn: () => api.contents.blob(request),
        });
        text = linesOf(blob.text ?? "");
        setNewText(text);
      } catch {
        return;
      } finally {
        setBusy(false);
      }
    }
    setExpanded(expandGap(hunks, gapIndex, direction, text));
  };

  const label = STATUS_LABEL[file.status];
  const columns = layout === "split" ? 4 : 3;

  const gapRow = (gapIndex: number) => {
    if (!canExpand) return null;
    const gap = gapAt(hunks, gapIndex, newText?.length ?? null);
    if (gap.count !== null && gap.count <= 0) return null;
    const hunk = hunks[gapIndex];
    const first = gapIndex === 0;
    const last = gapIndex === hunks.length;
    return (
      <tr key={`gap-${gapIndex}`} className="bg-surface-inset text-on-surface-faint">
        <td colSpan={columns} className="px-2 py-0.5">
          <div className="flex items-center gap-2 font-mono text-[11px]">
            {!first ? (
              <ExpandButton
                label={last ? "Show more lines" : "Show lines below the change above"}
                disabled={busy}
                onClick={() => void reveal(gapIndex, "down")}
                direction="down"
              />
            ) : null}
            {!last ? (
              <ExpandButton
                label={first ? "Show lines above" : "Show lines above the change below"}
                disabled={busy}
                onClick={() => void reveal(gapIndex, "up")}
                direction="up"
              />
            ) : null}
            {!first && !last && gap.count !== null && gap.count > 20 ? (
              <ExpandButton
                label={`Show all ${gap.count} hidden lines`}
                disabled={busy}
                onClick={() => void reveal(gapIndex, "all")}
                direction="all"
              />
            ) : null}
            {hunk ? (
              <span className="truncate">
                {hunkHeader(hunk)} {hunk.section}
              </span>
            ) : null}
          </div>
        </td>
      </tr>
    );
  };

  return (
    <Panel id={diffFileId(file.path)} className="scroll-mt-24">
      <div className="flex min-h-9 items-center gap-2 border-b border-border bg-surface-inset px-2 py-1.5 text-xs">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={collapsed ? `Show ${file.path}` : `Hide ${file.path}`}
          onClick={() => setCollapsed(!collapsed)}
          className="inline-flex size-5 items-center justify-center rounded text-on-surface-muted hover:bg-surface-sunken"
        >
          <Icon name={collapsed ? "chevronRight" : "chevronDown"} />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-on-surface">
          {file.oldPath !== null && file.oldPath !== file.path ? (
            <>
              <span className="text-on-surface-muted">{showBidi(file.oldPath)}</span>
              <span aria-label="renamed to" className="mx-1.5 text-on-surface-faint">
                →
              </span>
            </>
          ) : null}
          {showBidi(file.path)}
        </span>
        {label !== null ? (
          <Badge
            tone={
              file.status === "added" ? "success" : file.status === "deleted" ? "danger" : "neutral"
            }
          >
            {label}
            {file.similarity !== null && file.similarity < 100 ? ` ${file.similarity}%` : ""}
          </Badge>
        ) : null}
        {file.oldMode !== null && file.newMode !== null && file.oldMode !== file.newMode ? (
          <Badge tone="outline">
            {file.oldMode} → {file.newMode}
          </Badge>
        ) : null}
        {file.binary ? null : <DiffStat additions={file.additions} deletions={file.deletions} />}
        {file.status !== "deleted" ? (
          <AppLink
            href={paths.blob(repo, headOid, file.path)}
            className="whitespace-nowrap text-on-surface-muted hover:text-on-surface hover:underline"
          >
            View file
          </AppLink>
        ) : null}
      </div>
      {collapsed ? null : file.binary ? (
        <p className="px-3 py-4 text-xs text-on-surface-muted">Binary file</p>
      ) : file.tooLarge ? (
        <div className="flex items-center gap-3 px-3 py-4 text-xs text-on-surface-muted">
          <span>This diff is large.</span>
          {loadFile ? (
            <Button
              size="sm"
              busy={busy}
              onClick={() => {
                setBusy(true);
                void loadFile(file.path)
                  .then((loaded) => {
                    if (loaded) setLoadedFile(loaded);
                  })
                  .finally(() => setBusy(false));
              }}
            >
              Load diff
            </Button>
          ) : null}
        </div>
      ) : hunks.length === 0 ? (
        <p className="px-3 py-4 text-xs text-on-surface-muted">
          {file.status === "renamed" ? "Renamed without changes" : "No changes to show"}
        </p>
      ) : (
        <div className="code-surface overflow-x-auto">
          <table
            aria-label={`Changes to ${file.path}`}
            className={`w-full border-collapse font-mono text-xs leading-5 [tab-size:4] ${
              layout === "split" ? "table-fixed" : ""
            }`}
          >
            {layout === "split" ? (
              <colgroup>
                <col className="w-12" />
                <col />
                <col className="w-12" />
                <col />
              </colgroup>
            ) : null}
            <tbody>
              {hunks.map((hunk, index) => (
                <Fragment key={`${hunk.oldStart}:${hunk.newStart}`}>
                  {gapRow(index)}
                  {layout === "split"
                    ? splitRows(hunk.lines).map((row, rowIndex) => (
                        <Fragment key={rowIndex}>
                          {renderBeforeLine
                            ? [row.left, row.right === row.left ? null : row.right].map((line) => {
                                const above = line ? renderBeforeLine(file, line) : null;
                                return above ? (
                                  <tr key={`${line!.type}:${line!.oldLine}:${line!.newLine}`}>
                                    <td
                                      colSpan={4}
                                      className="border-y border-border p-0 font-sans"
                                    >
                                      {above}
                                    </td>
                                  </tr>
                                ) : null;
                              })
                            : null}
                          <tr>
                            <SplitCell
                              line={row.left}
                              side="old"
                              tokens={oldTokens}
                              action={row.left && lineAction ? lineAction(file, row.left) : null}
                            />
                            <SplitCell
                              line={row.right}
                              side="new"
                              tokens={newTokens}
                              action={
                                row.right && row.right !== row.left && lineAction
                                  ? lineAction(file, row.right)
                                  : null
                              }
                            />
                          </tr>
                          {renderAfterLine
                            ? [row.left, row.right === row.left ? null : row.right].map((line) => {
                                const extra = line ? renderAfterLine(file, line) : null;
                                return extra ? (
                                  <tr key={`${line!.type}:${line!.oldLine}:${line!.newLine}`}>
                                    <td
                                      colSpan={4}
                                      className="border-y border-border p-0 font-sans"
                                    >
                                      {extra}
                                    </td>
                                  </tr>
                                ) : null;
                              })
                            : null}
                        </Fragment>
                      ))
                    : hunk.lines.map((line) => {
                        const extra = renderAfterLine ? renderAfterLine(file, line) : null;
                        const above = renderBeforeLine ? renderBeforeLine(file, line) : null;
                        return (
                          <Fragment key={`${line.type}:${line.oldLine}:${line.newLine}`}>
                            {above ? (
                              <tr>
                                <td colSpan={3} className="border-y border-border p-0 font-sans">
                                  {above}
                                </td>
                              </tr>
                            ) : null}
                            <UnifiedRow
                              line={line}
                              tokens={
                                line.type === "delete"
                                  ? oldTokens.get(line.oldLine ?? 0)
                                  : newTokens.get(line.newLine ?? 0)
                              }
                              action={lineAction ? lineAction(file, line) : null}
                            />
                            {extra ? (
                              <tr>
                                <td colSpan={3} className="border-y border-border p-0 font-sans">
                                  {extra}
                                </td>
                              </tr>
                            ) : null}
                          </Fragment>
                        );
                      })}
                </Fragment>
              ))}
              {gapRow(hunks.length)}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function ExpandButton({
  label,
  onClick,
  disabled,
  direction,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  direction: "up" | "down" | "all";
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-5 items-center gap-0.5 rounded px-1 text-on-surface-muted hover:bg-surface-sunken hover:text-on-surface disabled:opacity-50"
    >
      {direction === "all" ? (
        <Icon name="unfoldVertical" size={12} />
      ) : (
        <Icon name="chevronDown" size={12} className={direction === "up" ? "rotate-180" : ""} />
      )}
    </button>
  );
}

const rowTone: Record<DiffLine["type"], string> = {
  context: "",
  add: "bg-success/10",
  delete: "bg-danger/10",
};
const numberTone: Record<DiffLine["type"], string> = {
  context: "text-on-surface-faint",
  add: "bg-success/15 text-on-surface-muted",
  delete: "bg-danger/15 text-on-surface-muted",
};
const MARK: Record<DiffLine["type"], string> = { context: " ", add: "+", delete: "-" };
const MARK_LABEL: Record<DiffLine["type"], string> = {
  context: "",
  add: "Added line",
  delete: "Removed line",
};

const numberCell = "w-px select-none whitespace-nowrap px-2 text-right align-top";

function NoNewline() {
  return (
    <span className="ml-2 select-none font-sans text-[10px] text-on-surface-faint">
      No newline at end of file
    </span>
  );
}

function UnifiedRow({
  line,
  tokens,
  action,
}: {
  line: DiffLine;
  tokens: ReadonlyArray<Token> | undefined;
  action: ReactNode;
}) {
  return (
    <tr className={`group ${rowTone[line.type]}`}>
      <td className={`${numberCell} ${numberTone[line.type]}`}>{line.oldLine ?? ""}</td>
      <td className={`${numberCell} relative ${numberTone[line.type]}`}>
        {line.newLine ?? ""}
        {action}
      </td>
      <td className="whitespace-pre p-0 pr-4 align-top text-on-surface">
        <span className="inline-block w-5 select-none text-center text-on-surface-muted">
          <span className="sr-only">{MARK_LABEL[line.type]}</span>
          <span aria-hidden="true">{MARK[line.type]}</span>
        </span>
        <CodeLine text={line.content} tokens={tokens} />
        {line.noNewlineAtEnd === true ? <NoNewline /> : null}
      </td>
    </tr>
  );
}

function SplitCell({
  line,
  side,
  tokens,
  action,
}: {
  line: DiffLine | null;
  side: "old" | "new";
  tokens: ReadonlyMap<number, ReadonlyArray<Token>>;
  action: ReactNode;
}) {
  if (line === null) {
    return (
      <>
        <td className="bg-surface-inset" />
        <td className="bg-surface-inset" />
      </>
    );
  }
  const number = side === "old" ? line.oldLine : line.newLine;
  return (
    <>
      <td className={`${numberCell} group relative ${numberTone[line.type]}`}>
        {number ?? ""}
        {action}
      </td>
      <td
        className={`overflow-hidden whitespace-pre-wrap break-all p-0 pr-2 align-top text-on-surface ${
          rowTone[line.type]
        } ${side === "old" ? "border-r border-border" : ""}`}
      >
        <span className="inline-block w-5 select-none text-center text-on-surface-muted">
          <span className="sr-only">{MARK_LABEL[line.type]}</span>
          <span aria-hidden="true">{MARK[line.type]}</span>
        </span>
        <CodeLine text={line.content} tokens={number === null ? undefined : tokens.get(number)} />
        {line.noNewlineAtEnd === true ? <NoNewline /> : null}
      </td>
    </>
  );
}
