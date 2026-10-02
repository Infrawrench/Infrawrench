import { Alert, Modal, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import type {
  CreateFieldConfig,
  SshInstallAccount,
  SshInstallInput,
  SshInstallResult,
} from "@infrawrench/plugin-base";
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
  const query = useQuery({
    queryKey: ["ssh-install-accounts", orgId, nativeConnection],
    queryFn: async () => {
      const [accounts, keys] = await Promise.all([
        api.org<SshInstallAccount[]>(orgId, "/resources/ssh-install/accounts"),
        nativeConnection
          ? Promise.resolve([])
          : api.org<Array<{ id: string; name: string }>>(orgId, "/ssh-keys"),
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
                "Add a Tailscale account on web or desktop first, then return here to enroll this server."}
            </Text>
          )}
          {query.isError && <Button label="Retry" onPress={() => void query.refetch()} />}
          <Button label="Close" onPress={onClose} />
        </View>
      </Modal>
    );
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
            defaultValue: defaultUsername || "root",
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
            options: query.data.keys.map((key) => ({ id: key.id, label: key.name })),
          },
        ]
      : []),
  ];
  return (
    <PromptCommandSheet
      visible
      title="Install service on server"
      description="Installs Tailscale over SSH and joins your tailnet. Requires Linux, root or passwordless sudo, and outbound HTTPS. Device approval may be required. Existing SSH and DNS settings are preserved."
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
        onClose();
        Alert.alert(
          "Installation complete",
          [
            result.message,
            result.address,
            ...(result.warnings ?? []),
            "Refresh the service account to see its devices.",
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
      }}
    />
  );
}
