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
      {/* Title still matters with the header hidden — iOS uses it as the back label. */}
      <Stack.Screen name="index" options={{ headerShown: false, title: "Settings" }} />
      <Stack.Screen name="account" options={{ title: "Account" }} />
      <Stack.Screen name="team" options={{ title: "Team" }} />
      <Stack.Screen name="api-keys" options={{ title: "API keys" }} />
      <Stack.Screen name="audit-log" options={{ title: "Audit log" }} />
      <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
      <Stack.Screen name="approvals" options={{ title: "Approvals" }} />
      <Stack.Screen name="access-requests" options={{ title: "Break-glass access" }} />
      <Stack.Screen name="ssh-keys" options={{ title: "SSH keys" }} />
      <Stack.Screen name="billing" options={{ title: "Billing" }} />
    </Stack>
  );
}
