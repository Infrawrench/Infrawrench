import { useState, useEffect } from "react";
import { invoke } from "../../lib/invoke";

interface SshKeyEntry {
  name: string;       // display label, e.g. "id_rsa"
  publicKey: string;  // full public key content
  source: "system";
}

export function SshKeyPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [keys, setKeys] = useState<SshKeyEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const sysKeys = await invoke<{ name: string }[]>("ssh_list_system_keys");
        const entries: SshKeyEntry[] = [];
        await Promise.all(sysKeys.map(async ({ name }) => {
          try {
            const pub = await invoke<string>("ssh_read_system_key", { name: `${name}.pub` });
            if (!cancelled && pub.trim()) {
              entries.push({ name, publicKey: pub.trim(), source: "system" });
            }
          } catch { /* no .pub file for this key */ }
        }));
        if (!cancelled) setKeys(entries.sort((a, b) => a.name.localeCompare(b.name)));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  if (loading) {
    return <p className="text-xs text-gray-600 py-1">Scanning ~/.ssh…</p>;
  }

  if (keys.length === 0) {
    return <p className="text-xs text-gray-600 py-1">No public keys found in ~/.ssh/</p>;
  }

  const noneSelected = !value;

  return (
    <div className="border border-gray-700 rounded-lg overflow-hidden divide-y divide-gray-700/40">
      {/* None option */}
      <button
        onClick={() => onChange("")}
        className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-2 ${
          noneSelected ? "bg-blue-600/20 text-blue-300" : "text-gray-500 hover:bg-gray-800"
        }`}
      >
        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${noneSelected ? "bg-blue-400" : "bg-gray-700"}`} />
        No SSH key
      </button>

      {keys.map((k) => {
        const selected = value === k.publicKey;
        const keyType = k.publicKey.split(" ")[0] ?? "";
        return (
          <button
            key={k.name}
            onClick={() => onChange(k.publicKey)}
            className={`w-full text-left px-3 py-2.5 text-sm transition-colors flex items-center gap-3 ${
              selected ? "bg-blue-600/20 text-blue-300" : "text-gray-300 hover:bg-gray-800"
            }`}
          >
            <span className={`w-2 h-2 rounded-full flex-shrink-0 ${selected ? "bg-blue-400" : "bg-gray-700"}`} />
            <span className="flex-1 min-w-0">
              <span className="font-medium block">{k.name}</span>
              <span className="text-[11px] text-gray-600">~/.ssh/{k.name}.pub · {keyType}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
