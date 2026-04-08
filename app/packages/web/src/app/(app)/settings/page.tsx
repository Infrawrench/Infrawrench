import { requireAuth } from "@/auth/session";

export default async function SettingsPage() {
  const session = await requireAuth();

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
