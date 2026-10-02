# Unlimited Brain — Styleguide

**Colour comes from the "Forest Green and Brown" palette**
(https://colorschemes.net/palettes/forest-green-and-brown), adopted October 2026.

**Type, shape and breakpoints** were reverse-engineered from https://g.ieffe.dev in
September 2026 and are unchanged — that site is built on Google Sites, so there was no
authored stylesheet to read: the theme is injected inline on obfuscated class names
(`.duRjpb`, `.QmpIrf`, …) that are generated and will change without warning, so **none
of them appear below**. What follows is the design itself, taken from the values the
theme set.

Sizes there are declared in **points**. Each is given below in pt as found, with the px
equivalent (pt × 4/3) to use directly in CSS.

---

## 1. Colors

Five colours, and **every one of them is dark**. That is the defining fact about this
palette: there is no light tone in it at all.

| Role here | Hex | Palette name | On white |
| --- | --- | --- | --- |
| **Sage** | `#5f725d` | Soft sage green — the lightest of the five | 5.18:1 |
| **Forest** | `#2e4b36` | Rich forest green | 9.65:1 |
| **Charcoal** | `#353a31` | Dark brown (it reads as a green-black) | 11.66:1 |
| **Brown** | `#4f473b` | Muted brown | 9.14:1 |
| **Ink** | `#312e28` | Dark grayish brown | 13.53:1 |

The palette's own description — vintage, muted, calming, earthy — is carried by how close
together they sit. Sage to ink is a span of 13.53 to 5.18 against white, so all five work
as *marks on a light ground* and none of them works as a ground for another: the largest
contrast between any two of them is sage against ink, at 2.61:1.

### What had to be added

A page needs something to put these on, and the palette supplies nothing. These are ours:

| Token | Hex | Why |
| --- | --- | --- |
| White | `#ffffff` | The page ground, and text on every one of the five |
| Paper | `#f7f6f3` | Warm off-white; text on dark grounds, where white is too stark |
| Tints | `#f2f4f1`, `#e3e6e1`, `#c8cec5` | Surfaces and borders, mixed from the sage so the greys stay in the family |
| Muted text | `#6b6459` | From the brown's family, deliberately *not* the sage — muted text next to green links must not read as a link |
| Red | `#b3261e` | There is no status colour in the palette |
| Amber | `#8a5a00` | A low balance is a warning, not yet an error |

Success is the brand **forest** green rather than a sixth colour: it appears only as a
4px border, never as text, so there is nothing to confuse with a link.

### The two roles

**Brown is the button, green is the link.** The palette's two usable hues split between
the two jobs instead of sharing one, which is what lets a reader tell a primary action
from a link without reading either.

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

`public/styles.css` implements this guide. The five palette colours are named once and
everything else is bound to them semantically, so a restyle touches the tokens and
nothing below them:

```css
:root {
  --sage: #5f725d;           /* the sidebar ground */
  --forest: #2e4b36;         /* links and focus */
  --charcoal: #353a31;       /* dark-mode surfaces */
  --brown: #4f473b;          /* buttons and headings */
  --ink: #312e28;            /* body text, and the dark-mode ground */

  --accent: var(--brown);    /* white on it: 9.14:1 */
  --link: var(--forest);     /* 9.65:1 */
  --text: var(--ink);        /* 13.53:1 */
  --radius: 0;               /* square, everywhere */
}
```

Three places needed a decision the palette does not make, and each is marked in the
stylesheet where it appears:

1. **Hover and focus.** The palette declares no states, so the `-600` values are
   darkened from their base.
2. **The sidebar.** It takes the **sage**, the lightest of the five, as a ground of its
   own, with bold white links at 5.18:1. That figure is the floor: lightening the sage
   any further takes the links below AA.
3. **Dark mode.** Not an inversion — the palette is already dark, so the **ink** becomes
   the ground and the paper off-white becomes the text. The brown cannot stay the button
   there: against the ink it is 1.48:1, which is no button at all. It lightens to
   `#a89b84` and takes *dark* text, because white on a brown light enough to see would
   be about 3:1. Since the label is the ground colour, one figure covers both jobs —
   **4.95:1** is the label on the fill and the fill on the page — and it has to clear
   4.5, because a 14px bold button label is not "large text".

Montserrat and Lato are **self-hosted** from `public/fonts/`: no third-party request, and
it works offline.

Every pairing was checked for contrast. The lowest in use is the sage sidebar's white
links at 5.18:1 (AA); body text, links, headings and buttons all clear AAA.
