import { Tabs, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { Pressable } from "react-native";
import {
  ChatIcon,
  CostsIcon,
  HomeIcon,
  ResourcesIcon,
  SearchIcon,
  SettingsIcon,
  SwitchIcon,
} from "@/components/icons";
import { useAuth } from "@/lib/auth/AuthProvider";
import { registerForPush, watchPushTokenRotation } from "@/lib/push";
import { colors } from "@/lib/theme";

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
            <SwitchIcon color={colors.textMuted} size={20} />
          </Pressable>
        ),
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Home",
          tabBarIcon: ({ color, size }) => <HomeIcon color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="accounts"
        options={{
          title: "Resources",
          tabBarIcon: ({ color, size }) => <ResourcesIcon color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="costs"
        options={{
          title: "Costs",
          tabBarIcon: ({ color, size }) => <CostsIcon color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="chat"
        options={{
          title: "Chat",
          tabBarIcon: ({ color, size }) => <ChatIcon color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: "Search",
          tabBarIcon: ({ color, size }) => <SearchIcon color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: "Settings",
          tabBarIcon: ({ color, size }) => <SettingsIcon color={color} size={size} />,
        }}
      />
      {/* Non-tab screens within the org group */}
      <Tabs.Screen
        name="resources/[pluginId]/[resourceTypeId]/[resourceId]"
        options={{ href: null, title: "Resource" }}
      />
      <Tabs.Screen name="dashboard/[dashboardId]" options={{ href: null, title: "Dashboard" }} />
      <Tabs.Screen name="terminal/[kind]" options={{ href: null, title: "Terminal" }} />
      <Tabs.Screen name="files/[accountId]" options={{ href: null, title: "Files" }} />
      <Tabs.Screen name="tools/[tool]" options={{ href: null, title: "Tools" }} />
      <Tabs.Screen name="workflows" options={{ href: null, title: "Workflows" }} />
      <Tabs.Screen name="agents" options={{ href: null, title: "Agents" }} />
    </Tabs>
  );
}
