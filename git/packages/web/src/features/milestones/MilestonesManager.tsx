import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Milestone } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Button } from "../../components/Button";
import { ConfirmDialog, Segmented } from "../../components/controls";
import { Field, Input, Textarea } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { RelativeTime } from "../../components/people";
import { EmptyState, InlineError, QueryView } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { formatDate } from "../../lib/format";
import { paths } from "../../lib/paths";

/** How far along a milestone is, as a bar and the numbers beside it. */
export function MilestoneProgress({ milestone }: { milestone: Milestone }) {
  const total = milestone.openCount + milestone.closedCount;
  const percent = total === 0 ? 0 : Math.round((milestone.closedCount / total) * 100);
  return (
    <div className="space-y-1">
      <div
        role="progressbar"
        aria-label="Closed"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="h-1.5 overflow-hidden rounded-full bg-surface-sunken"
      >
        <div className="h-full rounded-full bg-success" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-xs text-on-surface-muted">
        <span className="font-medium text-on-surface">{percent}%</span> complete ·{" "}
        {milestone.openCount} open · {milestone.closedCount} closed
      </p>
    </div>
  );
}

export function DueDate({ milestone }: { milestone: Milestone }) {
  if (milestone.state === "closed" && milestone.closedAt !== null) {
    return (
      <span>
        Closed <RelativeTime iso={milestone.closedAt} />
      </span>
    );
  }
  if (milestone.dueOn === null) return <span>No due date</span>;
  const overdue = milestone.dueOn < new Date().toISOString().slice(0, 10);
  return (
    <span className={`inline-flex items-center gap-1 ${overdue ? "text-danger" : ""}`}>
      <Icon name="clock" size={11} />
      {overdue ? "Was due" : "Due"} {formatDate(`${milestone.dueOn}T12:00:00`)}
    </span>
  );
}

