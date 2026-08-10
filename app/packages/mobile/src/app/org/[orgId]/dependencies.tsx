import { useLocalSearchParams } from "expo-router";
import { ErrorView } from "@/components/ui";
import { DependenciesScreen } from "@/features/graph/DependenciesScreen";

/**
 * One resource's dependency neighbourhood and blast radius. `resourceId` rides
 * in the query string rather than a path segment — composite resource ids
 * contain slashes and colons.
 */
export default function DependenciesRoute() {
  const { resourceId } = useLocalSearchParams<{ resourceId?: string }>();
  if (!resourceId) return <ErrorView message="No resource to show dependencies for." />;
  return <DependenciesScreen resourceId={resourceId} />;
}
