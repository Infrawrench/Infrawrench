import { Stack } from "expo-router";
import { colors } from "@/lib/theme";

export default function ChatLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        contentStyle: { backgroundColor: colors.background },
      }}
    >
      <Stack.Screen name="index" options={{ headerShown: false }} />
      <Stack.Screen name="[conversationId]" options={{ title: "Conversation" }} />
    </Stack>
  );
}
