import { useLocalSearchParams } from "expo-router";
import { IncidentDetailScreen } from "@/features/incidents/IncidentDetailScreen";

/** One incident: header, artefacts, the joined timeline and a note box. */
export default function IncidentDetailRoute() {
  const { incidentId } = useLocalSearchParams<{ incidentId: string }>();
  return <IncidentDetailScreen incidentId={incidentId} />;
}
