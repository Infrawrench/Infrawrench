import { Tabs, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { Pressable, Text } from "react-native";
import { useAuth } from "@/lib/auth/AuthProvider";
import { registerForPush, watchPushTokenRotation } from "@/lib/push";
import { colors } from "@/lib/theme";

function TabIcon({ glyph, color }: { glyph: string; color: string }) {
  return <Text style={{ color, fontSize: 20 }}>{glyph}</Text>;
}

export default function OrgLayout() {
  const router = useRouter();
  const { orgId } = useLocalSearchParams<{ orgId: string }>();
  const { state, orgId: selectedOrgId, selectOrg, api } = useAuth();

  // Keep the auth context's selected org in sync with the URL (deep links).
  useEffect(() => {
    if (state === "signed-in" && orgId && orgId !== selectedOrgId) {
      void selectOrg(orgId);
    }
  }, [state, orgId, selectedOrgId, selectOrg]);

  // Ensure the device is registered (idempotent) and follow token rotations.
  useEffect(() => {
    if (state !== "signed-in") return;
    void registerForPush(api).catch(() => {});
    return watchPushTokenRotation(api);
  }, [state, api]);

  useEffect(() => {
    if (state === "signed-out") router.replace("/sign-in");
  }, [state, router]);

  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.surface },
        headerTintColor: colors.text,
        tabBarStyle: { backgroundColor: colors.surface, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textMuted,
        sceneStyle: { backgroundColor: colors.background },
        headerRight: () => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Switch organization"
            onPress={() => router.push("/select-org")}
            style={{ paddingHorizontal: 16 }}
          >
            <Text style={{ color: colors.textMuted, fontSize: 18 }}>⇄</Text>
          </Pressable>
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{ title: "Home", tabBarIcon: ({ color }) => <TabIcon glyph="⌂" color={color} /> }}
      />
      <Tabs.Screen
        name="accounts"
        options={{
          title: "Resources",
          tabBarIcon: ({ color }) => <TabIcon glyph="▤" color={color} />,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{ title: "Chat", tabBarIcon: ({ color }) => <TabIcon glyph="✦" color={color} /> }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: "Search",
          tabBarIcon: ({ color }) => <TabIcon glyph="⌕" color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color }) => <TabIcon glyph="⚙" color={color} />,
        }}
      />
      {/* Non-tab screens within the org group */}
      <Tabs.Screen
        name="resources/[pluginId]/[resourceTypeId]/[resourceId]"
        options={{ href: null, title: "Resource" }}
      />
      <Tabs.Screen name="dashboard/[dashboardId]" options={{ href: null, title: "Dashboard" }} />
      <Tabs.Screen name="terminal/[sessionKey]" options={{ href: null, title: "Terminal" }} />
      <Tabs.Screen name="files/[accountId]" options={{ href: null, title: "Files" }} />
      <Tabs.Screen name="workflows" options={{ href: null, title: "Workflows" }} />
      <Tabs.Screen name="agents" options={{ href: null, title: "Agents" }} />
    </Tabs>
  );
}
