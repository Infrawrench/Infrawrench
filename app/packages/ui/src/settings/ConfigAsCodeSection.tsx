import { useCallback, useMemo, useRef, useState } from "react";
import {
  ORG_CONFIG_SECTIONS,
  ORG_CONFIG_SECTION_LABELS,
  ORG_CONFIG_SECTION_READ_PERMISSIONS,
  ORG_CONFIG_SECTION_WRITE_PERMISSIONS,
  orgConfigPlanIsNoop,
  type OrgConfigApplyResult,
  type OrgConfigChange,
  type OrgConfigDocument,
  type OrgConfigPlan,
  type OrgConfigSection,
} from "@infrawrench/client-core";
import { useSettingsHost } from "./host.js";

/**
 * Config as code — export the organization's configuration as one JSON
 * document, and apply one back.
 *
 * The same three server verbs the `infrawrench config` CLI drives, so the two
 * surfaces cannot disagree: export produces a file to commit, plan previews
 * what applying one would change, apply runs it in a single transaction. The
 * preview is not optional here — importing a document is the most destructive
 * thing this settings area can do, and nobody should be able to do it without
 * having seen the list first.
 */
export function ConfigAsCodeSection() {
  const { orgId, api, has } = useSettingsHost();
  const canExport = has("config:read");
  const canApply = has("config:write");

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Config as Code</h1>
        <p className="text-sm text-on-surface-muted mt-1">
          Your dashboards, workflows, custom graphs, budgets, metric alerts, probes, cost centres,
          tag policy and alert settings as one JSON document. Keep it in git for disaster recovery,
          seed a staging organization from it, or clone a whole setup for a new client. Accounts,
          credentials and resources are never included.
        </p>
      </div>

      {!canExport && !canApply ? (
        <p className="text-sm text-on-surface-muted">
          You need the <code>config:read</code> permission to export, and <code>config:write</code>{" "}
          to import.
        </p>
      ) : (
        <div className="space-y-8">
          {canExport && <ExportCard orgId={orgId} api={api} has={has} />}
          {canApply && <ImportCard orgId={orgId} api={api} has={has} />}
        </div>
      )}
    </div>
  );
}

type Api = ReturnType<typeof useSettingsHost>["api"];
type HasPermission = (permission: string) => boolean;

const CARD = "border border-border rounded-xl p-4 space-y-3 bg-surface-raised/50";
const PRIMARY_BUTTON =
  "px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors";
const SECONDARY_BUTTON =
  "px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay/50 disabled:opacity-50 rounded-lg transition-colors";

/** Sections whose read (or write) permission the caller actually holds. */
function allowedSections(has: HasPermission, table: Record<OrgConfigSection, string>) {
  return ORG_CONFIG_SECTIONS.filter((section) => has(table[section]));
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="px-3 py-2 text-sm text-red-400 border border-red-900/50 bg-red-950/20 rounded-lg">
      {message}
    </div>
  );
}

/* ---------------------------------- export --------------------------------- */

