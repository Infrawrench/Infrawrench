import { useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  groupFanoutResults,
  diffLines,
  compactDiff,
  type FanoutHostResult,
  type FanoutOutputGroup,
} from "@infrawrench/client-core";
import { formatErrorMessage } from "../utils.js";

/**
 * Fan-out SSH — shared web/desktop surface for running one command across a
 * selected set of SSH-capable hosts, with results collapsed into groups of
 * identical output and outliers diffed against the majority.
 *
 * Platform-neutral: the host list, SSH keys, snippets, and the actual run are
 * injected. Web backs `onRun` with `POST /ssh-fanout/run`; desktop backs it
 * with the same cloud API or per-host local IPC exec.
 */

export interface SshFanoutTargetInfo {
  kind: "account" | "resource";
  id: string;
  label: string;
  pluginId: string;
  resourceTypeId?: string | undefined;
  host?: string | undefined;
  defaultUsername?: string | undefined;
  running: boolean;
  needsKey: boolean;
  tags: string[];
}

export interface SshFanoutSnippetInfo {
  id: string;
  name: string;
  command: string;
  description?: string | null | undefined;
}

export interface SshFanoutRunRequest {
  command: string;
  targets: SshFanoutTargetInfo[];
  sshKeyId?: string | undefined;
  username?: string | undefined;
  /** Retry with the change-freeze override header. */
  overrideFreeze?: boolean | undefined;
}

export type SshFanoutRunOutcome =
  { kind: "results"; results: FanoutHostResult[] } | { kind: "freeze"; message: string };

export interface SshFanoutViewProps {
  targets: SshFanoutTargetInfo[];
  targetsLoading?: boolean;
  targetsError?: string | null;
  /** Org SSH keys, for targets that need one (sshEndpoint resources). */
  sshKeys: Array<{ id: string; name: string }>;
  snippets: SshFanoutSnippetInfo[];
  onRun: (input: SshFanoutRunRequest) => Promise<SshFanoutRunOutcome>;
  onSaveSnippet?: ((input: { name: string; command: string }) => Promise<void>) | undefined;
  onDeleteSnippet?: ((id: string) => Promise<void>) | undefined;
}

type Phase = "compose" | "confirm" | "running" | "results";

const INPUT_CLASSES =
  "bg-surface border border-border rounded px-2 py-1 text-sm text-on-surface focus:outline-none focus:border-accent";
const BTN_PRIMARY =
  "px-3 py-1.5 rounded bg-accent text-white text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-opacity";
const BTN_SECONDARY =
  "px-3 py-1.5 rounded border border-border text-sm text-on-surface-secondary hover:bg-surface-overlay transition-colors";

