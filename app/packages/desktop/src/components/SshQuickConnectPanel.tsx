import { useState, useEffect, useId } from "react";
import { deriveSSHUsername, useUIStore, SshKeyRadioItem } from "@infrawrench/ui";
import { invoke } from "../lib/invoke";
import { getDb } from "../db/client";
import { ONEPASSWORD_SENTINEL, PAGEANT_SENTINEL } from "../lib/ssh-agent";
import type { SystemKey, AppKey, KeySource, CloudKey } from "../lib/ssh-key-source";

interface SshQuickConnectPanelProps {
  host: string;
  defaultUsername?: string;
  preferredAppKeyId?: string | undefined;
  preferredAppKeyName?: string | undefined;
  onConnect: (config: { username: string; privateKey: string; keySource: KeySource }) => void;
}

export function SshQuickConnectPanel({
  host,
  defaultUsername,
  preferredAppKeyId,
  preferredAppKeyName,
  onConnect,
}: SshQuickConnectPanelProps) {
  const [systemKeys, setSystemKeys] = useState<SystemKey[]>([]);
  const [appKeys, setAppKeys] = useState<AppKey[]>([]);
  const [cloudKeys, setCloudKeys] = useState<CloudKey[]>([]);
  const [pageantAvailable, setPageantAvailable] = useState(false);
  const [onePasswordAvailable, setOnePasswordAvailable] = useState(false);
  const [selectedKey, setSelectedKey] = useState<KeySource | null>(null);
  const [username, setUsername] = useState(defaultUsername ?? "root");
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const radioGroupName = useId();

  const [showAddKey, setShowAddKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyPem, setNewKeyPem] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadKeys();
  }, [activeCloudOrgId, preferredAppKeyId, preferredAppKeyName]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadKeys() {
    const [sys, db, pageant, onePassword] = await Promise.all([
      invoke<SystemKey[]>("ssh_list_system_keys"),
      getDb(),
      invoke<boolean>("ssh_check_pageant").catch(() => false),
      invoke<boolean>("ssh_check_1password").catch(() => false),
    ]);
    setSystemKeys(sys);
    setPageantAvailable(pageant);
    setOnePasswordAvailable(onePassword);
    const rows = await db.select<{ id: string; name: string }[]>(
      "SELECT id, name FROM ssh_keys ORDER BY created_at ASC",
      [],
    );
    setAppKeys(rows);
    if (activeCloudOrgId) {
      const cloud = await invoke<CloudKey[]>("cloud_ssh_keys_list", {
        orgId: activeCloudOrgId,
      }).catch(() => []);
      setCloudKeys(cloud);
    } else {
      setCloudKeys([]);
    }
    // Prefer the key whose name matches the current/default username.
    const effectiveUsername = (defaultUsername ?? "root").toLowerCase();
    const sysMatch = sys.find((k) => k.name.toLowerCase() === effectiveUsername);
    const appMatch = rows.find((k) => k.name.toLowerCase() === effectiveUsername);
    const preferredAppKey =
      (preferredAppKeyId ? rows.find((k) => k.id === preferredAppKeyId) : undefined) ??
      (preferredAppKeyName ? rows.find((k) => k.name === preferredAppKeyName) : undefined);
    setSelectedKey((prev) => {
      if (preferredAppKey) {
        return { type: "app", id: preferredAppKey.id, name: preferredAppKey.name };
      }
      if (prev) return prev;
      if (sysMatch) return { type: "system", name: sysMatch.name };
      if (appMatch) return { type: "app", id: appMatch.id, name: appMatch.name };
      if (sys[0]) return { type: "system", name: sys[0].name };
      if (rows[0]) return { type: "app", id: rows[0].id, name: rows[0].name };
      if (onePassword) return { type: "1password" };
      if (pageant) return { type: "pageant" };
      return null;
    });
    if (!defaultUsername && !sysMatch && !appMatch && sys[0]) {
      try {
        const pub = await invoke<string>("ssh_read_system_key", { name: `${sys[0].name}.pub` });
        const comment = pub.trim().split(" ")[2];
        if (comment) {
          const derivedUsername = deriveSSHUsername(comment);
          setUsername((prev) => (prev === "root" ? derivedUsername : prev));
        }
      } catch {
        /* .pub might not exist */
      }
    }
  }

  async function saveAppKey() {
    if (!newKeyName.trim() || !newKeyPem.trim()) return;
    setSaving(true);
    try {
      const id = crypto.randomUUID();
      await invoke<void>("ssh_key_save_private_key", {
        keyId: id,
        name: newKeyName.trim(),
        privateKey: newKeyPem.trim(),
      });
      const newKey: AppKey = { id, name: newKeyName.trim() };
      setAppKeys((prev) => [...prev, newKey]);
      setSelectedKey({ type: "app", id, name: newKey.name });
      setNewKeyName("");
      setNewKeyPem("");
      setShowAddKey(false);
    } finally {
      setSaving(false);
    }
  }

  async function deleteAppKey(id: string) {
    const db = await getDb();
    await db.execute("DELETE FROM ssh_keys WHERE id = $1", [id]);
    setAppKeys((prev) => prev.filter((k) => k.id !== id));
    setSelectedKey((prev) => (prev?.type === "app" && prev.id === id ? null : prev));
  }

  async function connect() {
    if (!selectedKey) return;
    let key: string;
    if (selectedKey.type === "pageant") {
      key = PAGEANT_SENTINEL;
    } else if (selectedKey.type === "1password") {
      key = ONEPASSWORD_SENTINEL;
    } else if (selectedKey.type === "system") {
      key = await invoke<string>("ssh_read_system_key", { name: selectedKey.name });
    } else if (selectedKey.type === "app") {
      key = await invoke<string>("ssh_key_get_private_key", { keyId: selectedKey.id });
    } else {
      // Cloud key — private key stays server-side; SshTerminal uses keySource to dispatch.
      key = "";
    }
    onConnect({ username, privateKey: key, keySource: selectedKey });
  }

  return (
    <div className="border-t border-border shrink-0">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border/60">
        <span className="font-mono text-green-600 text-xs">SSH</span>
        <span className="text-on-surface-muted font-mono text-xs">{host}</span>
      </div>

      <div className="px-4 pb-4 pt-3 space-y-3 bg-surface/60">
        {/* Username */}
        <div className="flex items-center gap-3">
          <label
            id="ssh-quick-connect-username-label"
            htmlFor="ssh-quick-connect-username"
            className="text-xs text-on-surface-muted w-20 shrink-0"
          >
            Username
          </label>
          <input
            id="ssh-quick-connect-username"
            aria-labelledby="ssh-quick-connect-username-label"
            value={username}
            onChange={(e) => {
              const next = e.target.value;
              setUsername(next);
              const lc = next.toLowerCase();
              const sysMatch = systemKeys.find((k) => k.name.toLowerCase() === lc);
              if (sysMatch) {
                setSelectedKey({ type: "system", name: sysMatch.name });
                return;
              }
              const appMatch = appKeys.find((k) => k.name.toLowerCase() === lc);
              if (appMatch) {
                setSelectedKey({ type: "app", id: appMatch.id, name: appMatch.name });
              }
            }}
            className="flex-1 bg-surface-raised border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary font-mono focus:outline-none focus:border-border-strong"
            placeholder="root"
            spellCheck={false}
          />
        </div>

        {/* Key picker */}
        <div className="flex items-start gap-3">
          <span className="text-xs text-on-surface-muted w-20 shrink-0 pt-1">SSH Key</span>
          <div className="flex-1 space-y-1">
            {systemKeys.length === 0 &&
            appKeys.length === 0 &&
            !pageantAvailable &&
            !onePasswordAvailable ? (
              <p className="text-xs text-on-surface-faint py-1">No keys found.</p>
            ) : (
              <>
                {onePasswordAvailable && (
                  <div className="space-y-0.5">
                    <p className="text-xs text-on-surface-faint px-1 pb-0.5">SSH agent</p>
                    <KeyRow
                      groupName={radioGroupName}
                      value="1password"
                      label="1Password"
                      sublabel="running — "
                      selected={selectedKey?.type === "1password"}
                      onSelect={() => setSelectedKey({ type: "1password" })}
                    />
                  </div>
                )}
                {pageantAvailable && (
                  <div className="space-y-0.5">
                    <p className="text-xs text-on-surface-faint px-1 pb-0.5">Windows SSH Agent</p>
                    <KeyRow
                      groupName={radioGroupName}
                      value="pageant"
                      label="Pageant"
                      sublabel="running — "
                      selected={selectedKey?.type === "pageant"}
                      onSelect={() => setSelectedKey({ type: "pageant" })}
                    />
                  </div>
                )}
                {systemKeys.length > 0 && (
                  <div className="space-y-0.5">
                    <p className="text-xs text-on-surface-faint px-1 pb-0.5">System (~/.ssh)</p>
                    {systemKeys.map((k) => (
                      <KeyRow
                        key={k.name}
                        groupName={radioGroupName}
                        value={`system:${k.name}`}
                        label={k.name}
                        sublabel="~/.ssh/"
                        selected={selectedKey?.type === "system" && selectedKey.name === k.name}
                        onSelect={async () => {
                          setSelectedKey({ type: "system", name: k.name });
                          if (!defaultUsername) {
                            try {
                              const pub = await invoke<string>("ssh_read_system_key", {
                                name: `${k.name}.pub`,
                              });
                              const comment = pub.trim().split(" ")[2];
                              if (comment) {
                                const derivedUsername = deriveSSHUsername(comment);
                                setUsername((prev) =>
                                  prev === "root" || prev === derivedUsername
                                    ? derivedUsername
                                    : prev,
                                );
                              }
                            } catch {
                              /* .pub might not exist */
                            }
                          }
                        }}
                      />
                    ))}
                  </div>
                )}
                {appKeys.length > 0 && (
                  <div className="space-y-0.5 mt-1.5">
                    <p className="text-xs text-on-surface-faint px-1 pb-0.5">Saved keys</p>
                    {appKeys.map((k) => (
                      <KeyRow
                        key={k.id}
                        groupName={radioGroupName}
                        value={`app:${k.id}`}
                        label={k.name}
                        selected={selectedKey?.type === "app" && selectedKey.id === k.id}
                        onSelect={() => setSelectedKey({ type: "app", id: k.id, name: k.name })}
                        onDelete={() => void deleteAppKey(k.id)}
                      />
                    ))}
                  </div>
                )}
                {cloudKeys.length > 0 && (
                  <div className="space-y-0.5 mt-1.5">
                    <p className="text-xs text-on-surface-faint px-1 pb-0.5">Cloud keys</p>
                    {cloudKeys.map((k) => (
                      <KeyRow
                        key={k.id}
                        groupName={radioGroupName}
                        value={`cloud:${k.id}`}
                        label={k.name}
                        sublabel="cloud/"
                        selected={selectedKey?.type === "cloud" && selectedKey.sshKeyId === k.id}
                        onSelect={() =>
                          setSelectedKey({ type: "cloud", sshKeyId: k.id, name: k.name })
                        }
                      />
                    ))}
                  </div>
                )}
              </>
            )}

            {/* Add key inline form */}
            {showAddKey ? (
              <div className="mt-2 space-y-2 p-3 rounded-lg border border-border-strong bg-surface-raised">
                <input
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  className="w-full bg-surface-overlay border border-border-strong rounded px-2 py-1 text-xs text-on-surface-secondary font-mono focus:outline-none focus:border-border-strong"
                  placeholder="Key name (e.g. my-droplet-key)"
                  aria-label="Key name"
                  spellCheck={false}
                />
                <textarea
                  value={newKeyPem}
                  onChange={(e) => setNewKeyPem(e.target.value)}
                  className="w-full bg-surface-overlay border border-border-strong rounded px-2 py-1.5 text-xs text-on-surface-secondary font-mono focus:outline-none focus:border-border-strong resize-none"
                  rows={5}
                  aria-label="Private key"
                  placeholder={
                    "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"
                  }
                  spellCheck={false}
                />
                <div className="flex gap-2 justify-end">
                  <button
                    type="button"
                    onClick={() => {
                      setShowAddKey(false);
                      setNewKeyName("");
                      setNewKeyPem("");
                    }}
                    className="px-3 py-1 text-xs text-on-surface-muted hover:text-on-surface-secondary transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveAppKey()}
                    disabled={saving || !newKeyName.trim() || !newKeyPem.trim()}
                    className="px-3 py-1 rounded bg-surface-sunken hover:bg-surface-sunken text-xs text-on-surface-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    {saving ? "Saving…" : "Save Key"}
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowAddKey(true)}
                className="mt-1 text-xs text-on-surface-faint hover:text-on-surface-tertiary transition-colors"
              >
                + Add key to registry
              </button>
            )}
          </div>
        </div>

        {/* Connect button */}
        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={() => void connect()}
            disabled={!selectedKey}
            className="px-4 py-1.5 rounded-lg bg-green-100 dark:bg-green-900 border border-green-300 dark:border-green-700 hover:bg-green-200 dark:hover:bg-green-800 hover:border-green-400 dark:hover:border-green-600 text-green-700 dark:text-green-300 hover:text-green-800 dark:hover:text-green-200 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}

function KeyRow({
  groupName,
  value,
  label,
  sublabel,
  selected,
  onSelect,
  onDelete,
}: {
  groupName: string;
  value: string;
  label: string;
  sublabel?: string;
  selected: boolean;
  onSelect: () => void | Promise<void>;
  onDelete?: () => void;
}) {
  return (
    <SshKeyRadioItem
      name={groupName}
      value={value}
      label={label}
      {...(sublabel !== undefined ? { sublabel } : {})}
      selected={selected}
      onSelect={() => {
        void onSelect();
      }}
      trailing={
        onDelete ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete();
            }}
            className="opacity-0 group-hover:opacity-100 text-on-surface-faint hover:text-red-400 text-xs px-1 transition-all"
            title="Remove key"
          >
            ✕
          </button>
        ) : undefined
      }
    />
  );
}
