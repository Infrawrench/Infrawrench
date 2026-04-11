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
    { to: `/org/${orgId}/settings/api-keys`, label: "API Keys" },
    { to: `/org/${orgId}/settings/billing`, label: "Billing" },
    { to: `/org/${orgId}/settings/audit-log`, label: "Audit Log" },
  ];

  return (
    <div className="flex h-full">
      <nav className="w-48 border-r border-gray-800 p-4 flex-shrink-0">
        <h2 className="text-sm font-semibold text-gray-300 mb-4">Settings</h2>
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
                      ? "bg-gray-800 text-gray-100"
                      : "text-gray-400 hover:text-gray-200 hover:bg-gray-800/50"
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
