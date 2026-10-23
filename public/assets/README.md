# Studio photographs

Every image the website wants is a **named slot**. Drop a file with the exact
name into this folder and it appears on the page — no code change, no restart,
just refresh.

## The three tiers a slot can render in

1. **The studio's own photograph** — the file named below, sitting in this
   folder. This always wins.
2. **A tagged illustrative picture** — `public/assets/art/`, shown while a slot
   has no photograph. Every one of these carries a visible `Illustrative` chip
   in the corner and an alt text that starts "Illustrative image —", because a
   generated picture shown without a label reads as a claim about this studio.
3. **A labelled panel** — only if even the artwork is missing, so a slot can
   never render blank. It names the file it is waiting for.

Nothing is hotlinked from another website: the Content-Security-Policy in
`src/app.js` pins `img-src 'self' data:`, so every picture has to be a file in
this project.

## The slots

| Group | Filenames | Where it appears |
| --- | --- | --- |
| Hero portrait | `naina-hero-portrait.png` | Home hero, overlapping the NAINA wordmark |
| The studio | `naina-about-1.png` `naina-about-2.png` `naina-about-3.png` | Home → About the salon; `about-3` also sits in the gallery |
| Your visit | `naina-visit-1.png` … `naina-visit-4.png` | Home → Your visit, the four steps |
| Service groups | `naina-service-bridal.png` `naina-service-hair.png` `naina-service-facial.png` `naina-service-eye.png` `naina-service-treatment.png` | Home → What the studio works on |
| Gallery | `naina-gallery-1.png` … `naina-gallery-5.png` | Home → A look inside; `gallery-1` also sits beside the questions |

The list lives in one place — `config.photoSlots` in `src/config.js`, where each
slot pairs the photograph filename with the artwork that stands in for it. Add a
slot there and a matching `include('../partials/photo', …)` in the page to use
it.

`npm run check` and the staff area's integration card both report how many of
the 18 slots hold a real photograph.

## Shooting guidance

- **Hero portrait** — portrait orientation, at least 1000 × 1250 px. It is
  cropped to 4:5 and sits over the wordmark, so keep the face in the upper two
  thirds.
- **Everything else** — 1200 px on the long edge is plenty. Panels are rounded
  and cropped to 4:3, 3:2, 1:1 or 3:4, so keep faces and product away from the
  edges.
- Daylight through the front glass flatters the warm palette best.
- PNG or JPEG both work. Keep the extension in `config.photoSlots` matching the
  file you actually save.

## Privacy before you upload

Photos of clients are customer information. Only publish a shot where the person
in it is identifiable if the studio has their agreement, and avoid frames where
a phone screen, diary or receipt on the counter is legible.

## Section order on the home page

Hero → About the salon → Your visit → What the studio works on → What a visit
costs → Questions → A look inside → Everyone is welcome → Find the studio →
footer.

Two sections the design reference includes are deliberately **not** here:

- **Testimonials** — no real reviews have been supplied, and invented quotes,
  names, ratings or headshots would be false claims about the studio.
- **Newsletter signup** — there is no mailing-list service configured, so there
  is no form. Adding one means wiring a real provider first.

Prices are shown as "Contact us for pricing" for the same reason: the studio has
not published a price list, so the `price` column stays `NULL` in the database
and the pages show chair times instead of made-up amounts.
