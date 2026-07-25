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
      {/* Title still matters with the header hidden — iOS uses it as the back label. */}
      <Stack.Screen name="index" options={{ headerShown: false, title: "Chats" }} />
      <Stack.Screen name="[conversationId]" options={{ title: "Conversation" }} />
    </Stack>
  );
}
