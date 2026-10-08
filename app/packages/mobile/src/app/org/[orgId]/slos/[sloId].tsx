import { useLocalSearchParams } from "expo-router";
import { SloDetailScreen } from "@/features/slos/SloDetailScreen";

/** One SLO: budget, burn rates and the SLI and burndown charts. */
export default function SloDetailRoute() {
  const { sloId } = useLocalSearchParams<{ sloId: string }>();
  return <SloDetailScreen sloId={sloId} />;
}
