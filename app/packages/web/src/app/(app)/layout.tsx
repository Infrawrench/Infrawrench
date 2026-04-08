import { requireAuth } from "@/auth/session";
import { loadPlugins } from "@/plugins/loader";
import { AppShell } from "@/components/AppShell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requireAuth();
  await loadPlugins();

  return <AppShell>{children}</AppShell>;
}
