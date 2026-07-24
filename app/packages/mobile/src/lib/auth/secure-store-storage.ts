import * as SecureStore from "expo-secure-store";
import type { TokenStorage } from "@infrawrench/client-core";

/**
 * TokenStorage backed by the platform keychain/keystore — the mobile analog
 * of the desktop's encrypted SQLite token store.
 */
export const secureStoreStorage: TokenStorage = {
  async get(key) {
    return SecureStore.getItemAsync(key);
  },
  async set(key, value) {
    await SecureStore.setItemAsync(key, value);
  },
  async delete(key) {
    await SecureStore.deleteItemAsync(key);
  },
};
