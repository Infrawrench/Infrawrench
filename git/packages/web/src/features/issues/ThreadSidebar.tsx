/**
 * The column beside a thread (and beside the form that opens one): assignees,
 * labels and the milestone, each with a picker for people who may triage.
 */
import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Label, UserRef } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/controls";
import { Field, Select } from "../../components/forms";
import { Icon } from "../../components/icons";
import { LabelChip, LabelDot } from "../../components/LabelChip";
import { Avatar, UserLink } from "../../components/people";
import { Picker, type PickerOption } from "../../components/Picker";
import { InlineError } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import type { MilestoneRef } from "@infrawrench/git-contract";
import { paths } from "../../lib/paths";
import { threadSearchHref } from "./ThreadList";

export interface ThreadTriage {
  readonly labels: ReadonlyArray<string>;
  readonly assignees: ReadonlyArray<string>;
  readonly milestone: number | null;
}

function Section({
  title,
  picker,
  children,
}: {
  title: string;
  picker?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-border py-3 first:pt-0 last:border-b-0">
      <div className="mb-1.5 flex items-center justify-between">
        <h2 className="text-xs font-semibold text-on-surface-secondary">{title}</h2>
        {picker}
      </div>
      <div className="text-xs text-on-surface-muted">{children}</div>
    </section>
  );
}

const editButton = (label: string) =>
  function EditTrigger({
    props,
  }: {
    props: { "aria-expanded": boolean; "aria-controls": string; onClick: () => void };
  }) {
    return (
      <button
        {...props}
        type="button"
        aria-label={label}
        aria-haspopup="listbox"
        className="inline-flex size-6 items-center justify-center rounded text-on-surface-muted hover:bg-surface-sunken hover:text-on-surface"
      >
        <Icon name="settings" size={13} />
      </button>
    );
  };

/**
 * The three pickers over a value the caller owns: the new-thread forms keep it
 * in state, a thread's page sends each change to the API.
 */
