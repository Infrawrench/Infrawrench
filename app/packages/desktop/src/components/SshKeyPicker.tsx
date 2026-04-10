import { useState, useEffect } from "react";
import { deriveSSHUsername } from "@infrawrench/ui";
import { invoke } from "../lib/invoke";
import { getDb } from "../db/client";

interface SystemKey {
  name: string;
}

interface AppKey {
  id: string;
  name: string;
}

type KeySource =
  | { type: "system"; name: string }
  | { type: "app"; id: string; name: string };

interface SshKeyPickerProps {
  username: string;
  onUsernameChange: (username: string) => void;
  onKeyResolved: (privateKey: string) => void;
  /** Called with the current key source when selection changes */
  selectedKeyRef?: (source: KeySource | null) => void;
}

export function SshKeyPicker({ username, onUsernameChange, onKeyResolved, selectedKeyRef }: SshKeyPickerProps) {
  const [systemKeys, setSystemKeys] = useState<SystemKey[]>([]);
  const [appKeys, setAppKeys] = useState<AppKey[]>([]);
  const [selectedKey, setSelectedKey] = useState<KeySource | null>(null);

  const [showAddKey, setShowAddKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyPem, setNewKeyPem] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { void loadKeys(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadKeys() {
    const [sys, db] = await Promise.all([
      invoke<SystemKey[]>("ssh_list_system_keys"),
      getDb(),
    ]);
    setSystemKeys(sys);
    const rows = await db.select<{ id: string; name: string }[]>(
      "SELECT id, name FROM ssh_keys ORDER BY created_at ASC",
      [],
    );
    setAppKeys(rows);

    // Auto-select first key
    const first: KeySource | null =
      sys[0] ? { type: "system", name: sys[0].name } :
      rows[0] ? { type: "app", id: rows[0].id, name: rows[0].name } :
      null;

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
        } catch { /* .pub might not exist */ }
      }
    }
  }

  async function resolveAndEmit(source: KeySource) {
    if (source.type === "system") {
      const key = await invoke<string>("ssh_read_system_key", { name: source.name });
      onKeyResolved(key);
    } else {
      const db = await getDb();
      const rows = await db.select<{ encrypted_key: string; key_iv: string }[]>(
        "SELECT encrypted_key, key_iv FROM ssh_keys WHERE id = $1",
        [source.id],
      );
      if (!rows[0]) return;
      const key = await invoke<string>("decrypt_value", {
        ciphertext: rows[0].encrypted_key,
        iv: rows[0].key_iv,
      });
      onKeyResolved(key);
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
      } catch { /* .pub might not exist */ }
    }
  }

  async function saveAppKey() {
    if (!newKeyName.trim() || !newKeyPem.trim()) return;
    setSaving(true);
    try {
      const { ciphertext, iv } = await invoke<{ ciphertext: string; iv: string }>(
        "encrypt_value",
        { plaintext: newKeyPem.trim() },
      );
      const db = await getDb();
      const id = crypto.randomUUID();
      await db.execute(
        "INSERT INTO ssh_keys (id, name, encrypted_key, key_iv) VALUES ($1, $2, $3, $4)",
        [id, newKeyName.trim(), ciphertext, iv],
      );
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
        <label className="text-xs text-gray-500 w-20 shrink-0">Username</label>
        <input
          value={username}
          onChange={(e) => onUsernameChange(e.target.value)}
          className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 font-mono focus:outline-none focus:border-gray-500"
          placeholder="root"
          spellCheck={false}
        />
      </div>

      {/* Key picker */}
      <div className="flex items-start gap-3">
        <label className="text-xs text-gray-500 w-20 shrink-0 pt-1">SSH Key</label>
        <div className="flex-1 space-y-1">
          {systemKeys.length === 0 && appKeys.length === 0 ? (
            <p className="text-xs text-gray-600 py-1">No keys found.</p>
          ) : (
            <>
              {systemKeys.length > 0 && (
                <div className="space-y-0.5">
                  <p className="text-xs text-gray-700 px-1 pb-0.5">System (~/.ssh)</p>
                  {systemKeys.map((k) => (
                    <KeyRow
                      key={k.name}
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
                  <p className="text-xs text-gray-700 px-1 pb-0.5">Saved keys</p>
                  {appKeys.map((k) => (
                    <KeyRow
                      key={k.id}
                      label={k.name}
                      selected={selectedKey?.type === "app" && selectedKey.id === k.id}
                      onSelect={() => void selectKey({ type: "app", id: k.id, name: k.name })}
                      onDelete={() => void deleteAppKey(k.id)}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {showAddKey ? (
            <div className="mt-2 space-y-2 p-3 rounded-lg border border-gray-700 bg-gray-900">
              <input
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 font-mono focus:outline-none focus:border-gray-500"
                placeholder="Key name (e.g. my-droplet-key)"
                spellCheck={false}
              />
              <textarea
                value={newKeyPem}
                onChange={(e) => setNewKeyPem(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 font-mono focus:outline-none focus:border-gray-500 resize-none"
                rows={5}
                placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----"}
                spellCheck={false}
              />
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => { setShowAddKey(false); setNewKeyName(""); setNewKeyPem(""); }}
                  className="px-3 py-1 text-xs text-gray-500 hover:text-gray-300 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void saveAppKey()}
                  disabled={saving || !newKeyName.trim() || !newKeyPem.trim()}
                  className="px-3 py-1 rounded bg-gray-700 hover:bg-gray-600 text-xs text-gray-200 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {saving ? "Saving..." : "Save Key"}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowAddKey(true)}
              className="mt-1 text-xs text-gray-600 hover:text-gray-400 transition-colors"
            >
              + Add key to registry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function KeyRow({
  label,
  sublabel,
  selected,
  onSelect,
  onDelete,
}: {
  label: string;
  sublabel?: string;
  selected: boolean;
  onSelect: () => void;
  onDelete?: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={`group flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer transition-colors ${
        selected
          ? "bg-blue-950 border border-blue-800 text-blue-300"
          : "hover:bg-gray-800 border border-transparent text-gray-400"
      }`}
    >
      <span className="text-xs shrink-0">{selected ? "◉" : "○"}</span>
      <span className="text-xs font-mono flex-1 truncate">
        {sublabel && <span className="text-gray-600">{sublabel}</span>}
        {label}
      </span>
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="opacity-0 group-hover:opacity-100 text-gray-600 hover:text-red-400 text-xs px-1 transition-all"
          title="Remove key"
        >
          ✕
        </button>
      )}
    </div>
  );
}
