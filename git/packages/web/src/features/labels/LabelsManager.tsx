import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Label } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { AppLink } from "../../components/AppLink";
import { Button } from "../../components/Button";
import { ConfirmDialog } from "../../components/controls";
import { Field, Input, SearchInput } from "../../components/forms";
import { Icon } from "../../components/icons";
import { LabelChip } from "../../components/LabelChip";
import { Panel, PanelHeader } from "../../components/Panel";
import { EmptyState, InlineError, QueryView } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import { plural } from "../../lib/format";
import { threadSearchHref } from "../issues/ThreadList";

const SWATCHES = ["b3261e", "8a6100", "3a7d1e", "0a6b5c", "1d6fa5", "5b5f97", "8f1a9b", "6b6b73"];
const HEX = /^[0-9a-fA-F]{6}$/;

function LabelForm({
  label,
  onDone,
}: {
  /** The label being edited; omitted for a new one. */
  label?: Label;
  onDone: () => void;
}) {
  const repo = useRepoRef();
  const [name, setName] = useState(label?.name ?? "");
  const [color, setColor] = useState(label?.color ?? SWATCHES[4]!);
  const [description, setDescription] = useState(label?.description ?? "");
  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        color: color.toLowerCase(),
        description: description.trim() === "" ? null : description.trim(),
      };
      return label
        ? api.labels.update({ params: { ...repo, labelId: label.id }, payload })
        : api.labels.create({ params: repo, payload });
    },
    onSuccess: () => {
      void invalidate("labels");
      void invalidate("issues");
      void invalidate("branches");
      onDone();
    },
  });
  const valid = name.trim() !== "" && HEX.test(color);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (valid) save.mutate();
  };
  return (
    <form onSubmit={submit} className="space-y-3 px-3 py-3">
      <div>
        <LabelChip
          label={{
            name: name.trim() === "" ? "Preview" : name,
            color: HEX.test(color) ? color : "6b6b73",
            description: null,
          }}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_minmax(0,1fr)_auto]">
        <Field label="Name">
          {(control) => (
            <Input
              {...control}
              value={name}
              required
              autoFocus
              maxLength={50}
              onChange={(event) => setName(event.target.value)}
            />
          )}
        </Field>
        <Field label="Description" optional>
          {(control) => (
            <Input
              {...control}
              value={description}
              maxLength={200}
              onChange={(event) => setDescription(event.target.value)}
            />
          )}
        </Field>
        <Field label="Colour" error={HEX.test(color) ? null : "Six hex digits"}>
          {(control) => (
            <div className="flex items-center gap-1.5">
              <input
                type="color"
                aria-label="Pick a colour"
                value={`#${HEX.test(color) ? color : "6b6b73"}`}
                onChange={(event) => setColor(event.target.value.slice(1))}
                className="h-7 w-8 shrink-0 cursor-pointer rounded border border-border bg-surface p-0.5"
              />
              <Input
                {...control}
                value={color}
                maxLength={6}
                spellCheck={false}
                onChange={(event) => setColor(event.target.value.replace(/^#/, ""))}
                className="!w-20 font-mono"
              />
            </div>
          )}
        </Field>
      </div>
      <div
        className="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label="Suggested colours"
      >
        {SWATCHES.map((swatch) => (
          <button
            key={swatch}
            type="button"
            aria-label={`Use #${swatch}`}
            aria-pressed={color.toLowerCase() === swatch}
            onClick={() => setColor(swatch)}
            className="size-5 rounded-full border border-border-strong aria-pressed:ring-2 aria-pressed:ring-accent aria-pressed:ring-offset-1 aria-pressed:ring-offset-surface-raised"
            style={{ backgroundColor: `#${swatch}` }}
          />
        ))}
        <span className="flex flex-1 items-center justify-end gap-2">
          <InlineError error={save.error} />
          <Button onClick={onDone}>Cancel</Button>
          <Button type="submit" variant="primary" busy={save.isPending} disabled={!valid}>
            {label ? "Save" : "Create label"}
          </Button>
        </span>
      </div>
    </form>
  );
}

/** The repository's labels with create, edit and delete for people who may triage. */
export function LabelsManager() {
  const repo = useRepoRef();
  const repository = useRepository();
  const canEdit = repository.viewer.canTriage;
  const labels = useQuery(queries.labels.list({ params: repo }));
  const [filter, setFilter] = useState("");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Label | null>(null);
  const remove = useMutation({
    mutationFn: (label: Label) => api.labels.delete({ params: { ...repo, labelId: label.id } }),
    onSuccess: () => {
      setRemoving(null);
      void invalidate("labels");
      void invalidate("issues");
      void invalidate("branches");
    },
  });
  const words = filter.trim().toLowerCase();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          label="Filter labels"
          placeholder="Find a label"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="min-w-48 flex-1 sm:max-w-xs"
        />
        {canEdit ? (
          <Button variant="primary" className="ml-auto" onClick={() => setCreating(true)}>
            New label
          </Button>
        ) : null}
      </div>
      {creating ? (
        <Panel>
          <LabelForm onDone={() => setCreating(false)} />
        </Panel>
      ) : null}
      <QueryView query={labels}>
        {({ labels: all }) => {
          const shown = all.filter((label) =>
            `${label.name} ${label.description ?? ""}`.toLowerCase().includes(words),
          );
          return (
            <Panel>
              <PanelHeader>{plural(all.length, "label")}</PanelHeader>
              {shown.length === 0 ? (
                <EmptyState
                  action={
                    canEdit && all.length === 0 ? (
                      <Button onClick={() => setCreating(true)}>New label</Button>
                    ) : undefined
                  }
                >
                  {all.length === 0 ? "No labels yet" : "No labels match"}
                </EmptyState>
              ) : (
                <ul>
                  {shown.map((label) =>
                    editing === label.id ? (
                      <li key={label.id} className="border-t border-border first:border-t-0">
                        <LabelForm label={label} onDone={() => setEditing(null)} />
                      </li>
                    ) : (
                      <li
                        key={label.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-2 first:border-t-0"
                      >
                        <span className="w-48 shrink-0">
                          <LabelChip
                            label={label}
                            href={threadSearchHref(repo, "issues", { labels: [label.name] })}
                          />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-xs text-on-surface-muted">
                          {label.description}
                        </span>
                        <AppLink
                          href={threadSearchHref(repo, "branches", { labels: [label.name] })}
                          className="text-xs text-on-surface-muted hover:text-on-surface hover:underline"
                        >
                          Branches
                        </AppLink>
                        {canEdit ? (
                          <span className="flex items-center gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Edit ${label.name}`}
                              onClick={() => setEditing(label.id)}
                            >
                              <Icon name="pencil" size={12} />
                              Edit
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              aria-label={`Delete ${label.name}`}
                              onClick={() => setRemoving(label)}
                            >
                              <Icon name="trash" size={12} />
                              Delete
                            </Button>
                          </span>
                        ) : null}
                      </li>
                    ),
                  )}
                </ul>
              )}
            </Panel>
          );
        }}
      </QueryView>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Delete label"
        confirmLabel="Delete"
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      >
        <p>
          <span className="font-medium">{removing?.name}</span> comes off every issue and branch
          page that carries it.
        </p>
        <InlineError error={remove.error} />
      </ConfirmDialog>
    </div>
  );
}
