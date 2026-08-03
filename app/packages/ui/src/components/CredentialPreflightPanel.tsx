import { useMemo, useRef, useState } from "react";
import {
  buildPreflightChecklist,
  defaultTemplateCapabilityIds,
  summarizePreflight,
  type PolicyTemplate,
  type PreflightChecklistRow,
  type PreflightDeclaration,
  type PreflightReport,
} from "@infrawrench/client-core";
import { formatErrorMessage } from "../utils.js";
import { Modal } from "./Modal.js";

export interface CredentialPreflightPanelProps {
  /** The plugin's declared capabilities (from the plugin catalog). */
  declaration: PreflightDeclaration;
  /**
   * Runs the probe (server route on web/cloud, in-renderer plugin call on
   * desktop). Omit to hide the "Check credentials" affordance and render the
   * policy generator alone.
   */
  runPreflight?: (() => Promise<PreflightReport>) | undefined;
  /**
   * Builds the least-privilege template for the selected capability ids.
   * Only offered when the declaration carries a `templateFormat`.
   */
  fetchPolicyTemplate?: ((capabilityIds: string[]) => Promise<PolicyTemplate>) | undefined;
  /** Desktop routes external links through the shell instead of the renderer. */
  onOpenExternal?: ((url: string) => void) | undefined;
}

function StatusGlyph({ status }: { status: PreflightChecklistRow["status"] }) {
  if (status === "ok") {
    return (
      <span aria-hidden="true" className="text-emerald-400">
        ✓
      </span>
    );
  }
  if (status === "missing") {
    return (
      <span aria-hidden="true" className="text-red-400">
        ✗
      </span>
    );
  }
  return (
    <span aria-hidden="true" className="text-on-surface-faint">
      ?
    </span>
  );
}

const STATUS_TEXT: Record<PreflightChecklistRow["status"], string> = {
  ok: "Ready",
  missing: "Missing permissions",
  unknown: "Couldn't verify",
  unchecked: "Not checked yet",
};

function ExternalLink({
  link,
  onOpenExternal,
}: {
  link: { label: string; url: string };
  onOpenExternal?: ((url: string) => void) | undefined;
}) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={
        onOpenExternal
          ? (e) => {
              e.preventDefault();
              onOpenExternal(link.url);
            }
          : undefined
      }
      className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300"
    >
      {link.label}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

/**
 * Per-capability credential checklist + least-privilege policy generator.
 *
 * Fully generic: everything provider-specific (permission strings, probe
 * behaviour, template format) comes from the plugin through the declaration
 * and the two injected async callbacks, so this renders identically for any
 * plugin that opts in — and isn't rendered at all for plugins that don't.
 */
