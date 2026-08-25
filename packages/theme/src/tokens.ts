/**
 * Design tokens — single source of truth for both the web console and the
 * staff app. No component anywhere should hard-code a hex value; import
 * from here instead. See ../README.md for the rule this file exists to
 * protect: brand colour lives in chrome, status colour lives in data.
 *
 * PLACEHOLDER VALUES — REPLACE BEFORE M2 SHIP.
 * These were not read from https://dipashamedicalstore.in/ — this build
 * environment's network egress is blocked to that domain. Replace every
 * value below with the real hex codes from the site's stylesheet, then
 * delete this notice.
 */

export const colors = {
  // -- Brand (chrome only: nav, primary buttons, active tabs, login) --
  brandGreen: "#1E7D46",
  brandGreenDark: "#14582F",
  brandGreenTint: "#EAF6EE",

  // -- Data surfaces --
  surface: "#FFFFFF",
  textPrimary: "#1A1A1A",
  textSecondary: "#5F6B66",
  border: "#E1E6E3",

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
