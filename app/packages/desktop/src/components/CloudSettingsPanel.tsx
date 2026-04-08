import { useState, useEffect } from "react";
import { invoke } from "../lib/invoke";
import { Modal } from "@infrawrench/ui";

interface CloudStatus {
  authenticated: boolean;
  email?: string;
  organizationId?: string;
  syncing?: boolean;
  lastSyncedAt?: string;
}

interface CloudSettingsPanelProps {
  onClose: () => void;
}

export function CloudSettingsPanel({ onClose }: CloudSettingsPanelProps) {
  const [status, setStatus] = useState<CloudStatus | null>(null);
  const [loading, setLoading] = useState(true);

  async function loadStatus() {
    setLoading(true);
    try {
      const result = await invoke<CloudStatus>("cloud_sync_status");
      setStatus(result);
    } catch {
      setStatus({ authenticated: false });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadStatus();
  }, []);

  async function handleSignIn() {
    await invoke("cloud_auth_start");
    // Poll for auth status after browser redirect
    const pollInterval = setInterval(async () => {
      const s = await invoke<CloudStatus>("cloud_auth_status");
      if (s.authenticated) {
        clearInterval(pollInterval);
        setStatus(s);
      }
    }, 2000);
    // Stop polling after 5 minutes
    setTimeout(() => clearInterval(pollInterval), 300_000);
  }

  async function handleSignOut() {
    await invoke("cloud_auth_logout");
    setStatus({ authenticated: false });
  }

  async function handleSyncNow() {
    setStatus((s) => s ? { ...s, syncing: true } : s);
    await invoke("cloud_sync_now");
    await loadStatus();
  }

  return (
    <Modal onClose={onClose}>
      <div className="bg-gray-900 border border-gray-700 rounded-xl w-full max-w-sm shadow-2xl">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-800">
          <h2 className="text-sm font-semibold text-gray-200">Infrawrench Cloud</h2>
          <button onClick={onClose} className="text-gray-600 hover:text-gray-400 text-lg">
            &#215;
          </button>
        </div>

        <div className="p-5">
          {loading ? (
            <p className="text-xs text-gray-600">Loading...</p>
          ) : status?.authenticated ? (
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-400 mb-1">Signed in as</label>
                <p className="text-sm text-gray-200">{status.email}</p>
              </div>
              {status.organizationId && (
                <div>
                  <label className="block text-xs text-gray-400 mb-1">Organization</label>
                  <p className="text-xs text-gray-400 font-mono">{status.organizationId}</p>
                </div>
              )}
              <div>
                <label className="block text-xs text-gray-400 mb-1">Sync status</label>
                <div className="flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full ${
                      status.syncing ? "bg-yellow-400 animate-pulse" : "bg-green-400"
                    }`}
                  />
                  <span className="text-xs text-gray-300">
                    {status.syncing ? "Syncing..." : "Synced"}
                  </span>
                </div>
              </div>
              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => void handleSyncNow()}
                  disabled={!!status.syncing}
                  className="flex-1 px-3 py-2 text-sm border border-gray-700 rounded-lg text-gray-300 hover:text-gray-100 hover:border-gray-600 disabled:opacity-50 transition-colors"
                >
                  Sync now
                </button>
                <button
                  onClick={() => void handleSignOut()}
                  className="flex-1 px-3 py-2 text-sm border border-gray-700 rounded-lg text-red-400 hover:text-red-300 hover:border-red-500/50 transition-colors"
                >
                  Sign out
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-gray-400">
                Sign in to sync your accounts and dashboards across devices.
              </p>
              <button
                onClick={() => void handleSignIn()}
                className="w-full px-3 py-2 text-sm font-medium bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
              >
                Sign in to Infrawrench Cloud
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
