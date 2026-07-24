import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { fetch as expoFetch } from "expo/fetch";
import * as SecureStore from "expo-secure-store";
import {
  TokenManager,
  createCloudFetch,
  fetchOrgs,
  type CloudFetch,
  type CloudOrg,
} from "@infrawrench/client-core";
import { CLIENT_ID, CLOUD_URL, WORKOS_API_URL } from "../../../env";
import { secureStoreStorage } from "./secure-store-storage";
import { unregisterCurrentDevice } from "../push";

const SELECTED_ORG_KEY = "cloud_selected_org";

export type AuthState = "loading" | "signed-out" | "signed-in";

interface AuthContextValue {
  state: AuthState;
  email: string | null;
  orgs: CloudOrg[];
  orgId: string | null;
  tokens: TokenManager;
  api: CloudFetch;
  /** Complete sign-in after the OAuth code exchange; loads orgs. */
  completeSignIn(): Promise<void>;
  selectOrg(orgId: string): Promise<void>;
  refreshOrgs(): Promise<void>;
  signOut(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<CloudOrg[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const authErrorRef = useRef<() => void>(() => {});

  const tokens = useMemo(
    () =>
      new TokenManager({
        storage: secureStoreStorage,
        clientId: CLIENT_ID,
        workosApiUrl: WORKOS_API_URL,
        fetch: expoFetch as unknown as typeof fetch,
        onAuthError: () => authErrorRef.current(),
      }),
    [],
  );

  const api = useMemo(
    () =>
      createCloudFetch({
        tokens,
        baseUrl: CLOUD_URL,
        fetch: expoFetch as unknown as typeof fetch,
      }),
    [tokens],
  );

  const loadSession = useCallback(async () => {
    const authenticated = await tokens.isAuthenticated();
    if (!authenticated) {
      setState("signed-out");
      return;
    }
    setEmail(await tokens.getStoredEmail());
    const storedOrg = await SecureStore.getItemAsync(SELECTED_ORG_KEY);
    try {
      const orgList = await fetchOrgs(api);
      setOrgs(orgList);
      const valid = orgList.find((o) => o.id === storedOrg) ?? orgList[0];
      setOrgId(valid?.id ?? null);
    } catch {
      // Orgs load can fail offline; stay signed in and restore the last
      // selected org so org-scoped screens (useOrgApi) still have an id.
      if (storedOrg) setOrgId(storedOrg);
    }
    setState("signed-in");
  }, [api, tokens]);

  useEffect(() => {
    authErrorRef.current = () => {
      setState("signed-out");
      setOrgId(null);
      setOrgs([]);
    };
    void loadSession();
  }, [loadSession]);

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      email,
      orgs,
      orgId,
      tokens,
      api,
      async completeSignIn() {
        await loadSession();
      },
      async selectOrg(next: string) {
        setOrgId(next);
        await SecureStore.setItemAsync(SELECTED_ORG_KEY, next);
      },
      async refreshOrgs() {
        const orgList = await fetchOrgs(api);
        setOrgs(orgList);
      },
      async signOut() {
        await unregisterCurrentDevice(api).catch(() => {});
        await tokens.clear();
        await SecureStore.deleteItemAsync(SELECTED_ORG_KEY);
        setState("signed-out");
        setEmail(null);
        setOrgs([]);
        setOrgId(null);
      },
    }),
    [state, email, orgs, orgId, tokens, api, loadSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

/** Convenience: the org-scoped API pair most screens need. */
export function useOrgApi(): { api: CloudFetch; orgId: string } {
  const { api, orgId } = useAuth();
  if (!orgId) throw new Error("No organization selected");
  return { api, orgId };
}
