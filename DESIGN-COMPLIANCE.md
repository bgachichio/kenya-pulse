# Design compliance — design.md v1.1

Audited and brought into line on 29 August 2026. Every claim below is checked
by a test in `tests/`, not by eye: `node ui.js` guards the tokens, type and
shape; `node visual-check.mjs` renders the built app in Chromium and reads the
computed styles back in light, dark and at `xlarge`.

---

## §17 Checklist

**Substrate**

- [ ] shadcn/ui + Tailwind only — **exception, see below**
- [x] Zero hardcoded hex values in component files
- [x] Zero raw Tailwind palette classes (none exist; there is no Tailwind)

**Surface**

- [x] Every colour is an `--md-*` role token, taken verbatim from §4.2 / §4.3
- [ ] Green appears three times or fewer — **exception, see below**
- [x] Elevation from the six-level set; dark drops levels 1–2 to flat
- [x] Inter for UI and body, self-hosted. Courier Prime for `display-*` /
      `headline-*` only, self-hosted. No third family
- [x] Weights 400/500/600 on Inter, 400 on mono. Tracking `0em` on every mono token
- [x] No `px` font sizes anywhere
- [ ] Ripple + state layer on every button — **not done; see remaining work**

**Structure**

- [x] Surface tint and space carry separation
- [x] Cards at 20px (`--r-lg`). Sheets at 28px (`--r-xl`)
- [x] Spacing values from the 4/8 scale only
- [x] No element carries both a border and a shadow
- [x] Single column on mobile. Touch targets ≥ 44px in height, measured in a
      real browser on a phone profile, sheet included. One width exception,
      below

**Charts**

- [x] Horizontal rule only — the axis line, tick marks and border are gone
- [x] Title, unit, direct label on the hovered point, one-sentence summary
- [x] One series per chart, in `--md-primary`

**Non-negotiables**

- [x] Auto/Light/Dark, default Auto, persisted to `ui.theme`
- [x] Font size, four steps, persisted to `ui.fontScale`
- [x] No-FOUC script in `<head>`, reading the same two keys the app writes
- [x] Tested at `xlarge` and in dark mode — in a real browser, every build

**Accessibility**

- [x] WCAG 2.2 AA verified numerically on all twelve token pairs, both modes.
      Lowest passing ratio: 4.28:1 for outline against surface, floor 3.0 for
      UI parts. Body text runs 8.88:1 and up
- [x] Keyboard path complete, focus ring visible
- [x] `prefers-reduced-motion` and `prefers-reduced-transparency` respected

---

## §18 Exceptions — named, with reasons

**1. Substrate is inline styles, not shadcn/ui + Tailwind.**

The app predates design.md v1.1 and is one 2,000-line file with no build-time
CSS. Moving it onto Tailwind and shadcn means rewriting every element and
re-authoring 663 assertions against new markup, on an app that is live and
carries a daily notification people rely on. The gain is conformance; the cost
is a rewrite and a real chance of regression.

What was done instead: everything the substrate rule exists to deliver —
tokens, no stray hex, a real type scale in `rem`, shape and spacing tokens,
one easing — is now in place, declared in `index.css` and consumed through
`var()`. A future move to Tailwind reads those same custom properties, so this
is a step toward the rule rather than away from it.

**2. The vitals strip cannot give each mark 44px of width.**

The strip on the Pulse card draws one mark per indicator across the screen. At
33 indicators on a 360px phone, 44px each would need 1,452px. Every mark is a
44px *tall* target and carries its own name for a screen reader, which is what
the rule is actually protecting; the width is set by how many indicators there
are. Nothing in the strip is the only way to reach anything - every mark is a
shortcut to a row in the list below it.

**3. Green appears far more than three times per screen.**

The rule reserves `--md-primary` for the one primary action and the active
state. Kenya Pulse is a dashboard where **colour is the data**: a rung that
beats inflation is green, one that loses to it is red, across thirty
indicators, ten ladder rungs and a row of vitals at once. Reading that in a
single glance is the product. Obeying the rule literally would mean removing
the app's primary signal.

Colour never carries meaning alone (§13): every green or red is paired with a
sign, a figure, or a label. The rule is kept everywhere it was written for —
buttons, the active tab, the toggle — where green does mean "act here".

---

## Remaining work, honestly

- **Ripple and Material state layers** are not implemented. The app uses a
  scale-and-fade press affordance instead (`.kp-tap`). A ripple wants the
  `useRipple` hook from §16.1 and a positioned overlay on every button.
- **A move to Tailwind + shadcn** would close exception 1. The token layer is
  the prerequisite and it now exists.

---

## What changed in this pass

Removed: two hardcoded palettes in JavaScript (26 hex values), a decorative
green-to-orange gradient on the app mark, the chart's axis line, sixteen copies
of the same easing curve, one `px` font size and one `clamp()` in px, 30 lines
carrying em dashes in interface copy.

Added: `index.css` with the full token set for both modes, self-hosted Inter
and Courier Prime, a `rem` type scale driven by one `--font-scale` variable,
the pre-paint theme script, and `ui.theme` / `ui.fontScale` as the canonical
keys — which also fixed a real bug where the app's own store could drift from
the keys the pre-paint script reads, showing the wrong theme for a frame.
