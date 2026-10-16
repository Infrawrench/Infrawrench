import { Stack } from "expo-router";
import { colors } from "@/lib/theme";

export default function ResourceReportsLayout() {
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
