import { useState } from "react";

export interface RdpConnection {
  username: string;
  password: string;
  domain?: string;
}

interface WebRdpConnectPanelProps {
  host: string;
  defaultUsername?: string | null;
  onConnect: (connection: RdpConnection) => void;
}

// RDP has no key-based auth like SSH, and the password is never stored — so
// this form shows every time an RDP session is opened.
export function WebRdpConnectPanel({ host, defaultUsername, onConnect }: WebRdpConnectPanelProps) {
  const [username, setUsername] = useState(defaultUsername ?? "Administrator");
  const [password, setPassword] = useState("");
  const [domain, setDomain] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!username || !password) return;
    onConnect({ username, password, ...(domain ? { domain } : {}) });
  }

  return (
    <form onSubmit={submit} className="flex h-full flex-col items-center justify-center gap-3 px-4">
      <div className="w-full max-w-sm space-y-3 rounded-lg border border-border bg-surface p-5">
        <div className="text-sm font-medium text-on-surface-secondary">
          Connect to {host} via RDP
        </div>
        <label className="block text-xs text-on-surface-muted">
          Username
          <input
            type="text"
            value={username}
            autoFocus
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-on-surface-secondary"
          />
        </label>
        <label className="block text-xs text-on-surface-muted">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-on-surface-secondary"
          />
        </label>
        <label className="block text-xs text-on-surface-muted">
          Domain <span className="text-on-surface-faint">(optional)</span>
          <input
            type="text"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            className="mt-1 w-full rounded border border-border bg-background px-2 py-1.5 text-sm text-on-surface-secondary"
          />
        </label>
        <button
          type="submit"
          disabled={!username || !password}
          className="w-full rounded bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          Connect
        </button>
        <p className="text-[10px] leading-snug text-on-surface-faint">
          The password is used only for this session and is never stored.
        </p>
      </div>
    </form>
  );
}
