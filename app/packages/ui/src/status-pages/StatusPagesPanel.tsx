import { useCallback, useEffect, useRef, useState } from "react";
import { useGT } from "gt-react";
import { useDataString } from "../i18n/data-strings.js";
import {
  statusPagePublicUrl,
  statusPageUrl,
  type StatusPage,
  type StatusPageComponentInput,
} from "@infrawrench/client-core";
import { StatusPageEditorModal } from "./StatusPageEditorModal.js";
import type { StatusPagesClient } from "./types.js";

export interface StatusPagesPanelProps {
  client: StatusPagesClient;
  /** Open a probe's detail, when the host has somewhere to send the user. */
  onOpenProbes?: (() => void) | undefined;
}

/**
 * Status-page configuration: which of the org's synthetic probes are
 * published to the public, and at what URL.
 *
 * The panel's job beyond CRUD is to make the *exposure* legible: whether a page
 * is live, exactly what URL it is live at, and a one-click way to revoke that
 * URL. Everything published is a probe the org already runs, so the risk here
 * is never "what does this measure" — it is "who can see it".
 */
export function StatusPagesPanel({ client, onOpenProbes }: StatusPagesPanelProps) {
  const gt = useGT();
  const gtData = useDataString();
  const [pages, setPages] = useState<StatusPage[] | null>(null);
  const [probes, setProbes] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ page: StatusPage | null } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [domainDraft, setDomainDraft] = useState<Record<string, string>>({});

  // Bumped per request so a slow response can't overwrite a later refresh.
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const seq = ++requestSeq.current;
    setError(null);
    try {
      const [nextPages, nextProbes] = await Promise.all([
        client.listStatusPages(),
        // The probe list only feeds the editor's picker; failing it should not
        // hide pages that already exist.
        client.listProbes().catch(() => []),
      ]);
      if (seq !== requestSeq.current) return;
      setPages(nextPages);
      setProbes(nextProbes);
    } catch (e) {
      if (seq === requestSeq.current) setError(e instanceof Error ? e.message : String(e));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (input: {
    title: string;
    description: string | null;
    supportUrl: string | null;
    showHistory: boolean;
    showUptime: boolean;
    components: StatusPageComponentInput[];
  }) => {
    const target = editing?.page;
    if (target) await client.updateStatusPage(target.id, input);
    else await client.createStatusPage(input);
    setEditing(null);
    await refresh();
  };

  const togglePublished = async (page: StatusPage) => {
    if (
      !page.published &&
      !window.confirm(
        gt(
          'Publish "{title}"? Anyone with its link will be able to see the state of its {count} component{plural}, without signing in.',
          {
            title: gtData(page.title),
            count: page.components.length,
            plural: page.components.length === 1 ? "" : "s",
          },
        ),
      )
    ) {
      return;
    }
    setBusyId(page.id);
    try {
      await client.updateStatusPage(page.id, { published: !page.published });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const rotate = async (page: StatusPage) => {
    if (
      !window.confirm(
        gt(
          'Issue a new link for "{title}"? The current link stops working immediately, and anyone who needs access will have to be sent the new one.',
          { title: gtData(page.title) },
        ),
      )
    ) {
      return;
    }
    setBusyId(page.id);
    try {
      await client.rotateSlug(page.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (page: StatusPage) => {
    if (
      !window.confirm(
        gt('Delete "{title}"? Its link stops working. The probes are kept.', {
          title: gtData(page.title),
        }),
      )
    ) {
      return;
    }
    setBusyId(page.id);
    try {
      await client.deleteStatusPage(page.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const copyLink = async (page: StatusPage) => {
    const url = statusPagePublicUrl(client.appOrigin, page);
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(page.id);
      window.setTimeout(() => setCopiedId(null), 2_000);
    } catch {
      // Clipboard access can be denied; the URL is on screen either way.
      setError(gt("Couldn't copy — select the link and copy it manually."));
    }
  };

  const attachDomain = async (page: StatusPage) => {
    const hostname = (domainDraft[page.id] ?? "").trim();
    if (!hostname) {
      setError("Enter a subdomain, e.g. status.example.com");
      return;
    }
    setBusyId(page.id);
    try {
      await client.attachCustomHostname(page.id, { hostname });
      setDomainDraft((d) => {
        const next = { ...d };
        delete next[page.id];
        return next;
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const refreshDomain = async (page: StatusPage) => {
    setBusyId(page.id);
    try {
      await client.refreshCustomHostname(page.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const detachDomain = async (page: StatusPage) => {
    if (
      !window.confirm(
        `Remove the custom domain ${page.customHostname}? The secret link keeps working; ` +
          `DNS can be removed after this.`,
      )
    ) {
      return;
    }
    setBusyId(page.id);
    try {
      await client.detachCustomHostname(page.id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-on-surface">{gt("Status pages")}</h2>
          <p className="mt-1 text-xs text-on-surface-secondary">
            {gt(
              "Publish the probes above at a public link — the monitoring you already run, pointed at your users. Nothing is reachable until you publish it.",
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditing({ page: null })}
          className="shrink-0 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong"
        >
          {gt("New page")}
        </button>
      </div>

      {error !== null && (
        <div role="alert" className="text-sm text-danger">
          {error}{" "}
          <button type="button" onClick={() => void refresh()} className="underline">
            {gt("Retry")}
          </button>
        </div>
      )}
      {pages === null && error === null && (
        <p role="status" className="text-sm text-on-surface-faint">
          {gt("Loading status pages…")}
        </p>
      )}
      {pages !== null && pages.length === 0 && (
        <p className="text-sm text-on-surface-faint">
          {gt("No status pages yet.")}{" "}
          {probes.length === 0 ? (
            <>
              {gt(
                "Create a probe first — a status page publishes probes, so there is nothing to show until at least one exists.",
              )}
              {onOpenProbes && (
                <>
                  {" "}
                  <button type="button" onClick={onOpenProbes} className="underline">
                    {gt("Add a probe")}
                  </button>
                </>
              )}
            </>
          ) : (
            <>
              {gt("A page picks from your {count} probes and gives them public names.", {
                count: probes.length,
              })}
            </>
          )}
        </p>
      )}

      {pages?.map((page) => {
        const slugUrl = statusPageUrl(client.appOrigin, page.slug);
        const publicUrl = statusPagePublicUrl(client.appOrigin, page);
        const busy = busyId === page.id;
        const hasDomain = page.customHostname != null && page.customHostnameStatus !== "none";
        return (
          <div key={page.id} className="flex flex-col gap-2 rounded-xl border border-border p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="flex items-center gap-2 text-sm font-medium text-on-surface">
                  {gtData(page.title)}
                  {page.published ? (
                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-success">
                      {gt("Live")}
                    </span>
                  ) : (
                    <span className="rounded-full border border-border px-2 py-0.5 text-xs text-on-surface-faint">
                      {gt("Draft")}
                    </span>
                  )}
                </h3>
                <p className="mt-1 text-xs text-on-surface-tertiary">
                  {gt("{count} component{plural}", {
                    count: page.components.length,
                    plural: page.components.length === 1 ? "" : "s",
                  })}
                  {page.components.some((c) => !c.probeEnabled) && (
                    <span className="ml-2 text-warning">
                      {gt("Some probes are paused — those show as “No data”.")}
                    </span>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void togglePublished(page)}
                disabled={busy}
                className="shrink-0 rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
              >
                {page.published ? gt("Unpublish") : gt("Publish")}
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              <code className="truncate rounded-lg border border-border bg-surface-raised px-2 py-1 text-on-surface-secondary">
                {publicUrl}
              </code>
              <button
                type="button"
                onClick={() => void copyLink(page)}
                className="text-on-surface-tertiary underline hover:text-on-surface"
              >
                {copiedId === page.id ? gt("Copied") : gt("Copy")}
              </button>
              {page.published && (
                <a
                  href={publicUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-on-surface-tertiary underline hover:text-on-surface"
                >
                  {gt("Open")}
                </a>
              )}
            </div>
            {page.customHostnameStatus === "active" && publicUrl !== slugUrl && (
              <p className="text-xs text-on-surface-faint">
                Secret link still works: <code className="text-on-surface-tertiary">{slugUrl}</code>
              </p>
            )}
            <p className="text-xs text-on-surface-faint">
              {gt(
                "The link is the only thing protecting this page. Anyone who has it can read it.",
              )}
            </p>

            <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-surface-raised/40 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium text-on-surface">Custom domain</p>
                {hasDomain && (
                  <span className="text-xs text-on-surface-tertiary">
                    {page.customHostnameStatus === "active"
                      ? "Active"
                      : page.customHostnameStatus === "pending_ssl"
                        ? "Waiting for certificate"
                        : page.customHostnameStatus === "pending_dns"
                          ? "Waiting for DNS"
                          : page.customHostnameStatus === "error"
                            ? "Error"
                            : page.customHostnameStatus}
                  </span>
                )}
              </div>
              {!hasDomain ? (
                <div className="flex flex-col gap-1.5">
                  <label
                    htmlFor={`status-domain-${page.id}`}
                    className="text-xs text-on-surface-tertiary"
                  >
                    Hostname
                  </label>
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      id={`status-domain-${page.id}`}
                      type="text"
                      value={domainDraft[page.id] ?? ""}
                      onChange={(e) => setDomainDraft((d) => ({ ...d, [page.id]: e.target.value }))}
                      placeholder="status.example.com"
                      disabled={busy}
                      className="min-w-[12rem] flex-1 rounded-lg border border-border bg-surface px-2 py-1.5 text-sm text-on-surface placeholder:text-on-surface-faint"
                    />
                    <button
                      type="button"
                      onClick={() => void attachDomain(page)}
                      disabled={busy}
                      className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
                    >
                      Attach
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <code className="text-xs text-on-surface-secondary">{page.customHostname}</code>
                  {page.customHostnameVerification && (
                    <div className="space-y-1 text-xs text-on-surface-tertiary">
                      <p>
                        CNAME{" "}
                        <code className="text-on-surface-secondary">{page.customHostname}</code> →{" "}
                        <code className="text-on-surface-secondary">
                          {page.customHostnameVerification.cnameTarget}
                        </code>
                      </p>
                      {page.customHostnameVerification.txtName &&
                        page.customHostnameVerification.txtValue && (
                          <p>
                            TXT{" "}
                            <code className="text-on-surface-secondary">
                              {page.customHostnameVerification.txtName}
                            </code>{" "}
                            ={" "}
                            <code className="text-on-surface-secondary">
                              {page.customHostnameVerification.txtValue}
                            </code>
                          </p>
                        )}
                    </div>
                  )}
                  {page.customHostnameError && (
                    <p className="text-xs text-danger">{page.customHostnameError}</p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {page.customHostnameStatus !== "active" && (
                      <button
                        type="button"
                        onClick={() => void refreshDomain(page)}
                        disabled={busy}
                        className="rounded-lg border border-border bg-surface px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
                      >
                        Check DNS
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void detachDomain(page)}
                      disabled={busy}
                      className="rounded-lg px-3 py-1.5 text-sm text-on-surface-tertiary hover:text-danger disabled:opacity-50"
                    >
                      Remove domain
                    </button>
                  </div>
                </>
              )}
              <p className="text-xs text-on-surface-faint">
                Paid plan. Subdomains only — CNAME to Infrawrench; we issue the certificate.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setEditing({ page })}
                disabled={busy}
                className="rounded-lg border border-border bg-surface-raised px-3 py-1.5 text-sm text-on-surface hover:border-border-strong disabled:opacity-50"
              >
                {gt("Edit")}
              </button>
              <button
                type="button"
                onClick={() => void rotate(page)}
                disabled={busy}
                className="rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary hover:text-on-surface disabled:opacity-50"
              >
                {gt("New link")}
              </button>
              <button
                type="button"
                onClick={() => void remove(page)}
                disabled={busy}
                className="ml-auto rounded-lg px-3 py-1.5 text-sm text-on-surface-tertiary hover:text-danger disabled:opacity-50"
              >
                {gt("Delete")}
              </button>
            </div>
          </div>
        );
      })}

      {editing && (
        <StatusPageEditorModal
          page={editing.page}
          probes={probes}
          onCancel={() => setEditing(null)}
          onSave={save}
        />
      )}
    </section>
  );
}
