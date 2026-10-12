import { useLocalSearchParams } from "expo-router";
import { ServiceDetailScreen } from "@/features/services/ServiceDetailScreen";

/** One service: owners, cost, SLOs, on-call, findings, changes, members and scorecards. */
export default function ServiceDetailRoute() {
  const { serviceId } = useLocalSearchParams<{ serviceId: string }>();
  return <ServiceDetailScreen serviceId={serviceId} />;
}