export function TriageFields({
  value,
  onChange,
  canTriage,
  kind,
  shown,
}: {
  value: ThreadTriage;
  onChange: (next: ThreadTriage) => void;
  canTriage: boolean;
  kind: "issues" | "branches";
  /** The thread's own labels, people and milestone, to show before the lists load. */
  shown?: {
    readonly labels: ReadonlyArray<Label>;
    readonly assignees: ReadonlyArray<UserRef>;
    readonly milestone: MilestoneRef | null;
  };
}) {
  const repo = useRepoRef();
  const labels = useQuery({
    ...queries.labels.list({ params: repo }),
    enabled: canTriage || !shown,
  });
  const milestones = useQuery({
    ...queries.milestones.list({ params: repo, query: { state: "open" } }),
    enabled: canTriage || !shown,
  });
  const people = useQuery({
    ...queries.collaborators.listAssignable({ params: repo }),
    enabled: canTriage,
  });

  const chosenLabels =
    labels.data?.labels.filter((label) => value.labels.includes(label.name)) ?? shown?.labels ?? [];
  const known = new Map<string, UserRef>();
  for (const user of [...(shown?.assignees ?? []), ...(people.data?.users ?? [])]) {
    if (user.username !== null) known.set(user.username, user);
  }
  const chosenPeople = value.assignees.flatMap((name) => known.get(name) ?? []);
  const milestone =
    milestones.data?.milestones.find((item) => item.number === value.milestone) ??
    (shown?.milestone?.number === value.milestone ? shown?.milestone : null) ??
    null;

  const userOptions: PickerOption[] = [...known.values()].map((user) => ({
    value: user.username!,
    label: user.username!,
    detail: user.displayName,
    leading: <Avatar name={user.displayName ?? user.username!} src={user.avatarUrl} size={16} />,
  }));

  return (
    <>
      <Section
        title="Assignees"
        picker={
          canTriage ? (
            <Picker
              label="Assignees"
              align="end"
              multiple
              options={userOptions}
              selected={value.assignees}
              onChange={(assignees) => onChange({ ...value, assignees })}
              loading={people.isLoading}
              emptyText="Nobody matches"
              trigger={editButton("Edit assignees")}
            />
          ) : undefined
        }
      >
        {chosenPeople.length === 0 ? (
          "Nobody"
        ) : (
          <ul className="space-y-1">
            {chosenPeople.map((user) => (
              <li key={user.id}>
                <UserLink user={user} avatar />
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section
        title="Labels"
        picker={
          canTriage ? (
            <Picker
              label="Labels"
              align="end"
              multiple
              options={(labels.data?.labels ?? []).map((label) => ({
                value: label.name,
                label: label.name,
                detail: label.description,
                leading: <LabelDot color={label.color} />,
              }))}
              selected={value.labels}
              onChange={(next) => onChange({ ...value, labels: next })}
              loading={labels.isLoading}
              emptyText="No labels"
              footer={
                <AppLink
                  href={paths.labels(repo)}
                  className="text-on-surface-secondary hover:underline"
                >
                  Edit labels
                </AppLink>
              }
              trigger={editButton("Edit labels")}
            />
          ) : undefined
        }
      >
        {chosenLabels.length === 0 ? (
          "None"
        ) : (
          <div className="flex flex-wrap gap-1">
            {chosenLabels.map((label) => (
              <LabelChip
                key={label.id}
                label={label}
                href={threadSearchHref(repo, kind, { labels: [label.name] })}
              />
            ))}
          </div>
        )}
      </Section>
      <Section
        title="Milestone"
        picker={
          canTriage ? (
            <Picker
              label="Milestones"
              align="end"
              options={(milestones.data?.milestones ?? []).map((item) => ({
                value: String(item.number),
                label: item.title,
                detail: item.dueOn === null ? null : `Due ${item.dueOn}`,
              }))}
              selected={value.milestone === null ? [] : [String(value.milestone)]}
              onChange={([picked]) =>
                onChange({ ...value, milestone: picked === undefined ? null : Number(picked) })
              }
              loading={milestones.isLoading}
              emptyText="No open milestones"
              footer={
                <AppLink
                  href={paths.milestones(repo)}
                  className="text-on-surface-secondary hover:underline"
                >
                  Edit milestones
                </AppLink>
              }
              trigger={editButton("Edit milestone")}
            />
          ) : undefined
        }
      >
        {milestone === null ? (
          "None"
        ) : (
          <AppLink
            href={paths.milestone(repo, milestone.number)}
            className="inline-flex items-center gap-1.5 font-medium text-on-surface hover:underline"
          >
            <Icon name="milestone" size={12} />
            {milestone.title}
          </AppLink>
        )}
      </Section>
    </>
  );
}

const LOCK_REASONS = ["off-topic", "too heated", "resolved", "spam"] as const;
type LockReason = (typeof LOCK_REASONS)[number];

/** Lock or unlock a conversation: `triage` and above. */
export function LockControl({ number, locked }: { number: number; locked: boolean }) {
  const repo = useRepoRef();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<LockReason | "">("");
  const done = () => {
    setOpen(false);
    void invalidate("issues");
    void invalidate("branches");
  };
  const lock = useMutation({
    mutationFn: () =>
      api.issues.lock({
        params: { ...repo, number },
        payload: { reason: reason === "" ? null : reason },
      }),
    onSuccess: done,
  });
  const unlock = useMutation({
    mutationFn: () => api.issues.unlock({ params: { ...repo, number } }),
    onSuccess: done,
  });
  return (
    <section className="py-3">
      <button
        type="button"
        disabled={unlock.isPending}
        onClick={() => (locked ? unlock.mutate() : setOpen(true))}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-on-surface-secondary hover:text-on-surface disabled:opacity-60"
      >
        <Icon name={locked ? "unlock" : "lock"} size={13} />
        {locked ? "Unlock conversation" : "Lock conversation"}
      </button>
      <InlineError error={unlock.error} />
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Lock conversation"
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" busy={lock.isPending} onClick={() => lock.mutate()}>
              Lock
            </Button>
          </>
        }
      >
        <Field label="Reason" optional>
          {(control) => (
            <Select
              {...control}
              value={reason}
              onChange={(event) => setReason(event.target.value as LockReason | "")}
            >
              <option value="">No reason</option>
              {LOCK_REASONS.map((item) => (
                <option key={item} value={item}>
                  {item[0]!.toUpperCase() + item.slice(1)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <InlineError error={lock.error} />
      </Dialog>
    </section>
  );
}
