import { useEffect, useId, useState, type ReactNode } from "react";
import { useGT } from "gt-react";
import type { SshInstallAccount, SshInstallResult } from "@infrawrench/plugin-base";
import { Modal } from "../Modal.js";
import { useDataString } from "../../i18n/data-strings.js";

export interface SshInstallModalProps {
  hostName: string;
  accounts: SshInstallAccount[];
  loading: boolean;
  loadError?: string | undefined;
  connectionForm?: ReactNode;
  ready: boolean;
  onRun: (installerAccountId: string) => Promise<SshInstallResult>;
  onClose: () => void;
}

export function SshInstallModal({
  hostName,
  accounts,
  loading,
  loadError,
  connectionForm,
  ready,
  onRun,
  onClose,
}: SshInstallModalProps) {
  const gt = useGT();
  const ds = useDataString();
  const id = useId();
  const [accountId, setAccountId] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SshInstallResult | null>(null);
  useEffect(() => {
    if (!accounts.some((a) => a.accountId === accountId))
      setAccountId(accounts[0]?.accountId ?? "");
  }, [accounts, accountId]);
  const account = accounts.find((a) => a.accountId === accountId);
  async function run() {
    if (!account || !ready || running) return;
    setRunning(true);
    setError(null);
    try {
      setResult(await onRun(account.accountId));
    } catch (e) {
      setError(e instanceof Error ? e.message : gt("Installation failed"));
    } finally {
      setRunning(false);
    }
  }
  return (
    <Modal {...(!running ? { onClose } : {})} ariaLabel={gt("Install service on server")}>
      <div className="bg-surface-raised border border-border-strong rounded-xl p-6 w-[520px] max-h-[85vh] overflow-y-auto space-y-4">
        <h2 className="text-base font-semibold text-on-surface">
          {gt("Install service on server")}
        </h2>
        <p className="text-sm text-on-surface-muted">
          {gt("Connect {host} to a service account using SSH.", { host: hostName })}
        </p>
        {result ? (
          <div role="status" className="space-y-3 text-sm text-on-surface">
            <p>{ds(result.message)}</p>
            {result.address && (
              <p>{gt("Network address: {address}", { address: result.address })}</p>
            )}
            {result.warnings?.map((warning) => (
              <p key={warning} className="text-warning">
                {ds(warning)}
              </p>
            ))}
            <p className="text-on-surface-muted">
              {gt("Refresh the service account to see its devices.")}
            </p>
          </div>
        ) : (
          <fieldset disabled={running || loading} className="space-y-4">
            <label className="block text-sm text-on-surface" htmlFor={id}>
              {gt("Service account")}
            </label>
            <select
              id={id}
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="w-full p-2 bg-surface-overlay border border-border rounded-lg text-sm text-on-surface"
            >
              <option value="" disabled>
                {loading ? gt("Loading…") : gt("Select an account")}
              </option>
              {accounts.map((a) => (
                <option key={a.accountId} value={a.accountId}>
                  {a.serviceName}: {a.displayName}
                </option>
              ))}
            </select>
            {!loading && !loadError && accounts.length === 0 && (
              <p className="text-sm text-on-surface-muted">
                {gt("Add a Tailscale account first, then return here to enroll this server.")}
              </p>
            )}
            {account && <p className="text-xs text-on-surface-muted">{ds(account.description)}</p>}
            {connectionForm}
          </fieldset>
        )}
        {(loadError || error) && (
          <p role="alert" className="text-sm text-danger whitespace-pre-wrap">
            {loadError || error}
          </p>
        )}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            disabled={running}
            onClick={onClose}
            className="px-4 py-2 text-sm text-on-surface-muted disabled:opacity-50"
          >
            {result ? gt("Close") : gt("Cancel")}
          </button>
          {!result && (
            <button
              type="button"
              disabled={running || loading || !ready || !account || !!loadError}
              onClick={() => void run()}
              className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white disabled:opacity-50"
            >
              {running ? gt("Installing…") : gt("Install and connect")}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

export function SshInstallConnectionFields({
  username,
  port,
  onUsernameChange,
  onPortChange,
  showUsername = true,
  children,
}: {
  username: string;
  port: number;
  onUsernameChange(value: string): void;
  onPortChange(value: number): void;
  showUsername?: boolean;
  children: ReactNode;
}) {
  const gt = useGT();
  const id = useId();
  return (
    <div className="space-y-3">
      {showUsername && (
        <>
          <label className="block text-sm text-on-surface" htmlFor={`${id}-user`}>
            {gt("SSH username")}
          </label>
          <input
            id={`${id}-user`}
            value={username}
            onChange={(e) => onUsernameChange(e.target.value)}
            className="w-full p-2 text-sm bg-surface-overlay border border-border rounded-lg text-on-surface"
          />
        </>
      )}
      <label className="block text-sm text-on-surface" htmlFor={`${id}-port`}>
        {gt("SSH port")}
      </label>
      <input
        id={`${id}-port`}
        type="number"
        min={1}
        max={65535}
        value={port}
        onChange={(e) => onPortChange(Number(e.target.value))}
        className="w-full p-2 text-sm bg-surface-overlay border border-border rounded-lg text-on-surface"
      />
      {children}
    </div>
  );
}
