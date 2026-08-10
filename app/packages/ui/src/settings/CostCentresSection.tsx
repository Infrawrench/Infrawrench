import { useCallback, useEffect, useMemo, useState } from "react";
import {
  COST_CENTRE_LIMITS,
  costCentreDepths,
  costCentreMoveBlocker,
  costCentrePaths,
  type AllocationRule,
  type CostCentre,
  type CostCentrePathRow,
} from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";

/**
 * Cost centre management: the tree spend is allocated to for showback.
 *
 * Centres nest — a division holds teams, a team holds products — so "what does
 * Engineering cost" is a subtree rather than one bucket. Nesting changes
 * nothing about matching: the allocation rules on the Tag Policy page still
 * evaluate first-match-wins and every cost row is allocated to exactly one
 * centre. What nesting adds is the rollup on the Costs panel, where a parent
 * reports its own spend and its subtree's separately.
 *
 * Move targets are greyed out with `costCentreMoveBlocker` — the same function
 * the server enforces with a 400 — so the picker offers exactly what will be
 * accepted.
 */
export function CostCentresSection() {
  const { orgId, api, has, openSection } = useSettingsHost();
  const canEdit = has("costs:write");

  const [centres, setCentres] = useState<CostCentre[]>([]);
  const [rules, setRules] = useState<AllocationRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const [newName, setNewName] = useState("");
  const [newParentId, setNewParentId] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [centreRows, ruleRows] = await Promise.all([
        api.get<CostCentre[]>(`/api/org/${orgId}/cost-centres`),
        api.get<AllocationRule[]>(`/api/org/${orgId}/cost-centres/rules`),
      ]);
      setCentres(centreRows);
      setRules(ruleRows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load cost centres");
    } finally {
      setLoading(false);
    }
  }, [api, orgId]);

  useEffect(() => {
    void load();
  }, [load]);

  const tree = useMemo(() => costCentrePaths(centres), [centres]);
  const depths = useMemo(() => costCentreDepths(centres), [centres]);
  const byId = useMemo(() => new Map(centres.map((c) => [c.id, c])), [centres]);
  const ruleCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const rule of rules) {
      counts.set(rule.costCentreId, (counts.get(rule.costCentreId) ?? 0) + 1);
    }
    return counts;
  }, [rules]);
  const childCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const centre of centres) {
      if (centre.parentId === null) continue;
      counts.set(centre.parentId, (counts.get(centre.parentId) ?? 0) + 1);
    }
    return counts;
  }, [centres]);

  async function addCentre() {
    const name = newName.trim();
    if (!name) return;
    setBusyId("__new__");
    try {
      await api.post(`/api/org/${orgId}/cost-centres`, {
        name,
        parentId: newParentId || null,
      });
      setNewName("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create cost centre");
    } finally {
      setBusyId(null);
    }
  }

  async function renameCentre(centre: CostCentre) {
    const name = editingName.trim();
    if (!name || name === centre.name) {
      setEditingId(null);
      return;
    }
    setBusyId(centre.id);
    try {
      // `parentId` omitted on purpose: a rename must never move the centre.
      await api.put(`/api/org/${orgId}/cost-centres/${centre.id}`, {
        name,
        ...(centre.description ? { description: centre.description } : {}),
      });
      setEditingId(null);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rename cost centre");
    } finally {
      setBusyId(null);
    }
  }

  async function moveCentre(centre: CostCentre, parentId: string | null) {
    setBusyId(centre.id);
    setError(null);
    try {
      await api.put(`/api/org/${orgId}/cost-centres/${centre.id}`, {
        name: centre.name,
        ...(centre.description ? { description: centre.description } : {}),
        parentId,
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to move cost centre");
    } finally {
      setBusyId(null);
    }
  }

  async function removeCentre(centre: CostCentre) {
    const ruleCount = ruleCounts.get(centre.id) ?? 0;
    const childCount = childCounts.get(centre.id) ?? 0;
    const parentName = centre.parentId
      ? (centres.find((c) => c.id === centre.parentId)?.name ?? "its parent")
      : null;

    // The confirmation says exactly where the pieces land — children move up
    // one level, spend history is untouched, and only the rules go away.
    const lines = [`Delete cost centre "${centre.name}"?`];
    if (childCount > 0) {
      lines.push(
        parentName
          ? `Its ${childCount} child centre(s) move up under "${parentName}" — they are not deleted.`
          : `Its ${childCount} child centre(s) become top-level centres — they are not deleted.`,
      );
    }
    if (ruleCount > 0) {
      lines.push(
        `Its ${ruleCount} allocation rule(s) are deleted, so the spend they claimed falls through to the next matching rule or to "Unallocated".`,
      );
    }
    lines.push("No spend history is deleted.");
    if (!window.confirm(lines.join("\n\n"))) return;

    setBusyId(centre.id);
    try {
      await api.delete(`/api/org/${orgId}/cost-centres/${centre.id}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete cost centre");
    } finally {
      setBusyId(null);
    }
  }

  const selectClass =
    "px-2.5 py-1.5 text-sm bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong disabled:opacity-60";

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Cost Centres</h1>
        <p className="text-sm text-on-surface-muted mt-1">
          The tree spend is allocated to for showback. Centres nest, so a division holds teams and a
          team holds products — &ldquo;what does Engineering cost&rdquo; is the whole subtree, not
          one bucket. The Costs panel reports each centre&rsquo;s own spend and its subtree&rsquo;s
          separately. Nesting is at most {COST_CENTRE_LIMITS.maxDepth} levels deep.
        </p>
        <p className="text-sm text-on-surface-muted mt-2">
          Nesting changes nothing about matching: a cost row is still allocated to exactly one
          centre by the{" "}
          <button
            type="button"
            onClick={() => openSection("tag-policy")}
            className="text-blue-500 hover:text-blue-400 underline underline-offset-2"
          >
            allocation rules
          </button>{" "}
          on the Tag Policy page, and spend no rule claims still reports as
          &ldquo;Unallocated&rdquo;.
        </p>
      </div>

      {error && (
        <div className="mb-4 px-3 py-2 text-sm text-red-400 border border-red-900/50 bg-red-950/20 rounded-lg">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-on-surface-faint">Loading…</p>
      ) : (
        <div className="space-y-6">
          <div className="border border-border rounded-xl overflow-hidden">
            {tree.length === 0 ? (
              <p className="px-4 py-3 text-sm text-on-surface-muted">
                No cost centres yet. Add one below, then map spend onto it with an allocation rule.
              </p>
            ) : (
              <ul>
                {tree.map(({ id, name, depth }) => {
                  const centre = byId.get(id);
                  if (!centre) return null;
                  const busy = busyId === centre.id;
                  const rulesHere = ruleCounts.get(centre.id) ?? 0;
                  const kids = childCounts.get(centre.id) ?? 0;
                  return (
                    <li
                      key={centre.id}
                      className="flex items-center gap-3 px-4 py-2 border-b border-border/50 last:border-b-0"
                    >
                      <span
                        className="flex-1 min-w-0 flex items-center gap-2"
                        style={{ paddingLeft: `${depth * 20}px` }}
                      >
                        {depth > 0 && (
                          <span aria-hidden className="text-on-surface-muted text-xs">
                            └
                          </span>
                        )}
                        {editingId === centre.id ? (
                          <input
                            type="text"
                            value={editingName}
                            autoFocus
                            maxLength={COST_CENTRE_LIMITS.maxNameLength}
                            onChange={(e) => setEditingName(e.target.value)}
                            onBlur={() => void renameCentre(centre)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") void renameCentre(centre);
                              if (e.key === "Escape") setEditingId(null);
                            }}
                            aria-label={`Rename ${centre.name}`}
                            className={selectClass}
                          />
                        ) : (
                          <span className="truncate text-sm text-on-surface-secondary">{name}</span>
                        )}
                        <span className="text-xs text-on-surface-muted shrink-0">
                          {rulesHere > 0 && `${rulesHere} rule${rulesHere === 1 ? "" : "s"}`}
                          {rulesHere > 0 && kids > 0 && " · "}
                          {kids > 0 && `${kids} child${kids === 1 ? "" : "ren"}`}
                        </span>
                      </span>

                      {canEdit && (
                        <span className="flex items-center gap-2 shrink-0">
                          <MoveSelect
                            centres={centres}
                            tree={tree}
                            centre={centre}
                            disabled={busy}
                            className={selectClass}
                            onMove={(parentId) => void moveCentre(centre, parentId)}
                          />
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => {
                              setEditingId(centre.id);
                              setEditingName(centre.name);
                            }}
                            className="text-xs text-on-surface-muted hover:text-on-surface-secondary disabled:opacity-40"
                          >
                            Rename
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void removeCentre(centre)}
                            className="text-xs text-red-400 hover:text-red-500 dark:text-red-300 disabled:opacity-40"
                          >
                            Delete
                          </button>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {canEdit && (
            <div className="border border-border rounded-xl p-4 space-y-3 bg-surface-raised/50">
              <h2 className="text-sm font-semibold">Add a cost centre</h2>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={newName}
                  maxLength={COST_CENTRE_LIMITS.maxNameLength}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void addCentre();
                  }}
                  placeholder="e.g. Platform"
                  aria-label="Cost centre name"
                  className={selectClass}
                />
                <span className="text-sm text-on-surface-muted">under</span>
                <select
                  value={newParentId}
                  onChange={(e) => setNewParentId(e.target.value)}
                  aria-label="Parent cost centre"
                  className={selectClass}
                >
                  <option value="">Top level</option>
                  {tree.map(({ id, path }) => (
                    <option
                      key={id}
                      value={id}
                      // A new centre is a leaf, so it fits exactly when its
                      // parent is not already on the bottom level.
                      disabled={(depths.get(id) ?? 0) + 2 > COST_CENTRE_LIMITS.maxDepth}
                    >
                      {path}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => void addCentre()}
                  disabled={busyId === "__new__" || newName.trim().length === 0}
                  className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
                >
                  Add
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The move picker. Every target the server would reject — an unknown parent,
 * the centre's own subtree, anything that would push the subtree past the depth
 * cap — is disabled by the shared blocker rather than by a second rule written
 * here that could drift from it.
 */
function MoveSelect({
  centres,
  tree,
  centre,
  disabled,
  className,
  onMove,
}: {
  centres: CostCentre[];
  tree: CostCentrePathRow[];
  centre: CostCentre;
  disabled: boolean;
  className: string;
  onMove: (parentId: string | null) => void;
}) {
  return (
    <select
      value={centre.parentId ?? ""}
      disabled={disabled}
      aria-label={`Move ${centre.name}`}
      onChange={(e) => onMove(e.target.value || null)}
      className={`${className} max-w-44`}
    >
      <option value="">Top level</option>
      {tree
        .filter((row) => row.id !== centre.id)
        .map((row) => {
          const blocked = costCentreMoveBlocker(centres, centre.id, row.id);
          return (
            <option
              key={row.id}
              value={row.id}
              disabled={blocked !== null}
              title={blocked ?? undefined}
            >
              {row.path}
            </option>
          );
        })}
    </select>
  );
}
