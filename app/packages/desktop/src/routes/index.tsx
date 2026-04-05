import { useEffect } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { getDb } from "../db/client";

export const Route = createFileRoute("/")({
  component: IndexPage,
});

function IndexPage() {
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    async function redirect() {
      try {
        const db = await getDb();
        const rows = await db.select<{ id: string }[]>(
          "SELECT id FROM dashboards WHERE is_default = 1 LIMIT 1",
        );
        if (cancelled) return;
        let homeId: string;
        if (rows[0]) {
          homeId = rows[0].id;
        } else {
          homeId = crypto.randomUUID();
          await db.execute(
            "INSERT INTO dashboards (id, name, is_default) VALUES ($1, $2, 1)",
            [homeId, "Home"],
          );
        }
        if (!cancelled) {
          navigate({ to: "/dashboard/$dashboardId", params: { dashboardId: homeId }, replace: true });
        }
      } catch {
        // If DB fails, just stay on the loading screen
      }
    }
    void redirect();
    return () => { cancelled = true; };
  }, [navigate]);

  return (
    <div className="flex items-center justify-center h-full text-gray-600 text-sm">
      Loading…
    </div>
  );
}