function ExportCard({ orgId, api, has }: { orgId: string; api: Api; has: HasPermission }) {
  const readable = useMemo(() => allowedSections(has, ORG_CONFIG_SECTION_READ_PERMISSIONS), [has]);
  const [selected, setSelected] = useState<Set<OrgConfigSection>>(new Set(readable));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const missing = ORG_CONFIG_SECTIONS.filter((s) => !readable.includes(s));

  async function fetchDocument(): Promise<OrgConfigDocument> {
    // The server refuses a section the caller cannot read rather than omitting
    // it, so only ever ask for the ones we know are allowed.
    const sections = [...selected].filter((s) => readable.includes(s));
    const query = sections.length > 0 ? `?sections=${sections.join(",")}` : "";
    return api.get<OrgConfigDocument>(`/api/org/${orgId}/config/export${query}`);
  }

  async function download() {
    setBusy(true);
    setError(null);
    try {
      const document = await fetchDocument();
      const blob = new Blob([`${JSON.stringify(document, null, 2)}\n`], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement("a");
      link.href = url;
      link.download = "infrawrench.json";
      window.document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to export the configuration");
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    setBusy(true);
    setError(null);
    try {
      const document = await fetchDocument();
      await navigator.clipboard.writeText(`${JSON.stringify(document, null, 2)}\n`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to copy the configuration");
    } finally {
      setBusy(false);
    }
  }

  const toggle = (section: OrgConfigSection) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });

  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold">Export</h2>
      <p className="text-xs text-on-surface-muted">
        Entities are addressed by a stable key derived from their name, not by database id, so the
        document applies to any organization. Ordering is stable too — re-exporting an unchanged
        organization produces the same file, which is what makes the git diff meaningful.
      </p>

      {error && <ErrorBanner message={error} />}

      <div className="flex flex-wrap gap-x-4 gap-y-2 pt-1">
        {readable.map((section) => (
          <label
            key={section}
            className="flex items-center gap-2 text-sm text-on-surface-secondary"
          >
            <input
              type="checkbox"
              checked={selected.has(section)}
              onChange={() => toggle(section)}
            />
            {ORG_CONFIG_SECTION_LABELS[section]}
          </label>
        ))}
      </div>

      {missing.length > 0 && (
        <p className="text-xs text-on-surface-muted">
          Not available to you: {missing.map((s) => ORG_CONFIG_SECTION_LABELS[s]).join(", ")}.
        </p>
      )}

      <div className="flex items-center gap-2 pt-1">
        <button
          type="button"
          onClick={() => void download()}
          disabled={busy || selected.size === 0}
          className={PRIMARY_BUTTON}
        >
          {busy ? "Working…" : "Download infrawrench.json"}
        </button>
        <button
          type="button"
          onClick={() => void copy()}
          disabled={busy || selected.size === 0}
          className={SECONDARY_BUTTON}
        >
          {copied ? "Copied" : "Copy JSON"}
        </button>
      </div>
    </section>
  );
}

/* ---------------------------------- import --------------------------------- */

function ImportCard({ orgId, api, has }: { orgId: string; api: Api; has: HasPermission }) {
  const [text, setText] = useState("");
  const [prune, setPrune] = useState(false);
  const [plan, setPlan] = useState<OrgConfigPlan | null>(null);
  const [applied, setApplied] = useState<OrgConfigApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const writable = useMemo(() => allowedSections(has, ORG_CONFIG_SECTION_WRITE_PERMISSIONS), [has]);
  const missing = ORG_CONFIG_SECTIONS.filter((s) => !writable.includes(s));

  /** Parse the pasted text, reporting a bad document before any round trip. */
  const parse = useCallback((): unknown => {
    if (!text.trim()) throw new Error("Paste a document, or choose a file.");
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a config document object at the top level.");
    }
    return parsed;
  }, [text]);

  async function preview() {
    setBusy(true);
    setError(null);
    setApplied(null);
    try {
      const document = parse();
      setPlan(
        await api.post<OrgConfigPlan>(`/api/org/${orgId}/config/plan`, {
          document,
          mode: prune ? "replace" : "merge",
        }),
      );
    } catch (e) {
      setPlan(null);
      setError(e instanceof Error ? e.message : "Failed to preview the changes");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setError(null);
    try {
      const document = parse();
      const result = await api.post<OrgConfigApplyResult>(`/api/org/${orgId}/config/apply`, {
        document,
        mode: prune ? "replace" : "merge",
      });
      setApplied(result);
      setPlan(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to apply the configuration");
    } finally {
      setBusy(false);
    }
  }

  function chooseFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setText(typeof reader.result === "string" ? reader.result : "");
      // The loaded document is not the one the current plan describes.
      setPlan(null);
      setApplied(null);
    };
    reader.onerror = () => setError("Failed to read that file");
    reader.readAsText(file);
    event.target.value = "";
  }

  const pending = plan ? plan.counts.create + plan.counts.update + plan.counts.delete : 0;
  const nothingToDo = plan !== null && orgConfigPlanIsNoop(plan);

  return (
    <section className={CARD}>
      <h2 className="text-sm font-semibold">Import</h2>
      <p className="text-xs text-on-surface-muted">
        Sections the document leaves out are never touched. Everything in it is applied in one
        transaction — if any part fails, nothing changes.
      </p>

      {missing.length > 0 && (
        <p className="text-xs text-on-surface-muted">
          You cannot import these sections, and a document carrying one will be refused:{" "}
          {missing.map((s) => ORG_CONFIG_SECTION_LABELS[s]).join(", ")}.
        </p>
      )}

      {error && <ErrorBanner message={error} />}

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPlan(null);
          setApplied(null);
        }}
        rows={8}
        spellCheck={false}
        placeholder='{ "version": 1, "budgets": [ … ] }'
        aria-label="Configuration document"
        className="w-full px-3 py-2 text-xs font-mono bg-surface border border-border rounded-lg focus:outline-none focus:border-border-strong"
      />

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => fileInput.current?.click()}
          className={SECONDARY_BUTTON}
        >
          Choose file…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept="application/json,.json"
          onChange={chooseFile}
          className="hidden"
        />
        <label className="flex items-center gap-2 text-sm text-on-surface-secondary">
          <input
            type="checkbox"
            checked={prune}
            onChange={(e) => {
              setPrune(e.target.checked);
              setPlan(null);
            }}
          />
          Delete anything the document doesn&rsquo;t name
        </label>
        <button
          type="button"
          onClick={() => void preview()}
          disabled={busy || !text.trim()}
          className={PRIMARY_BUTTON}
        >
          {busy ? "Working…" : "Preview changes"}
        </button>
      </div>

      {plan && (
        <div className="space-y-3 pt-1">
          <PlanView plan={plan} />
          <button
            type="button"
            onClick={() => void apply()}
            disabled={busy || nothingToDo}
            className={
              plan.counts.delete > 0
                ? "px-3 py-1.5 text-sm font-medium bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-lg transition-colors"
                : PRIMARY_BUTTON
            }
          >
            {nothingToDo
              ? "Already up to date"
              : plan.counts.delete > 0
                ? `Apply — ${plan.counts.delete} will be deleted`
                : `Apply ${pending} change${pending === 1 ? "" : "s"}`}
          </button>
        </div>
      )}

      {applied && (
        <div className="space-y-3 pt-1">
          <p className="text-sm text-emerald-500">Applied.</p>
          <PlanView plan={applied} />
        </div>
      )}
    </section>
  );
}

