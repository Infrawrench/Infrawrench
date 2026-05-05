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
} from "@infrawrench/ui";
import { apiDelete } from "@/lib/api";
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
  fieldsJson: unknown;
  outputsJson: unknown;
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
}: Props) {
  const navigate = useNavigate();
  const orgId = useOrgId();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [createTarget, setCreateTarget] = useState<ResourceTypeInfo | null>(null);

  async function handleDeleteAccount() {
    await apiDelete(`/api/org/${orgId}/accounts/${account.id}`);
    useUIStore.getState().bumpAccounts();
    dispatchResourcesChanged();
    void navigate({ to: "/org/$orgId", params: { orgId } });
  }

  return (
    <div className="p-6">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        {pluginLogoSvg && (
          <div
            className="w-8 h-8 flex-shrink-0"
            dangerouslySetInnerHTML={{ __html: pluginLogoSvg }}
          />
        )}
        <div className="flex-1">
          <h1 className="text-xl font-semibold">{account.displayName}</h1>
          <p className="text-xs text-on-surface-muted">{pluginDisplayName}</p>
        </div>
        <button
          onClick={() => setConfirmDelete(true)}
          className="px-3 py-1.5 text-xs text-red-500 dark:text-red-400 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-100 dark:hover:bg-red-950/50 rounded transition-colors"
        >
          Delete
        </button>
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
          const subtitle = String(
            (resource.fieldsJson as Record<string, unknown>)?.["host"] ??
              (resource.fieldsJson as Record<string, unknown>)?.["region"] ??
              (resource.fieldsJson as Record<string, unknown>)?.["engine"] ??
              "",
          );
          const draggable: DraggableResource = {
            id: resource.id,
            pluginId: resource.pluginId,
            resourceTypeId: resource.resourceTypeId,
            accountId: account.id,
            displayName: resource.displayName,
            fields: (resource.fieldsJson as Record<string, unknown>) ?? {},
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
