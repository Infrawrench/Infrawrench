import { useCallback, useEffect, useState } from "react";
import { T, Var, useGT } from "gt-react";
import { formatChangeValue, localRevertRefusal } from "@infrawrench/client-core";
import { Modal } from "../components/Modal.js";
import { useDataString } from "../i18n/data-strings.js";
import type {
  ChangeRevertClient,
  ResourceChangeEntry,
  RevertFieldPlan,
  RevertFieldStatus,
  RevertPreviewResponse,
} from "./types.js";

/**
 * Reverting a change, shared by the org feed and the per-resource Changes tab
 * on both desktop and web.
 *
 * The button decides *locally* whether a revert is even worth asking about —
 * only `updated` events with a diff, and only ones not already reverted — and
 * says why when it is disabled rather than disappearing, because a missing
 * button reads as a bug. Everything past that is the server's plan: which
 * fields can go back, which already did, which moved again since, and which the
 * plugin simply can't write.
 */

// The local refusals live in client-core beside the contract, because mobile's
// native row needs the same three sentences and can't import this package.
export { localRevertRefusal };

const STATUS_LABELS: Record<RevertFieldStatus, string> = {
  revertible: "Will revert",
  "already-reverted": "No change needed",
  conflict: "Changed since",
  "not-writable": "Not writable",
  "provider-derived": "Provider-derived",
};

const STATUS_CLASSES: Record<RevertFieldStatus, string> = {
  revertible: "bg-green-500/10 text-success",
  "already-reverted": "bg-surface-overlay text-on-surface-tertiary",
  conflict: "bg-amber-500/10 text-warning",
  "not-writable": "bg-surface-overlay text-on-surface-faint",
  "provider-derived": "bg-surface-overlay text-on-surface-faint",
};

