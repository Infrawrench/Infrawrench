import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { COLLABORATOR_ROLES, type CollaboratorRole, type UserRef } from "@infrawrench/git-contract";
import { api } from "../../api/client";
import { invalidate, queries } from "../../api/queries";
import { Badge } from "../../components/Badge";
import { Button, buttonClass } from "../../components/Button";
import { ConfirmDialog } from "../../components/controls";
import { Select } from "../../components/forms";
import { Icon } from "../../components/icons";
import { Panel, Table, Td, Th, Tr } from "../../components/Panel";
import { Avatar, RelativeTime, UserLink } from "../../components/people";
import { Picker } from "../../components/Picker";
import { SettingsSection } from "../../components/SideNav";
import { EmptyState, InlineError, QueryView } from "../../components/states";
import { useRepoRef, useRepository } from "../../layout/RepoLayout";
import type { Collaborator } from "@infrawrench/git-contract";

const ROLE_LABEL: Record<CollaboratorRole, string> = {
  read: "Read",
  triage: "Triage",
  write: "Write",
  admin: "Admin",
};

function RoleSelect({
  value,
  onChange,
  label,
  disabled = false,
}: {
  value: CollaboratorRole;
  onChange: (role: CollaboratorRole) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Select
      aria-label={label}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value as CollaboratorRole)}
      className="!w-auto"
    >
      {COLLABORATOR_ROLES.map((role) => (
        <option key={role} value={role}>
          {ROLE_LABEL[role]}
        </option>
      ))}
    </Select>
  );
}

