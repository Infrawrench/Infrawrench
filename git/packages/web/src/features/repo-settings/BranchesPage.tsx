import { useState, type FormEvent } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { Badge } from "../../components/Badge";
import { Button, buttonClass } from "../../components/Button";
import { ConfirmDialog } from "../../components/controls";
import { Checkbox, Field, Input } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Panel } from "../../components/Panel";
import { Avatar } from "../../components/people";
import { Picker } from "../../components/Picker";
import { SettingsSection } from "../../components/SideNav";
import { EmptyState, InlineError, QueryView } from "../../components/states";
import { useRepoRef } from "../../layout/RepoLayout";
import { plural } from "../../lib/format";
import type { ProtectedBranch } from "@infrawrench/git-contract";

interface RuleDraft {
  pattern: string;
  requirePullRequest: boolean;
  requiredApprovals: number;
  dismissStaleApprovals: boolean;
  requiredStatusContexts: string[];
  allowForcePush: boolean;
  allowDeletion: boolean;
  restrictPushers: boolean;
  pushers: string[];
  enforceAdmins: boolean;
}

const BLANK: RuleDraft = {
  pattern: "",
  requirePullRequest: true,
  requiredApprovals: 1,
  dismissStaleApprovals: false,
  requiredStatusContexts: [],
  allowForcePush: false,
  allowDeletion: false,
  restrictPushers: false,
  pushers: [],
  enforceAdmins: false,
};

const draftOf = (rule: ProtectedBranch): RuleDraft => ({
  pattern: rule.pattern,
  requirePullRequest: rule.requirePullRequest,
  requiredApprovals: rule.requiredApprovals,
  dismissStaleApprovals: rule.dismissStaleApprovals,
  requiredStatusContexts: [...rule.requiredStatusContexts],
  allowForcePush: rule.allowForcePush,
  allowDeletion: rule.allowDeletion,
  restrictPushers: rule.restrictPushers,
  pushers: rule.pushers.flatMap((user) => user.username ?? []),
  enforceAdmins: rule.enforceAdmins,
});

const pickerButton = buttonClass("secondary", "md", "justify-between");

