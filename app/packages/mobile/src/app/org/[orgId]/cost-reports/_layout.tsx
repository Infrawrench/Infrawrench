import { Stack } from "expo-router";
import { colors } from "@/lib/theme";

export default function CostReportsLayout() {
  return (
    <Stack
      screenOptions={{
        // The org Tabs navigator already renders a header for this route;
        // screens show their own titles inline instead of a second bar.
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
      }}
    />
  );
}
