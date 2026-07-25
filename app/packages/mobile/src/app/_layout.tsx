import { useEffect, useRef } from "react";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Notifications from "expo-notifications";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthProvider, useAuth } from "@/lib/auth/AuthProvider";
import { configureNotificationHandler, parsePushData, pushDataToPath } from "@/lib/push";
import { colors } from "@/lib/theme";

configureNotificationHandler();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 15_000, retry: 1 },
  },
});

/** Routes notification taps once the user is signed in. */
function NotificationRouter() {
  const router = useRouter();
  const { state, orgId, selectOrg } = useAuth();
  // The effect re-runs on org switches; the launch response must only be
  // handled once per app session or every re-run replays the deep link.
  const coldStartHandled = useRef(false);

  useEffect(() => {
    if (state !== "signed-in") return;

    const route = async (response: Notifications.NotificationResponse) => {
      const data = parsePushData(response.notification.request.content.data);
      if (!data) return;
      if (data.orgId && data.orgId !== orgId) await selectOrg(data.orgId);
      router.push(pushDataToPath(data) as never);
    };

    // Cold-start tap: the response that launched the app.
    if (!coldStartHandled.current) {
      coldStartHandled.current = true;
      void Notifications.getLastNotificationResponseAsync().then((response) => {
        if (response) {
          void route(response).finally(() => {
            void Notifications.clearLastNotificationResponseAsync();
          });
        }
      });
    }
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      void route(response);
    });
    return () => sub.remove();
  }, [state, orgId, router, selectOrg]);

  return null;
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <NotificationRouter />
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.surface },
              headerTintColor: colors.text,
              contentStyle: { backgroundColor: colors.background },
            }}
          >
            {/* Titles matter even with headers hidden — iOS uses them as back labels. */}
            <Stack.Screen name="index" options={{ headerShown: false, title: "Infrawrench" }} />
            <Stack.Screen name="sign-in" options={{ headerShown: false, title: "Sign in" }} />
            <Stack.Screen name="select-org" options={{ title: "Choose organization" }} />
            <Stack.Screen
              name="org/[orgId]"
              options={{ headerShown: false, title: "Organization" }}
            />
          </Stack>
        </AuthProvider>
      </QueryClientProvider>
    </GestureHandlerRootView>
  );
}
