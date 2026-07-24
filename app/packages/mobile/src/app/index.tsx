import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useAuth } from "@/lib/auth/AuthProvider";
import { colors } from "@/lib/theme";

export default function Index() {
  const { state, orgId } = useAuth();

  if (state === "loading") {
    return (
      <View
        style={{
          flex: 1,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.background,
        }}
      >
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }
  if (state === "signed-out") return <Redirect href="/sign-in" />;
  if (!orgId) return <Redirect href="/select-org" />;
  return <Redirect href={`/org/${orgId}`} />;
}
