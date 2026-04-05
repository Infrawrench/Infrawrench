import { requireAuth } from "@/auth/session";
import { loadPlugins } from "@/plugins/loader";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireAuth();
  await loadPlugins();

  return (
    <div className="flex h-screen bg-gray-950 text-gray-100">
      {/* Sidebar placeholder — implemented in @infrawrench/ui */}
      <aside className="w-64 border-r border-gray-800 flex-shrink-0" id="sidebar-root" />
      <main className="flex-1 overflow-auto">{children}</main>
    </div>
  );
}
