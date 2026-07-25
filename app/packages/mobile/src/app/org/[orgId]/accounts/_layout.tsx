import { Stack } from "expo-router";
import { colors } from "@/lib/theme";

export default function AccountsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      {/* Title still matters with the header hidden — iOS uses it as the back label. */}
      <Stack.Screen name="index" options={{ headerShown: false, title: "Resources" }} />
      <Stack.Screen name="[accountId]" options={{ title: "Account" }} />
    </Stack>
  );
}