function RuleForm({ rule, onDone }: { rule?: ProtectedBranch; onDone: () => void }) {
  const repo = useRepoRef();
  const [draft, setDraft] = useState<RuleDraft>(() => (rule ? draftOf(rule) : BLANK));
  const set = <K extends keyof RuleDraft>(key: K, value: RuleDraft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const contexts = useQuery(queries.protectedBranches.statusContexts({ params: repo }));
  const people = useQuery(queries.collaborators.listAssignable({ params: repo }));
  const save = useMutation({
    mutationFn: () => {
      const payload = { ...draft, pattern: draft.pattern.trim() };
      return rule
        ? api.protectedBranches.update({ params: { ...repo, ruleId: rule.id }, payload })
        : api.protectedBranches.create({ params: repo, payload });
    },
    onSuccess: () => {
      void invalidate("protectedBranches");
      void invalidate("pulls");
      onDone();
    },
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (draft.pattern.trim() !== "") save.mutate();
  };
  // A context a rule already requires stays pickable after nothing has reported it lately.
  const known = [...new Set([...(contexts.data?.contexts ?? []), ...draft.requiredStatusContexts])];

  return (
    <form onSubmit={submit} className="space-y-4 px-3 py-3">
      <Field label="Branch name pattern" hint="A name or a glob: main, release/*">
        {(control) => (
          <Input
            {...control}
            value={draft.pattern}
            required
            autoFocus={rule === undefined}
            maxLength={255}
            spellCheck={false}
            onChange={(event) => set("pattern", event.target.value)}
            className="max-w-xs font-mono"
          />
        )}
      </Field>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-semibold text-on-surface-secondary">
          Pull requests
        </legend>
        <Checkbox
          label="Changes arrive by pull request only"
          checked={draft.requirePullRequest}
          onChange={(event) => set("requirePullRequest", event.target.checked)}
        />
        <Field label="Required approvals" hint="0 to 10">
          {(control) => (
            <Input
              {...control}
              type="number"
              min={0}
              max={10}
              value={draft.requiredApprovals}
              onChange={(event) =>
                set(
                  "requiredApprovals",
                  Math.max(0, Math.min(10, Math.round(Number(event.target.value) || 0))),
                )
              }
              className="!w-20"
            />
          )}
        </Field>
        <Checkbox
          label="A push dismisses approvals of the older commits"
          checked={draft.dismissStaleApprovals}
          disabled={draft.requiredApprovals === 0}
          onChange={(event) => set("dismissStaleApprovals", event.target.checked)}
        />
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-semibold text-on-surface-secondary">
          Required checks
        </legend>
        <Picker
          label="Checks"
          multiple
          options={known.map((context) => ({ value: context, label: context }))}
          selected={draft.requiredStatusContexts}
          onChange={(next) => set("requiredStatusContexts", next)}
          loading={contexts.isLoading}
          emptyText="No checks have reported on recent commits"
          trigger={({ props }) => (
            <button {...props} type="button" aria-haspopup="listbox" className={pickerButton}>
              {draft.requiredStatusContexts.length === 0
                ? "Choose checks"
                : plural(draft.requiredStatusContexts.length, "check")}
              <Icon name="chevronDown" size={12} />
            </button>
          )}
        />
        {draft.requiredStatusContexts.length > 0 ? (
          <ul className="flex flex-wrap gap-1">
            {draft.requiredStatusContexts.map((context) => (
              <li key={context}>
                <Badge tone="outline">
                  {context}
                  <button
                    type="button"
                    aria-label={`Stop requiring ${context}`}
                    onClick={() =>
                      set(
                        "requiredStatusContexts",
                        draft.requiredStatusContexts.filter((item) => item !== context),
                      )
                    }
                    className="hover:text-on-surface"
                  >
                    <Icon name="x" size={10} />
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </fieldset>

      <fieldset className="space-y-2">
        <legend className="mb-1 text-xs font-semibold text-on-surface-secondary">Pushes</legend>
        <Checkbox
          label="Allow force pushes"
          checked={draft.allowForcePush}
          onChange={(event) => set("allowForcePush", event.target.checked)}
        />
        <Checkbox
          label="Allow deleting the branch"
          checked={draft.allowDeletion}
          onChange={(event) => set("allowDeletion", event.target.checked)}
        />
        <Checkbox
          label="Only chosen people may push or merge"
          checked={draft.restrictPushers}
          onChange={(event) => set("restrictPushers", event.target.checked)}
        />
        {draft.restrictPushers ? (
          <Picker
            label="People"
            multiple
            options={(people.data?.users ?? []).flatMap((user) =>
              user.username === null
                ? []
                : [
                    {
                      value: user.username,
                      label: user.username,
                      detail: user.displayName,
                      leading: (
                        <Avatar
                          name={user.displayName ?? user.username}
                          src={user.avatarUrl}
                          size={16}
                        />
                      ),
                    },
                  ],
            )}
            selected={draft.pushers}
            onChange={(next) => set("pushers", next)}
            loading={people.isLoading}
            trigger={({ props }) => (
              <button {...props} type="button" aria-haspopup="listbox" className={pickerButton}>
                {draft.pushers.length === 0 ? "Choose people" : draft.pushers.join(", ")}
                <Icon name="chevronDown" size={12} />
              </button>
            )}
          />
        ) : null}
        <Checkbox
          label="Administrators are bound by this rule too"
          checked={draft.enforceAdmins}
          onChange={(event) => set("enforceAdmins", event.target.checked)}
        />
      </fieldset>

      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <InlineError error={save.error} />
        <Button onClick={onDone}>Cancel</Button>
        <Button
          type="submit"
          variant="primary"
          busy={save.isPending}
          disabled={draft.pattern.trim() === ""}
        >
          {rule ? "Save rule" : "Add rule"}
        </Button>
      </div>
    </form>
  );
}

/** A rule as one line of what it asks for. */
function summary(rule: ProtectedBranch): string[] {
  const parts: string[] = [];
  if (rule.requirePullRequest) parts.push("Pull request required");
  if (rule.requiredApprovals > 0) parts.push(plural(rule.requiredApprovals, "approval"));
  if (rule.requiredStatusContexts.length > 0) {
    parts.push(plural(rule.requiredStatusContexts.length, "required check"));
  }
  parts.push(rule.allowForcePush ? "Force pushes allowed" : "No force pushes");
  if (rule.allowDeletion) parts.push("Deletion allowed");
  if (rule.restrictPushers)
    parts.push(`${plural(rule.pushers.length, "person", "people")} may push`);
  if (rule.enforceAdmins) parts.push("Binds administrators");
  return parts;
}

export function BranchesPage() {
  const repo = useRepoRef();
  const rules = useQuery(queries.protectedBranches.list({ params: repo }));
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<ProtectedBranch | null>(null);
  const remove = useMutation({
    mutationFn: (rule: ProtectedBranch) =>
      api.protectedBranches.delete({ params: { ...repo, ruleId: rule.id } }),
    onSuccess: () => {
      setRemoving(null);
      void invalidate("protectedBranches");
      void invalidate("pulls");
    },
  });
  return (
    <SettingsSection
      title="Protected branches"
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          Add rule
        </Button>
      }
    >
      {creating ? (
        <Panel className="overflow-visible">
          <RuleForm onDone={() => setCreating(false)} />
        </Panel>
      ) : null}
      <QueryView query={rules}>
        {({ rules: items }) => (
          <Panel className="overflow-visible">
            {items.length === 0 ? (
              <EmptyState action={<Button onClick={() => setCreating(true)}>Add rule</Button>}>
                No branches are protected
              </EmptyState>
            ) : (
              <ul>
                {items.map((rule) =>
                  editing === rule.id ? (
                    <li key={rule.id} className="border-t border-border first:border-t-0">
                      <RuleForm rule={rule} onDone={() => setEditing(null)} />
                    </li>
                  ) : (
                    <li
                      key={rule.id}
                      className="flex flex-wrap items-start gap-3 border-t border-border px-3 py-2.5 first:border-t-0"
                    >
                      <Icon name="shield" size={14} className="mt-0.5 text-on-surface-muted" />
                      <div className="min-w-0 flex-1 space-y-1">
                        <p className="font-mono text-sm font-medium text-on-surface">
                          {rule.pattern}
                        </p>
                        <p className="text-xs text-on-surface-muted">{summary(rule).join(" · ")}</p>
                        {rule.requiredStatusContexts.length > 0 ? (
                          <ul className="flex flex-wrap gap-1" aria-label="Required checks">
                            {rule.requiredStatusContexts.map((context) => (
                              <li key={context}>
                                <Badge tone="outline">{context}</Badge>
                              </li>
                            ))}
                          </ul>
                        ) : null}
                        <p className="text-xs text-on-surface-muted">
                          {rule.matchingBranches.length === 0
                            ? "Matches no branch yet"
                            : `Matches ${rule.matchingBranches.join(", ")}`}
                        </p>
                      </div>
                      <span className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(rule.id)}>
                          Edit
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setRemoving(rule)}>
                          Delete
                        </Button>
                      </span>
                    </li>
                  ),
                )}
              </ul>
            )}
          </Panel>
        )}
      </QueryView>
      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Delete rule"
        confirmLabel="Delete"
        busy={remove.isPending}
        onConfirm={() => removing && remove.mutate(removing)}
      >
        <p>
          Branches matching <span className="font-mono">{removing?.pattern}</span> are no longer
          protected.
        </p>
        <InlineError error={remove.error} />
      </ConfirmDialog>
    </SettingsSection>
  );
}
