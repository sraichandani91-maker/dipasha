# @dipasha/theme

Single source of truth for colour, spacing and radius tokens, shared by the web console and the staff app (build order Section 12C.5: theme created in M0, before any screen exists).

## ⚠️ Placeholder colours

`src/tokens.ts` and `src/tokens.css` currently hold **placeholder** brand green / tint values, not the real palette from https://dipashamedicalstore.in/. This build environment cannot reach that domain (network egress is blocked to it), so the real hex codes were never extracted.

**Before M2 (product master UI) ships**, replace every value in both files with the real values read from the live site's stylesheet — primary green, background tint, text colour, button accent — then delete the placeholder notices. Both files must stay in sync since there are only two of them.

## The rule this file protects

Brand colour lives in the chrome (nav, primary buttons, active tabs, login screen). Status colour lives in the data (margin bands, expiry proximity, schedule badges, stock-out states). `--status-good` is deliberately a *different* green from `--brand-green` — never reach for brand green to mean "good" on a data surface.

No component should hard-code a hex value. Import `colors` from `tokens.ts` (React Native / TS) or reference the CSS custom properties in `tokens.css` (web).
