/**
 * What reviewers sent back to the agent that writes the branch: the list,
 * the box for a note in the reviewer's own words, and the "Send to agent"
 * button a review thread and a finding carry.
 */
import { createContext, useContext, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import type { Instruction } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate } from "../../api/queries";
import { Badge } from "../../components/Badge";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/controls";
import { Field, Textarea } from "../../components/forms";
import { Icon } from "../../components/icons";
import { RelativeTime, UserLink } from "../../components/people";
import { InlineError } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { INSTRUCTION_STATUS } from "./branch";

export interface InstructionsState {
  readonly branchKey: string;
  /** Null when the server does not serve instructions yet. */
  readonly instructions: ReadonlyArray<Instruction> | null;
  /** The viewer may send one. */
  readonly canSend: boolean;
}

const InstructionsContext = createContext<InstructionsState | null>(null);
export const InstructionsProvider = InstructionsContext.Provider;

/** The branch's instructions. Null outside a branch page, and where they are not served. */
export function useInstructions(): InstructionsState | null {
  const state = useContext(InstructionsContext);
  return state === null || state.instructions === null ? null : state;
}

/** Everything a new instruction, or a change to one, can show up in. */
export function refreshInstructions(): void {
  void invalidate("instructions");
  void invalidate("versions", "branchState");
  void invalidate("findings");
}

export function InstructionBadge({ instruction }: { instruction: Instruction }) {
  const look = INSTRUCTION_STATUS[instruction.status];
  return (
    <Badge tone={look.tone}>
      <Icon name="send" size={10} />
      {instruction.status === "answered" && instruction.answeredInVersion !== null
        ? `Answered by v${instruction.answeredInVersion}`
        : look.label}
    </Badge>
  );
}

type Source =
  | { readonly source: "review_comment"; readonly reviewCommentId: string }
  | { readonly source: "finding"; readonly findingId: string };

/** Sends a review thread or a finding to the agent, with a note if the reviewer has one. */
export function SendToAgentButton({ from }: { from: Source }) {
  const repo = useRepoRef();
  const state = useInstructions();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const send = useMutation({
    mutationFn: () =>
      api.instructions.send({
        params: { ...repo, branch: state!.branchKey },
        payload: { ...from, ...(note.trim() === "" ? {} : { body: note.trim() }) },
      }),
    onSuccess: () => {
      setOpen(false);
      setNote("");
      refreshInstructions();
    },
  });
  if (state === null || !state.canSend) return null;
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Icon name="send" size={11} />
        Send to agent
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Send to agent"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" busy={send.isPending} onClick={() => send.mutate()}>
              Send
            </Button>
          </>
        }
      >
        <Field label="Note" optional>
          {(control) => (
            <Textarea
              {...control}
              rows={3}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          )}
        </Field>
        <InlineError error={send.error} />
      </Dialog>
    </>
  );
}

function InstructionRow({
  instruction,
  branchKey,
}: {
  instruction: Instruction;
  branchKey: string;
}) {
  const repo = useRepoRef();
  const state = useInstructions();
  const withdraw = useMutation({
    mutationFn: () =>
      api.instructions.dismiss({
        params: { ...repo, branch: branchKey, instructionId: instruction.id },
      }),
    onSuccess: refreshInstructions,
  });
  const open = instruction.status === "queued" || instruction.status === "delivered";
  return (
    <li className="space-y-1 py-2 first:pt-0">
      <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-on-surface-muted">
        <InstructionBadge instruction={instruction} />
        {instruction.createdBy !== null ? <UserLink user={instruction.createdBy} /> : null}
        <RelativeTime iso={instruction.createdAt} />
      </p>
      <p className="line-clamp-3 text-xs break-words text-on-surface-secondary">
        {instruction.body}
      </p>
      {open && state?.canSend === true ? (
        <button
          type="button"
          disabled={withdraw.isPending}
          onClick={() => withdraw.mutate()}
          className="text-xs text-on-surface-muted hover:text-on-surface hover:underline disabled:opacity-60"
        >
          Withdraw
        </button>
      ) : null}
      <InlineError error={withdraw.error} />
    </li>
  );
}

/** The sidebar's section: what has been sent, and a box to send more. */
export function InstructionsPanel() {
  const repo = useRepoRef();
  const state = useInstructions();
  const [body, setBody] = useState("");
  const send = useMutation({
    mutationFn: () =>
      api.instructions.send({
        params: { ...repo, branch: state!.branchKey },
        payload: { source: "text", body: body.trim() },
      }),
    onSuccess: () => {
      setBody("");
      refreshInstructions();
    },
  });
  if (state === null || state.instructions === null) return null;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (body.trim() !== "") send.mutate();
  };
  // The newest first: what is still with the agent is what a reviewer came for.
  const shown = [...state.instructions].reverse();
  return (
    <section aria-labelledby="branch-instructions" className="border-b border-border py-3">
      <h2
        id="branch-instructions"
        className="mb-1.5 text-xs font-semibold text-on-surface-secondary"
      >
        Instructions
      </h2>
      {state.canSend ? (
        <form onSubmit={submit} className="mb-2 space-y-1.5">
          <Textarea
            aria-label="Instruction for the agent"
            placeholder="Tell the agent what to change"
            rows={2}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" size="sm" busy={send.isPending} disabled={body.trim() === ""}>
              <Icon name="send" size={11} />
              Send to agent
            </Button>
            <InlineError error={send.error} />
          </div>
        </form>
      ) : null}
      {shown.length === 0 ? (
        <p className="text-xs text-on-surface-muted">Nothing sent</p>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((instruction) => (
            <InstructionRow
              key={instruction.id}
              instruction={instruction}
              branchKey={state.branchKey}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