export function SshFanoutView({
  targets,
  targetsLoading = false,
  targetsError = null,
  sshKeys,
  snippets,
  onRun,
  onSaveSnippet,
  onDeleteSnippet,
}: SshFanoutViewProps) {
  const gt = useGT();
  const [search, setSearch] = useState("");
  const [pluginFilter, setPluginFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [command, setCommand] = useState("");
  const [sshKeyId, setSshKeyId] = useState("");
  const [username, setUsername] = useState("");
  const [phase, setPhase] = useState<Phase>("compose");
  const [freezeMessage, setFreezeMessage] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [results, setResults] = useState<FanoutHostResult[]>([]);
  const [savingSnippet, setSavingSnippet] = useState(false);
  const [snippetName, setSnippetName] = useState("");

  const plugins = useMemo(() => [...new Set(targets.map((t) => t.pluginId))].sort(), [targets]);
  const types = useMemo(
    () => [...new Set(targets.flatMap((t) => (t.resourceTypeId ? [t.resourceTypeId] : [])))].sort(),
    [targets],
  );
  const tags = useMemo(() => [...new Set(targets.flatMap((t) => t.tags))].sort(), [targets]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return targets.filter((t) => {
      if (pluginFilter && t.pluginId !== pluginFilter) return false;
      if (typeFilter && t.resourceTypeId !== typeFilter) return false;
      if (tagFilter && !t.tags.includes(tagFilter)) return false;
      if (!q) return true;
      return (
        t.label.toLowerCase().includes(q) ||
        (t.host ?? "").toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q))
      );
    });
  }, [targets, search, pluginFilter, typeFilter, tagFilter]);

  const selectedTargets = useMemo(
    () => targets.filter((t) => selected.has(`${t.kind}:${t.id}`)),
    [targets, selected],
  );
  const needsKey = selectedTargets.some((t) => t.needsKey);
  const canRun =
    command.trim().length > 0 && selectedTargets.length > 0 && (!needsKey || sshKeyId !== "");

  function toggle(t: SshFanoutTargetInfo) {
    const key = `${t.kind}:${t.id}`;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function selectAllFiltered() {
    setSelected((prev) => {
      const next = new Set(prev);
      const selectable = filtered.filter((t) => t.running);
      const allSelected = selectable.every((t) => next.has(`${t.kind}:${t.id}`));
      for (const t of selectable) {
        if (allSelected) next.delete(`${t.kind}:${t.id}`);
        else next.add(`${t.kind}:${t.id}`);
      }
      return next;
    });
  }

  async function execute(overrideFreeze: boolean) {
    setPhase("running");
    setRunError(null);
    try {
      const outcome = await onRun({
        command: command.trim(),
        targets: selectedTargets,
        sshKeyId: needsKey ? sshKeyId : undefined,
        username: username.trim() || undefined,
        overrideFreeze,
      });
      if (outcome.kind === "freeze") {
        setFreezeMessage(outcome.message);
        setPhase("confirm");
        return;
      }
      setResults(outcome.results);
      setPhase("results");
    } catch (e) {
      setRunError(formatErrorMessage(e));
      setPhase("confirm");
    }
  }

  async function saveSnippet() {
    if (!onSaveSnippet || !snippetName.trim() || !command.trim()) return;
    try {
      await onSaveSnippet({ name: snippetName.trim(), command: command.trim() });
      setSnippetName("");
      setSavingSnippet(false);
    } catch (e) {
      setRunError(formatErrorMessage(e));
    }
  }

  if (phase === "results") {
    return (
      <FanoutResults
        results={results}
        command={command}
        onBack={() => {
          setPhase("compose");
          setFreezeMessage(null);
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-3 p-3 h-full overflow-y-auto">
      <div>
        <h2 className="text-sm font-semibold text-on-surface">{gt("Fan-out SSH")}</h2>
        <T>
          <p className="text-xs text-on-surface-muted">
            Run one command across many hosts. Identical output is collapsed so the odd one out
            stands out.
          </p>
        </T>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={gt("Search hosts…")}
          aria-label={gt("Search hosts")}
          className={`${INPUT_CLASSES} w-48`}
        />
        <select
          value={pluginFilter}
          onChange={(e) => setPluginFilter(e.target.value)}
          aria-label={gt("Filter by plugin")}
          className={INPUT_CLASSES}
        >
          <option value="">{gt("All plugins")}</option>
          {plugins.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        {types.length > 0 && (
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            aria-label={gt("Filter by resource type")}
            className={INPUT_CLASSES}
          >
            <option value="">{gt("All types")}</option>
            {types.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
        {tags.length > 0 && (
          <select
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            aria-label={gt("Filter by tag")}
            className={INPUT_CLASSES}
          >
            <option value="">{gt("All tags")}</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
        <button type="button" onClick={selectAllFiltered} className={BTN_SECONDARY}>
          {gt("Toggle all shown")}
        </button>
        <span className="text-xs text-on-surface-muted">
          {gt("{selected} of {total} selected", {
            selected: selectedTargets.length,
            total: targets.length,
          })}
        </span>
      </div>

      {/* Host list */}
      <div className="border border-border rounded max-h-64 overflow-y-auto divide-y divide-border">
        {targetsLoading && (
          <div className="p-3 text-sm text-on-surface-muted">{gt("Loading hosts…")}</div>
        )}
        {targetsError && <div className="p-3 text-sm text-danger">{targetsError}</div>}
        {!targetsLoading && !targetsError && filtered.length === 0 && (
          <T>
            <div className="p-3 text-sm text-on-surface-muted">
              No SSH-capable hosts match. SSH accounts and running VMs with an SSH endpoint appear
              here.
            </div>
          </T>
        )}
        {filtered.map((t) => {
          const key = `${t.kind}:${t.id}`;
          return (
            <label
              key={key}
              className={`flex items-center gap-2 px-2 py-1.5 text-sm cursor-pointer hover:bg-surface-overlay ${
                t.running ? "" : "opacity-50"
              }`}
            >
              <input
                type="checkbox"
                checked={selected.has(key)}
                disabled={!t.running}
                onChange={() => toggle(t)}
              />
              <span className="text-on-surface truncate">{t.label}</span>
              <span className="text-xs text-on-surface-faint truncate">
                {t.pluginId}
                {t.resourceTypeId ? ` · ${t.resourceTypeId}` : ""}
                {t.host ? ` · ${t.host}` : ""}
                {t.running ? "" : gt(" · stopped")}
              </span>
              {t.tags.length > 0 && (
                <span className="ml-auto text-[10px] text-on-surface-faint truncate">
                  {t.tags.join(" ")}
                </span>
              )}
            </label>
          );
        })}
      </div>

      {/* Command + snippets */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <label className="text-xs text-on-surface-muted" htmlFor="fanout-command">
            {gt("Command")}
          </label>
          {snippets.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                const s = snippets.find((sn) => sn.id === e.target.value);
                if (s) setCommand(s.command);
              }}
              aria-label={gt("Insert saved snippet")}
              className={INPUT_CLASSES}
            >
              <option value="">{gt("Insert snippet…")}</option>
              {snippets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
          {onSaveSnippet && !savingSnippet && (
            <button
              type="button"
              onClick={() => setSavingSnippet(true)}
              disabled={!command.trim()}
              className={`${BTN_SECONDARY} disabled:opacity-50`}
            >
              {gt("Save as snippet")}
            </button>
          )}
          {onDeleteSnippet && snippets.length > 0 && (
            <select
              value=""
              onChange={(e) => {
                const s = snippets.find((sn) => sn.id === e.target.value);
                if (!s) return;
                if (!window.confirm(gt('Delete snippet "{name}"?', { name: s.name }))) return;
                onDeleteSnippet(s.id).catch((err) => setRunError(formatErrorMessage(err)));
              }}
              aria-label={gt("Delete saved snippet")}
              className={INPUT_CLASSES}
            >
              <option value="">{gt("Delete snippet…")}</option>
              {snippets.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          )}
        </div>
        {savingSnippet && (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={snippetName}
              onChange={(e) => setSnippetName(e.target.value)}
              placeholder={gt("Snippet name")}
              aria-label={gt("Snippet name")}
              className={`${INPUT_CLASSES} w-56`}
            />
            <button
              type="button"
              onClick={() => void saveSnippet()}
              disabled={!snippetName.trim()}
              className={BTN_PRIMARY}
            >
              {gt("Save")}
            </button>
            <button type="button" onClick={() => setSavingSnippet(false)} className={BTN_SECONDARY}>
              {gt("Cancel")}
            </button>
          </div>
        )}
        <textarea
          id="fanout-command"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          // i18n-ignore: example shell command
          placeholder="uname -r"
          rows={3}
          className={`${INPUT_CLASSES} font-mono w-full resize-y`}
        />
      </div>

      {/* Key + username for quick-connect targets */}
      {needsKey && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-xs text-on-surface-muted" htmlFor="fanout-key">
            {gt("SSH key")}
          </label>
          <select
            id="fanout-key"
            value={sshKeyId}
            onChange={(e) => setSshKeyId(e.target.value)}
            className={INPUT_CLASSES}
          >
            <option value="">{gt("Select a key…")}</option>
            {sshKeys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={gt("Username override (optional)")}
            aria-label={gt("Username override")}
            className={`${INPUT_CLASSES} w-56`}
          />
          <T>
            <span className="text-xs text-on-surface-faint">
              Applies to VM hosts; SSH accounts use their own credentials.
            </span>
          </T>
        </div>
      )}

      {runError && <div className="text-sm text-danger">{runError}</div>}

      {/* Confirm step */}
      {phase === "confirm" || phase === "running" ? (
        <div className="border border-border rounded p-3 bg-surface-raised flex flex-col gap-2">
          <div className="text-sm font-medium text-on-surface">
            {selectedTargets.length === 1
              ? gt("Run on 1 host?")
              : gt("Run on {count} hosts?", { count: selectedTargets.length })}
          </div>
          <pre className="text-xs font-mono text-on-surface-secondary whitespace-pre-wrap bg-surface rounded p-2 max-h-24 overflow-y-auto">
            {command.trim()}
          </pre>
          <div className="text-xs text-on-surface-muted truncate">
            {selectedTargets
              .slice(0, 8)
              .map((t) => t.label)
              .join(", ")}
            {selectedTargets.length > 8
              ? gt(" and {count} more", { count: selectedTargets.length - 8 })
              : ""}
          </div>
          {freezeMessage && (
            <div className="text-xs text-warning border border-amber-500/40 rounded p-2">
              {freezeMessage}
            </div>
          )}
          <div className="flex gap-2">
            {freezeMessage ? (
              <button
                type="button"
                onClick={() => void execute(true)}
                disabled={phase === "running"}
                className={BTN_PRIMARY}
              >
                {phase === "running" ? gt("Running…") : gt("Override freeze and run")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void execute(false)}
                disabled={phase === "running"}
                className={BTN_PRIMARY}
              >
                {phase === "running"
                  ? selectedTargets.length === 1
                    ? gt("Running on 1 host…")
                    : gt("Running on {count} hosts…", { count: selectedTargets.length })
                  : selectedTargets.length === 1
                    ? gt("Run on 1 host")
                    : gt("Run on {count} hosts", { count: selectedTargets.length })}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setPhase("compose");
                setFreezeMessage(null);
              }}
              disabled={phase === "running"}
              className={BTN_SECONDARY}
            >
              {gt("Cancel")}
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button
            type="button"
            onClick={() => setPhase("confirm")}
            disabled={!canRun}
            className={BTN_PRIMARY}
          >
            {gt("Run command…")}
          </button>
        </div>
      )}
    </div>
  );
}

/** Results: collapsed output groups, outliers diffed against the majority. */
function FanoutResults({
  results,
  command,
  onBack,
}: {
  results: FanoutHostResult[];
  command: string;
  onBack: () => void;
}) {
  const gt = useGT();
  const groups = useMemo(() => groupFanoutResults(results), [results]);
  const majority = groups.find((g) => g.isMajority);
  const okCount = results.filter((r) => r.status === "done" && (r.exitCode ?? 0) === 0).length;

  return (
    <div className="flex flex-col gap-3 p-3 h-full overflow-y-auto">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onBack} className={BTN_SECONDARY}>
          {gt("← New run")}
        </button>
        <div className="min-w-0">
          <div className="text-sm font-mono text-on-surface truncate">{command}</div>
          <T>
            <div className="text-xs text-on-surface-muted">
              <Var>{results.length}</Var> host
              <Var>{results.length === 1 ? "" : "s"}</Var> · <Var>{okCount}</Var> succeeded ·{" "}
              <Var>{results.length - okCount}</Var> failed or differing exit ·{" "}
              <Var>{groups.length}</Var> distinct output
              <Var>{groups.length === 1 ? "" : "s"}</Var>
            </div>
          </T>
        </div>
      </div>

      {groups.map((group) => (
        <FanoutGroup
          key={group.key}
          group={group}
          majority={majority && group !== majority ? majority : null}
          total={results.length}
        />
      ))}
    </div>
  );
}

function FanoutGroup({
  group,
  majority,
  total,
}: {
  group: FanoutOutputGroup;
  /** The majority group to diff against, when this group is an outlier. */
  majority: FanoutOutputGroup | null;
  total: number;
}) {
  const gt = useGT();
  const [showRaw, setShowRaw] = useState(false);
  const isOutlier = majority !== null;
  const diff = useMemo(
    () =>
      isOutlier && !group.isFailure ? compactDiff(diffLines(majority.output, group.output)) : null,
    [isOutlier, group, majority],
  );

  const border = group.isFailure
    ? "border-red-500/50"
    : group.isMajority
      ? "border-border"
      : "border-amber-500/50";
  const badge = group.isFailure
    ? "bg-red-500/10 text-danger"
    : group.isMajority
      ? "bg-accent-muted text-accent-on-muted"
      : "bg-amber-500/10 text-warning";

  return (
    <div className={`border ${border} rounded`}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <span className={`text-[11px] px-1.5 py-0.5 rounded font-medium ${badge}`}>
          {group.isFailure
            ? gt("failed")
            : group.isMajority
              ? total === group.results.length
                ? gt("all hosts")
                : gt("majority")
              : gt("outlier")}
        </span>
        <span className="text-sm text-on-surface">
          {group.results.length === 1
            ? gt("1 host")
            : gt("{count} hosts", { count: group.results.length })}
        </span>
        {!group.isFailure && (
          <span className="text-xs text-on-surface-muted">
            {gt("exit {code}", { code: group.exitCode ?? 0 })}
          </span>
        )}
        <button
          type="button"
          onClick={() => setShowRaw((v) => !v)}
          className="ml-auto text-xs text-on-surface-muted hover:text-on-surface"
        >
          {showRaw ? gt("Hide output") : gt("Show output")}
        </button>
      </div>

      <div className="px-3 pb-2 flex flex-wrap gap-1">
        {group.results.map((r) => (
          <span
            key={r.targetId}
            title={r.error ?? undefined}
            className="text-[11px] px-1.5 py-0.5 rounded bg-surface-overlay text-on-surface-secondary"
          >
            {r.label}
            {r.exitCode !== null && r.exitCode !== 0
              ? gt(" (exit {code})", { code: r.exitCode })
              : ""}
          </span>
        ))}
      </div>

      {/* Outlier diff against the majority output */}
      {diff && diff.length > 0 && (
        <div className="border-t border-border px-3 py-2 overflow-x-auto">
          <T>
            <div className="text-[11px] text-on-surface-faint mb-1">
              Diff vs majority output (green = only on these hosts, red = missing here)
            </div>
          </T>
          <pre className="text-xs font-mono leading-5">
            {diff.map((line, i) =>
              "skipped" in line ? (
                <div key={i} className="text-on-surface-faint">
                  <T>
                    ⋯ <Var>{line.skipped}</Var> unchanged line
                    <Var>{line.skipped === 1 ? "" : "s"}</Var> ⋯
                  </T>
                </div>
              ) : (
                <div
                  key={i}
                  className={
                    line.type === "added"
                      ? "text-success"
                      : line.type === "removed"
                        ? "text-danger"
                        : "text-on-surface-secondary"
                  }
                >
                  {line.type === "added" ? "+ " : line.type === "removed" ? "- " : "  "}
                  {line.line}
                </div>
              ),
            )}
          </pre>
        </div>
      )}

      {group.isFailure && (
        <div className="border-t border-border px-3 py-2">
          <pre className="text-xs font-mono text-danger whitespace-pre-wrap">{group.output}</pre>
        </div>
      )}

      {showRaw && !group.isFailure && (
        <div className="border-t border-border px-3 py-2 overflow-x-auto">
          <pre className="text-xs font-mono text-on-surface-secondary whitespace-pre-wrap max-h-64 overflow-y-auto">
            {group.output || gt("(no output)")}
          </pre>
        </div>
      )}
    </div>
  );
}
