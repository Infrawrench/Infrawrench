import { useGT } from "gt-react";
import { useEffect, useId, useState } from "react";
import { SshInstallModal, SshInstallConnectionFields } from "@infrawrench/ui";
import type {
  SshInstallAccount,
  SshInstallInput,
  SshInstallResult,
} from "@infrawrench/plugin-base";
import { apiGet, apiPost } from "@/lib/api";
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
  const id = useId();
  const { withTrustPrompt, dialog } = useHostKeyTrust(orgId);
  const [accounts, setAccounts] = useState<SshInstallAccount[]>([]);
  const [keys, setKeys] = useState<Array<{ id: string; name: string }>>([]);
  const [keyId, setKeyId] = useState("");
  const [username, setUsername] = useState(defaultUsername || "root");
  const [port, setPort] = useState(22);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      apiGet<SshInstallAccount[]>(`/api/org/${orgId}/resources/ssh-install/accounts`),
      nativeConnection
        ? Promise.resolve([])
        : apiGet<Array<{ id: string; name: string }>>(`/api/org/${orgId}/ssh-keys`),
    ])
      .then(([a, k]) => {
        if (!cancelled) {
          setAccounts(a);
          setKeys(k);
          setKeyId(k[0]?.id ?? "");
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
  }, [orgId, nativeConnection, loadErrorMessage]);
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
              <label htmlFor={id} className="block text-sm text-on-surface">
                {gt("SSH key")}
              </label>
              <select
                id={id}
                value={keyId}
                onChange={(e) => setKeyId(e.target.value)}
                className="w-full p-2 bg-surface-overlay text-on-surface text-sm border border-border rounded-lg"
              >
                <option value="" disabled>
                  {gt("Select an SSH key")}
                </option>
                {keys.map((key) => (
                  <option key={key.id} value={key.id}>
                    {key.name}
                  </option>
                ))}
              </select>
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
