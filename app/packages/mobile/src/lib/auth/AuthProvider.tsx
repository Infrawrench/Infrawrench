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
import { handleHostKeyTrustConflict } from "../ssh/host-key-trust";
import { secureStoreStorage } from "./secure-store-storage";
import { unregisterCurrentDevice } from "../push";

const SELECTED_ORG_KEY = "cloud_selected_org";

/** Give up on the launch-path orgs fetch rather than spinning on a dead host. */
const ORG_FETCH_TIMEOUT_MS = 15_000;

/** AbortSignal that fires after `ms`. Hand-rolled: Hermes has no AbortSignal.timeout. */
function abortAfter(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

export type AuthState = "loading" | "signed-out" | "signed-in";

interface AuthContextValue {
  state: AuthState;
  email: string | null;
  orgs: CloudOrg[];
  /** Set when the last orgs fetch failed — `orgs` may be stale or empty. */
  orgsError: string | null;
  /**
   * Set when restoring the session failed outright (rather than resolving to
   * "signed out"). The sign-in screen shows it so a dead network doesn't look
   * like a spontaneous sign-out.
   */
  sessionError: string | null;
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
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [orgsError, setOrgsError] = useState<string | null>(null);
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
        // SSH-backed routes (SFTP, tunnels) answer 409 when the host key is
        // unknown or changed. Prompt, pin, and let the request replay.
        on409: handleHostKeyTrustConflict,
      }),
    [tokens],
  );

  const loadSession = useCallback(async () => {
    // Everything here runs while the launch screen shows a bare spinner, so
    // every path out of this function has to settle `state`. A throw used to
    // leave it on "loading" forever — no error, no retry, nothing to do but
    // reinstall.
    try {
      setSessionError(null);
      const authenticated = await tokens.isAuthenticated();
      if (!authenticated) {
        setState("signed-out");
        return;
      }
      setEmail(await tokens.getStoredEmail());
      const storedOrg = await SecureStore.getItemAsync(SELECTED_ORG_KEY);
      try {
        const orgList = await fetchOrgs(api, { signal: abortAfter(ORG_FETCH_TIMEOUT_MS) });
        setOrgs(orgList);
        setOrgsError(null);
        const valid = orgList.find((o) => o.id === storedOrg) ?? orgList[0];
        setOrgId(valid?.id ?? null);
      } catch (e) {
        // Orgs load can fail offline; stay signed in and restore the last
        // selected org so org-scoped screens (useOrgApi) still have an id.
        // Record the error so screens can tell "fetch failed" from "no orgs".
        setOrgsError(e instanceof Error ? e.message : "Failed to load organizations");
        if (storedOrg) setOrgId(storedOrg);
      }
      setState("signed-in");
    } catch (e) {
      // Unreadable secure storage, a wedged token refresh — we can't tell
      // whether the session is good, so send them to sign-in with the reason
      // rather than stranding them. Tokens are left alone: if they were fine,
      // signing in again is a no-op round trip.
      setSessionError(e instanceof Error ? e.message : "Couldn't restore your session");
      setState("signed-out");
    }
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
      orgsError,
      sessionError,
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
        try {
          const orgList = await fetchOrgs(api);
          setOrgs(orgList);
          setOrgsError(null);
        } catch (e) {
          setOrgsError(e instanceof Error ? e.message : "Failed to load organizations");
        }
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
    [state, email, orgs, orgsError, sessionError, orgId, tokens, api, loadSession],
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
