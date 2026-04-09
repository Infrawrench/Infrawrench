import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { apiGet } from "@/lib/api";

export const Route = createFileRoute("/settings/")({
  component: SettingsGeneralPage,
});

function SettingsGeneralPage() {
  const [session, setSession] = useState<{ email: string; organizationId: string } | null>(null);

  useEffect(() => {
    apiGet<{ email: string; organizationId: string }>("/api/auth/me").then(setSession);
  }, []);

  if (!session) return <div className="text-gray-500 text-sm animate-pulse">Loading…</div>;

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">General</h1>
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-gray-400 mb-1">Email</label>
          <p className="text-sm text-gray-200">{session.email}</p>
        </div>
        <div>
          <label className="block text-xs text-gray-400 mb-1">Organization ID</label>
          <p className="text-sm text-gray-200 font-mono">{session.organizationId}</p>
        </div>
      </div>
    </div>
  );
}
