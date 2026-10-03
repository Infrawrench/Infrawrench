import { Alert, Modal, Text, View } from "react-native";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CreateFieldConfig,
  SshInstallAccount,
  SshInstallInput,
  SshInstallResult,
} from "@infrawrench/plugin-base";
import { deriveSSHUsername, pickQuickConnectKeyId, type SshKey } from "@infrawrench/client-core";
import { useOrgApi } from "@/lib/auth/AuthProvider";
import { PromptCommandSheet } from "@/components/PromptCommandSheet";
import { Button, LoadingView } from "@/components/ui";
import { colors } from "@/lib/theme";

export function SshInstallSheet({
  target,
  nativeConnection,
  defaultUsername,
  onClose,
}: {
  target: SshInstallInput["target"];
  nativeConnection: boolean;
  defaultUsername?: string | null | undefined;
  onClose(): void;
}) {
  const { api, orgId } = useOrgApi();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["ssh-install-accounts", orgId, nativeConnection],
    queryFn: async () => {
      const [accounts, keys] = await Promise.all([
        api.org<SshInstallAccount[]>(orgId, "/resources/ssh-install/accounts"),
        nativeConnection ? Promise.resolve([]) : api.org<SshKey[]>(orgId, "/ssh-keys"),
      ]);
      return { accounts: accounts ?? [], keys: keys ?? [] };
    },
  });
  if (!query.data || query.data.accounts.length === 0)
    return (
      <Modal visible onRequestClose={onClose} presentationStyle="pageSheet">
        <View style={{ flex: 1, backgroundColor: colors.background, padding: 24, gap: 16 }}>
          {query.isPending ? (
            <LoadingView />
          ) : (
            <Text style={{ color: colors.text }}>
              {query.error?.message ||
                "None of your accounts can install a service over SSH yet. Add one on web or desktop, then return here."}
            </Text>
          )}
          {query.isError && <Button label="Retry" onPress={() => void query.refetch()} />}
          <Button label="Close" onPress={onClose} />
        </View>
      </Modal>
    );
  // Same defaults as SSH quick connect: a key matching the login, else the first,
  // and a username derived from the key's owner when the resource names none.
  const keys = query.data.keys;
  const username = defaultUsername || "root";
  const defaultKeyId = pickQuickConnectKeyId({
    keys,
    previousId: null,
    effectiveUsername: username,
  });
  const defaultKeyOwner = keys.find((k) => k.id === defaultKeyId)?.ownerName;
  const suggestedUsername =
    !defaultUsername && defaultKeyOwner ? deriveSSHUsername(defaultKeyOwner) : username;
  const fields: CreateFieldConfig[] = [
    {
      key: "installerAccountId",
      label: "Service account",
      kind: "select",
      required: true,
      defaultValue: query.data.accounts[0]!.accountId,
      options: query.data.accounts.map((a) => ({
        id: a.accountId,
        label: `${a.serviceName}: ${a.displayName}`,
      })),
    },
    ...(!nativeConnection
      ? [
          {
            key: "username",
            label: "SSH username",
            kind: "text" as const,
            required: true,
            defaultValue: suggestedUsername,
          },
          {
            key: "port",
            label: "SSH port",
            kind: "number" as const,
            required: true,
            defaultValue: "22",
          },
          {
            key: "sshKeyId",
            label: "SSH key",
            kind: "select" as const,
            required: true,
            ...(defaultKeyId ? { defaultValue: defaultKeyId } : {}),
            options: keys.map((key) => ({
              id: key.id,
              label: key.name,
              description: [key.ownerName, key.keyType].filter(Boolean).join(" · "),
            })),
          },
        ]
      : []),
  ];
  return (
    <PromptCommandSheet
      visible
      title="Install service on server"
      // Each installer describes itself; with several, the choice is made in the picker.
      description={
        query.data.accounts.length === 1
          ? query.data.accounts[0]!.description
          : "Installs the selected account's service on this server over SSH."
      }
      fields={fields}
      submitLabel="Install and connect"
      onCancel={onClose}
      onSubmit={async (values) => {
        const result = await api.org<SshInstallResult>(orgId, "/resources/ssh-install", {
          method: "POST",
          body: JSON.stringify({
            installerAccountId: values.installerAccountId,
            target,
            ...(!nativeConnection
              ? {
                  sshKeyId: values.sshKeyId,
                  username: values.username?.trim(),
                  port: Number(values.port),
                }
              : {}),
          }),
        });
        if (!result) throw new Error("Installation returned no result.");
        // The server re-synced the account after installing; drop the cached
        // listing so the new device shows without pulling to refresh.
        const installerAccountId = String(values.installerAccountId);
        void queryClient.invalidateQueries({
          queryKey: ["account-resources", orgId, installerAccountId],
        });
        const accountName = query.data.accounts.find(
          (a) => a.accountId === installerAccountId,
        )?.displayName;
        onClose();
        Alert.alert(
          "Installation complete",
          [
            result.message,
            result.address,
            ...(result.warnings ?? []),
            accountName ? `${accountName} has been refreshed to include this server.` : "",
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
      }}
    />
  );
}
