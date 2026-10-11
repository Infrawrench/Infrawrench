import { Stack } from "expo-router";
import { colors } from "@/lib/theme";

export default function DeliveryLayout() {
  return (
    <Stack
      screenOptions={{
        // The org Tabs navigator already renders a header for this route.
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    />
  );
}