function AddCollaborator({ existing }: { existing: ReadonlyArray<string> }) {
  const repo = useRepoRef();
  const [words, setWords] = useState("");
  const [user, setUser] = useState<UserRef | null>(null);
  const [role, setRole] = useState<CollaboratorRole>("write");
  const search = useQuery({
    ...queries.namespaces.searchUsers({
      query: { q: words, repository: `${repo.owner}/${repo.repo}` },
    }),
    enabled: words.trim().length > 0,
    placeholderData: (previous) => previous,
  });
  const found = (search.data?.users ?? []).filter(
    (item) => item.username !== null && !existing.includes(item.id),
  );
  const add = useMutation({
    mutationFn: () =>
      api.collaborators.set({
        params: { ...repo, username: user?.username ?? "" },
        payload: { role },
      }),
    onSuccess: () => {
      setUser(null);
      void invalidate("collaborators");
    },
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Picker
        label="People"
        options={
          words.trim() === ""
            ? []
            : found.map((item) => ({
                value: item.id,
                label: item.username!,
                detail: item.displayName,
                leading: (
                  <Avatar
                    name={item.displayName ?? item.username!}
                    src={item.avatarUrl}
                    size={16}
                  />
                ),
              }))
        }
        selected={user === null ? [] : [user.id]}
        onChange={([id]) => setUser(found.find((item) => item.id === id) ?? null)}
        onFilter={setWords}
        loading={search.isFetching}
        emptyText={words.trim() === "" ? "Type a username" : "Nobody by that name"}
        trigger={({ props }) => (
          <button
            {...props}
            type="button"
            aria-haspopup="listbox"
            className={buttonClass("secondary", "md", "min-w-44 justify-between")}
          >
            <span className="inline-flex items-center gap-1.5">
              <Icon name="user" size={12} />
              {user?.username ?? "Find a person"}
            </span>
            <Icon name="chevronDown" size={12} />
          </button>
        )}
      />
      <RoleSelect value={role} onChange={setRole} label="Role for the new collaborator" />
      <Button
        variant="primary"
        busy={add.isPending}
        disabled={user === null}
        onClick={() => add.mutate()}
      >
        Add collaborator
      </Button>
      <InlineError error={add.error} />
    </div>
  );
}

export function CollaboratorsPage() {
  const repo = useRepoRef();
  const repository = useRepository();
  const access = useQuery(queries.collaborators.list({ params: repo }));
  const namespace = useQuery({
    ...queries.namespaces.get({ params: { namespace: repo.owner } }),
    enabled: repository.owner.kind === "org",
  });
  const [removing, setRemoving] = useState<Collaborator | null>(null);
  const change = useMutation({
    mutationFn: ({ username, role }: { username: string; role: CollaboratorRole }) =>
      api.collaborators.set({ params: { ...repo, username }, payload: { role } }),
    onSuccess: () => void invalidate("collaborators"),
  });
  const remove = useMutation({
    mutationFn: (username: string) => api.collaborators.remove({ params: { ...repo, username } }),
    onSuccess: () => {
      setRemoving(null);
      void invalidate("collaborators");
    },
  });

  return (
    <QueryView query={access}>
      {({ collaborators, organization }) => (
        <>
          <SettingsSection title="Collaborators">
            {repository.archived ? null : (
              <AddCollaborator
                existing={[
                  ...collaborators.map((item) => item.user.id),
                  ...organization.map((item) => item.user.id),
                ]}
              />
            )}
            <Panel>
              {collaborators.length === 0 ? (
                <EmptyState>No collaborators</EmptyState>
              ) : (
                <Table caption="Collaborators">
                  <thead>
                    <tr>
                      <Th>Person</Th>
                      <Th>Role</Th>
                      <Th>Added</Th>
                      <Th>
                        <span className="sr-only">Actions</span>
                      </Th>
                    </tr>
                  </thead>
                  <tbody>
                    {collaborators.map((item) => (
                      <Tr key={item.user.id}>
                        <Td>
                          <UserLink user={item.user} avatar />
                          {item.user.displayName !== null ? (
                            <span className="ml-2 text-on-surface-muted">
                              {item.user.displayName}
                            </span>
                          ) : null}
                        </Td>
                        <Td>
                          <RoleSelect
                            value={item.role}
                            label={`Role of ${item.user.username ?? "this person"}`}
                            disabled={change.isPending || repository.archived}
                            onChange={(role) =>
                              change.mutate({ username: item.user.username ?? "", role })
                            }
                          />
                        </Td>
                        <Td className="text-on-surface-muted">
                          <RelativeTime iso={item.createdAt} />
                          {item.addedBy?.username ? ` by ${item.addedBy.username}` : ""}
                        </Td>
                        <Td className="w-px text-right">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={repository.archived}
                            aria-label={`Remove ${item.user.username ?? "collaborator"}`}
                            onClick={() => setRemoving(item)}
                          >
                            Remove
                          </Button>
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              )}
            </Panel>
            <InlineError error={change.error} />
          </SettingsSection>

          {repository.owner.kind === "org" ? (
            <SettingsSection
              title={`${repository.owner.displayName ?? repository.owner.slug} members`}
              actions={
                namespace.data?.appUrl ? (
                  <a
                    href={namespace.data.appUrl}
                    target="_blank"
                    rel="noreferrer"
                    className={buttonClass("secondary", "sm")}
                  >
                    Manage in Infrawrench
                    <Icon name="externalLink" size={11} />
                  </a>
                ) : undefined
              }
            >
              <Panel>
                {organization.length === 0 ? (
                  <EmptyState>No members reach this repository</EmptyState>
                ) : (
                  <Table caption="Organisation members with access">
                    <thead>
                      <tr>
                        <Th>Person</Th>
                        <Th>Access</Th>
                        <Th>Role in the organisation</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {organization.map((item) => (
                        <Tr key={item.user.id}>
                          <Td>
                            <UserLink user={item.user} avatar />
                            {item.user.username !== null && item.user.displayName !== null ? (
                              <span className="ml-2 text-on-surface-muted">
                                {item.user.displayName}
                              </span>
                            ) : null}
                          </Td>
                          <Td>
                            <Badge tone="outline">{ROLE_LABEL[item.access]}</Badge>
                          </Td>
                          <Td className="text-on-surface-muted">{item.roleName ?? ""}</Td>
                        </Tr>
                      ))}
                    </tbody>
                  </Table>
                )}
              </Panel>
            </SettingsSection>
          ) : null}

          <ConfirmDialog
            open={removing !== null}
            onClose={() => setRemoving(null)}
            title="Remove collaborator"
            confirmLabel="Remove"
            busy={remove.isPending}
            onConfirm={() => removing && remove.mutate(removing.user.username ?? "")}
          >
            <p>
              <span className="font-medium">{removing?.user.username}</span> loses the access this
              gave them.
            </p>
            <InlineError error={remove.error} />
          </ConfirmDialog>
        </>
      )}
    </QueryView>
  );
}
