import { useCallback, useEffect, useState } from "react";
import {
  HYGIENE_SEVERITY_LABELS,
  hygieneFindingSection,
  summarizeHygiene,
  type HygieneFinding,
  type HygieneReport,
  type HygieneSeverity,
} from "@infrawrench/client-core";

import { useSettingsHost } from "./host.js";
import { CARD, SECONDARY_BUTTON } from "./styles.js";

const WINDOW_OPTIONS = [30, 90, 180, 365];

const SEVERITY_CLASS: Record<HygieneSeverity, string> = {
  high: "text-red-400 bg-red-500/10",
  medium: "text-amber-400 bg-amber-500/10",
  low: "text-on-surface-tertiary bg-surface-overlay",
};

/**
 * Credential hygiene — the credentials this organization is carrying that it
 * probably should not be.
 *
 * Every finding here is derived from data the server already holds: no
 * provider call, nothing to enable, no agent. The page's job beyond listing
 * them is to be honest about what the evidence can and cannot support — the
 * audit log records writes, not reads, so the report says nothing about read
 * permissions and says so out loud rather than letting a reader assume
 * coverage that isn't there.
 */
export function CredentialHygieneSection() {
  const { orgId, api, has, permissionsLoading, openSection } = useSettingsHost();
  const canRead = has("audit:read");

  const [report, setReport] = useState<HygieneReport | null>(null);
  const [windowDays, setWindowDays] = useState(90);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setReport(
        await api.get<HygieneReport>(
          `/api/org/${orgId}/credential-hygiene?windowDays=${windowDays}`,
        ),
      );
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not build the hygiene report");
    } finally {
      setLoading(false);
    }
  }, [api, orgId, windowDays]);

  useEffect(() => {
    if (!canRead) return;
    void load();
  }, [canRead, load]);

  if (permissionsLoading) return <p className="text-sm text-on-surface-faint">Loading…</p>;

  if (!canRead) {
    return (
      <div>
        <Header />
        <p className="text-sm text-on-surface-muted">
          This report is built from the audit log, so it needs <code>audit:read</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Header />

      {error && <p className="text-sm text-red-400">{error}</p>}

      <section className={`${CARD} space-y-3`}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <p className="text-sm text-on-surface-secondary">
            {report ? summarizeHygiene(report) : loading ? "Building the report…" : "—"}
          </p>
          <div className="flex items-center gap-1" role="group" aria-label="Activity window">
            {WINDOW_OPTIONS.map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => setWindowDays(days)}
                aria-pressed={windowDays === days}
                className={`px-2 py-1 text-xs rounded-md transition-colors ${
                  windowDays === days
                    ? "bg-surface-overlay text-on-surface"
                    : "text-on-surface-tertiary hover:text-on-surface-secondary"
                }`}
              >
                {days}d
              </button>
            ))}
          </div>
        </div>

        <p className="text-xs text-on-surface-muted">
          &ldquo;Unused&rdquo; means <em>no write recorded in the audit log</em> over the window.
          Reads are not audit-logged, so nothing here concludes anything about what someone can{" "}
          <em>see</em> — only about what they never <em>did</em>.
        </p>

        {report?.permissionFindingsWithheld && (
          <p className="text-xs text-amber-400">
            {report.auditHistoryDays === null
              ? "This organization has no audit history yet, so the unused-permission findings are withheld."
              : `This organization has ${report.auditHistoryDays} days of audit history — not enough to judge unused permissions, so those findings are withheld rather than guessed at.`}
          </p>
        )}
      </section>

      {report && report.findings.length === 0 && !loading && (
        <p className="text-sm text-on-surface-muted">
          Nothing to flag. Every API key is in use, every SSH key has been used, and no member is
          sitting on write permissions they have never exercised.
        </p>
      )}

      {report && report.findings.length > 0 && (
        <ul className="border border-border rounded-xl divide-y divide-border overflow-hidden">
          {report.findings.map((finding) => (
            <FindingRow key={finding.id} finding={finding} onOpenSection={openSection} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Header() {
  return (
    <div className="mb-6">
      <h1 className="text-xl font-semibold">Credential hygiene</h1>
      <p className="text-sm text-on-surface-muted mt-1">
        API keys nobody uses, SSH keys nothing references, and members holding write permissions
        they never exercise — all of it from data already in the system. Nothing to install, no
        provider to ask.
      </p>
    </div>
  );
}

function FindingRow({
  finding,
  onOpenSection,
}: {
  finding: HygieneFinding;
  onOpenSection: (section: string) => void;
}) {
  return (
    <li className="p-3 space-y-1">
      <div className="flex items-start gap-3">
        <span
          className={`text-xs px-2 py-0.5 rounded-md whitespace-nowrap ${SEVERITY_CLASS[finding.severity]}`}
        >
          {HYGIENE_SEVERITY_LABELS[finding.severity]}
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-on-surface-secondary">{finding.title}</p>
          <p className="text-xs text-on-surface-muted mt-0.5">{finding.detail}</p>
          <p className="text-xs text-on-surface-faint mt-0.5">{finding.recommendation}</p>
        </div>
        <button
          type="button"
          className={SECONDARY_BUTTON}
          onClick={() => onOpenSection(hygieneFindingSection(finding))}
        >
          Fix
        </button>
      </div>
    </li>
  );
}
