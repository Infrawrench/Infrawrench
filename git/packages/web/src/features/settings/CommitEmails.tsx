/**
 * The extra addresses the reader's commits carry in one organisation: a
 * commit with one is shown as theirs in that organisation's repositories,
 * once they have typed back the code mailed to it.
 */
import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import type { CommitEmail, SessionOrganization } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate } from "../../api/queries";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Field, Input } from "../../components/forms";
import { InlineError } from "../../components/states";

const changed = () => invalidate("account", "listCommitEmails");

function PendingEmail({ email }: { email: CommitEmail }) {
  const [code, setCode] = useState("");
  const verify = useMutation({
    mutationFn: () =>
      api.account.verifyCommitEmail({ params: { emailId: email.id }, payload: { code } }),
    onSuccess: changed,
  });
  const send = useMutation({
    mutationFn: () => api.account.sendCommitEmailCode({ params: { emailId: email.id } }),
    onSuccess: changed,
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (code.trim() !== "") verify.mutate();
  };
  return (
    <form onSubmit={submit} noValidate className="mt-1.5 space-y-1">
      <Field
        label={`Code sent to ${email.email}`}
        hint={email.codeSentAt === null ? "Sending the code" : undefined}
      >
        {(control) => (
          <div className="flex flex-wrap items-center gap-2">
            <Input
              {...control}
              autoComplete="one-time-code"
              spellCheck={false}
              maxLength={32}
              value={code}
              onChange={(event) => {
                setCode(event.target.value);
                if (verify.error) verify.reset();
              }}
              className="max-w-36 font-mono uppercase"
            />
            <Button type="submit" size="sm" busy={verify.isPending} disabled={code.trim() === ""}>
              Verify
            </Button>
            <Button size="sm" variant="ghost" busy={send.isPending} onClick={() => send.mutate()}>
              Send again
            </Button>
          </div>
        )}
      </Field>
      <InlineError error={verify.error ?? send.error} />
    </form>
  );
}

function EmailRow({ email }: { email: CommitEmail }) {
  const remove = useMutation({
    mutationFn: () => api.account.removeCommitEmail({ params: { emailId: email.id } }),
    onSuccess: changed,
  });
  const verified = email.verifiedAt !== null;
  return (
    <li className="py-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs text-on-surface">{email.email}</span>
          <Badge tone={verified ? "success" : "warning"}>{verified ? "Verified" : "Pending"}</Badge>
        </div>
        <Button
          size="sm"
          variant="ghost"
          busy={remove.isPending}
          aria-label={`Remove ${email.email}`}
          onClick={() => remove.mutate()}
        >
          Remove
        </Button>
      </div>
      {verified ? null : <PendingEmail email={email} />}
      <InlineError error={remove.error} />
    </li>
  );
}

export function CommitEmails({
  organization,
  emails,
}: {
  organization: SessionOrganization;
  emails: ReadonlyArray<CommitEmail>;
}) {
  const [address, setAddress] = useState("");
  const add = useMutation({
    mutationFn: () =>
      api.account.addCommitEmail({
        payload: { organizationId: organization.id, email: address.trim() },
      }),
    onSuccess: () => {
      setAddress("");
      return changed();
    },
  });
  const title = `Commit emails in ${organization.name}`;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (address.trim() !== "") add.mutate();
  };
  return (
    <section aria-label={title} className="space-y-1">
      <h3 className="text-xs font-medium text-on-surface">{title}</h3>
      {emails.length > 0 ? (
        <ul aria-label={title} className="divide-y divide-border">
          {emails.map((email) => (
            <EmailRow key={email.id} email={email} />
          ))}
        </ul>
      ) : null}
      <form onSubmit={submit} noValidate className="space-y-1 pt-1">
        <Field label={`Add an address in ${organization.name}`}>
          {(control) => (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                {...control}
                type="email"
                autoComplete="email"
                spellCheck={false}
                maxLength={320}
                value={address}
                onChange={(event) => {
                  setAddress(event.target.value);
                  if (add.error) add.reset();
                }}
                className="max-w-xs"
              />
              <Button type="submit" size="sm" busy={add.isPending} disabled={address.trim() === ""}>
                Add
              </Button>
            </div>
          )}
        </Field>
        <InlineError error={add.error} />
      </form>
    </section>
  );
}