const ACTION_CLASS: Record<OrgConfigChange["action"], string> = {
  create: "text-emerald-500",
  update: "text-amber-500",
  delete: "text-red-400",
  unchanged: "text-on-surface-muted",
};

const ACTION_SIGN: Record<OrgConfigChange["action"], string> = {
  create: "+",
  update: "~",
  delete: "−",
  unchanged: " ",
};

function PlanView({ plan }: { plan: OrgConfigPlan }) {
  const interesting = plan.changes.filter((change) => change.action !== "unchanged");
  const bySection = new Map<OrgConfigSection, OrgConfigChange[]>();
  for (const change of interesting) {
    const list = bySection.get(change.section) ?? [];
    list.push(change);
    bySection.set(change.section, list);
  }

  return (
    <div className="border border-border rounded-lg p-3 space-y-3 bg-surface">
      {interesting.length === 0 ? (
        <p className="text-sm text-on-surface-muted">
          No changes — this organization already matches.
        </p>
      ) : (
        [...bySection.entries()].map(([section, changes]) => (
          <div key={section}>
            <h3 className="text-xs font-semibold text-on-surface-secondary mb-1">
              {ORG_CONFIG_SECTION_LABELS[section]}
            </h3>
            <ul className="space-y-0.5">
              {changes.map((change) => (
                <li key={`${change.section}:${change.key}`} className="text-sm font-mono">
                  <span className={ACTION_CLASS[change.action]}>{ACTION_SIGN[change.action]}</span>{" "}
                  <span className="text-on-surface-secondary">{change.name}</span>{" "}
                  <span className="text-on-surface-muted text-xs">[{change.key}]</span>
                  {change.action === "update" && change.fields && change.fields.length > 0 && (
                    <span className="text-on-surface-muted text-xs">
                      {" "}
                      ({change.fields.join(", ")})
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}

      <p className="text-xs text-on-surface-muted">
        {plan.counts.create} to create · {plan.counts.update} to update · {plan.counts.delete} to
        delete · {plan.counts.unchanged} unchanged
      </p>

      {plan.unresolved.length > 0 && (
        <div className="border-t border-border/50 pt-2">
          <h3 className="text-xs font-semibold text-amber-500 mb-1">Not applied</h3>
          <ul className="space-y-1">
            {plan.unresolved.map((item, i) => (
              <li key={i} className="text-xs text-on-surface-muted">
                <span className="text-on-surface-secondary">
                  {ORG_CONFIG_SECTION_LABELS[item.section]} · {item.key}
                </span>{" "}
                — {item.detail}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
