import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { apiPost } from "@/lib/api";

export const Route = createFileRoute("/onboarding")({
  component: OnboardingPage,
});

function OnboardingPage() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleCreate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    try {
      const org = await apiPost<{ id: string; displayName: string }>("/api/orgs", {
        displayName: trimmed,
      });
      void navigate({ to: "/org/$orgId", params: { orgId: org.id } });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create organization");
      setCreating(false);
    }
  }

  return (
    <div className="flex h-screen items-center justify-center bg-surface text-on-surface">
      <div className="w-full max-w-md px-6">
        <h1 className="text-2xl font-bold mb-2">Create your organization</h1>
        <p className="text-sm text-on-surface-tertiary mb-8">
          Organizations let you manage infrastructure and collaborate with your team.
        </p>

        <label className="block text-sm font-medium text-on-surface-secondary mb-2">
          Organization name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void handleCreate();
          }}
          placeholder="My Company"
          autoFocus
          className="w-full bg-surface-overlay border border-border-strong rounded-lg px-4 py-3 text-sm text-on-surface-secondary placeholder:text-on-surface-faint focus:outline-none focus:border-border-strong mb-4"
        />

        {error && <p className="text-xs text-red-400 mb-4">{error}</p>}

        <button
          onClick={() => void handleCreate()}
          disabled={creating || !name.trim()}
          className="w-full px-4 py-3 text-sm font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg transition-colors"
        >
          {creating ? "Creating..." : "Create Organization"}
        </button>
      </div>
    </div>
  );
}
