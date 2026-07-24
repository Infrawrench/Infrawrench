import { Stack } from "expo-router";
import { colors } from "@/lib/theme";

export default function SettingsLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="team" options={{ title: "Team" }} />
      <Stack.Screen name="api-keys" options={{ title: "API keys" }} />
      <Stack.Screen name="audit-log" options={{ title: "Audit log" }} />
      <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
      <Stack.Screen name="ssh-keys" options={{ title: "SSH keys" }} />
      <Stack.Screen name="billing" options={{ title: "Billing" }} />
    </Stack>
  );
}
