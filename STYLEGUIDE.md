# Nyenrode Business Universiteit — Styleguide

Reverse-engineered from the live site (https://nyenrode.nl), September 2026.
Source of truth: `/styles/themes/corporate/styles.min.css` (a Tailwind CSS build) and the
homepage markup. Every value below is taken verbatim from that CSS — nothing is invented.

---

## 1. Brand colors

The site declares seven brand colors as CSS custom properties on `:root`:

```css
:root {
  --color-nyenrode-yellow:     #fbba20;
  --color-nyenrode-red:        #e4032c;
  --color-nyenrode-blue:       #0462b6;
  --color-nyenrode-dark-blue:  #355071;
  --color-nyenrode-light-blue: #0462b6;
  --color-nyenrode-bordeaux:   #7a103e;
  --color-nyenrode-gray:       #c8a3d9;
}
```

Note: `--color-nyenrode-blue` and `--color-nyenrode-light-blue` are the same value, and
`--color-nyenrode-gray` (`#c8a3d9`, a lilac) is *not* the gray actually used in the UI —
the utility classes use `#eceef2`. Treat the variables as legacy; the palette below is
what the components really render.

### Working palette

Each color exists as a `-500` base with a darker `-600` used for hover/focus.

| Role | Token | 500 (base) | 600 (hover) | On-color text |
|---|---|---|---|---|
| Primary | `primary` / `dark-blue` | `#355071` | `#2a405a` | white |
| Secondary | `secondary` / `yellow` | `#fbba20` | `#c9951a` | `#355071` (→ `#203044` on hover) |
| Accent blue | `light-blue` | `#0462b6` | `#034e92` | white |
| Alert / attention | `red` | `#e4032c` | `#b60223` | white |
| Accent deep | `bordeaux` | `#7a103e` | `#620d32` | white |
| Success | `green` | `#7abf3a` | `#62992e` | white |
| Neutral surface | `gray` | `#eceef2` | `#bdbec2` | `#355071` / black |

Supporting neutrals:

| Token | Value | Use |
|---|---|---|
| `gray-800` | `#5e5f61` | muted/secondary body text |
| `black` | `#000000` | default body copy |
| `white` | `#ffffff` | surfaces, inverted text |

### Usage rules observed on the site

- **`primary` (`#355071`) is the workhorse.** All headings, most links and the footer use it.
- **`primary-600` (`#2a405a`)** is the darker footer/section band and every primary hover state.
- **Yellow is a secondary CTA, never a text color on white.** It always carries dark-blue text.
- `text-*-inverted-500` tokens exist to pair with each background: red, bordeaux, dark-blue and
  light-blue invert to **white**; yellow, secondary and gray invert to **black**.
- Never place `yellow-500` text on white or `gray-500` text on white — both fail contrast and
  the CSS only ever uses them as backgrounds.

---

## 2. Typography

### Typefaces

| Family | Weights loaded | Role |
|---|---|---|
| **Noto Sans** | 600 | All headings (`h1`–`h6`, `.heading1`–`.heading6`) |
| **Open Sans** | 300–800, roman + italic | Body copy, UI, buttons. Applied via `.font-body` on `<body>` |
| **Cream** (Cream-Medium) | 500 | Display/campaign accent only, via `.font-['Cream']` |
| Font Awesome 6 Free (Solid) | — | Icons |

`font-display: swap` on every face. Open Sans 400/600/700, Noto Sans 600 and Cream Medium are
`<link rel="preload">`ed; the remaining Open Sans weights load on demand.

### Scale

Headings are Noto Sans 600 with `margin-bottom: 1rem`, color `#355071`.

| Class | Size | Line height |
|---|---|---|
| `.heading1` | `3rem` (48px) | `1.25` |
| `.heading2` | `1.875rem` (30px) | `1.25` |
| `.heading3` | `1.5rem` (24px) | `2rem` |
| `.heading4` | `1.25rem` (20px) | — |
| `.heading5` | `1.125rem` (18px) | `1.75rem` |
| `.heading6` | `0.875rem` (14px) | `1.25rem` |

**Responsive headings.** The page hero does not use `.heading1` directly at mobile width — it
uses `class="heading2 xl:heading1"`, i.e. 30px on small screens promoted to 48px from `xl`
(1280px) up. `lg:heading1` and container-query variants (`@sm:heading2`, `@3xl:heading1`) exist
for the same purpose. Follow this pattern rather than scaling headings with ad-hoc sizes.

### Body copy

- Base paragraph: `1rem / 1.5rem`, color `#000`.
- Prose blocks (`.prose`): `1rem / 1.75`, `max-width: 65ch`, paragraph margin `0.75em` top and
  bottom, headings `#355071`, links `#355071`.
- `p.intro` — the lead paragraph — is `font-weight: 700`.
- Utility weights available: `.font-normal` 400, `.font-semibold` 600, `.font-bold` 700,
  `.font-black` 900.

### Links

```css
.link          { text-decoration: underline; }
.link-primary  { color: #355071; }
```

The common pattern in markup is `class="link link-primary"` plus `hover:underline`. In the
desktop navigation links use `xl:decoration-2 xl:underline-offset-8` for a heavier, offset rule.

---

## 3. Buttons

Base class, applied to every button:

```css
.btn {
  display: flex;
  width: fit-content;
  align-items: center;
  justify-content: center;
  column-gap: .5rem;
  white-space: nowrap;
  border-width: 1px;
  border-color: transparent;
  padding: .625rem 1rem;
  text-align: center;
  font-weight: 700;
  text-transform: uppercase;
  text-decoration: none;
  transition: all .15s cubic-bezier(.4, 0, .2, 1);
}
```

Buttons are **square-cornered** (no radius), **uppercase**, **bold**, and always carry a 1px
border so solid and outline variants share the same box.

### Sizes

| Class | Padding | Font |
|---|---|---|
| `.btn-sm` | `.25rem .5rem` | `.875rem / 1.25rem` |
| (default) | `.625rem 1rem` | inherited |
| `.btn-lg` | `1rem 1.5rem` | `1.125rem / 1.75rem` |

### Variants

| Class | Background | Text | Hover background |
|---|---|---|---|
| `.btn-primary` | `#355071` | white | `#2a405a` |
| `.btn-secondary` / `.btn-yellow` | `#fbba20` | `#355071` | `#c9951a`, text `#203044` |
| `.btn-dark-blue` | `#355071` | white | `#2a405a` |
| `.btn-light-blue` | `#0462b6` | white | `#034e92` |
| `.btn-red` | `#e4032c` | white | `#b60223` |
| `.btn-bordeaux` | `#7a103e` | white | `#620d32` |
| `.btn-green` | `#7abf3a` | white | `#62992e` |
| `.btn-tertiary` / `.btn-gray` | `#eceef2` | `#355071` / black | `#bdbec2` |
| `.btn-outline-primary` | transparent, `#355071` border | `#355071` | `#2a405a` fill, white text |
| `.btn-outline-white` | transparent, white border | white | white fill |
| `.btn-primary-inverted` | white | `#355071` | `#2a405a` fill, white text |

Every variant defines `:hover` and `:focus` identically — focus is never left unstyled.

### Real-world combinations from the homepage

```html
<a class="btn btn-primary">…</a>
<a class="btn btn-light-blue btn-lg w-full">…</a>
<a class="btn btn-dark-blue btn-lg w-full">…</a>
<a class="btn btn-outline-primary btn-sm !font-normal
          group-hover:bg-primary-600 group-hover:border-primary-600
          group-hover:text-inverted-500">…</a>
```

Note the last one: inside a card the outline button reacts to the **card's** hover via `group-`
prefixes, so the whole card behaves as one target. `!font-normal` overrides the bold default when
the button sits inside dense card content.

---

## 4. Layout

### Breakpoints & container

Standard Tailwind breakpoints; `.container` is `width: 100%` capped at each step:

| Breakpoint | min-width | `.container` max-width |
|---|---|---|
| `sm` | 640px | 640px |
| `md` | 768px | 768px |
| `lg` | 1024px | 1024px |
| `xl` | 1280px | 1280px |
| `2xl` | 1536px | 1536px |

**`xl` (1280px) is the primary desktop switch**, not `lg`. The navigation, heading promotion and
most layout shifts all key off `xl:`. Below 1280px the site is in its mobile/tablet layout.

### Spacing

Tailwind's default spacing scale applies. On top of it, CMS-authored sections use a three-step
rhythm (`sf-` = Sitefinity):

| Step | Value |
|---|---|
| `sm` | `1rem` |
| `md` | `2rem` |
| `lg` | `4rem` |

Available as `.sf-mt-*`, `.sf-mb-*`, `.sf-ml-*`, `.sf-mr-*`, `.sf-pt-*`, `.sf-pb-*`, `.sf-pl-*`,
`.sf-pr-*`, plus `.sf-items-start|center|end` (which set `display:flex; height:100%`).

Common in-component gaps: `gap-4`, `space-y-2`, `mt-4`, `py-4`, `pl-4`.

### Radii

| Class | Value |
|---|---|
| `.rounded-md` | `.375rem` |
| `.rounded-lg` | `.5rem` |
| `.rounded-xl` | `.75rem` |
| `.rounded-full` | `9999px` |

Cards use `rounded-lg`. Buttons use **no** radius. `rounded-full` is for avatars and pills.

### Elevation

One shadow only:

```css
.shadow-md {
  box-shadow: 0 4px 6px -1px #0000001a, 0 2px 4px -2px #0000001a;
}
```

Used for cards, the sticky header and desktop dropdown panels. There is no shadow scale —
resist adding one.

---

## 5. Components

### Card

The card pattern used for events and news on the homepage:

```html
<div class="flex flex-col relative bg-white rounded-lg shadow-md group overflow-hidden h-104">
  <img …>
  <h3 class="heading5 text-primary-500 !mb-0 line-clamp-3 break-words">…</h3>
  <a class="btn btn-outline-primary btn-sm !font-normal group-hover:bg-primary-600 …">…</a>
</div>
```

Key points: white surface, `rounded-lg`, `shadow-md`, fixed height with `overflow-hidden`,
`group` on the wrapper so the CTA responds to hovering anywhere on the card, and `line-clamp-3`
to keep titles to three lines.

### Header

Sticky, with a transparency mode over hero imagery:

- Transparent state: `bg-transparent text-white` + `/img/logo_nyenrode_white.svg`
- Solid state: `bg-white text-primary-500 shadow-md` + `/img/logo_nyenrode.svg`

Logo sizing: `h-6 xl:h-14 2xl:h-16 w-auto` (intrinsic 261×50, SVG).

### Navigation

Mobile is a stacked accordion; desktop is a horizontal bar with full-width dropdown panels
(`xl:absolute xl:top-full xl:left-0 xl:right-0 xl:w-full xl:bg-white xl:shadow-md`). Item
styling toggles wholesale at `xl`: dividers (`border-b border-gray-500`) and vertical padding
(`py-4`) are removed (`xl:border-b-0 xl:py-0`), text drops to `xl:text-sm` and switches to
`xl:text-black`. Chevrons are Font Awesome (`fa-solid fa-chevron-down`) rotated via Alpine state
(`{'rotate-180': subNavOpen}`).

### Footer

Dark band: `bg-primary-500` / `bg-primary-600` with `text-inverted-500` (white) headings at
`heading4`.

---

## 6. Interaction & accessibility

Focus styling is explicit and consistent:

```css
.focus\:outline:focus           { outline-style: solid; }
.focus\:outline-2:focus         { outline-width: 2px; }
.focus\:outline-offset-2:focus  { outline-offset: 2px; }
.focus\:outline-primary-500:focus { outline-color: #355071; }
```

Apply all four together on interactive elements. Never remove the outline without a replacement.

Other conventions in use:

- Transitions are `.15s cubic-bezier(.4, 0, .2, 1)` — short and uniform.
- `.sr-only` is used liberally (24 occurrences on the homepage) for icon-only controls and
  landmark labels. Every icon button needs one.
- Images carry explicit `width`/`height` and `loading="lazy"` below the fold.
- Interactivity is Alpine.js (`x-data`, `x-bind`, `x-intersect`) — behaviour lives in markup,
  not in separate scripts.

---

## 7. Quick reference

```css
/* Colors */
--primary:      #355071;  --primary-hover:   #2a405a;
--secondary:    #fbba20;  --secondary-hover: #c9951a;
--light-blue:   #0462b6;  --light-blue-hover:#034e92;
--red:          #e4032c;  --red-hover:       #b60223;
--bordeaux:     #7a103e;  --bordeaux-hover:  #620d32;
--green:        #7abf3a;  --green-hover:     #62992e;
--gray:         #eceef2;  --gray-hover:      #bdbec2;
--gray-800:     #5e5f61;

/* Type */
--font-heading: "Noto Sans", sans-serif;   /* 600 */
--font-body:    "Open Sans", sans-serif;   /* 300–800 */
--font-display: "Cream", sans-serif;       /* 500, accent only */

/* Geometry */
--radius-card:  .5rem;    /* buttons: 0 */
--shadow:       0 4px 6px -1px #0000001a, 0 2px 4px -2px #0000001a;
--space-sm:     1rem;  --space-md: 2rem;  --space-lg: 4rem;
--desktop-bp:   1280px;   /* xl */
```

### Do

- Use `primary` for headings and `primary`/`light-blue` for main CTAs.
- Promote headings responsively (`heading2 xl:heading1`), not with custom sizes.
- Keep buttons uppercase, bold, square-cornered, with a 1px border on every variant.
- Pair every background color with its matching `*-inverted-500` text token.
- Define `:hover` and `:focus` together, and keep the 2px offset focus outline.

### Don't

- Don't set yellow or `gray-500` as a text color on a light surface.
- Don't add radii to buttons or introduce a second shadow level.
- Don't branch layout at `lg` when the rest of the site branches at `xl`.
- Don't reach for `--color-nyenrode-gray` (`#c8a3d9`) — it is unused legacy; use `#eceef2`.
- Don't use Cream for anything but display/campaign accents; it ships in one weight.
