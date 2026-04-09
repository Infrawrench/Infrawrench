import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";

const NAV_ITEMS = [
  { to: "/settings", label: "General" },
  { to: "/settings/team", label: "Team" },
  { to: "/settings/api-keys", label: "API Keys" },
  { to: "/settings/billing", label: "Billing" },
  { to: "/settings/audit-log", label: "Audit Log" },
];

export const Route = createFileRoute("/settings")({
  component: SettingsLayout,
});

function SettingsLayout() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className="flex h-full">
      <nav className="w-48 border-r border-gray-800 p-4 flex-shrink-0">
        <h2 className="text-sm font-semibold text-gray-300 mb-4">Settings</h2>
        <ul className="space-y-1">
          {NAV_ITEMS.map((item) => {
            const isActive =
              item.to === "/settings"
                ? pathname === "/settings"
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
