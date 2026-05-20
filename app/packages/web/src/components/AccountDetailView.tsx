import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ResourcePill,
  ConfirmDeleteModal,
  dispatchResourcesChanged,
  AccountResourceSections,
  type DraggableResource,
  type SectionCategoryState,
  useUIStore,
  formatErrorMessage,
  toast,
} from "@infrawrench/ui";
import { apiDelete, apiPatch } from "@/lib/api";
import { useOrgId } from "@/lib/useOrgId";
import { CreateResourceModal } from "./CreateResourceModal";

export interface ResourceTypeInfo {
  id: string;
  displayName: string;
  pluralDisplayName: string;
  parentTypeId: string | undefined;
  supportsCreate: boolean;
  attachTargets?: import("@infrawrench/plugin-base").AttachTarget[];
}

interface Resource {
  id: string;
  pluginId: string;
  resourceTypeId: string;
  displayName: string;
  externalId: string | null;
  fieldsJson: Record<string, unknown> | null;
  outputsJson: Record<string, unknown> | null;
  parentResourceId: string | null;
}

export type CategoryState = SectionCategoryState<ResourceTypeInfo, Resource>;

interface Props {
  account: { id: string; pluginId: string; displayName: string };
  categories: CategoryState[];
  pluginDisplayName: string;
  pluginLogoSvg: string;
  searchQuery?: string;
  onSearchQueryChange?: (query: string) => void;
  activeSectionId?: string | null;
  onActiveSectionIdChange?: (id: string | null) => void;
  onAccountUpdated?: (displayName: string) => void;
}

export function AccountDetailView({
  account,
  categories,
  pluginDisplayName,
  pluginLogoSvg,
  searchQuery,
  onSearchQueryChange,
  activeSectionId,
  onActiveSectionIdChange,
  onAccountUpdated,
}: Props) {
  const navigate = useNavigate();
  const orgId = useOrgId();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [createTarget, setCreateTarget] = useState<ResourceTypeInfo | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(account.displayName);
  const [isSaving, setIsSaving] = useState(false);

  async function handleDeleteAccount() {
    await apiDelete(`/api/org/${orgId}/accounts/${account.id}`);
    useUIStore.getState().bumpAccounts();
    dispatchResourcesChanged();
    void navigate({ to: "/org/$orgId", params: { orgId } });
  }

  async function handleRename() {
    if (!editName.trim() || editName === account.displayName) {
      setIsEditing(false);
      return;
    }
    setIsSaving(true);
    try {
      const result = await apiPatch<{ id: string; displayName: string }>(
        `/api/org/${orgId}/accounts/${account.id}`,
        { displayName: editName.trim() },
      );
      useUIStore.getState().bumpAccounts();
      onAccountUpdated?.(result.displayName);
      setIsEditing(false);
    } catch (e) {
      toast.error(`Couldn't rename account: ${formatErrorMessage(e)}`);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        {pluginLogoSvg && (
          <div
            className="w-8 h-8 flex-shrink-0"
            aria-hidden="true"
            dangerouslySetInnerHTML={{ __html: pluginLogoSvg }}
          />
        )}
        <div className="flex-1">
          {isEditing ? (
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleRename();
                  if (e.key === "Escape") {
                    setEditName(account.displayName);
                    setIsEditing(false);
                  }
                }}
                className="px-2 py-1 text-lg font-semibold bg-transparent border border-border rounded focus:outline-none focus:border-accent"
                autoFocus
                disabled={isSaving}
              />
              <button
                onClick={handleRename}
                disabled={isSaving}
                className="px-2 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
              >
                Save
              </button>
              <button
                onClick={() => {
                  setEditName(account.displayName);
                  setIsEditing(false);
                }}
                disabled={isSaving}
                className="px-2 py-1 text-xs text-on-surface-muted hover:text-on-surface hover:bg-surface-overlay rounded"
              >
                Cancel
              </button>
            </div>
          ) : (
            <h1 className="text-xl font-semibold">{account.displayName}</h1>
          )}
          <p className="text-xs text-on-surface-muted">{pluginDisplayName}</p>
        </div>
        <div className="flex items-center gap-1">
          {!isEditing && (
            <button
              onClick={() => setIsEditing(true)}
              className="px-3 py-1.5 text-xs text-on-surface-muted hover:text-on-surface hover:bg-surface-overlay rounded transition-colors"
            >
              Rename
            </button>
          )}
          <button
            onClick={() => setConfirmDelete(true)}
            className="px-3 py-1.5 text-xs text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-100 dark:hover:bg-red-950/50 rounded transition-colors"
          >
            Delete
          </button>
        </div>
      </div>

      {confirmDelete && (
        <ConfirmDeleteModal
          kind="account"
          name={account.displayName}
          onConfirm={handleDeleteAccount}
          onClose={() => setConfirmDelete(false)}
        />
      )}

      <AccountResourceSections
        categories={categories}
        searchQuery={searchQuery}
        onSearchQueryChange={onSearchQueryChange}
        activeSectionId={activeSectionId}
        onActiveSectionIdChange={onActiveSectionIdChange}
        renderResource={(resource, activeCategory) => {
          const fields = resource.fieldsJson ?? {};
          const subtitle = String(fields["host"] ?? fields["region"] ?? fields["engine"] ?? "");
          const draggable: DraggableResource = {
            id: resource.id,
            pluginId: resource.pluginId,
            resourceTypeId: resource.resourceTypeId,
            accountId: account.id,
            displayName: resource.displayName,
            fields,
            ...(resource.externalId != null ? { externalId: resource.externalId } : {}),
            ...(activeCategory.typeDef.attachTargets
              ? { attachTargets: activeCategory.typeDef.attachTargets }
              : {}),
          };
          return (
            <ResourcePill
              key={resource.id}
              resource={draggable}
              subtitle={subtitle || undefined}
              onOpen={() =>
                void navigate({
                  to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
                  params: {
                    orgId,
                    pluginId: resource.pluginId,
                    resourceTypeId: resource.resourceTypeId,
                    resourceId: resource.id,
                  },
                })
              }
            />
          );
        }}
        renderCreateButton={(typeDef) => (
          <button
            key={`create-${typeDef.id}`}
            onClick={() => setCreateTarget(typeDef)}
            className="flex items-center gap-1.5 pl-3 pr-3 py-1.5 rounded-full border border-dashed border-border-strong text-on-surface-faint hover:border-blue-600 hover:text-accent transition-colors text-sm"
          >
            <span className="text-base leading-none">+</span>
            <span>Create {typeDef.displayName}</span>
          </button>
        )}
      />

      {createTarget && (
        <CreateResourceModal
          accountId={account.id}
          pluginId={account.pluginId}
          resourceTypeId={createTarget.id}
          resourceTypeDisplayName={createTarget.displayName}
          onClose={() => setCreateTarget(null)}
          onCreated={(resource) => {
            setCreateTarget(null);
            dispatchResourcesChanged({ accountId: account.id, resourceTypeId: createTarget.id });
            void navigate({
              to: "/org/$orgId/resources/$pluginId/$resourceTypeId/$resourceId",
              params: {
                orgId,
                pluginId: account.pluginId,
                resourceTypeId: createTarget.id,
                resourceId: resource.id,
              },
              search: { accountId: account.id },
            });
          }}
        />
      )}
    </div>
  );
}