function PlanRow({ field }: { field: RevertFieldPlan }) {
  const gtData = useDataString();
  return (
    <li className="border border-border rounded-lg px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-on-surface-secondary break-all">{field.field}</span>
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_CLASSES[field.status]}`}
        >
          {gtData(STATUS_LABELS[field.status])}
        </span>
      </div>
      {/* Same before → after shape the feed's diff list uses, read the other
          way round: the value we would write comes last. */}
      <div className="mt-1 flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className="font-mono text-on-surface-faint line-through break-all">
          {formatChangeValue(field.changedTo)}
        </span>
        <span className="text-on-surface-faint" aria-hidden>
          →
        </span>
        <span className="font-mono text-on-surface-tertiary break-all">
          {formatChangeValue(field.revertTo)}
        </span>
      </div>
      {field.status === "conflict" && (
        <T>
          <p className="mt-1 text-xs text-warning break-all">
            Now holds{" "}
            <Var>
              <span className="font-mono">{formatChangeValue(field.current)}</span>
            </Var>
          </p>
        </T>
      )}
      <p className="mt-1 text-xs text-on-surface-faint">{gtData(field.reason)}</p>
    </li>
  );
}

export interface RevertChangeDialogProps {
  entry: ResourceChangeEntry;
  client: ChangeRevertClient;
  onClose: () => void;
  /** Called after a successful apply so the host can refetch the feed. */
  onReverted?: (() => void) | undefined;
}

/**
 * Confirmation dialog: loads the dry run, shows the plan field by field, and
 * only offers the button when the server says something would actually be
 * written.
 */
export function RevertChangeDialog({
  entry,
  client,
  onClose,
  onReverted,
}: RevertChangeDialogProps) {
  const gt = useGT();
  const gtData = useDataString();
  const [preview, setPreview] = useState<RevertPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [done, setDone] = useState<string[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setError(null);
    void (async () => {
      try {
        const result = await client.preview(entry.id);
        if (!cancelled) setPreview(result);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, entry.id]);

  const apply = useCallback(async () => {
    setApplying(true);
    setError(null);
    try {
      const result = await client.apply(entry.id);
      setDone(result.appliedFields);
      onReverted?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setApplying(false);
    }
  }, [client, entry.id, onReverted]);

  const plan = preview?.plan ?? null;

  return (
    <Modal onClose={onClose} ariaLabel={gt("Revert change to {name}", { name: entry.displayName })}>
      <div className="bg-surface-raised border border-border rounded-xl w-[min(42rem,90vw)] max-h-[80vh] overflow-auto p-5">
        <h2 className="text-lg font-semibold">{gt("Revert this change")}</h2>
        <T>
          <p className="mt-1 text-sm text-on-surface-muted">
            <Var>{entry.displayName}</Var> — recorded{" "}
            <Var>{new Date(entry.createdAt).toLocaleString()}</Var>. The plan below is computed
            against the resource&apos;s current state, not against what the poller saw.
          </p>
        </T>

        {error !== null && (
          <div role="alert" className="mt-4 text-sm text-danger">
            {error}
          </div>
        )}

        {done !== null ? (
          <div className="mt-4 text-sm text-on-surface-secondary">
            <p>
              {done.length === 1
                ? gt("Reverted {field}.", { field: done[0] })
                : gt("Reverted {count} fields: {fields}.", {
                    count: done.length,
                    fields: done.join(", "),
                  })}
            </p>
            <p className="mt-1 text-xs text-on-surface-faint">
              {gt("The next poll will pick this up and record it as its own change event.")}
            </p>
          </div>
        ) : preview === null && error === null ? (
          <p role="status" className="mt-4 text-sm text-on-surface-faint">
            {gt("Reading the resource's current state…")}
          </p>
        ) : plan !== null ? (
          <>
            {plan.blockedReason !== null && (
              <p className="mt-4 text-sm text-on-surface-tertiary">{gtData(plan.blockedReason)}</p>
            )}
            {plan.fields.length > 0 && (
              <ul className="mt-4 space-y-2">
                {plan.fields.map((f) => (
                  <PlanRow key={f.field} field={f} />
                ))}
              </ul>
            )}
          </>
        ) : null}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm border border-border-strong rounded-lg text-on-surface-tertiary hover:text-on-surface-secondary"
          >
            {done === null ? gt("Cancel") : gt("Close")}
          </button>
          {done === null && (
            <button
              type="button"
              onClick={() => void apply()}
              disabled={applying || !plan?.revertible}
              className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white disabled:opacity-40 hover:bg-blue-500"
            >
              {applying
                ? gt("Reverting…")
                : plan
                  ? gt("Revert {count} {label}", {
                      count: plan.revertibleFields.length || "",
                      label: plan.revertibleFields.length === 1 ? gt("field") : gt("fields"),
                    })
                  : gt("Revert")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export interface RevertChangeButtonProps {
  entry: ResourceChangeEntry;
  client: ChangeRevertClient;
  onReverted?: (() => void) | undefined;
  className?: string | undefined;
}

/**
 * The Revert affordance on a change row: a button that stays visible and
 * explains itself when the event isn't revertible, plus the dialog it opens.
 */
export function RevertChangeButton({
  entry,
  client,
  onReverted,
  className,
}: RevertChangeButtonProps) {
  const gt = useGT();
  const gtData = useDataString();
  const [open, setOpen] = useState(false);
  const refusal = localRevertRefusal(entry);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={refusal !== null}
        title={
          refusal !== null ? gtData(refusal) : gt("Put the changed fields back to what they were")
        }
        className={`text-xs shrink-0 ${
          refusal !== null
            ? "text-on-surface-faint cursor-not-allowed"
            : "text-on-surface-tertiary hover:text-on-surface-secondary underline"
        } ${className ?? ""}`}
      >
        {gt("Revert")}
      </button>
      {open && (
        <RevertChangeDialog
          entry={entry}
          client={client}
          onClose={() => setOpen(false)}
          onReverted={onReverted}
        />
      )}
    </>
  );
}
