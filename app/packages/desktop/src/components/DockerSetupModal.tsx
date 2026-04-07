import { useState, useCallback } from "react";
import { invoke } from "../lib/invoke";
import { getDb } from "../db/client";
import { sshExecCommand, sshOpenTunnel } from "../lib/ssh-tunnel";
import { useUIStore } from "@infrawrench/ui";
import { formatErrorMessage } from "../lib/errors";
import { pinResource } from "../lib/pins";
import { ErrorNotice } from "./ErrorNotice";
import { SshKeyPicker } from "./SshKeyPicker";

type Step = "credentials" | "checking" | "installing" | "configuring" | "done";

interface DockerSetupModalProps {
  sshHost: string;
  sourceAccountId: string;
  onClose: () => void;
  onComplete: (newAccountId: string) => void;
}

export function DockerSetupModal({ sshHost, sourceAccountId, onClose, onComplete }: DockerSetupModalProps) {
  const [sshUser, setSshUser] = useState("root");
  const [sshPort, setSshPort] = useState(22);
  const [privateKey, setPrivateKey] = useState("");
  const [accountName, setAccountName] = useState(`Docker on ${sshHost}`);
  const [step, setStep] = useState<Step>("credentials");
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dockerVersion, setDockerVersion] = useState<string | null>(null);
  const [createdAccountId, setCreatedAccountId] = useState<string | null>(null);
  const [pinnedToDashboard, setPinnedToDashboard] = useState(false);
  const [dashboards, setDashboards] = useState<{ id: string; name: string }[]>([]);
  const [showDashboardPicker, setShowDashboardPicker] = useState(false);

  function appendLog(msg: string) {
    setLog((prev) => [...prev, msg]);
  }

  const sshConfig = useCallback(() => ({
    sshHost,
    sshPort,
    sshUser,
    privateKey: privateKey.trim(),
  }), [sshHost, sshPort, sshUser, privateKey]);

  async function exec(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    return sshExecCommand(sshConfig(), command);
  }

  /** Prefix with sudo when not connecting as root */
  function sudo(cmd: string): string {
    return sshUser === "root" ? cmd : `sudo ${cmd}`;
  }

  async function startSetup() {
    if (!privateKey.trim()) { setError("Select an SSH key first"); return; }
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
          throw new Error("Docker installation failed:\n" + (installResult.stderr || installResult.stdout).slice(0, 500));
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

        // Use printf piped to tee to avoid heredoc issues over SSH
        const confContent = "[Service]\\nExecStart=\\nExecStart=/usr/bin/dockerd -H fd:// -H tcp://127.0.0.1:2375";
        const overrideCmd = [
          sudo("mkdir -p /etc/systemd/system/docker.service.d"),
          `printf '${confContent}\\n' | ${sudo("tee /etc/systemd/system/docker.service.d/tcp.conf > /dev/null")}`,
          sudo("systemctl daemon-reload"),
          sudo("systemctl restart docker"),
        ].join(" && ");

        const configResult = await exec(overrideCmd);
        if (configResult.code !== 0) {
          throw new Error("Failed to configure Docker TCP:\n" + (configResult.stderr || configResult.stdout).slice(0, 500));
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

      // Step 4: Open SSH tunnel and create account
      appendLog("Opening SSH tunnel to Docker...");
      const { localPort } = await sshOpenTunnel({
        ...sshConfig(),
        remoteHost: "127.0.0.1",
        remotePort: 2375,
      });
      appendLog(`Tunnel open: localhost:${localPort} -> ${sshHost}:2375`);

      const db = await getDb();
      const newAccountId = crypto.randomUUID();

      const credentials = { dockerHost: "tcp://localhost:2375" };
      const { ciphertext: credCiphertext, iv: credIv } = await invoke<{ ciphertext: string; iv: string }>(
        "encrypt_value",
        { plaintext: JSON.stringify(credentials) },
      );
      const { ciphertext: keyCiphertext, iv: keyIv } = await invoke<{ ciphertext: string; iv: string }>(
        "encrypt_value",
        { plaintext: privateKey.trim() },
      );

      const displayName = accountName;
      await db.execute(
        "INSERT INTO accounts (id, plugin_id, display_name, encrypted_credentials, credentials_iv) VALUES ($1, $2, $3, $4, $5)",
        [newAccountId, "docker", displayName, credCiphertext, credIv],
      );

      const tunnelConfigId = crypto.randomUUID();
      await db.execute(
        `INSERT OR REPLACE INTO ssh_tunnel_configs
         (id, account_id, ssh_host, ssh_port, ssh_user, remote_host, remote_port, encrypted_private_key, private_key_iv)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [tunnelConfigId, newAccountId, sshHost, sshPort, sshUser, "127.0.0.1", 2375, keyCiphertext, keyIv],
      );

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-[520px] max-h-[90vh] overflow-auto">
        <div className="p-6 border-b border-gray-800">
          <h2 className="text-base font-semibold text-gray-100">Setup Docker on VM</h2>
          <p className="text-xs text-gray-500 mt-1">
            Host: <span className="text-gray-300 font-mono">{sshHost}</span>
          </p>
        </div>

        <div className="p-6 space-y-4">
          {step === "credentials" && (
            <>
              <div className="flex items-center gap-3">
                <label className="text-xs text-gray-500 w-20 shrink-0">Name</label>
                <input
                  value={accountName}
                  onChange={(e) => setAccountName(e.target.value)}
                  className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-gray-500"
                  placeholder={`Docker on ${sshHost}`}
                  spellCheck={false}
                />
              </div>

              <SshKeyPicker
                username={sshUser}
                onUsernameChange={setSshUser}
                onKeyResolved={setPrivateKey}
              />

              <div className="flex items-center gap-3">
                <label className="text-xs text-gray-500 w-20 shrink-0">SSH Port</label>
                <input
                  type="number"
                  value={sshPort}
                  onChange={(e) => setSshPort(Number(e.target.value))}
                  className="w-24 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 font-mono focus:outline-none focus:border-gray-500"
                />
              </div>

              <div className="bg-gray-800/50 rounded-lg p-3 space-y-1">
                <div className="text-xs text-gray-400 font-medium">This will:</div>
                <ul className="text-xs text-gray-500 space-y-0.5 list-disc pl-4">
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
                <StepIndicator label="Check" active={step === "checking"} done={step !== "checking"} />
                <StepIndicator label="Install" active={step === "installing"} done={step === "configuring" || step === "done"} />
                <StepIndicator label="Configure" active={step === "configuring"} done={step === "done"} />
                <StepIndicator label="Done" active={step === "done"} done={false} />
              </div>

              <div className="bg-gray-950 rounded-lg p-3 max-h-[200px] overflow-y-auto">
                {log.map((line, i) => (
                  <div key={i} className="text-xs font-mono text-gray-400 leading-relaxed">
                    <span className="text-gray-600 mr-2">$</span>
                    {line}
                  </div>
                ))}
                {isRunning && (
                  <div className="text-xs font-mono text-blue-400 animate-pulse mt-1">Working...</div>
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

        <div className="p-6 border-t border-gray-800 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={isRunning}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200 transition-colors disabled:opacity-50"
          >
            {step === "done" ? "Close" : "Cancel"}
          </button>
          {step === "credentials" && (
            <button
              onClick={() => void startSetup()}
              disabled={!privateKey.trim()}
              className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors disabled:opacity-50"
            >
              Start Setup
            </button>
          )}
          {step === "done" && createdAccountId && (
            <>
              <div className="relative">
                <button
                  onClick={() => {
                    if (pinnedToDashboard) return;
                    void (async () => {
                      const db = await getDb();
                      const rows = await db.select<{ id: string; name: string }[]>(
                        "SELECT id, name FROM dashboards ORDER BY is_default DESC, name ASC",
                      );
                      if (rows.length <= 1) {
                        // Only one (or zero) dashboard — pin directly
                        await pinResource({
                          id: createdAccountId,
                          pluginId: "docker",
                          resourceTypeId: "__account__",
                          accountId: createdAccountId,
                          displayName: accountName,
                          fields: { pluginId: "docker", pluginDisplayName: "Docker" },
                        }, db, rows[0]?.id);
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
                      ? "bg-gray-700 text-gray-400"
                      : "bg-gray-700 hover:bg-gray-600 text-gray-200"
                  }`}
                >
                  {pinnedToDashboard ? "Added to Dashboard" : "Add to Dashboard"}
                </button>
                {showDashboardPicker && (
                  <div className="absolute bottom-full mb-1 right-0 bg-gray-800 border border-gray-700 rounded-lg shadow-xl py-1 min-w-[180px] z-10">
                    {dashboards.map((d) => (
                      <button
                        key={d.id}
                        onClick={() => {
                          setShowDashboardPicker(false);
                          void (async () => {
                            const db = await getDb();
                            await pinResource({
                              id: createdAccountId,
                              pluginId: "docker",
                              resourceTypeId: "__account__",
                              accountId: createdAccountId,
                              displayName: accountName,
                              fields: { pluginId: "docker", pluginDisplayName: "Docker" },
                            }, db, d.id);
                            setPinnedToDashboard(true);
                          })();
                        }}
                        className="w-full px-3 py-2 text-xs text-gray-200 hover:bg-gray-700 text-left"
                      >
                        {d.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button
                onClick={() => onComplete(createdAccountId)}
                className="px-4 py-2 text-sm bg-green-600 hover:bg-green-500 text-white rounded-lg transition-colors"
              >
                Open Docker
              </button>
            </>
          )}
          {error && step !== "credentials" && (
            <button
              onClick={() => { setError(null); setStep("credentials"); }}
              className="px-4 py-2 text-sm bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg transition-colors"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function StepIndicator({ label, active, done }: { label: string; active: boolean; done: boolean }) {
  return (
    <div className={`flex items-center gap-1.5 ${active ? "text-blue-400" : done ? "text-green-400" : "text-gray-600"}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${active ? "bg-blue-400 animate-pulse" : done ? "bg-green-400" : "bg-gray-700"}`} />
      {label}
    </div>
  );
}
