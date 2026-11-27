/**
 * The extra addresses the reader's commits carry in one place: an
 * organisation (Settings > Organisations) or their own repositories
 * (Settings > Profile). A commit with one is shown as theirs in that place's
 * repositories from the moment it is added. Verifying one, with a code mailed
 * to it, is optional; the code's field opens in the address's own row.
 */
import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { CommitEmail, SessionOrganization } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/controls";
import { Input } from "../../components/forms";
import { Icon } from "../../components/icons";
import { InlineError } from "../../components/states";

const changed = () => invalidate("account", "listCommitEmails");

/** How long a mailed code works: one asked for since then is still good to type. */
const CODE_TTL_MS = 24 * 60 * 60 * 1000;

const codeOutstanding = (email: CommitEmail): boolean =>
  email.codeRequestedAt !== null && Date.now() - Date.parse(email.codeRequestedAt) < CODE_TTL_MS;

/** The reader's commit emails, everywhere: each page keeps the ones of the place it shows. */
export const useCommitEmails = (enabled: boolean) =>
  useQuery({ ...queries.account.listCommitEmails(), enabled });

function EmailRow({ email, onRemove }: { email: CommitEmail; onRemove: () => void }) {
  const [verifying, setVerifying] = useState(false);
  const [code, setCode] = useState("");
  const verified = email.verifiedAt !== null;
  // Another member has the address: its code is the only way this row will count.
  const waiting = !email.active;
  const verify = useMutation({
    mutationFn: () =>
      api.account.verifyCommitEmail({ params: { emailId: email.id }, payload: { code } }),
    onSuccess: changed,
  });
  const send = useMutation({
    mutationFn: () => api.account.sendCommitEmailCode({ params: { emailId: email.id } }),
    onSuccess: changed,
  });
  const start = () => {
    setVerifying(true);
    // A code asked for within the day is still good: no second message.
    if (!codeOutstanding(email)) send.mutate();
  };
  const cancel = () => {
    setVerifying(false);
    setCode("");
    verify.reset();
    send.reset();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (code.trim() !== "") verify.mutate();
  };
  const error = verify.error ?? send.error;
  return (
    <li className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-1.5">
      <span
        className={`min-w-0 flex-1 basis-40 truncate font-mono text-xs ${waiting ? "text-on-surface-muted" : "text-on-surface"}`}
      >
        {email.email}
      </span>
      {verified ? (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
          <Icon name="check" size={12} />
          Verified
        </span>
      ) : waiting || verifying ? (
        // The code's field, in this row only; under the address where the row is narrow.
        <form
          onSubmit={submit}
          noValidate
          className="flex flex-wrap items-center gap-1.5 max-sm:order-last max-sm:basis-full"
        >
          <Input
            aria-label={`Code sent to ${email.email}`}
            aria-invalid={verify.error !== null || undefined}
            placeholder="Code"
            autoFocus={!waiting}
            autoComplete="one-time-code"
            spellCheck={false}
            maxLength={32}
            value={code}
            onChange={(event) => {
              setCode(event.target.value);
              if (verify.error) verify.reset();
            }}
            className="!w-28 !py-1 font-mono uppercase placeholder:font-sans placeholder:normal-case"
          />
          <Button type="submit" size="sm" busy={verify.isPending} disabled={code.trim() === ""}>
            Verify
          </Button>
          <Button size="sm" variant="ghost" busy={send.isPending} onClick={() => send.mutate()}>
            Send again
          </Button>
          {waiting ? null : (
            <Button size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          )}
        </form>
      ) : (
        <Button size="sm" variant="ghost" onClick={start}>
          Verify
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        aria-label={`Remove ${email.email}`}
        title="Remove"
        onClick={onRemove}
        className="!px-1 text-on-surface-muted hover:text-danger"
      >
        <Icon name="trash" size={13} />
      </Button>
      {waiting || error !== null ? (
        <div className="order-last basis-full space-y-1 pb-1 sm:text-right">
          {waiting ? (
            <p className="text-xs text-on-surface-muted">
              Another member added this address. It counts for you once verified.
            </p>
          ) : null}
          <InlineError error={error} />
        </div>
      ) : null}
    </li>
  );
}

export function CommitEmails({
  organization,
  emails,
}: {
  /** Null: the reader's own repositories. */
  organization: SessionOrganization | null;
  emails: ReadonlyArray<CommitEmail>;
}) {
  const [address, setAddress] = useState("");
  const [removing, setRemoving] = useState<CommitEmail | null>(null);
  const add = useMutation({
    mutationFn: () =>
      api.account.addCommitEmail({
        payload: { organizationId: organization?.id ?? null, email: address.trim() },
      }),
    onSuccess: () => {
      setAddress("");
      return changed();
    },
  });
  const remove = useMutation({
    mutationFn: (email: CommitEmail) =>
      api.account.removeCommitEmail({ params: { emailId: email.id } }),
    onSuccess: () => {
      setRemoving(null);
      return changed();
    },
  });
  const place = organization?.name ?? "your own repositories";
  const title = `Commit emails in ${place}`;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (address.trim() !== "") add.mutate();
  };
  return (
    <section
      aria-label={title}
      className="overflow-hidden rounded-md border border-border bg-surface-raised"
    >
      {/* Profile's section is headed "Commit emails" already: there, only where they count. */}
      <h3 className="flex min-h-8 items-center border-b border-border bg-surface-inset px-3 text-xs font-medium text-on-surface-secondary">
        {organization === null ? "Your own repositories" : "Commit emails"}
      </h3>
      {emails.length > 0 ? (
        <ul aria-label={title} className="divide-y divide-border border-b border-border">
          {emails.map((email) => (
            <EmailRow key={email.id} email={email} onRemove={() => setRemoving(email)} />
          ))}
        </ul>
      ) : null}
      <form onSubmit={submit} noValidate className="space-y-1 px-3 py-2">
        <div className="flex items-center gap-2">
          <Input
            aria-label={
              organization === null ? `Add an address for ${place}` : `Add an address in ${place}`
            }
            aria-invalid={add.error !== null || undefined}
            type="email"
            placeholder="name@example.com"
            autoComplete="email"
            spellCheck={false}
            maxLength={320}
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
              if (add.error) add.reset();
            }}
            className="max-w-xs !py-1 font-mono placeholder:font-sans"
          />
          <Button type="submit" size="sm" busy={add.isPending} disabled={address.trim() === ""}>
            Add
          </Button>
        </div>
        <InlineError error={add.error} />
      </form>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => {
          setRemoving(null);
          remove.reset();
        }}
        title="Remove commit email"
        confirmLabel="Remove"
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      >
        <p>
          Commits made with <span className="font-mono">{removing?.email}</span> stop being shown as
          yours in {place}.
        </p>
        <InlineError error={remove.error} />
      </ConfirmDialog>
    </section>
  );
}