export function MilestoneForm({
  milestone,
  onDone,
}: {
  milestone?: Milestone;
  onDone: () => void;
}) {
  const repo = useRepoRef();
  const [title, setTitle] = useState(milestone?.title ?? "");
  const [description, setDescription] = useState(milestone?.description ?? "");
  const [dueOn, setDueOn] = useState(milestone?.dueOn ?? "");
  const save = useMutation({
    mutationFn: () => {
      const payload = {
        title: title.trim(),
        description: description.trim() === "" ? null : description,
        dueOn: dueOn === "" ? null : dueOn,
      };
      return milestone
        ? api.milestones.update({ params: { ...repo, milestone: milestone.number }, payload })
        : api.milestones.create({ params: repo, payload });
    },
    onSuccess: () => {
      void invalidate("milestones");
      void invalidate("issues");
      void invalidate("pulls");
      onDone();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim() !== "") save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3 px-3 py-3">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_11rem]">
        <Field label="Title">
          {(control) => (
            <Input
              {...control}
              value={title}
              required
              autoFocus
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
          )}
        </Field>
        <Field label="Due date" optional>
          {(control) => (
            <Input
              {...control}
              type="date"
              value={dueOn}
              onChange={(event) => setDueOn(event.target.value)}
            />
          )}
        </Field>
      </div>
      <Field label="Description" optional>
        {(control) => (
          <Textarea
            {...control}
            rows={3}
            value={description}
            maxLength={5000}
            onChange={(event) => setDescription(event.target.value)}
          />
        )}
      </Field>
      <div className="flex items-center justify-end gap-2">
        <InlineError error={save.error} />
        <Button onClick={onDone}>Cancel</Button>
        <Button
          type="submit"
          variant="primary"
          busy={save.isPending}
          disabled={title.trim() === ""}
        >
          {milestone ? "Save" : "Create milestone"}
        </Button>
      </div>
    </form>
  );
}

/** Close or reopen, and delete: the buttons a milestone's row and page share. */
export function MilestoneActions({
  milestone,
  onEdit,
  onDeleted,
}: {
  milestone: Milestone;
  onEdit: () => void;
  onDeleted?: () => void;
}) {
  const repo = useRepoRef();
  const [confirming, setConfirming] = useState(false);
  const params = { ...repo, milestone: milestone.number };
  const refresh = () => {
    void invalidate("milestones");
    void invalidate("issues");
    void invalidate("pulls");
  };
  const toggle = useMutation({
    mutationFn: () =>
      api.milestones.update({
        params,
        payload: { state: milestone.state === "open" ? "closed" : "open" },
      }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => api.milestones.delete({ params }),
    onSuccess: () => {
      setConfirming(false);
      refresh();
      onDeleted?.();
    },
  });
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Button size="sm" variant="ghost" onClick={onEdit}>
        Edit
      </Button>
      <Button size="sm" variant="ghost" busy={toggle.isPending} onClick={() => toggle.mutate()}>
        {milestone.state === "open" ? "Close" : "Reopen"}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
        Delete
      </Button>
      <InlineError error={toggle.error} />
      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title="Delete milestone"
        confirmLabel="Delete"
        busy={remove.isPending}
        onConfirm={() => remove.mutate()}
      >
        <p>
          The issues and pull requests in <span className="font-medium">{milestone.title}</span>{" "}
          stay, without a milestone.
        </p>
        <InlineError error={remove.error} />
      </ConfirmDialog>
    </span>
  );
}

export function MilestonesManager() {
  const repo = useRepoRef();
  const repository = useRepository();
  const canEdit = repository.viewer.canTriage;
  const [state, setState] = useState<"open" | "closed">("open");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const milestones = useQuery(queries.milestones.list({ params: repo, query: { state } }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label="State"
          value={state}
          onChange={setState}
          options={[
            { value: "open", label: "Open" },
            { value: "closed", label: "Closed" },
          ]}
        />
        {canEdit ? (
          <Button variant="primary" onClick={() => setCreating(true)}>
            New milestone
          </Button>
        ) : null}
      </div>
      {creating ? (
        <Panel>
          <MilestoneForm onDone={() => setCreating(false)} />
        </Panel>
      ) : null}
      <QueryView query={milestones}>
        {({ milestones: items }) => (
          <Panel>
            {items.length === 0 ? (
              <EmptyState
                action={
                  canEdit && state === "open" ? (
                    <Button onClick={() => setCreating(true)}>New milestone</Button>
                  ) : undefined
                }
              >
                {state === "open" ? "No open milestones" : "No closed milestones"}
              </EmptyState>
            ) : (
              <ul>
                {items.map((milestone) =>
                  editing === milestone.number ? (
                    <li key={milestone.id} className="border-t border-border first:border-t-0">
                      <MilestoneForm milestone={milestone} onDone={() => setEditing(null)} />
                    </li>
                  ) : (
                    <li
                      key={milestone.id}
                      className="grid gap-x-6 gap-y-2 border-t border-border px-3 py-3 first:border-t-0 sm:grid-cols-2"
                    >
                      <div className="min-w-0 space-y-1">
                        <AppLink
                          href={paths.milestone(repo, milestone.number)}
                          className="text-sm font-semibold text-on-surface hover:underline"
                        >
                          {milestone.title}
                        </AppLink>
                        <p className="text-xs text-on-surface-muted">
                          <DueDate milestone={milestone} />
                        </p>
                        {milestone.description !== null ? (
                          <p className="text-xs text-on-surface-secondary">
                            {milestone.description}
                          </p>
                        ) : null}
                      </div>
                      <div className="space-y-1.5">
                        <MilestoneProgress milestone={milestone} />
                        {canEdit ? (
                          <MilestoneActions
                            milestone={milestone}
                            onEdit={() => setEditing(milestone.number)}
                          />
                        ) : null}
                      </div>
                    </li>
                  ),
                )}
              </ul>
            )}
          </Panel>
        )}
      </QueryView>
    </div>
  );
}
