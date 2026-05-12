import type {
  AssociationSource,
  CredentialFormat,
  PluginClient,
  ResourceInstance,
  ResourceTypeDefinition,
} from "@infrawrench/plugin-base";
import {
  ConfirmDeleteModal,
  CredentialExportModal,
  PromptNoSqlCommandModal,
  dispatchRefreshResource,
  dispatchResourcesChanged,
  type PromptNoSqlCommandDetail,
  type ResourcePickerOption,
} from "@infrawrench/ui";
import { useNavigate } from "@tanstack/react-router";
import { SshTunnelModal } from "../../components/SshTunnelModal";
import { DockerSetupModal } from "../../components/DockerSetupModal";
import { SpotlightSearch } from "../../components/SpotlightSearch";
import { CreateResourceModal } from "../../components/CreateResourceModal";
import { exportCloudCredential } from "../../lib/cloud-api";
import {
  accountTabTarget,
  navigateToWorkspaceTarget,
  resourceTabTarget,
} from "../../lib/workspace-tabs";
import type { AccountRow } from "../../db/rows";
import type { CloudCtx } from "./-types";

interface ResourceModalsProps {
  showExportCredential: boolean;
  resource: ResourceInstance | null;
  credentialFormats: CredentialFormat[];
  accountId: string;
  decodedResourceId: string;
  onCloseExportCredential: () => void;
  getLocalClient: () => PluginClient | null;
  getCloudCtx: () => CloudCtx | null;

  confirmDelete: boolean;
  resourceTypeLabel: string;
  onCloseConfirmDelete: () => void;
  onConfirmDelete: () => void;

  promptModal: PromptNoSqlCommandDetail | null;
  onClosePromptModal: () => void;
  onSubmitPromptModal: (values: Record<string, string>) => Promise<void>;
  loadPromptResources: (
    sources: AssociationSource[],
    acctId: string,
  ) => Promise<ResourcePickerOption[]>;

  showTunnelModal: boolean;
  sshHost: string | null;
  sshDefaultUsername: string | null;
  onCloseTunnelModal: () => void;

  showDockerSetup: boolean;
  onCloseDockerSetup: () => void;

  showDropSpotlight: boolean;
  onCloseDropSpotlight: () => void;

  createChildTarget: ResourceTypeDefinition | null;
  account: AccountRow | null;
  onCloseCreateChild: () => void;
}

export function ResourceModals({
  showExportCredential,
  resource,
  credentialFormats,
  accountId,
  decodedResourceId,
  onCloseExportCredential,
  getLocalClient,
  getCloudCtx,
  confirmDelete,
  resourceTypeLabel,
  onCloseConfirmDelete,
  onConfirmDelete,
  promptModal,
  onClosePromptModal,
  onSubmitPromptModal,
  loadPromptResources,
  showTunnelModal,
  sshHost,
  sshDefaultUsername,
  onCloseTunnelModal,
  showDockerSetup,
  onCloseDockerSetup,
  showDropSpotlight,
  onCloseDropSpotlight,
  createChildTarget,
  account,
  onCloseCreateChild,
}: ResourceModalsProps) {
  const navigate = useNavigate();
  return (
    <>
      {showExportCredential && resource && credentialFormats.length > 0 && (
        <CredentialExportModal
          resourceDisplayName={resource.displayName}
          formats={credentialFormats}
          generate={async (formatId) => {
            const local = getLocalClient();
            if (local?.exportCredential) {
              return local.exportCredential(
                resource.resourceTypeId,
                resource.id,
                accountId,
                formatId,
              );
            }
            const cloud = getCloudCtx();
            if (cloud) {
              const result = (await exportCloudCredential(
                cloud.orgId,
                cloud.pluginId,
                resource.resourceTypeId,
                resource.id,
                accountId,
                formatId,
                cloud.parentResourceId,
              )) as Awaited<ReturnType<NonNullable<PluginClient["exportCredential"]>>>;
              return result;
            }
            throw new Error("No client available for credential export");
          }}
          onClose={onCloseExportCredential}
        />
      )}

      {confirmDelete && resource && (
        <ConfirmDeleteModal
          kind={resourceTypeLabel}
          name={resource.displayName}
          onConfirm={onConfirmDelete}
          onClose={onCloseConfirmDelete}
        />
      )}

      {promptModal && (
        <PromptNoSqlCommandModal
          title={promptModal.title ?? promptModal.command}
          {...(promptModal.description ? { description: promptModal.description } : {})}
          fields={promptModal.fields}
          submitLabel={promptModal.submitLabel ?? "Submit"}
          danger={!!promptModal.danger}
          resourcePickerProps={{ loadResources: loadPromptResources, accountId }}
          onCancel={onClosePromptModal}
          onSubmit={async (values) => {
            await onSubmitPromptModal(values);
            onClosePromptModal();
            dispatchRefreshResource();
          }}
        />
      )}

      {showTunnelModal && sshHost && (
        <SshTunnelModal
          sshHost={sshHost}
          {...(sshDefaultUsername ? { defaultUsername: sshDefaultUsername } : {})}
          sourceAccountId={accountId}
          onClose={onCloseTunnelModal}
          onTunnelEstablished={(newAccountId) => {
            onCloseTunnelModal();
            void navigateToWorkspaceTarget(navigate, accountTabTarget(newAccountId));
          }}
        />
      )}

      {showDockerSetup && sshHost && (
        <DockerSetupModal
          sshHost={sshHost}
          {...(sshDefaultUsername ? { defaultUsername: sshDefaultUsername } : {})}
          sourceAccountId={accountId}
          onClose={onCloseDockerSetup}
          onComplete={(newAccountId) => {
            onCloseDockerSetup();
            void navigateToWorkspaceTarget(navigate, accountTabTarget(newAccountId));
          }}
        />
      )}

      {showDropSpotlight && resource && (
        <SpotlightSearch
          mode="drop"
          onClose={onCloseDropSpotlight}
          onDrop={(source) => {
            onCloseDropSpotlight();
            window.dispatchEvent(
              new CustomEvent("iw:sidebar-secret-drop", {
                detail: { source, targetId: decodedResourceId, kind: "resource" },
              }),
            );
          }}
        />
      )}

      {createChildTarget && account && (
        <CreateResourceModal
          accountId={accountId}
          pluginId={account.plugin_id}
          resourceType={createChildTarget}
          parentResourceId={decodedResourceId}
          onClose={onCloseCreateChild}
          onCreated={(newResource) => {
            const childTypeId = createChildTarget.id;
            onCloseCreateChild();
            dispatchResourcesChanged({ accountId, resourceTypeId: childTypeId });
            void navigateToWorkspaceTarget(
              navigate,
              resourceTabTarget(accountId, newResource.id, account.plugin_id, childTypeId),
              { label: newResource.displayName },
            );
          }}
        />
      )}
    </>
  );
}