export function CredentialPreflightPanel({
  declaration,
  runPreflight,
  fetchPolicyTemplate,
  onOpenExternal,
}: CredentialPreflightPanelProps) {
  const [report, setReport] = useState<PreflightReport | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showGenerator, setShowGenerator] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    defaultTemplateCapabilityIds(declaration),
  );
  const [template, setTemplate] = useState<PolicyTemplate | null>(null);
  const [generating, setGenerating] = useState(false);
  const [generatorError, setGeneratorError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const rows = useMemo(() => buildPreflightChecklist(declaration, report), [declaration, report]);
  const summary = useMemo(() => summarizePreflight(rows), [rows]);

  async function check() {
    if (!runPreflight) return;
    setRunning(true);
    setError(null);
    try {
      setReport(await runPreflight());
    } catch (e) {
      setError(formatErrorMessage(e));
    } finally {
      setRunning(false);
    }
  }

  // Rapidly toggling capability checkboxes fires overlapping generate calls;
  // only the newest request may write the template (or its error) back.
  const generateSeq = useRef(0);

  async function generate(ids: string[]) {
    if (!fetchPolicyTemplate) return;
    const seq = ++generateSeq.current;
    setGenerating(true);
    setGeneratorError(null);
    setCopied(false);
    try {
      const next = await fetchPolicyTemplate(ids);
      if (seq === generateSeq.current) setTemplate(next);
    } catch (e) {
      if (seq === generateSeq.current) setGeneratorError(formatErrorMessage(e));
    } finally {
      if (seq === generateSeq.current) setGenerating(false);
    }
  }

  async function copyTemplate() {
    if (!template) return;
    try {
      await navigator.clipboard.writeText(template.document);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied — the document stays selectable below.
    }
  }

  const offersTemplate = Boolean(declaration.templateFormat && fetchPolicyTemplate);
  const checked = report !== null;

  return (
    <div className="rounded-lg border border-border-strong bg-surface-overlay/50 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium text-on-surface-secondary">Credential check</p>
          <p className="text-xs text-on-surface-faint">
            {checked
              ? `${summary.ok} of ${summary.total} capabilities ready` +
                (report.identity ? ` · ${report.identity}` : "")
              : "Verify what these credentials can do before saving."}
          </p>
        </div>
        {runPreflight && (
          <button
            type="button"
            onClick={() => void check()}
            disabled={running}
            className="shrink-0 px-3 py-1.5 text-xs font-medium border border-border-strong rounded-lg text-on-surface-secondary hover:bg-surface-overlay disabled:opacity-50 transition-colors"
          >
            {running ? "Checking…" : checked ? "Re-check" : "Check credentials"}
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.capability.id} className="text-xs">
            <div className="flex items-start gap-2">
              <StatusGlyph status={row.status} />
              <div className="min-w-0 flex-1">
                <span className="text-on-surface-secondary font-medium">
                  {row.capability.label}
                </span>
                <span className="text-on-surface-faint"> — {STATUS_TEXT[row.status]}</span>
                {row.status === "unchecked" && row.capability.description && (
                  <p className="text-on-surface-faint mt-0.5">{row.capability.description}</p>
                )}
                {row.message && <p className="text-on-surface-tertiary mt-0.5">{row.message}</p>}
                {row.status === "missing" && row.missingPermissions.length > 0 && (
                  <ul className="mt-1 space-y-0.5">
                    {row.missingPermissions.map((p) => (
                      <li key={p.id} className="text-on-surface-tertiary">
                        <code className="font-mono text-[11px] bg-surface-overlay rounded px-1 py-0.5">
                          {p.id}
                        </code>{" "}
                        <span className="text-on-surface-faint">{p.label}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {row.helpLink && (
                  <p className="mt-1">
                    <ExternalLink link={row.helpLink} onOpenExternal={onOpenExternal} />
                  </p>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {offersTemplate && (
        <div className="pt-1 border-t border-border">
          <button
            type="button"
            onClick={() => {
              const next = !showGenerator;
              setShowGenerator(next);
              if (next && !template) void generate(selectedIds);
            }}
            className="text-xs text-blue-400 hover:text-blue-300"
          >
            {showGenerator
              ? "Hide least-privilege template"
              : `Generate least-privilege ${declaration.templateFormat!.label}`}
          </button>

          {showGenerator && (
            <div className="mt-2 space-y-2">
              <fieldset>
                <legend className="text-xs text-on-surface-faint mb-1">
                  Scope the credential to:
                </legend>
                <div className="flex flex-wrap gap-x-4 gap-y-1">
                  {declaration.capabilities.map((cap) => (
                    <label
                      key={cap.id}
                      className="inline-flex items-center gap-1.5 text-xs text-on-surface-secondary"
                    >
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(cap.id)}
                        onChange={(e) => {
                          const next = e.target.checked
                            ? [...selectedIds, cap.id]
                            : selectedIds.filter((id) => id !== cap.id);
                          setSelectedIds(next);
                          if (next.length > 0) void generate(next);
                          else setTemplate(null);
                        }}
                      />
                      {cap.label}
                    </label>
                  ))}
                </div>
              </fieldset>

              {generatorError && <p className="text-xs text-red-400">{generatorError}</p>}
              {generating && <p className="text-xs text-on-surface-faint">Generating…</p>}

              {template && !generating && (
                <div className="space-y-2">
                  {template.instructions && (
                    <p className="text-xs text-on-surface-faint">{template.instructions}</p>
                  )}
                  <div className="relative">
                    <pre className="max-h-56 overflow-auto rounded-lg bg-surface-overlay border border-border-strong p-2 text-[11px] font-mono text-on-surface-secondary whitespace-pre-wrap break-all">
                      {template.document}
                    </pre>
                    <button
                      type="button"
                      onClick={() => void copyTemplate()}
                      className="absolute top-2 right-2 px-2 py-1 text-[11px] font-medium border border-border-strong rounded bg-surface-raised text-on-surface-secondary hover:bg-surface-overlay transition-colors"
                    >
                      {copied ? "Copied" : "Copy"}
                    </button>
                  </div>
                  {template.helpLink && (
                    <ExternalLink link={template.helpLink} onOpenExternal={onOpenExternal} />
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export interface CredentialPreflightModalProps extends CredentialPreflightPanelProps {
  /** Modal title context, e.g. the account display name. */
  accountName: string;
  onClose: () => void;
}

/** The same panel, wrapped as a standalone modal for account settings. */
export function CredentialPreflightModal({
  accountName,
  onClose,
  ...panel
}: CredentialPreflightModalProps) {
  return (
    <Modal onClose={onClose} ariaLabel={`Check credentials for ${accountName}`}>
      <div className="bg-surface-raised border border-border-strong rounded-xl w-full max-w-md shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-on-surface-secondary">
            Check credentials — {accountName}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-on-surface-faint hover:text-on-surface-tertiary text-lg leading-none"
            aria-label="Close"
          >
            &#215;
          </button>
        </div>
        <div className="p-5">
          <CredentialPreflightPanel {...panel} />
        </div>
      </div>
    </Modal>
  );
}
