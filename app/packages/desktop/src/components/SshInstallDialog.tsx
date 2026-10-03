import { useGT } from "gt-react";
import { useEffect, useState } from "react";
import {
  SshInstallModal,
  SshInstallConnectionFields,
  SshInstallKeyField,
  deriveSSHUsername,
  pickQuickConnectKeyId,
  useUIStore,
} from "@infrawrench/ui";
import type {
  SshInstallAccount,
  SshInstallInput,
  SshInstallResult,
} from "@infrawrench/plugin-base";
import { invoke } from "../lib/invoke";
import { listLocalSshInstallAccounts, runLocalSshInstall } from "../lib/ssh-install";
import { SshKeyPicker } from "./SshKeyPicker";

interface CloudSshKey {
  id: string;
  name: string;
  ownerName?: string;
}

export function SshInstallDialog({
  target,
  hostName,
  defaultUsername,
  nativeConnection,
  onClose,
}: {
  target: SshInstallInput["target"];
  hostName: string;
  defaultUsername?: string | undefined;
  nativeConnection: boolean;
  onClose(): void;
}) {
  const gt = useGT();
  const loadErrorMessage = gt("Could not load service accounts");
  const orgId = useUIStore((s) => s.activeCloudOrgId);
  const [accounts, setAccounts] = useState<SshInstallAccount[]>([]);
  const [keys, setKeys] = useState<CloudSshKey[]>([]);
  const [keyId, setKeyId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [username, setUsername] = useState(defaultUsername || "root");
  const [port, setPort] = useState(22);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      orgId
        ? invoke<SshInstallAccount[]>("cloud_ssh_install_accounts", { orgId })
        : listLocalSshInstallAccounts(),
      orgId && !nativeConnection
        ? invoke<CloudSshKey[]>("cloud_list_ssh_keys", { orgId })
        : Promise.resolve([]),
    ])
      .then(([a, k]) => {
        if (!cancelled) {
          setAccounts(a);
          setKeys(k);
          // Same defaults as SSH quick connect: a key matching the login, else
          // the first, and the key owner's name as the login when none is declared.
          const picked = pickQuickConnectKeyId({
            keys: k,
            previousId: null,
            effectiveUsername: defaultUsername || "root",
          });
          setKeyId(picked ?? "");
          const owner = k.find((key) => key.id === picked)?.ownerName;
          if (!defaultUsername && owner) setUsername(deriveSSHUsername(owner));
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : loadErrorMessage);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, nativeConnection, loadErrorMessage, defaultUsername]);
  return (
    <SshInstallModal
      hostName={hostName}
      accounts={accounts}
      loading={loading}
      loadError={error}
      ready={
        nativeConnection ||
        (!!(orgId ? keyId : privateKey) &&
          !!username.trim() &&
          Number.isInteger(port) &&
          port > 0 &&
          port <= 65535)
      }
      connectionForm={
        nativeConnection ? (
          <p className="text-xs text-on-surface-muted">
            {gt("Uses this SSH account's saved connection and key.")}
          </p>
        ) : (
          <SshInstallConnectionFields
            showUsername={!!orgId}
            username={username}
            port={port}
            onUsernameChange={setUsername}
            onPortChange={setPort}
          >
            {orgId ? (
              <SshInstallKeyField
                keys={keys}
                selectedId={keyId}
                onChange={(next) => {
                  setKeyId(next);
                  const owner = keys.find((k) => k.id === next)?.ownerName;
                  if (!defaultUsername && owner) setUsername(deriveSSHUsername(owner));
                }}
              />
            ) : (
              <SshKeyPicker
                username={username}
                onUsernameChange={setUsername}
                onKeyResolved={setPrivateKey}
              />
            )}
          </SshInstallConnectionFields>
        )
      }
      onRun={(installerAccountId) => {
        const body: SshInstallInput = {
          installerAccountId,
          target,
          ...(!nativeConnection
            ? { username: username.trim(), port, ...(keyId ? { sshKeyId: keyId } : {}) }
            : {}),
        };
        return orgId
          ? invoke<SshInstallResult>("cloud_ssh_install", { orgId, body })
          : runLocalSshInstall(body, privateKey);
      }}
      onClose={onClose}
    />
  );
}
