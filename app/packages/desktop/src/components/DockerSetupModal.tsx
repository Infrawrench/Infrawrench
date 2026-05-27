import { useState, useCallback } from "react";
import { invoke } from "../lib/invoke";
import { getDb } from "../db/client";
import { sshExecCommand, sshOpenTunnel } from "../lib/ssh-tunnel";
import { useUIStore, Modal, formatErrorMessage, runDockerSetupScript } from "@infrawrench/ui";
import { pinResource } from "../lib/pins";
import { ErrorNotice } from "./ErrorNotice";
import { SshKeyPicker } from "./SshKeyPicker";
import type { KeySource } from "../lib/ssh-key-source";
import { cloudSshTunnelExec, cloudSshTunnelCreateAccount } from "../lib/cloud-api";

type Step = "credentials" | "checking" | "installing" | "configuring" | "done";

interface DockerSetupModalProps {
  sshHost: string;
  defaultUsername?: string;
  sourceAccountId: string;
  onClose: () => void;
  onComplete: (newAccountId: string) => void;
}

export function DockerSetupModal({
  sshHost,
  defaultUsername,
  sourceAccountId,
  onClose,
  onComplete,
}: DockerSetupModalProps) {
  const [sshUser, setSshUser] = useState(defaultUsername ?? "root");
  const [sshPort, setSshPort] = useState(22);
  const [privateKey, setPrivateKey] = useState("");
  const [selectedKey, setSelectedKey] = useState<KeySource | null>(null);
  const [accountName, setAccountName] = useState(`Docker on ${sshHost}`);
  const [step, setStep] = useState<Step>("credentials");
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dockerVersion, setDockerVersion] = useState<string | null>(null);
  const [createdAccountId, setCreatedAccountId] = useState<string | null>(null);
  const [pinnedToDashboard, setPinnedToDashboard] = useState(false);
  const [dashboards, setDashboards] = useState<{ id: string; name: string }[]>([]);
  const [showDashboardPicker, setShowDashboardPicker] = useState(false);
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const isCloudKey = selectedKey?.type === "cloud";

  function appendLog(msg: string) {
    setLog((prev) => [...prev, msg]);
  }

  const sshConfig = useCallback(
    () => ({
      sshHost,
      sshPort,
      sshUser,
      privateKey: privateKey.trim(),
    }),
    [sshHost, sshPort, sshUser, privateKey],
  );

  async function exec(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    if (isCloudKey && selectedKey && activeCloudOrgId) {
      const resp = await cloudSshTunnelExec(activeCloudOrgId, {
        sshHost,
        sshPort,
        sshUser,
        sshKeyId: selectedKey.sshKeyId,
        command,
      });
      return { stdout: resp.stdout, stderr: resp.stderr ?? "", code: resp.code };
    }
    return sshExecCommand(sshConfig(), command);
  }

  /** Prefix with sudo when not connecting as root */
  function sudo(cmd: string): string {
    return sshUser === "root" ? cmd : `sudo ${cmd}`;
  }

  async function startSetup() {
    if (isCloudKey) {
      if (!selectedKey || !activeCloudOrgId) {
        setError("Select an SSH key first");
        return;
      }
    } else if (!privateKey.trim()) {
      setError("Select an SSH key first");
      return;
    }
    setError(null);
    setLog([]);
    setStep("checking");

    try {
      const { dockerVersion: ver } = await runDockerSetupScript({
        exec,
        sudo,
        sshHost,
        appendLog,
        setStep,
      });
      setDockerVersion(ver);

      appendLog("Opening SSH tunnel to Docker...");

      let newAccountId: string;
      if (isCloudKey && selectedKey && activeCloudOrgId) {
        const resp = await cloudSshTunnelCreateAccount(activeCloudOrgId, {
          sshHost,
          sshPort,
          sshUser,
          sshKeyId: selectedKey.sshKeyId,
          remoteHost: "127.0.0.1",
          remotePort: 2375,
          pluginId: "docker",
          displayName: accountName,
          credentials: { dockerHost: "tcp://localhost:2375" },
        });
        newAccountId = resp.accountId;
        appendLog(`Cloud tunnel created for ${sshHost}:2375`);
      } else {
        const { localPort } = await sshOpenTunnel({
          ...sshConfig(),
          remoteHost: "127.0.0.1",
          remotePort: 2375,
        });
        appendLog(`Tunnel open: localhost:${localPort} -> ${sshHost}:2375`);

        const db = await getDb();
        newAccountId = crypto.randomUUID();

        const credentials = { dockerHost: "tcp://localhost:2375" };
        await invoke<void>("account_create", {
          accountId: newAccountId,
          pluginId: "docker",
          displayName: accountName,
          credentials,
        });

        const tunnelConfigId = crypto.randomUUID();
        const { ciphertext: keyCiphertext, iv: keyIv } = await invoke<{
          ciphertext: string;
          iv: string;
        }>("ssh_tunnel_config_encrypt_private_key", {
          tunnelConfigId,
          privateKey: privateKey.trim(),
        });
        await db.execute(
          `INSERT OR REPLACE INTO ssh_tunnel_configs
           (id, account_id, ssh_host, ssh_port, ssh_user, remote_host, remote_port, encrypted_private_key, private_key_iv)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            tunnelConfigId,
            newAccountId,
            sshHost,
            sshPort,
            sshUser,
            "127.0.0.1",
            2375,
            keyCiphertext,
            keyIv,
          ],
        );
      }

      appendLog("Docker account created.");
      setCreatedAccountId(newAccountId);
      useUIStore.getState().bumpAccounts();
      setStep("done");
    } catch (e) {
      setError(formatErrorMessage(e));
    }
  }

  const isRunning = step === "checking" || step === "installing" || step === "configuring";

  return (
    <Modal onClose={onClose}>
      <div className="bg-surface-raised border border-border-strong rounded-2xl shadow-2xl w-[520px] max-h-[90vh] overflow-auto">
        <div className="p-6 border-b border-border">
          <h2 className="text-base font-semibold text-on-surface">Setup Docker on VM</h2>
          <p className="text-xs text-on-surface-muted mt-1">
            Host: <span className="text-on-surface-secondary font-mono">{sshHost}</span>
          </p>
        </div>

        <div className="p-6 space-y-4">
          {step === "credentials" && (
            <>
              <div className="flex items-center gap-3">
                <label
                  id="docker-setup-name-label"
                  htmlFor="docker-setup-name"
                  className="text-xs text-on-surface-muted w-20 shrink-0"
                >
                  Name
                </label>
                <input
                  id="docker-setup-name"
                  aria-labelledby="docker-setup-name-label"
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  className="flex-1 bg-surface-overlay border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary focus:outline-none focus:border-border-strong"
                  placeholder={`Docker on ${sshHost}`}
                  spellCheck={false}
                />
              </div>

              <SshKeyPicker
                username={sshUser}
                onUsernameChange={setSshUser}
                onKeyResolved={setPrivateKey}
                selectedKeyRef={setSelectedKey}
              />

              <div className="flex items-center gap-3">
                <label
                  id="docker-setup-ssh-port-label"
                  htmlFor="docker-setup-ssh-port"
                  className="text-xs text-on-surface-muted w-20 shrink-0"
                >
                  SSH Port
                </label>
                <input
                  id="docker-setup-ssh-port"
                  aria-labelledby="docker-setup-ssh-port-label"
                  type="number"
                  value={sshPort}
                  onChange={(e) => setSshPort(Number(e.target.value))}
                  className="w-24 bg-surface-overlay border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary font-mono focus:outline-none focus:border-border-strong"
                />
              </div>

              <div className="bg-surface-overlay/50 rounded-lg p-3 space-y-1">
                <div className="text-xs text-on-surface-tertiary font-medium">This will:</div>
                <ul className="text-xs text-on-surface-muted space-y-0.5 list-disc pl-4">
                  <li>Check if Docker is installed on the VM</li>
                  <li>Install Docker if needed (via get.docker.com)</li>
                  <li>Configure Docker to listen on TCP (localhost only)</li>
                  <li>Create an SSH tunnel and Docker account</li>
                </ul>
              </div>
            </>
          )}

          {/* Progress log */}
          {step !== "credentials" && (
            <div className="space-y-3">
              <div className="flex items-center gap-6 text-xs">
                <StepIndicator
                  label="Check"
                  active={step === "checking"}
                  done={step !== "checking"}
                />
                <StepIndicator
                  label="Install"
                  active={step === "installing"}
                  done={step === "configuring" || step === "done"}
                />
                <StepIndicator
                  label="Configure"
                  active={step === "configuring"}
                  done={step === "done"}
                />
                <StepIndicator label="Done" active={step === "done"} done={false} />
              </div>

              <div className="bg-surface rounded-lg p-3 max-h-[200px] overflow-y-auto">
                {log.map((line, i) => (
                  <div
                    key={i}
                    className="text-xs font-mono text-on-surface-tertiary leading-relaxed"
                  >
                    <span className="text-on-surface-faint mr-2">$</span>
                    {line}
                  </div>
                ))}
                {isRunning && (
                  <div className="text-xs font-mono text-accent animate-pulse mt-1">Working…</div>
                )}
              </div>

              {dockerVersion && (
                <div className="text-xs text-green-400 font-mono">{dockerVersion}</div>
              )}
            </div>
          )}

          {error && (
            <ErrorNotice
              message={error}
              className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2"
              textClassName="text-xs text-red-400"
            />
          )}
        </div>

        <div className="p-6 border-t border-border flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isRunning}
            className="px-4 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary transition-colors disabled:opacity-50"
          >
            {step === "done" ? "Close" : "Cancel"}
          </button>
          {step === "credentials" && (
            <button
              type="button"
              onClick={() => void startSetup()}
              disabled={
                (!isCloudKey && !privateKey.trim()) ||
                (isCloudKey && !activeCloudOrgId) ||
                !sshUser.trim() ||
                !accountName.trim()
              }
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              Start Setup
            </button>
          )}
          {step === "done" && createdAccountId && (
            <>
              <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    if (pinnedToDashboard) return;
                    void (async () => {
                      const db = await getDb();
                      const rows = await db.select<{ id: string; name: string }[]>(
                        "SELECT id, name FROM dashboards ORDER BY is_default DESC, name ASC",
                      );
                      if (rows.length <= 1) {
                        // Only one (or zero) dashboard — pin directly
                        await pinResource(
                          {
                            id: createdAccountId,
                            pluginId: "docker",
                            resourceTypeId: "__account__",
                            accountId: createdAccountId,
                            displayName: accountName,
                            fields: { pluginId: "docker", pluginDisplayName: "Docker" },
                          },
                          db,
                          rows[0]?.id,
                        );
                        setPinnedToDashboard(true);
                      } else {
                        setDashboards(rows);
                        setShowDashboardPicker(true);
                      }
                    })();
                  }}
                  disabled={pinnedToDashboard}
                  className={`px-4 py-2 text-sm rounded-lg transition-colors ${
                    pinnedToDashboard
                      ? "bg-surface-sunken text-on-surface-tertiary"
                      : "bg-surface-sunken hover:bg-surface-sunken text-on-surface-secondary"
                  }`}
                >
                  {pinnedToDashboard ? "Added to Dashboard" : "Add to Dashboard"}
                </button>
                {showDashboardPicker && (
                  <div className="absolute bottom-full mb-1 right-0 bg-surface-overlay border border-border-strong rounded-lg shadow-xl py-1 min-w-[180px] z-10">
                    {dashboards.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() => {
                          setShowDashboardPicker(false);
                          void (async () => {
                            const db = await getDb();
                            await pinResource(
                              {
                                id: createdAccountId,
                                pluginId: "docker",
                                resourceTypeId: "__account__",
                                accountId: createdAccountId,
                                displayName: accountName,
                                fields: { pluginId: "docker", pluginDisplayName: "Docker" },
                              },
                              db,
                              d.id,
                            );
                            setPinnedToDashboard(true);
                          })();
                        }}
                        className="w-full px-3 py-2 text-xs text-on-surface-secondary hover:bg-surface-sunken text-left"
                      >
                        {d.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => onComplete(createdAccountId)}
                className="px-4 py-2 text-sm bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors"
              >
                Open Docker
              </button>
            </>
          )}
          {error && step !== "credentials" && (
            <button
              type="button"
              onClick={() => {
                setError(null);
                setStep("credentials");
              }}
              className="px-4 py-2 text-sm bg-surface-sunken hover:bg-surface-sunken text-on-surface-secondary rounded-lg transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function StepIndicator({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <div
      className={`flex items-center gap-1.5 ${active ? "text-accent" : done ? "text-green-400" : "text-on-surface-faint"}`}
    >
      <span
        className={`size-1.5 rounded-full ${active ? "bg-blue-400 animate-pulse" : done ? "bg-green-400" : "bg-surface-sunken"}`}
      />
      {label}
    </div>
  );
}
