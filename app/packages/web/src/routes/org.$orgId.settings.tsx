import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";

export const Route = createFileRoute("/org/$orgId/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  const { orgId } = Route.useParams();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const navItems = [
    { to: `/org/${orgId}/settings`, label: "General" },
    { to: `/org/${orgId}/settings/team`, label: "Team" },
    { to: `/org/${orgId}/settings/roles`, label: "Roles" },
    { to: `/org/${orgId}/settings/ssh-keys`, label: "SSH Keys" },
    { to: `/org/${orgId}/settings/ssh-host-keys`, label: "Trusted SSH Hosts" },
    { to: `/org/${orgId}/settings/bastions`, label: "Bastions" },
    { to: `/org/${orgId}/settings/api-keys`, label: "API Keys" },
    { to: `/org/${orgId}/settings/paging`, label: "Paging" },
    { to: `/org/${orgId}/settings/billing`, label: "Billing" },
    { to: `/org/${orgId}/settings/audit-log`, label: "Audit Log" },
  ];

  return (
    <div className="flex h-full">
      <nav className="w-48 border-r border-border p-4 flex-shrink-0">
        <h2 className="text-sm font-semibold text-on-surface-secondary mb-4">Settings</h2>
        <ul className="space-y-1">
          {navItems.map((item) => {
            const isActive =
              item.to === `/org/${orgId}/settings`
                ? pathname === `/org/${orgId}/settings`
                : pathname.startsWith(item.to);
            return (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className={`block px-3 py-1.5 rounded-lg text-sm transition-colors ${
                    isActive
                      ? "bg-surface-overlay text-on-surface"
                      : "text-on-surface-tertiary hover:text-on-surface-secondary hover:bg-surface-overlay/50"
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="flex-1 overflow-auto p-6">
        <Outlet />
      </div>
    </div>
  );
}
