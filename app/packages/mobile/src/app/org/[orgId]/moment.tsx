import { useLocalSearchParams } from "expo-router";
import { MomentScreen } from "@/features/moment/MomentScreen";

/**
 * The moment view — "what changed around 03:14?". `at` and `window` are how a
 * deep link (or an anomaly/drift/incident push — see `pushDataToPath` in
 * `lib/push.ts`) hands over its window; both absent means "around now".
 */
export default function MomentRoute() {
  const { at, window } = useLocalSearchParams<{ at?: string; window?: string }>();
  return <MomentScreen at={at} window={window} />;
}
