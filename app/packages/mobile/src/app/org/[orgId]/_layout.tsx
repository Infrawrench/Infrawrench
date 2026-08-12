import { Tabs, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect } from "react";
import { Pressable } from "react-native";
import {
  BackIcon,
  ChatIcon,
  CostsIcon,
  DashboardsIcon,
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
        // Six tabs share the bar, and at the stock 10pt "Dashboards" — the
        // longest label — ellipsizes to "Dashboa…" on a 375pt screen: each tab
        // gets ~62pt and the item's own 5pt padding is not ours to reclaim
        // (`tabBarItemStyle` dresses the outer pressable, not the inner row).
        // A point smaller fits every label with room to spare.
        tabBarLabelStyle: { fontSize: 9 },
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
          title: "Dashboards",
          tabBarIcon: ({ color, size }) => <DashboardsIcon color={color} size={size} />,
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
      <Tabs.Screen
        name="dashboard/[dashboardId]"
        options={{
          href: null,
          // Replaced with the dashboard's name once the screen has it.
          title: "Dashboard",
          // A screen pushed over a tab gets no back affordance of its own, and
          // the tab bar's Dashboards button would land on the list without
          // reading as "back" — so draw one.
          headerLeft: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to dashboards"
              onPress={() => router.navigate(`/org/${orgId}`)}
              style={{ paddingHorizontal: 12 }}
            >
              <BackIcon color={colors.text} size={22} />
            </Pressable>
          ),
        }}
      />
      <Tabs.Screen name="terminal/[kind]" options={{ href: null, title: "Terminal" }} />
      <Tabs.Screen name="files/[accountId]" options={{ href: null, title: "Files" }} />
      <Tabs.Screen name="tools/[tool]" options={{ href: null, title: "Tools" }} />
      <Tabs.Screen name="workflows" options={{ href: null, title: "Workflows" }} />
      <Tabs.Screen name="agents" options={{ href: null, title: "Agents" }} />
      <Tabs.Screen name="deployments" options={{ href: null, title: "Deploys" }} />
      <Tabs.Screen name="changes" options={{ href: null, title: "Changes" }} />
      <Tabs.Screen name="moment" options={{ href: null, title: "Moment" }} />
      <Tabs.Screen name="dependencies" options={{ href: null, title: "Dependencies" }} />
      <Tabs.Screen name="expiring" options={{ href: null, title: "Expiring" }} />
      <Tabs.Screen name="posture" options={{ href: null, title: "Posture" }} />
      <Tabs.Screen name="dns" options={{ href: null, title: "Domains" }} />
      <Tabs.Screen name="probes" options={{ href: null, title: "Probes" }} />
      <Tabs.Screen name="incidents" options={{ href: null, title: "Incidents" }} />
      <Tabs.Screen name="log-workspaces" options={{ href: null, title: "Log workspace" }} />
      <Tabs.Screen name="cost-reports" options={{ href: null, title: "Cost reports" }} />
    </Tabs>
  );
}
