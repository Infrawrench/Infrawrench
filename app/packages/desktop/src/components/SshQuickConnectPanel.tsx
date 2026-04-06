import { useState, useEffect } from "react";
import { SshTerminal } from "./SshTerminal";
import { invoke } from "../lib/invoke";
import { getDb } from "../db/client";

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── Main component ────────────────────────────────────────────────────────────

interface SshQuickConnectPanelProps {
  host: string;
}

export function SshQuickConnectPanel({ host }: SshQuickConnectPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [systemKeys, setSystemKeys] = useState<SystemKey[]>([]);
  const [appKeys, setAppKeys] = useState<AppKey[]>([]);
  const [selectedKey, setSelectedKey] = useState<KeySource | null>(null);
  const [username, setUsername] = useState("root");
  const [connected, setConnected] = useState(false);
  const [resolvedKey, setResolvedKey] = useState<string | null>(null);

  // Add-key form state
  const [showAddKey, setShowAddKey] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyPem, setNewKeyPem] = useState("");
  const [saving, setSaving] = useState(false);

  // Load keys when panel expands
  useEffect(() => {
    if (!expanded) return;
    void loadKeys();
  }, [expanded]);

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
    // Auto-select first available key and derive username from its public key comment
    setSelectedKey((prev) => {
      if (prev) return prev;
      if (sys[0]) return { type: "system", name: sys[0].name };
      if (rows[0]) return { type: "app", id: rows[0].id, name: rows[0].name };
      return null;
    });
    if (sys[0]) {
      try {
        const pub = await invoke<string>("ssh_read_system_key", { name: `${sys[0].name}.pub` });
        const comment = pub.trim().split(" ")[2];
        if (comment) setUsername((prev) => (prev === "root" ? comment.split("@")[0] : prev));
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
    setSelectedKey((prev) =>
      prev?.type === "app" && prev.id === id ? null : prev,
    );
  }

  async function connect() {
    if (!selectedKey) return;
    let key: string;
    if (selectedKey.type === "system") {
      key = await invoke<string>("ssh_read_system_key", { name: selectedKey.name });
    } else {
      const db = await getDb();
      const rows = await db.select<{ encrypted_key: string; key_iv: string }[]>(
        "SELECT encrypted_key, key_iv FROM ssh_keys WHERE id = $1",
        [selectedKey.id],
      );
      if (!rows[0]) throw new Error("Key not found");
      key = await invoke<string>("decrypt_value", {
        ciphertext: rows[0].encrypted_key,
        iv: rows[0].key_iv,
      });
    }
    setResolvedKey(key);
    setConnected(true);
  }

  // ── Connected — show terminal ───────────────────────────────────────────────

  if (connected && resolvedKey) {
    return (
      <div className="flex flex-col flex-1 min-h-0 border-t border-gray-800">
        <button
          onClick={() => { setConnected(false); setResolvedKey(null); }}
          className="w-full flex items-center gap-2 px-4 py-1.5 border-b border-gray-800 text-xs text-gray-600 hover:text-gray-400 hover:bg-gray-800/40 transition-colors shrink-0"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-green-500 shrink-0" />
          <span className="font-mono">{username}@{host}</span>
          <span className="ml-auto text-gray-700 hover:text-gray-500">Disconnect ✕</span>
        </button>
        <SshTerminal host={host} port={22} username={username} privateKey={resolvedKey} />
      </div>
    );
  }

  // ── Collapsed ─────────────────────────────────────────────────────────────

  return (
    <div className="border-t border-gray-800 shrink-0">
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-2 px-4 py-2 text-xs text-gray-600 hover:text-gray-400 hover:bg-gray-800/40 transition-colors"
      >
        <span
          className="inline-block transition-transform text-xs"
          style={{ transform: expanded ? "rotate(90deg)" : "rotate(0deg)" }}
        >
          ▶
        </span>
        <span className="font-mono text-green-600 text-xs">SSH</span>
        <span className="text-gray-700 font-mono">{host}</span>
        {!expanded && <span className="ml-auto text-gray-700">Connect…</span>}
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 bg-gray-950/60">
          {/* Username */}
          <div className="flex items-center gap-3">
            <label className="text-xs text-gray-500 w-20 shrink-0">Username</label>
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-gray-200 font-mono focus:outline-none focus:border-gray-500"
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
                          onSelect={async () => {
                            setSelectedKey({ type: "system", name: k.name });
                            try {
                              const pub = await invoke<string>("ssh_read_system_key", { name: `${k.name}.pub` });
                              const comment = pub.trim().split(" ")[2];
                              if (comment) setUsername((prev) => (prev === "root" || prev === comment.split("@")[0] ? comment.split("@")[0] : prev));
                            } catch { /* .pub might not exist */ }
                          }}
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
                          onSelect={() => setSelectedKey({ type: "app", id: k.id, name: k.name })}
                          onDelete={() => void deleteAppKey(k.id)}
                        />
                      ))}
                    </div>
                  )}
                </>
              )}

              {/* Add key inline form */}
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
                      {saving ? "Saving…" : "Save Key"}
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

          {/* Connect button */}
          <div className="flex justify-end pt-1">
            <button
              onClick={() => void connect()}
              disabled={!selectedKey}
              className="px-4 py-1.5 rounded-lg bg-green-900 border border-green-700 hover:bg-green-800 hover:border-green-600 text-green-300 hover:text-green-200 text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              ⌨ Connect
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Key row sub-component ─────────────────────────────────────────────────────

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
  onSelect: () => void | Promise<void>;
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
