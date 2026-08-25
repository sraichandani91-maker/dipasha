# @dipasha/theme

Single source of truth for colour, spacing and radius tokens, shared by the web console and the staff app (build order Section 12C.5: theme created in M0, before any screen exists).

## ⚠️ Estimated colours, not pixel-sampled

`src/tokens.ts` and `src/tokens.css` hold values read **visually** off the logo and a homepage screenshot the owner provided — this build environment cannot reach dipashamedicalstore.in directly, so the real hex codes were never pulled from the live stylesheet. They should be close (button green, hero background tint, heading colour, body text grey), but they are estimates.

If pixel-perfect brand matching ever matters, open the site's CSS/inspector, read the exact hex codes, and replace the values in both files. Both must stay in sync since there are only two of them.

**Logo vs. UI palette:** the logo mark itself uses a third colour — an orange-red — on the outer ring and one of the two pill capsules. The page chrome (buttons, headings, backgrounds) does not use it anywhere visible; it reads as white/green throughout, consistent with Section 12C. So orange isn't in these tokens. If a secondary accent is ever wanted (e.g. matching a WhatsApp-style CTA to the logo), that's a deliberate addition to make later, not an oversight now.

## The rule this file protects

Brand colour lives in the chrome (nav, primary buttons, active tabs, login screen). Status colour lives in the data (margin bands, expiry proximity, schedule badges, stock-out states). `--status-good` is deliberately a *different* green from `--brand-green` — never reach for brand green to mean "good" on a data surface.

No component should hard-code a hex value. Import `colors` from `tokens.ts` (React Native / TS) or reference the CSS custom properties in `tokens.css` (web).
