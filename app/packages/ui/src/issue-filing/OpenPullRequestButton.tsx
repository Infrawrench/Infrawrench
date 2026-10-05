import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import {
  GithubPermissionRequiredClientError,
  type GithubIacChange,
  type GithubPermissionRequiredPayload,
  type GithubPullRequestPreview,
  type GithubPullRequestResult,
} from "@infrawrench/client-core";

import { Modal } from "../components/Modal.js";
import { GithubPermissionPrompt } from "./github.js";
import { useIssueFiling } from "./host.js";

export interface OpenPullRequestButtonProps {
  sourceKind: "orphan" | "oversized";
  /** The finding id (for these kinds, the resource id). */
  sourceId: string;
  resourceId: string;
  change: GithubIacChange;
  className?: string;
}

/**
 * "Open PR": propose the fix as a Terraform change, for a finding whose
 * resource is managed by Terraform in a mapped repository.
 *
 * Renders nothing unless the org enabled IaC pull requests and the caller
 * holds `github-issues:write`. Eligibility (managed by Terraform? a plain
 * literal attribute? referenced elsewhere?) is only knowable by reading the
 * repository, so the button is offered on every row and the modal's preview
 * either shows the one-file diff or says, in a sentence, why this one is not
 * a mechanical change. Opening is a second, explicit click; nothing merges.
 */
export function OpenPullRequestButton({
  sourceKind,
  sourceId,
  resourceId,
  change,
  className,
}: OpenPullRequestButtonProps) {
  const gt = useGT();
  const filing = useIssueFiling();
  const [open, setOpen] = useState(false);
  if (!filing || !filing.canOpenPullRequests) return null;

  const link = filing.linksFor(sourceKind, sourceId).github;
  if (link?.pullRequestUrl && link.pullRequestNumber) {
    const url = link.pullRequestUrl;
    return (
      <button
        type="button"
        onClick={() => filing.openExternal(url)}
        className={
          className ?? "text-xs font-medium text-info hover:text-info-strong whitespace-nowrap"
        }
      >
        {gt("PR #{number}", { number: link.pullRequestNumber })}
      </button>
    );
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          "text-xs text-on-surface-muted hover:text-on-surface-secondary whitespace-nowrap"
        }
      >
        {gt("Open PR")}
      </button>
      {open && (
        <OpenPullRequestModal
          sourceKind={sourceKind}
          sourceId={sourceId}
          resourceId={resourceId}
          change={change}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function OpenPullRequestModal({
  sourceKind,
  sourceId,
  resourceId,
  change,
  onClose,
}: Omit<OpenPullRequestButtonProps, "className"> & { onClose: () => void }) {
  const gt = useGT();
  const filing = useIssueFiling();
  const [preview, setPreview] = useState<GithubPullRequestPreview | null>(null);
  const [opened, setOpened] = useState<GithubPullRequestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permission, setPermission] = useState<GithubPermissionRequiredPayload | null>(null);

  const api = filing?.api;
  const orgId = filing?.orgId;
  const body = { sourceKind, sourceId, resourceId, change };
  const bodyKey = JSON.stringify(body);

  useEffect(() => {
    if (!api || !orgId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await api.post<GithubPullRequestPreview>(
          `/api/org/${orgId}/github-issues/pull-requests/preview`,
          JSON.parse(bodyKey) as unknown,
        );
        if (!cancelled) setPreview(res);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof GithubPermissionRequiredClientError) setPermission(e.payload);
        else setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, orgId, bodyKey]);

  if (!filing || !api || !orgId) return null;

  async function submit() {
    if (!api || !orgId) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<GithubPullRequestResult>(
        `/api/org/${orgId}/github-issues/pull-requests`,
        body,
      );
      setOpened(res);
      if (res.link) filing?.onGithubFiled(res.link);
    } catch (e) {
      if (e instanceof GithubPermissionRequiredClientError) setPermission(e.payload);
      else setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const heading = gt("Open a Terraform pull request");
  return (
    <Modal onClose={onClose} ariaLabel={heading}>
      <div className="bg-surface-raised border border-border-strong rounded-xl shadow-2xl w-[640px] max-w-[94vw] p-6">
        <h2 className="text-base font-semibold text-on-surface mb-1">{heading}</h2>
        <p className="text-xs text-on-surface-faint mb-4">
          {gt(
            "Infrawrench edits the Terraform that manages this resource and opens a pull request for review. It is never merged automatically.",
          )}
        </p>

        {permission && (
          <div className="mb-3">
            <GithubPermissionPrompt
              accountLogin={permission.accountLogin}
              permissions={permission.permissions}
              manageUrl={permission.manageUrl}
              openExternal={filing.openExternal}
            />
          </div>
        )}
        {error !== null && (
          <div role="alert" className="mb-3 text-sm text-danger">
            {error}
          </div>
        )}

        {opened ? (
          <div className="text-sm text-on-surface">
            <p>{gt("Pull request #{number} is open.", { number: opened.pullRequest.number })}</p>
            <button
              type="button"
              onClick={() => filing.openExternal(opened.pullRequest.url)}
              className="mt-2 text-sm font-medium text-info hover:text-info-strong"
            >
              {gt("View on GitHub")}
            </button>
          </div>
        ) : preview === null && !error && !permission ? (
          <p className="text-sm text-on-surface-muted">{gt("Reading the repository…")}</p>
        ) : preview && !preview.eligible ? (
          <p className="text-sm text-on-surface-secondary">{preview.reason}</p>
        ) : preview && preview.eligible ? (
          <div className="space-y-2">
            <p className="text-sm text-on-surface">{preview.title}</p>
            <p className="text-xs text-on-surface-muted">
              {gt("{repo} · {path} · into {branch}", {
                repo: preview.repo.fullName,
                path: preview.path,
                branch: preview.baseBranch,
              })}
            </p>
            <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-surface-sunken p-3 text-xs font-mono text-on-surface-secondary">
              {preview.diff}
            </pre>
          </div>
        ) : null}

        <div className="flex justify-end gap-2 mt-5">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-3 py-1.5 text-sm font-medium border border-border hover:bg-surface-overlay disabled:opacity-50 text-on-surface-secondary rounded-lg transition-colors"
          >
            {opened ? gt("Close") : gt("Cancel")}
          </button>
          {!opened && preview?.eligible && (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || permission !== null}
              className="px-3 py-1.5 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-lg transition-colors"
            >
              {busy ? gt("Opening…") : gt("Open pull request")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
