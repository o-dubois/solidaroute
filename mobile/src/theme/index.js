/**
 * Shared design tokens — mirrors the web app's Tailwind teal palette.
 * Import from here rather than hard-coding colors in components.
 *
 * Dark mode pattern:
 *   import { useColors, useShared, spacing, radius } from '../../theme';
 *   const c  = useColors();   // light or dark color set based on OS preference
 *   const sh = useShared();   // pre-built StyleSheet using the correct color set
 */
import { StyleSheet } from 'react-native';
import { useColorScheme } from 'react-native';

// ─── Light palette ────────────────────────────────────────────────────────────
export const colors = {
  // Brand
  teal600:  '#0d9488',
  teal700:  '#0f766e',
  teal500:  '#14b8a6',
  teal200:  '#99f6e4',
  teal100:  '#ccfbf1',
  teal50:   '#f0fdfa',

  // Grays (light mode: darker = higher number)
  gray900:  '#111827',
  gray800:  '#1f2937',
  gray700:  '#374151',
  gray600:  '#4b5563',
  gray500:  '#6b7280',
  gray400:  '#9ca3af',
  gray300:  '#d1d5db',
  gray200:  '#e5e7eb',
  gray100:  '#f3f4f6',
  gray50:   '#f9fafb',
  white:    '#ffffff',

  // Semantic surface keys (change between modes)
  surface:  '#ffffff',   // card / input background
  screenBg: '#f9fafb',   // full-screen background

  // Semantic status
  red500:   '#ef4444',
  red50:    '#fef2f2',
  amber700: '#b45309',
  amber50:  '#fffbeb',
  green600: '#16a34a',
};

// ─── Dark palette ─────────────────────────────────────────────────────────────
export const darkColors = {
  // Brand — teal is fine on dark backgrounds
  teal600:  '#0d9488',
  teal700:  '#0f766e',
  teal500:  '#14b8a6',
  teal200:  '#134e4a',
  teal100:  '#134e4a',
  teal50:   '#0f2621',

  // Grays (dark mode: semantic inversion — text becomes light, bg becomes dark)
  gray900:  '#f9fafb',   // primary text → near-white
  gray800:  '#f3f4f6',
  gray700:  '#d1d5db',   // secondary text
  gray600:  '#9ca3af',   // muted text
  gray500:  '#6b7280',
  gray400:  '#4b5563',   // subtle elements
  gray300:  '#374151',   // borders
  gray200:  '#374151',   // borders (same in dark)
  gray100:  '#1f2937',   // subtle card tint
  gray50:   '#f9fafb',   // keep as very-light for accents (use screenBg for screen bg)
  white:    '#ffffff',   // TRUE white — never changes (text on teal buttons, icons)

  // Semantic surface keys
  surface:  '#1f2937',   // dark card / input background (gray-800)
  screenBg: '#111827',   // dark full-screen background (gray-900)

  // Semantic status — lighter for dark-bg visibility
  red500:   '#f87171',
  red50:    '#450a0a',
  amber700: '#fbbf24',
  amber50:  '#291800',
  green600: '#4ade80',
};

export const spacing = {
  xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24,
};

export const radius = {
  sm: 8, md: 12, lg: 16, xl: 20, full: 9999,
};

// ─── Style factory ────────────────────────────────────────────────────────────
function makeShared(c) {
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: c.screenBg,
    },
    card: {
      backgroundColor: c.surface,
      borderRadius: radius.xl,
      padding: spacing.xl,
      marginHorizontal: spacing.lg,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.06,
      shadowRadius: 4,
      elevation: 2,
    },
    input: {
      borderWidth: 1,
      borderColor: c.gray300,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm + 2,
      fontSize: 14,
      color: c.gray900,
      backgroundColor: c.surface,
      marginBottom: spacing.sm,
    },
    inputFocused: {
      borderColor: c.teal600,
    },
    inputError: {
      borderColor: c.red500,
    },
    label: {
      fontSize: 13,
      fontWeight: '500',
      color: c.gray700,
      marginBottom: 4,
    },
    btnPrimary: {
      backgroundColor: c.teal600,
      borderRadius: radius.md,
      paddingVertical: spacing.md,
      alignItems: 'center',
      marginTop: spacing.sm,
    },
    btnPrimaryText: {
      color: '#ffffff',
      fontWeight: '600',
      fontSize: 15,
    },
    btnPrimaryDisabled: {
      backgroundColor: c.teal500,
      opacity: 0.6,
    },
    btnSecondary: {
      borderWidth: 1,
      borderColor: c.gray300,
      borderRadius: radius.md,
      paddingVertical: spacing.md,
      alignItems: 'center',
      marginTop: spacing.sm,
    },
    btnSecondaryText: {
      color: c.gray700,
      fontWeight: '500',
      fontSize: 15,
    },
    errorBox: {
      backgroundColor: c.red50,
      borderWidth: 1,
      borderColor: c.red500,
      borderRadius: radius.md,
      padding: spacing.md,
      marginBottom: spacing.md,
    },
    errorText: {
      color: c.red500,
      fontSize: 13,
    },
    warnBox: {
      backgroundColor: c.amber50,
      borderWidth: 1,
      borderColor: c.amber700,
      borderRadius: radius.md,
      padding: spacing.md,
      marginBottom: spacing.md,
    },
    warnText: {
      color: c.amber700,
      fontSize: 13,
    },
    fieldError: {
      color: c.red500,
      fontSize: 12,
      marginTop: -4,
      marginBottom: spacing.sm,
    },
    sectionTitle: {
      fontSize: 16,
      fontWeight: '600',
      color: c.gray900,
      marginBottom: spacing.lg,
    },
    logoBox: {
      width: 56,
      height: 56,
      backgroundColor: c.teal600,
      borderRadius: radius.lg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    center: {
      alignItems: 'center',
    },
  });
}

// Pre-built stylesheets for each mode
const lightShared = makeShared(colors);
const darkShared  = makeShared(darkColors);

// ─── Hooks ────────────────────────────────────────────────────────────────────
export function useColors() {
  const scheme = useColorScheme();
  return scheme === 'dark' ? darkColors : colors;
}

export function useShared() {
  const scheme = useColorScheme();
  return scheme === 'dark' ? darkShared : lightShared;
}

// Legacy export — light mode only. Use useShared() in new code.
export const shared = lightShared;
