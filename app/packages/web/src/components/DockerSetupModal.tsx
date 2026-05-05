import { useState, useEffect, useCallback } from "react";
import { Modal, useUIStore, formatErrorMessage, deriveSSHUsername } from "@infrawrench/ui";
import { apiGet, apiPost } from "@/lib/api";
import type { SshKey } from "@/lib/api-types";
import { useOrgId } from "@/lib/useOrgId";

type Step = "credentials" | "checking" | "installing" | "configuring" | "done";

interface DockerSetupModalProps {
  sshHost: string;
  defaultUsername?: string | undefined;
  onClose: () => void;
  onComplete: (newAccountId: string) => void;
}

export function DockerSetupModal({
  sshHost,
  defaultUsername,
  onClose,
  onComplete,
}: DockerSetupModalProps) {
  const orgId = useOrgId();
  const [sshUser, setSshUser] = useState(defaultUsername ?? "root");
  const [sshPort, setSshPort] = useState(22);
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [keys, setKeys] = useState<SshKey[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(true);
  const [accountName, setAccountName] = useState(`Docker on ${sshHost}`);
  const [step, setStep] = useState<Step>("credentials");
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dockerVersion, setDockerVersion] = useState<string | null>(null);
  const [createdAccountId, setCreatedAccountId] = useState<string | null>(null);

  useEffect(() => {
    apiGet<SshKey[]>(`/api/org/${orgId}/ssh-keys`)
      .then((result) => {
        setKeys(result);
        if (result.length > 0) {
          setSelectedKeyId(result[0]!.id);
          if (!defaultUsername && result[0]!.ownerName) {
            setSshUser(deriveSSHUsername(result[0]!.ownerName));
          }
        }
      })
      .catch(() => {})
      .finally(() => setLoadingKeys(false));
  }, []);

  function appendLog(msg: string) {
    setLog((prev) => [...prev, msg]);
  }

  const exec = useCallback(
    async (command: string): Promise<{ stdout: string; stderr: string; code: number }> => {
      const result = await apiPost<{ stdout: string; stderr?: string; code: number }>(
        `/api/org/${orgId}/ssh-tunnels/exec`,
        {
          sshHost,
          sshPort,
          sshUser,
          sshKeyId: selectedKeyId,
          command,
        },
      );
      return { stdout: result.stdout, stderr: result.stderr ?? "", code: result.code };
    },
    [orgId, sshHost, sshPort, sshUser, selectedKeyId],
  );

  function sudo(cmd: string): string {
    return sshUser === "root" ? cmd : `sudo ${cmd}`;
  }

  async function startSetup() {
    if (!selectedKeyId) {
      setError("Select an SSH key first");
      return;
    }
    setError(null);
    setLog([]);
    setStep("checking");

    try {
      // Step 1: Check if Docker is installed
      appendLog("Connecting to " + sshHost + "...");
      const versionResult = await exec("docker --version 2>/dev/null");

      if (versionResult.code === 0 && versionResult.stdout.includes("Docker")) {
        const ver = versionResult.stdout.trim();
        setDockerVersion(ver);
        appendLog("Docker found: " + ver);
      } else {
        appendLog("Docker not found. Installing...");
        setStep("installing");

        const installResult = await exec(`curl -fsSL https://get.docker.com | ${sudo("sh")} 2>&1`);
        if (installResult.code !== 0) {
          throw new Error(
            "Docker installation failed:\n" +
              (installResult.stderr || installResult.stdout).slice(0, 500),
          );
        }
        appendLog("Docker installed successfully.");

        const verifyResult = await exec("docker --version");
        if (verifyResult.code !== 0) {
          throw new Error("Docker installed but not accessible: " + verifyResult.stderr);
        }
        setDockerVersion(verifyResult.stdout.trim());
        appendLog("Verified: " + verifyResult.stdout.trim());
      }

      // Step 2: Ensure Docker is running
      appendLog("Ensuring Docker service is running...");
      await exec(sudo("systemctl start docker 2>/dev/null || service docker start 2>/dev/null"));

      // Step 3: Check if Docker is listening on TCP
      setStep("configuring");
      appendLog("Checking Docker TCP configuration...");

      const tcpCheck = await exec("curl -s --max-time 2 http://127.0.0.1:2375/version 2>/dev/null");

      if (tcpCheck.code !== 0 || !tcpCheck.stdout.includes("ApiVersion")) {
        appendLog("Configuring Docker to listen on TCP 127.0.0.1:2375...");

        const confContent =
          "[Service]\\nExecStart=\\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375";
        const overrideCmd = [
          sudo("mkdir -p /etc/systemd/system/docker.service.d"),
          `printf '${confContent}\\n' | ${sudo("tee /etc/systemd/system/docker.service.d/tcp.conf > /dev/null")}`,
          sudo("systemctl daemon-reload"),
          sudo("systemctl restart docker"),
        ].join(" && ");

        const configResult = await exec(overrideCmd);
        if (configResult.code !== 0) {
          throw new Error(
            "Failed to configure Docker TCP:\n" +
              (configResult.stderr || configResult.stdout).slice(0, 500),
          );
        }
        appendLog("Docker TCP listener configured on 127.0.0.1:2375.");

        await exec("sleep 2");

        const verifyTcp = await exec("curl -s --max-time 5 http://127.0.0.1:2375/version");
        if (verifyTcp.code !== 0 || !verifyTcp.stdout.includes("ApiVersion")) {
          throw new Error("Docker TCP listener not responding after configuration");
        }
        appendLog("TCP listener verified.");
      } else {
        appendLog("Docker already listening on TCP 127.0.0.1:2375.");
      }

      // Step 4: Create tunneled Docker account
      appendLog("Creating SSH tunnel to Docker...");
      const credentials = { dockerHost: "tcp://localhost:2375" };

      const result = await apiPost<{ accountId: string }>(
        `/api/org/${orgId}/ssh-tunnels/create-account`,
        {
          sshHost,
          sshPort,
          sshUser,
          sshKeyId: selectedKeyId,
          remoteHost: "127.0.0.1",
          remotePort: 2375,
          pluginId: "docker",
          displayName: accountName,
          credentials,
        },
      );

      appendLog("Docker account created.");
      setCreatedAccountId(result.accountId);
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
                <label className="text-xs text-on-surface-muted w-20 shrink-0">Name</label>
                <input
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  className="flex-1 bg-surface-overlay border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary focus:outline-none focus:border-border-strong"
                  placeholder={`Docker on ${sshHost}`}
                  spellCheck={false}
                />
              </div>

              {/* SSH Key picker */}
              <div className="flex items-start gap-3">
                <label className="text-xs text-on-surface-muted w-20 shrink-0 pt-1">SSH Key</label>
                <div className="flex-1 space-y-1">
                  {loadingKeys ? (
                    <p className="text-xs text-on-surface-faint py-1">Loading keys...</p>
                  ) : keys.length === 0 ? (
                    <p className="text-xs text-on-surface-faint py-1">
                      No SSH keys found. Go to Settings to create one.
                    </p>
                  ) : (
                    keys.map((k) => (
                      <div
                        key={k.id}
                        onClick={() => {
                          setSelectedKeyId(k.id);
                          if (!defaultUsername && k.ownerName) {
                            setSshUser(deriveSSHUsername(k.ownerName));
                          }
                        }}
                        className={`group flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
                          selectedKeyId === k.id
                            ? "bg-accent-muted border border-accent-muted-border text-accent-on-muted"
                            : "hover:bg-surface-overlay border border-transparent text-on-surface-tertiary"
                        }`}
                      >
                        <span className="text-xs shrink-0">
                          {selectedKeyId === k.id ? "\u25c9" : "\u25cb"}
                        </span>
                        <span className="text-xs font-mono flex-1 truncate">{k.name}</span>
                        <span className="text-xs text-on-surface-faint">{k.ownerName}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Username */}
              <div className="flex items-center gap-3">
                <label className="text-xs text-on-surface-muted w-20 shrink-0">Username</label>
                <input
                  value={sshUser}
                  onChange={(e) => setSshUser(e.target.value)}
                  className="flex-1 bg-surface-overlay border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary font-mono focus:outline-none focus:border-border-strong"
                  placeholder="root"
                  spellCheck={false}
                />
              </div>

              <div className="flex items-center gap-3">
                <label className="text-xs text-on-surface-muted w-20 shrink-0">SSH Port</label>
                <input
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
                  <div className="text-xs font-mono text-accent animate-pulse mt-1">Working...</div>
                )}
              </div>

              {dockerVersion && (
                <div className="text-xs text-green-400 font-mono">{dockerVersion}</div>
              )}
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2">
              <p className="text-xs text-red-400">{error}</p>
            </div>
          )}
        </div>

        <div className="p-6 border-t border-border flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={isRunning}
            className="px-4 py-2 text-sm text-on-surface-tertiary hover:text-on-surface-secondary transition-colors disabled:opacity-50"
          >
            {step === "done" ? "Close" : "Cancel"}
          </button>
          {step === "credentials" && (
            <button
              onClick={() => void startSetup()}
              disabled={!selectedKeyId || !sshUser.trim() || !accountName.trim()}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              Start Setup
            </button>
          )}
          {step === "done" && createdAccountId && (
            <button
              onClick={() => onComplete(createdAccountId)}
              className="px-4 py-2 text-sm bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors"
            >
              Open Docker
            </button>
          )}
          {error && step !== "credentials" && (
            <button
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
        className={`w-1.5 h-1.5 rounded-full ${active ? "bg-blue-400 animate-pulse" : done ? "bg-green-400" : "bg-surface-sunken"}`}
      />
      {label}
    </div>
  );
}
