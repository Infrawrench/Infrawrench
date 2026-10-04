import { useCallback, useEffect, useMemo, useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  TAG_KEY_SETTINGS_LIMITS,
  hiddenTagKeyMatch,
  suggestTagKeyPrefixes,
  tagKeyPatternError,
  tagKeySettingsError,
  type DiscoveredTagKey,
  type DiscoveredTagKeysResponse,
  type TagKeySettings,
} from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";
import { ArrowIcon, CloseIcon } from "../components/icons/ChromeIcons.js";
import { CARD, INPUT, PRIMARY_BUTTON, SECONDARY_BUTTON } from "./styles.js";

/** Rows shown before "Show all": a bill can carry hundreds of keys. */
const INITIAL_ROWS = 50;

type StatusFilter = "all" | "visible" | "preferred" | "hidden";

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * Tag keys: hide noise keys from every tag picker and pin the keys the org
 * reports on to the top of them.
 *
 * Edits a draft of both lists against the discovered-keys table (every key the
 * cost data and inventory carry, with its providers and usage) and saves the
 * whole document at once. Status in the table is computed from the draft, so
 * adding `aws:cloudformation:*` immediately shows which keys it would hide.
 * The server applies the saved settings to every picker; this page only
 * writes them.
 */
export function TagKeysSection() {
  const gt = useGT();
  const { orgId, api, has } = useSettingsHost();
  const canEdit = has("org:settings:write");

  const [data, setData] = useState<DiscoveredTagKeysResponse | null>(null);
  const [saved, setSaved] = useState<TagKeySettings>({ hidden: [], preferred: [] });
  const [draft, setDraft] = useState<TagKeySettings>({ hidden: [], preferred: [] });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const [patternDraft, setPatternDraft] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await api.get<DiscoveredTagKeysResponse>(`/api/org/${orgId}/tag-keys`);
      setData(res);
      setSaved(res.settings);
      setDraft(res.settings);
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to load tag keys"));
    } finally {
      setLoading(false);
    }
  }, [api, orgId, gt]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty =
    !sameList(saved.hidden, draft.hidden) || !sameList(saved.preferred, draft.preferred);
  const draftError = tagKeySettingsError(draft);
  const patternError = patternDraft.trim() ? tagKeyPatternError(patternDraft) : null;

  const keys = data?.keys ?? [];
  const suggestions = useMemo(
    () =>
      suggestTagKeyPrefixes(
        keys.map((k) => k.key),
        draft,
      ).slice(0, 6),
    [keys, draft],
  );

  /** A key's status under the draft, not the saved settings. */
  const statusOf = useCallback(
    (key: string): { preferred: boolean; hiddenBy: string | null } => {
      const preferred = draft.preferred.includes(key);
      return { preferred, hiddenBy: preferred ? null : hiddenTagKeyMatch(key, draft.hidden) };
    },
    [draft],
  );

  const matchCount = useCallback(
    (pattern: string) =>
      keys.filter((k) => !draft.preferred.includes(k.key) && hiddenTagKeyMatch(k.key, [pattern]))
        .length,
    [keys, draft.preferred],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return keys.filter((k) => {
      if (q && !k.key.toLowerCase().includes(q)) return false;
      const s = statusOf(k.key);
      if (statusFilter === "preferred") return s.preferred;
      if (statusFilter === "hidden") return s.hiddenBy !== null;
      if (statusFilter === "visible") return s.hiddenBy === null;
      return true;
    });
  }, [keys, search, statusFilter, statusOf]);
  const rows = showAll ? filtered : filtered.slice(0, INITIAL_ROWS);

  const update = (next: TagKeySettings) => {
    setDraft(next);
    setSavedAt(null);
  };
  const prefer = (key: string) =>
    update({
      hidden: draft.hidden.filter((h) => h !== key),
      preferred: draft.preferred.includes(key) ? draft.preferred : [...draft.preferred, key],
    });
  const unprefer = (key: string) =>
    update({ ...draft, preferred: draft.preferred.filter((p) => p !== key) });
  const hide = (pattern: string) => {
    const value = pattern.trim();
    if (!value || draft.hidden.includes(value)) return;
    update({
      hidden: [...draft.hidden, value],
      preferred: draft.preferred.filter((p) => p !== value),
    });
  };
  const unhide = (pattern: string) =>
    update({ ...draft, hidden: draft.hidden.filter((h) => h !== pattern) });
  const movePreferred = (index: number, delta: -1 | 1) => {
    const next = [...draft.preferred];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    update({ ...draft, preferred: next });
  };

  async function save() {
    if (draftError) return;
    setSaving(true);
    setError(null);
    try {
      const res = await api.put<TagKeySettings>(`/api/org/${orgId}/tag-keys/settings`, draft);
      setSaved(res);
      setDraft(res);
      setSavedAt(Date.now());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Failed to save tag key settings"));
    } finally {
      setSaving(false);
    }
  }

  function addPattern() {
    if (patternError || !patternDraft.trim()) return;
    hide(patternDraft);
    setPatternDraft("");
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">{gt("Tag Keys")}</h1>
        <T>
          <p className="text-sm text-on-surface-muted mt-1">
            Hide tag keys nobody reports on (provider bookkeeping like{" "}
            <code>aws:cloudformation:stack-id</code>) and pin the ones your team groups by to the
            top. This applies to every tag picker and group-by dropdown: cost reports, dashboards,
            saved filters, budgets, alerts, cost centre rules and the resource selector. Hidden keys
            are only hidden from pickers; their data is kept, exported and still queryable.
          </p>
        </T>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 text-sm text-danger border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-on-surface-faint">{gt("Loading…")}</p>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <section className={`${CARD} space-y-3`}>
              <div>
                <h2 className="text-sm font-semibold">{gt("Preferred keys")}</h2>
                <p className="text-xs text-on-surface-muted mt-1">
                  {gt(
                    "Pinned to the top of every picker, in this order. Pin keys from the table below.",
                  )}
                </p>
              </div>
              {draft.preferred.length === 0 ? (
                <p className="text-sm text-on-surface-faint">{gt("No preferred keys.")}</p>
              ) : (
                <ol className="space-y-1">
                  {draft.preferred.map((key, i) => (
                    <li
                      key={key}
                      className="flex items-center gap-2 px-2 py-1 rounded-lg bg-surface-overlay text-sm"
                    >
                      <span className="text-xs text-on-surface-faint w-5 text-right">{i + 1}</span>
                      <code className="flex-1 truncate text-on-surface-secondary">{key}</code>
                      {canEdit && (
                        <>
                          <button
                            type="button"
                            aria-label={gt("Move {key} up", { key })}
                            disabled={i === 0}
                            onClick={() => movePreferred(i, -1)}
                            className="p-1 text-on-surface-muted hover:text-on-surface disabled:opacity-30"
                          >
                            <ArrowIcon direction="up" size={12} />
                          </button>
                          <button
                            type="button"
                            aria-label={gt("Move {key} down", { key })}
                            disabled={i === draft.preferred.length - 1}
                            onClick={() => movePreferred(i, 1)}
                            className="p-1 text-on-surface-muted hover:text-on-surface disabled:opacity-30"
                          >
                            <ArrowIcon direction="down" size={12} />
                          </button>
                          <button
                            type="button"
                            aria-label={gt("Unpin {key}", { key })}
                            onClick={() => unprefer(key)}
                            className="p-1 text-on-surface-faint hover:text-danger"
                          >
                            <CloseIcon size={12} />
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </section>

            <section className={`${CARD} space-y-3`}>
              <div>
                <h2 className="text-sm font-semibold">{gt("Hidden keys")}</h2>
                <T>
                  <p className="text-xs text-on-surface-muted mt-1">
                    Exact keys, or prefixes ending in <code>*</code> such as{" "}
                    <code>aws:cloudformation:*</code>. Matching is case-sensitive.
                  </p>
                </T>
              </div>
              {draft.hidden.length === 0 ? (
                <p className="text-sm text-on-surface-faint">{gt("No hidden keys.")}</p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {draft.hidden.map((pattern) => (
                    <li
                      key={pattern}
                      className="flex items-center gap-1 px-2 py-0.5 rounded bg-surface-overlay text-xs text-on-surface-secondary"
                    >
                      <code>{pattern}</code>
                      <span className="text-on-surface-faint">
                        {gt("({count} keys)", { count: matchCount(pattern) })}
                      </span>
                      {canEdit && (
                        <button
                          type="button"
                          aria-label={gt("Stop hiding {pattern}", { pattern })}
                          onClick={() => unhide(pattern)}
                          className="ml-1 text-on-surface-faint hover:text-danger"
                        >
                          <CloseIcon size={12} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {canEdit && (
                <>
                  <div className="flex items-start gap-2">
                    <div className="flex-1">
                      <input
                        type="text"
                        value={patternDraft}
                        onChange={(e) => setPatternDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            addPattern();
                          }
                        }}
                        // i18n-ignore: tag key pattern syntax example
                        placeholder="aws:cloudformation:*"
                        aria-label={gt("Key or prefix pattern to hide")}
                        maxLength={TAG_KEY_SETTINGS_LIMITS.maxKeyLength}
                        className={INPUT}
                      />
                      {patternError ? (
                        <p className="mt-1 text-xs text-danger">
                          {gtPatternError(gt, patternDraft)}
                        </p>
                      ) : patternDraft.trim() ? (
                        <p className="mt-1 text-xs text-on-surface-faint">
                          {gt("Matches {count} discovered keys", {
                            count: matchCount(patternDraft.trim()),
                          })}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className={SECONDARY_BUTTON}
                      disabled={!patternDraft.trim() || patternError !== null}
                      onClick={addPattern}
                    >
                      {gt("Hide")}
                    </button>
                  </div>
                  {suggestions.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs text-on-surface-muted">
                        {gt("Suggested from your data")}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {suggestions.map((s) => (
                          <button
                            key={s.pattern}
                            type="button"
                            onClick={() => hide(s.pattern)}
                            className="px-2 py-0.5 text-xs rounded-lg border border-border text-on-surface-secondary hover:bg-surface-overlay"
                          >
                            <T>
                              Hide{" "}
                              <code>
                                <Var>{s.pattern}</Var>
                              </code>{" "}
                              (<Var>{s.keyCount}</Var> keys)
                            </T>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </section>
          </div>

          {canEdit && (
            <div className="flex items-center justify-end gap-3">
              {draftError && <p className="text-xs text-danger">{draftError}</p>}
              {dirty && (
                <button
                  type="button"
                  className={SECONDARY_BUTTON}
                  onClick={() => setDraft(saved)}
                  disabled={saving}
                >
                  {gt("Discard changes")}
                </button>
              )}
              <button
                type="button"
                className={PRIMARY_BUTTON}
                onClick={() => void save()}
                disabled={saving || !dirty || draftError !== null}
              >
                {saving ? gt("Saving…") : savedAt && !dirty ? gt("Saved") : gt("Save tag keys")}
              </button>
            </div>
          )}

          <section className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold">{gt("Discovered tag keys")}</h2>
                <p className="text-xs text-on-surface-muted mt-1">
                  {gt(
                    "Every key in the last {days} days of cost data and in your resource inventory, busiest first.",
                    { days: data?.lookbackDays ?? 90 },
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={gt("Search keys")}
                  aria-label={gt("Search keys")}
                  className="px-3 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong"
                />
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                  aria-label={gt("Filter by status")}
                  className="px-2.5 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong"
                >
                  <option value="all">{gt("All keys")}</option>
                  <option value="visible">{gt("Visible")}</option>
                  <option value="preferred">{gt("Preferred")}</option>
                  <option value="hidden">{gt("Hidden")}</option>
                </select>
              </div>
            </div>

            {keys.length === 0 ? (
              <p className="text-sm text-on-surface-muted">
                {gt(
                  "No tag keys found yet. They appear once cost data or resources carrying tags or labels have been collected.",
                )}
              </p>
            ) : (
              <div className="border border-border rounded-xl overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-border text-xs text-on-surface-muted">
                      <th scope="col" className="text-left px-4 py-2 font-medium">
                        {gt("Key")}
                      </th>
                      <th scope="col" className="text-left px-4 py-2 font-medium">
                        {gt("Providers")}
                      </th>
                      <th scope="col" className="text-right px-4 py-2 font-medium">
                        {gt("Cost rows")}
                      </th>
                      <th scope="col" className="text-right px-4 py-2 font-medium">
                        {gt("Resources")}
                      </th>
                      <th scope="col" className="text-left px-4 py-2 font-medium">
                        {gt("Last seen")}
                      </th>
                      <th scope="col" className="text-left px-4 py-2 font-medium">
                        {gt("Status")}
                      </th>
                      {canEdit && (
                        <th scope="col" className="px-4 py-2">
                          <span className="sr-only">{gt("Actions")}</span>
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((k) => (
                      <TagKeyRow
                        key={k.key}
                        row={k}
                        status={statusOf(k.key)}
                        canEdit={canEdit}
                        onPrefer={() => prefer(k.key)}
                        onUnprefer={() => unprefer(k.key)}
                        onHide={() => hide(k.key)}
                        onUnhide={() => unhide(k.key)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {filtered.length > rows.length && (
              <button
                type="button"
                className="text-sm text-info hover:text-info-strong"
                onClick={() => setShowAll(true)}
              >
                {gt("Show all {count} keys", { count: filtered.length })}
              </button>
            )}
            {data?.truncated && (
              <p className="text-xs text-on-surface-faint">
                {gt("Showing the {count} busiest keys.", { count: keys.length })}
              </p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

/** The pattern error, translated: `tagKeyPatternError` speaks English for the API. */
function gtPatternError(gt: ReturnType<typeof useGT>, pattern: string): string {
  const trimmed = pattern.trim();
  if (trimmed === "*") return gt("A lone * would hide every tag key.");
  if (trimmed.length > TAG_KEY_SETTINGS_LIMITS.maxKeyLength) {
    return gt("Patterns can be at most {max} characters.", {
      max: TAG_KEY_SETTINGS_LIMITS.maxKeyLength,
    });
  }
  return gt("* is only supported at the end of a pattern.");
}

function TagKeyRow({
  row,
  status,
  canEdit,
  onPrefer,
  onUnprefer,
  onHide,
  onUnhide,
}: {
  row: DiscoveredTagKey;
  status: { preferred: boolean; hiddenBy: string | null };
  canEdit: boolean;
  onPrefer: () => void;
  onUnprefer: () => void;
  onHide: () => void;
  onUnhide: () => void;
}) {
  const gt = useGT();
  const hiddenExactly = status.hiddenBy === row.key;
  const linkButton = "text-xs text-info hover:text-info-strong";
  return (
    <tr className="border-b border-border/50 hover:bg-surface-raised/50">
      <td className="px-4 py-2 text-sm">
        <code className={status.hiddenBy ? "text-on-surface-faint" : "text-on-surface-secondary"}>
          {row.key}
        </code>
      </td>
      <td className="px-4 py-2 text-xs text-on-surface-tertiary">
        {row.providers.join(", ") || "—"}
      </td>
      <td className="px-4 py-2 text-right text-xs text-on-surface-tertiary">
        {row.costRowCount.toLocaleString()}
      </td>
      <td className="px-4 py-2 text-right text-xs text-on-surface-tertiary">
        {Math.max(row.costResourceCount, row.inventoryCount).toLocaleString()}
      </td>
      <td className="px-4 py-2 text-xs text-on-surface-tertiary">{row.lastSeen ?? "—"}</td>
      <td className="px-4 py-2 text-xs">
        {status.preferred ? (
          <span className="text-info">{gt("Preferred")}</span>
        ) : status.hiddenBy ? (
          <span className="text-on-surface-faint">
            {hiddenExactly ? gt("Hidden") : gt("Hidden by {pattern}", { pattern: status.hiddenBy })}
          </span>
        ) : (
          <span className="text-on-surface-muted">{gt("Visible")}</span>
        )}
      </td>
      {canEdit && (
        <td className="px-4 py-2 text-right whitespace-nowrap space-x-3">
          {status.preferred ? (
            <button type="button" className={linkButton} onClick={onUnprefer}>
              {gt("Unpin")}
            </button>
          ) : (
            <button type="button" className={linkButton} onClick={onPrefer}>
              {gt("Pin")}
            </button>
          )}
          {hiddenExactly ? (
            <button type="button" className={linkButton} onClick={onUnhide}>
              {gt("Unhide")}
            </button>
          ) : (
            !status.preferred &&
            !status.hiddenBy && (
              <button type="button" className={linkButton} onClick={onHide}>
                {gt("Hide")}
              </button>
            )
          )}
        </td>
      )}
    </tr>
  );
}
