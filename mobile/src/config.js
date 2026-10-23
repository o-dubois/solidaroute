/**
 * Runtime configuration.
 *
 * API_URL priority:
 *   1. EXPO_PUBLIC_API_URL  — set in a .env file at the repo root (recommended for dev)
 *   2. app.json extra.apiUrl — fallback for EAS builds
 *   3. Hard-coded localhost  — last-resort for local emulator (Android emulator uses 10.0.2.2)
 *
 * Quick start:
 *   Create mobile/.env and add:
 *     EXPO_PUBLIC_API_URL=http://192.168.1.X:4000/api
 *   Replace 192.168.1.X with your computer's LAN IP (not localhost — Expo Go
 *   runs on your phone, which can't reach your computer's localhost).
 */
import Constants from 'expo-constants';

export const API_URL =
  process.env.EXPO_PUBLIC_API_URL ||
  Constants.expoConfig?.extra?.apiUrl ||
  Constants.manifest?.extra?.apiUrl ||
  'http://10.0.2.2:4000/api'; // Android emulator default
