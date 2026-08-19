import { useState, useEffect, useId } from "react";
import { useGT } from "gt-react";
import { deriveSSHUsername, useUIStore, SshKeyRadioItem } from "@infrawrench/ui";
import { invoke } from "../lib/invoke";
import { getDb } from "../db/client";
import { ONEPASSWORD_SENTINEL, PAGEANT_SENTINEL } from "../lib/ssh-agent";
import type { SystemKey, AppKey, KeySource, CloudKey } from "../lib/ssh-key-source";

interface SshKeyPickerProps {
  username: string;
  onUsernameChange: (username: string) => void;
  onKeyResolved: (privateKey: string) => void;
  /** Called with the current key source when selection changes */
  selectedKeyRef?: (source: KeySource | null) => void;
}

export function SshKeyPicker({
  username,
  onUsernameChange,
  onKeyResolved,
  selectedKeyRef,
}: SshKeyPickerProps) {
  const gt = useGT();
  const [systemKeys, setSystemKeys] = useState<SystemKey[]>([]);
  const [appKeys, setAppKeys] = useState<AppKey[]>([]);
  const [cloudKeys, setCloudKeys] = useState<CloudKey[]>([]);
  const [pageantAvailable, setPageantAvailable] = useState(false);
  const [onePasswordAvailable, setOnePasswordAvailable] = useState(false);
  const [selectedKey, setSelectedKey] = useState<KeySource | null>(null);
  const activeCloudOrgId = useUIStore((s) => s.activeCloudOrgId);
  const radioGroupName = useId();

  const [showAddKey, setShowAddKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyPem, setNewKeyPem] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void loadKeys();
  }, [activeCloudOrgId]); // eslint-disable-line react-hooks/exhaustive-deps

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

    let cloud: CloudKey[] = [];
    if (activeCloudOrgId) {
      cloud = await invoke<CloudKey[]>("cloud_ssh_keys_list", {
        orgId: activeCloudOrgId,
      }).catch(() => []);
      setCloudKeys(cloud);
    } else {
      setCloudKeys([]);
    }

    // Prefer a key whose name matches the username, otherwise fall back to the first available.
    const sysMatch = sys.find((k) => k.name === username);
    const appMatch = rows.find((k) => k.name === username);
    const first: KeySource | null = sysMatch
      ? { type: "system", name: sysMatch.name }
      : appMatch
        ? { type: "app", id: appMatch.id, name: appMatch.name }
        : sys[0]
          ? { type: "system", name: sys[0].name }
          : rows[0]
            ? { type: "app", id: rows[0].id, name: rows[0].name }
            : onePassword
              ? { type: "1password" }
              : pageant
                ? { type: "pageant" }
                : null;

    if (first) {
      setSelectedKey(first);
      selectedKeyRef?.(first);
      void resolveAndEmit(first);

      // Derive username from pub key comment
      if (first.type === "system") {
        try {
          const pub = await invoke<string>("ssh_read_system_key", { name: `${first.name}.pub` });
          const comment = pub.trim().split(" ")[2];
          if (comment) {
            const derived = deriveSSHUsername(comment);
            if (username === "root") onUsernameChange(derived);
          }
        } catch {
          /* .pub might not exist */
        }
      }
    }
  }

  async function resolveAndEmit(source: KeySource) {
    if (source.type === "pageant") {
      onKeyResolved(PAGEANT_SENTINEL);
    } else if (source.type === "1password") {
      onKeyResolved(ONEPASSWORD_SENTINEL);
    } else if (source.type === "system") {
      const key = await invoke<string>("ssh_read_system_key", { name: source.name });
      onKeyResolved(key);
    } else if (source.type === "app") {
      const key = await invoke<string>("ssh_key_get_private_key", { keyId: source.id });
      onKeyResolved(key);
    } else {
      // Cloud key — private key lives server-side, so pass an empty PEM.
      // Dispatch routes through the WS proxy based on the keySource prop.
      onKeyResolved("");
    }
  }

  async function selectKey(source: KeySource) {
    setSelectedKey(source);
    selectedKeyRef?.(source);
    void resolveAndEmit(source);

    if (source.type === "system") {
      try {
        const pub = await invoke<string>("ssh_read_system_key", { name: `${source.name}.pub` });
        const comment = pub.trim().split(" ")[2];
        if (comment) {
          const derived = deriveSSHUsername(comment);
          if (username === "root" || username === derived) onUsernameChange(derived);
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
      const newSource: KeySource = { type: "app", id, name: newKeyName.trim() };
      setAppKeys((prev) => [...prev, { id, name: newKeyName.trim() }]);
      setSelectedKey(newSource);
      selectedKeyRef?.(newSource);
      onKeyResolved(newKeyPem.trim());
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
    if (selectedKey?.type === "app" && selectedKey.id === id) {
      setSelectedKey(null);
      selectedKeyRef?.(null);
    }
  }

  return (
    <div className="space-y-3">
      {/* Username */}
      <div className="flex items-center gap-3">
        <label
          id="ssh-key-picker-username-label"
          htmlFor="ssh-key-picker-username"
          className="text-xs text-on-surface-muted w-20 shrink-0"
        >
          {gt("Username")}
        </label>
        <input
          id="ssh-key-picker-username"
          aria-labelledby="ssh-key-picker-username-label"
          value={username}
          onChange={(e) => onUsernameChange(e.target.value)}
          className="flex-1 bg-surface-overlay border border-border-strong rounded-lg px-3 py-1.5 text-sm text-on-surface-secondary font-mono focus:outline-none focus:border-border-strong"
          placeholder="root"
          spellCheck={false}
        />
      </div>

      {/* Key picker */}
      <div className="flex items-start gap-3">
        <span className="text-xs text-on-surface-muted w-20 shrink-0 pt-1">{gt("SSH Key")}</span>
        <div className="flex-1 space-y-1">
          {systemKeys.length === 0 &&
          appKeys.length === 0 &&
          !pageantAvailable &&
          !onePasswordAvailable ? (
            <p className="text-xs text-on-surface-faint py-1">{gt("No keys found.")}</p>
          ) : (
            <>
              {onePasswordAvailable && (
                <div className="space-y-0.5">
                  <p className="text-xs text-on-surface-faint px-1 pb-0.5">{gt("SSH agent")}</p>
                  <KeyRow
                    groupName={radioGroupName}
                    value="1password"
                    // i18n-ignore: product name
                    label="1Password"
                    sublabel={gt("running — ")}
                    selected={selectedKey?.type === "1password"}
                    onSelect={() => void selectKey({ type: "1password" })}
                  />
                </div>
              )}
              {pageantAvailable && (
                <div className="space-y-0.5">
                  <p className="text-xs text-on-surface-faint px-1 pb-0.5">
                    {gt("Windows SSH Agent")}
                  </p>
                  <KeyRow
                    groupName={radioGroupName}
                    value="pageant"
                    // i18n-ignore: product name
                    label="Pageant"
                    sublabel={gt("running — ")}
                    selected={selectedKey?.type === "pageant"}
                    onSelect={() => void selectKey({ type: "pageant" })}
                  />
                </div>
              )}
              {systemKeys.length > 0 && (
                <div className="space-y-0.5">
                  <p className="text-xs text-on-surface-faint px-1 pb-0.5">
                    {gt("System (~/.ssh)")}
                  </p>
                  {systemKeys.map((k) => (
                    <KeyRow
                      key={k.name}
                      groupName={radioGroupName}
                      value={`system:${k.name}`}
                      label={k.name}
                      sublabel="~/.ssh/"
                      selected={selectedKey?.type === "system" && selectedKey.name === k.name}
                      onSelect={() => void selectKey({ type: "system", name: k.name })}
                    />
                  ))}
                </div>
              )}
              {appKeys.length > 0 && (
                <div className="space-y-0.5 mt-1.5">
                  <p className="text-xs text-on-surface-faint px-1 pb-0.5">{gt("Saved keys")}</p>
                  {appKeys.map((k) => (
                    <KeyRow
                      key={k.id}
                      groupName={radioGroupName}
                      value={`app:${k.id}`}
                      label={k.name}
                      selected={selectedKey?.type === "app" && selectedKey.id === k.id}
                      onSelect={() => void selectKey({ type: "app", id: k.id, name: k.name })}
                      onDelete={() => void deleteAppKey(k.id)}
                    />
                  ))}
                </div>
              )}
              {cloudKeys.length > 0 && (
                <div className="space-y-0.5 mt-1.5">
                  <p className="text-xs text-on-surface-faint px-1 pb-0.5">{gt("Cloud keys")}</p>
                  {cloudKeys.map((k) => (
                    <KeyRow
                      key={k.id}
                      groupName={radioGroupName}
                      value={`cloud:${k.id}`}
                      label={k.name}
                      sublabel="cloud/"
                      selected={selectedKey?.type === "cloud" && selectedKey.sshKeyId === k.id}
                      onSelect={() =>
                        void selectKey({ type: "cloud", sshKeyId: k.id, name: k.name })
                      }
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {showAddKey ? (
            <div className="mt-2 space-y-2 p-3 rounded-lg border border-border-strong bg-surface-raised">
              <input
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                className="w-full bg-surface-overlay border border-border-strong rounded px-2 py-1 text-xs text-on-surface-secondary font-mono focus:outline-none focus:border-border-strong"
                placeholder={gt("Key name (e.g. my-droplet-key)")}
                spellCheck={false}
                aria-label={gt("Key name")}
              />
              <textarea
                value={newKeyPem}
                onChange={(e) => setNewKeyPem(e.target.value)}
                className="w-full bg-surface-overlay border border-border-strong rounded px-2 py-1.5 text-xs text-on-surface-secondary font-mono focus:outline-none focus:border-border-strong resize-none"
                rows={5}
                aria-label={gt("Private key (PEM)")}
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
                  {gt("Cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => void saveAppKey()}
                  disabled={saving || !newKeyName.trim() || !newKeyPem.trim()}
                  className="px-3 py-1 rounded bg-surface-sunken hover:bg-surface-sunken text-xs text-on-surface-secondary disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {saving ? gt("Saving...") : gt("Save Key")}
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowAddKey(true)}
              className="mt-1 text-xs text-on-surface-faint hover:text-on-surface-tertiary transition-colors"
            >
              {gt("+ Add key to registry")}
            </button>
          )}
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
  onSelect: () => void;
  onDelete?: () => void;
}) {
  const gt = useGT();
  return (
    <SshKeyRadioItem
      name={groupName}
      value={value}
      label={label}
      {...(sublabel !== undefined ? { sublabel } : {})}
      selected={selected}
      onSelect={onSelect}
      trailing={
        onDelete ? (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onDelete();
            }}
            className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 text-on-surface-faint hover:text-danger text-xs px-1 transition-all"
            title={gt("Remove key")}
            aria-label={gt("Remove key")}
          >
            ✕
          </button>
        ) : undefined
      }
    />
  );
}
