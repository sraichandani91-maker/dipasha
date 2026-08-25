/**
 * Design tokens — single source of truth for both the web console and the
 * staff app. No component anywhere should hard-code a hex value; import
 * from here instead. See ../README.md for the rule this file exists to
 * protect: brand colour lives in chrome, status colour lives in data.
 *
 * ESTIMATED FROM SCREENSHOTS, NOT PIXEL-SAMPLED FROM CSS.
 * This build environment cannot reach dipashamedicalstore.in directly, so
 * these values were read visually off the logo and a homepage screenshot,
 * not extracted from the live stylesheet. Close, but if pixel-perfect
 * brand matching ever matters, pull the exact hex codes from the site's
 * CSS/inspector and replace these. See ../README.md.
 */

export const colors = {
  // -- Brand (chrome only: nav, primary buttons, active tabs, login) --
  brandGreen: "#167A4B",
  brandGreenDark: "#0F5C39",
  brandGreenTint: "#EAF7F1",

  // -- Data surfaces --
  surface: "#FFFFFF",
  textPrimary: "#1A1A1A",
  textSecondary: "#5B6B63",
  border: "#E3E8E5",

  // -- Status (deliberately distinct from brand green) --
  statusGood: "#2F9E44",
  statusWarn: "#E8A317",
  statusBad: "#D64545",
  statusInfo: "#2B6CB0",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radii = {
  sm: 4,
  md: 8,
  lg: 12,
} as const;

export const touchTarget = {
  minDp: 44,
} as const;

export type ColorToken = keyof typeof colors;
