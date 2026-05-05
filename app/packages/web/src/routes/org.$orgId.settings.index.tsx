import { createFileRoute, useParams } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { apiGet } from "@/lib/api";

export const Route = createFileRoute("/org/$orgId/settings/")({
  component: SettingsGeneralPage,
});

function SettingsGeneralPage() {
  const { orgId } = useParams({ from: "/org/$orgId/settings/" });
  const [session, setSession] = useState<{ email: string } | null>(null);

  useEffect(() => {
    apiGet<{ email: string }>("/api/auth/me").then(setSession);
  }, []);

  if (!session)
    return <div className="text-on-surface-muted text-sm animate-pulse">Loading...</div>;

  return (
    <div>
      <h1 className="text-xl font-semibold mb-6">General</h1>
      <div className="space-y-4">
        <div>
          <label className="block text-xs text-on-surface-tertiary mb-1">Email</label>
          <p className="text-sm text-on-surface-secondary">{session.email}</p>
        </div>
        <div>
          <label className="block text-xs text-on-surface-tertiary mb-1">Organization ID</label>
          <p className="text-sm text-on-surface-secondary font-mono">{orgId}</p>
        </div>
      </div>
    </div>
  );
}
