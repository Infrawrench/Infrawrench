import { useState } from "react";
import { T, Var, useGT } from "gt-react";
import {
  hasRemediation,
  orderedRemediationCommands,
  remediationScript,
  remediationToolLabel,
  type FindingRemediation,
} from "@infrawrench/client-core";

/** Copy `value`, flashing "Copied" for a moment. */
function CopyTextButton({ value, label }: { value: string; label: string }) {
  const gt = useGT();
  const [copied, setCopied] = useState(false);
  const onClick = () => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-md border px-2 py-0.5 text-xs transition-colors ${
        copied
          ? "border-success text-success"
          : "border-border text-on-surface-secondary hover:border-border-strong hover:text-on-surface"
      }`}
    >
      {copied ? gt("Copied") : label}
    </button>
  );
}

export interface RemediateToggleProps {
  remediation: FindingRemediation | null | undefined;
  open: boolean;
  onToggle: () => void;
}

/**
 * The per-row "Remediate" disclosure button. Renders nothing when the finding
 * has no commands and no Terraform hint, so a row never advertises an empty
 * panel.
 */
export function RemediateToggle({ remediation, open, onToggle }: RemediateToggleProps) {
  const gt = useGT();
  if (!hasRemediation(remediation)) return null;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      className="whitespace-nowrap text-xs font-medium text-info hover:text-info-strong"
    >
      {open ? gt("Hide commands") : gt("Remediate")}
    </button>
  );
}

export interface RemediationPanelProps {
  remediation: FindingRemediation;
  /**
   * Set when the row also offers a one-click fix (Apply resize): the panel
   * says the commands are the do-it-yourself alternative.
   */
  oneClickLabel?: string | undefined;
}

/**
 * The "Remediate" panel under a savings finding: the owning plugin's
 * ready-to-run CLI commands in run order, each with a copy button, destructive
 * steps marked, plus the Terraform hint first when IaC reconciliation says the
 * resource is managed (a CLI change would be reverted by the next apply).
 *
 * Shared by every findings list on web and desktop; the commands come from
 * the server (or the desktop's local scan) already filled in, so this only
 * renders.
 */
export function RemediationPanel({ remediation, oneClickLabel }: RemediationPanelProps) {
  const gt = useGT();
  const commands = orderedRemediationCommands(remediation);
  if (commands.length === 0) return null;
  const iac = remediation.iac;

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-sunken p-3 text-xs">
      <div className="flex items-start justify-between gap-3">
        <p className="text-on-surface-secondary">
          {oneClickLabel ? (
            <T>
              Prefer the terminal? These commands do the same as{" "}
              <Var>
                <span className="font-medium text-on-surface">{oneClickLabel}</span>
              </Var>
              . Run them in order.
            </T>
          ) : (
            gt("Ready-to-run commands, filled in for this resource. Run them in order.")
          )}
        </p>
        <CopyTextButton value={remediationScript(remediation)} label={gt("Copy all")} />
      </div>

      {iac && (
        <div
          role="note"
          className="rounded-md border border-warning-border bg-warning-surface px-3 py-2"
        >
          <T>
            <p className="text-on-surface">
              Managed by Terraform at{" "}
              <Var>
                <code className="font-mono">{iac.address}</code>
              </Var>
              . Change the configuration instead: the next apply reverts a CLI change.
            </p>
          </T>
          {iac.stateLabel && (
            <p className="mt-0.5 text-on-surface-faint">
              {gt("From the state document {label}", { label: iac.stateLabel })}
            </p>
          )}
          {iac.attributeChanges.length > 0 && (
            <ul className="mt-1.5 flex flex-col gap-0.5 font-mono text-on-surface-secondary">
              {iac.attributeChanges.map((change) => (
                <li key={change.attribute}>
                  {change.attribute} = {change.to ?? gt("(remove)")}
                  {change.from !== null && (
                    <span className="ml-2 text-on-surface-faint">
                      {gt("was {value}", { value: change.from })}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {remediation.placeholders.length > 0 && (
        <div className="text-on-surface-secondary">
          <p className="font-medium text-on-surface">{gt("Set these first")}</p>
          <ul className="mt-1 flex flex-col gap-0.5">
            {remediation.placeholders.map((p) => (
              <li key={p.name}>
                <code className="font-mono text-on-surface">${p.name}</code>
                <span className="ml-2">{p.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ol className="flex flex-col gap-2.5">
        {commands.map((command, index) => (
          <li key={`${index}:${command.command}`} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-on-surface-faint">{index + 1}.</span>
              <span className="rounded-full border border-border px-2 py-0.5 text-on-surface-tertiary">
                {remediationToolLabel(command.tool)}
              </span>
              {command.destructive && (
                <span className="rounded-full border border-danger-border px-2 py-0.5 font-medium text-danger">
                  {gt("Destructive")}
                </span>
              )}
              <span className="text-on-surface-secondary">{command.description}</span>
            </div>
            <div className="flex items-start gap-2">
              <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre-wrap break-all rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-on-surface">
                {command.command}
              </pre>
              <CopyTextButton value={command.command} label={gt("Copy")} />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
