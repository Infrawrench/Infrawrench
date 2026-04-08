import { notFound } from "next/navigation";
import { getDashboardWithPins } from "@/actions/dashboard";
import { DashboardView } from "@/components/DashboardView";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ dashboardId: string }>;
}) {
  const { dashboardId } = await params;
  const result = await getDashboardWithPins(dashboardId);

  if (!result) notFound();

  return (
    <DashboardView
      dashboardId={result.dashboard.id}
      dashboardName={result.dashboard.name}
      pins={result.pins}
    />
  );
}
