/**
 * Secure token storage using expo-secure-store.
 * Replaces localStorage (web) with an encrypted on-device keystore.
 * All methods are async.
 */
import * as SecureStore from 'expo-secure-store';

const TOKEN_KEY = 'sr_token';
const USER_KEY  = 'sr_user';

export const storage = {
  getToken:  ()          => SecureStore.getItemAsync(TOKEN_KEY),
  setToken:  (val)       => SecureStore.setItemAsync(TOKEN_KEY, val),
  clearToken: ()         => SecureStore.deleteItemAsync(TOKEN_KEY),

  async getUser() {
    const raw = await SecureStore.getItemAsync(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  },
  setUser:   (user)      => SecureStore.setItemAsync(USER_KEY, JSON.stringify(user)),
  clearUser: ()          => SecureStore.deleteItemAsync(USER_KEY),

  async clearAll() {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    await SecureStore.deleteItemAsync(USER_KEY);
  },
};
