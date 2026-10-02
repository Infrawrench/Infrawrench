import { useGT } from "gt-react";
import { useEffect, useState } from "react";
import {
  SshInstallModal,
  SshInstallConnectionFields,
  SshInstallKeyField,
  deriveSSHUsername,
  pickQuickConnectKeyId,
} from "@infrawrench/ui";
import type {
  SshInstallAccount,
  SshInstallInput,
  SshInstallResult,
} from "@infrawrench/plugin-base";
import { apiGet, apiPost } from "@/lib/api";
import type { SshKey } from "@/lib/api-types";
import { useOrgId } from "@/lib/useOrgId";
import { useHostKeyTrust } from "@/lib/useHostKeyTrust";

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
  const orgId = useOrgId();
  const { withTrustPrompt, dialog } = useHostKeyTrust(orgId);
  const [accounts, setAccounts] = useState<SshInstallAccount[]>([]);
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [keyId, setKeyId] = useState("");
  const [username, setUsername] = useState(defaultUsername || "root");
  const [port, setPort] = useState(22);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      apiGet<SshInstallAccount[]>(`/api/org/${orgId}/resources/ssh-install/accounts`),
      nativeConnection ? Promise.resolve([]) : apiGet<SshKey[]>(`/api/org/${orgId}/ssh-keys`),
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
    <>
      <SshInstallModal
        hostName={hostName}
        accounts={accounts}
        loading={loading}
        loadError={error}
        ready={
          nativeConnection ||
          (!!keyId && !!username.trim() && Number.isInteger(port) && port > 0 && port <= 65535)
        }
        connectionForm={
          nativeConnection ? (
            <p className="text-xs text-on-surface-muted">
              {gt("Uses this SSH account's saved connection and key.")}
            </p>
          ) : (
            <SshInstallConnectionFields
              username={username}
              port={port}
              onUsernameChange={setUsername}
              onPortChange={setPort}
            >
              <SshInstallKeyField
                keys={keys}
                selectedId={keyId}
                onChange={(next) => {
                  setKeyId(next);
                  const owner = keys.find((k) => k.id === next)?.ownerName;
                  if (!defaultUsername && owner) setUsername(deriveSSHUsername(owner));
                }}
              />
            </SshInstallConnectionFields>
          )
        }
        onRun={(installerAccountId) =>
          withTrustPrompt(() =>
            apiPost<SshInstallResult>(`/api/org/${orgId}/resources/ssh-install`, {
              installerAccountId,
              target,
              ...(!nativeConnection ? { sshKeyId: keyId, username: username.trim(), port } : {}),
            }),
          )
        }
        onClose={onClose}
      />
      {dialog}
    </>
  );
}
