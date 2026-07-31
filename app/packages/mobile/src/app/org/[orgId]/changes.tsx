import { useLocalSearchParams } from "expo-router";
import { ChangesScreen } from "@/features/changes/ChangesScreen";

/**
 * The org change timeline. `since` and `accountId` are how a `resource_drift`
 * push notification hands over the window it summarised — see `pushDataToPath`
 * in `lib/push.ts`; both are absent when the screen is opened by hand.
 */
export default function ChangesRoute() {
  const { since, accountId } = useLocalSearchParams<{ since?: string; accountId?: string }>();
  return <ChangesScreen since={since} accountId={accountId} />;
}
