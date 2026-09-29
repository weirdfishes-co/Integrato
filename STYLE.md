# Dev Ieffe — Styleguide

Reverse-engineered from the live site (https://g.ieffe.dev), September 2026.

The site is built on **Google Sites**, so there is no authored stylesheet to read: the
framework CSS is a 1.8 MB generated file and the theme is injected inline as a block of
rules on obfuscated class names (`.duRjpb`, `.QmpIrf`, …). Those names are generated and
will change without warning, so **none of them appear below**. What follows is the design
itself — palette, type, shape — taken verbatim from the values the theme sets.

Sizes on the site are declared in **points**. Each is given below in pt as found, with the
px equivalent (pt × 4/3) to use directly in CSS.

---

## 1. Colors

The theme uses no CSS custom properties; every colour is a literal. Collected from the
rendered page and the inline theme:

| Role | Hex | Where it appears |
| --- | --- | --- |
| **Ink** | `#1c1c1c` | Default body and heading colour on light sections |
| **Black** | `#000000` | Headings and filled buttons in the black section theme |
| **Paper** | `#f9f9f9` | Text on dark grounds, and the light section background |
| **White** | `#ffffff` | Section backgrounds, outlined-button fill |
| **Accent brown** | `#783f04` | Headings in the accent section theme |
| **Accent blue** | `#0c4466` | Filled and outlined buttons in the accent section theme |
| **Lavender tint** | `#f7f5fe` | Default filled-button background |
| **Cream** | `#fff2cc` | Occasional block background |
| **Grey 100** | `#efefef` | Block background |
| **Grey 150** | `#f3f3f3` | Block background |
| **Grey 900** | `#242424` | Deep block background, just off black |

There is no red, green or amber: the site carries **no status palette at all**. Anything
here needing success/warning/error will have to introduce it, and should do so in a
hue that does not collide with the brown or the blue.

### Section themes

Rather than one page-wide palette, the site paints in **four section themes**. Each sets
its own heading colour and button treatment, and every theme is used about equally across
the page.

| Theme | Headings | Filled button | Outlined button |
| --- | --- | --- | --- |
| Black | `#000000` | `#000000` bg, `#f9f9f9` text | transparent, `#000000` text and border |
| Accent | `#783f04` | `#0c4466` bg, `#f9f9f9` text | transparent, `#0c4466` text and border |
| Light | `#1c1c1c` | `#ffffff` bg, `#1c1c1c` text and border | transparent, `#1c1c1c` text and border |
| Dark | `#f9f9f9` | `#ffffff` bg, `#1c1c1c` text | transparent, `#f9f9f9` text and border |

The pattern worth copying: a section decides its own ground, and the heading and button
colours follow from it. That is the same shape as a `prefers-color-scheme` block — one set
of semantic names, several bindings.

---

## 2. Typography

### Typefaces

| Family | Weight | Role |
| --- | --- | --- |
| **Montserrat** | 700 | Every heading (h1–h3) |
| **Lato** | 400 | Body copy, links, buttons, navigation |

Both are loaded from Google Fonts. Four further families are requested by the page — DM
Mono, Google Sans, Roboto, Source Code Pro — but the theme never references them; they are
Google Sites' own defaults and should be ignored.

Fallback stacks are not declared by the theme. Use:

```css
--font-heading: Montserrat, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
--font-body: Lato, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
```

### Scale

Sizes step at three breakpoints. Where a single value is given, the size does not change.

| Role | ≤479px | 480–767px | ≥768px | Weight |
| --- | --- | --- | --- | --- |
| Display XL | 40pt / 53px | 51pt / 68px | 60pt / 80px | 700 |
| Display | 33pt / 44px | 41pt / 55px | 48pt / 64px | 700 |
| **h1** | 25pt / 33px | 30pt / 40px | 34pt / 45px | 700 |
| **h2** | 17pt / 23px | 18pt / 24px | 18pt / 24px | 700 |
| **h3** | 14pt / 19px | 14pt / 19px | 14pt / 19px | 700 |
| Body | 13pt / 17px | 14pt / 19px | 15pt / 20px | 400 |
| Link / nav | 16pt / 21px | 18pt / 24px | 20pt / 27px | 400 |

Two things stand out and are worth keeping:

- **The jump from h1 to h2 is enormous** — 45px to 24px on a wide screen. Headings below h1
  are labels, not scaled-down titles.
- **Body text is large**, 20px at desktop where 16px is the usual default, and links are
  larger still.

### Line height

`1.5` for body copy, `1.38` for tighter blocks. No `letter-spacing` is set anywhere, and
no `text-transform` — **headings and buttons are sentence case**.

---

## 3. Shape

The theme sets **no `border-radius` at all**: every button, card and image block is
square-cornered.

It sets **no `box-shadow`** either, apart from a focus ring
(`0 0 0 2px rgba(255,255,255,0.8)`). Separation between blocks comes from background colour
and whitespace, never from elevation.

Buttons carry a border in every variant, so the filled and outlined forms occupy the same
box and do not shift when swapped — the border colour simply matches the background on a
filled button.

---

## 4. Breakpoints

```
479px   480px   544px   767px   768px   1279px   1280px
```

Used as three ranges — up to 479, 480–767, 768 and up — with 1280 present but setting the
same values as 768. In practice: **phone, tablet, desktop**.

---

## 5. As applied here

`public/styles.css` implements this guide. It names its colours semantically and binds
them to the palette above:

```css
:root {
  --primary: #0c4466;        /* accent blue: filled buttons */
  --primary-600: #093349;    /* darkened for hover; the site defines no hover state */
  --secondary: #783f04;      /* accent brown: headings in the accent theme */
  --text: #1c1c1c;
  --bg: #ffffff;
  --bg-subtle: #f3f3f3;
  --bg-raised: #ffffff;
  --border: #efefef;
  --radius: 0;               /* square, everywhere */
  --radius-card: 0;
  --font-heading: Montserrat, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  --font-body: Lato, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
}
```

Three things the source does not provide had to be decided. Each is marked in the
stylesheet where it appears:

1. **Hover and focus colours.** The site declares none beyond the focus ring, so the `-600`
   values are darkened from their base rather than taken from the source.
2. **Status colours.** The site has no red or green at all. `#b3261e` and `#1e6b3a` were
   chosen to sit apart from both the brown and the blue; both clear AA on white.
3. **A dark theme.** The four section themes are a *layout* device on one light page, not a
   light/dark pair, so the dark variant follows the "Dark" section: paper text on an ink
   ground, with white as the accent because the blue disappears against it.

Of the four section themes the app adopts the **Accent** one — brown headings, blue filled
buttons. The Light theme's white-on-white buttons give a primary action too little weight
in an interface people work in.

Montserrat and Lato are **self-hosted** from `public/fonts/` rather than loaded from the
Google Fonts link the site uses: no third-party request, and it works offline.

Every pairing was checked for contrast; the lowest is the green at 6.52:1, and everything
else clears AAA.
