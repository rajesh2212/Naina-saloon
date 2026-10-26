'use strict';
/**
 * Idempotent seed data: service categories/catalogue, weekly hours and booking
 * settings. Rows are inserted only when their key is missing, so re-running the
 * seed never overwrites edits the studio already made in /admin.
 *
 * Descriptions deliberately stay factual and free of outcome claims; prices and
 * durations are placeholders for the studio to confirm.
 */
const db = require('./index');

const SETTINGS = [
  ['slot_step_minutes', '30', 'Minutes between the start of consecutive appointment slots'],
  ['booking_horizon_days', '30', 'How many days ahead slots can be offered'],
  ['lead_time_minutes', '120', 'Minimum notice a customer must give when booking'],
  ['max_active_bookings_per_user', '3', 'Active (pending/confirmed) bookings allowed per account'],
  ['hours_note', 'Studio timings shown here are a starting configuration. Please confirm the daily closing time with the salon.', 'Note displayed to staff about the hours'],
];

// 0 = Sunday … 6 = Saturday
const HOURS = [
  { weekday: 0, opens: '09:00', closes: '19:00' },
  { weekday: 1, opens: '09:00', closes: '19:00' },
  { weekday: 2, opens: '09:00', closes: '19:00' },
  { weekday: 3, opens: '09:00', closes: '19:00' },
  { weekday: 4, opens: '09:00', closes: '19:00' },
  { weekday: 5, opens: '09:00', closes: '19:00' },
  { weekday: 6, opens: '09:00', closes: '19:00' },
];

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const CATALOGUE = [
  {
    slug: 'bridal-and-occasion-makeup',
    name: 'Bridal & Occasion Makeup',
    summary: 'Wedding, reception and function-day looks, booked with enough time for the full routine.',
    services: [
      { slug: 'bridal-makeup', name: 'Bridal Makeup', minutes: 150, description: 'Full wedding-day look. The studio confirms the trial and finish details when you book.' },
      { slug: 'reception-makeup', name: 'Reception Makeup', minutes: 120, description: 'Evening reception look, including hair finishing.' },
      { slug: 'engagement-party-makeup', name: 'Engagement & Party Makeup', minutes: 90, description: 'For engagement, sangeet and party functions.' },
      { slug: 'guest-family-makeup', name: 'Guest / Family Makeup', minutes: 60, description: 'For family members and guests attending a function.' },
      { slug: 'saree-draping-styling', name: 'Saree Draping & Styling', minutes: 30, description: 'Draping and final styling to go with your look.' },
    ],
  },
  {
    slug: 'hair-styling-and-coloring',
    name: 'Hair Styling & Colouring',
    summary: 'Cutting, setting and colour services, timed so the chair is free when you leave.',
    services: [
      { slug: 'hair-cut-wash-blowdry', name: 'Hair Cut, Wash & Blow-Dry', minutes: 60, description: 'Cut with wash and blow-dry finish.' },
      { slug: 'hair-colour-global', name: 'Hair Colour — Global', minutes: 90, description: 'Full-head colour. The studio confirms the shade and patch-test timing before the appointment.' },
      { slug: 'hair-colour-root-touchup', name: 'Hair Colour — Root Touch-Up', minutes: 60, description: 'Regrowth colour on the new growth only.' },
      { slug: 'highlights-meches', name: 'Highlights / Meches', minutes: 120, description: 'Section lightening. Time depends on the length and the look you want.' },
      { slug: 'party-hair-style', name: 'Party Hair Style', minutes: 45, description: 'Curls, waves, buns and braided styles for functions.' },
      { slug: 'hair-wash-set', name: 'Hair Wash & Set', minutes: 40, description: 'Wash with a set finish.' },
    ],
  },
  {
    slug: 'hair-smoothing-and-keratin',
    name: 'Hair Smoothing & Keratin Treatments',
    summary: 'Longer chair-time services. Book the slot length shown and plan the day around it.',
    services: [
      { slug: 'keratin-treatment', name: 'Keratin Treatment', minutes: 180, description: 'Keratin smoothing session. The studio explains the after-care instructions at the appointment.' },
      { slug: 'hair-smoothing', name: 'Hair Smoothing', minutes: 150, description: 'Smoothing session for frizz-prone hair.' },
      { slug: 'anti-frizz-session', name: 'Anti-Frizz Session', minutes: 120, description: 'Shorter smoothing session for humidity and frizz control.' },
      { slug: 'rebonding', name: 'Hair Rebonding / Straightening', minutes: 240, description: 'Full straightening service. Longest chair time — confirm the length of your hair when booking.' },
    ],
  },
  {
    slug: 'hair-treatments',
    name: 'Hair Treatments',
    summary: 'Conditioning and scalp-care sessions between styling appointments.',
    services: [
      { slug: 'hair-spa', name: 'Hair Spa', minutes: 60, description: 'Conditioning spa with a scalp massage.' },
      { slug: 'deep-conditioning', name: 'Deep Conditioning', minutes: 45, description: 'Intensive conditioning session.' },
      { slug: 'scalp-care-session', name: 'Hair & Scalp Care Session', minutes: 45, description: 'Cleansing and conditioning session for the scalp and lengths.' },
      { slug: 'oil-treatment', name: 'Oil Treatment', minutes: 30, description: 'Warm oil treatment for the lengths and scalp.' },
    ],
  },
  {
    slug: 'facials-and-skincare',
    name: 'Facials & Skincare Treatments',
    summary: 'Face and skin sessions at the parlour. The studio talks through your skin before starting.',
    services: [
      { slug: 'cleanup', name: 'Face Clean-Up', minutes: 30, description: 'Quick cleansing session before an event.' },
      { slug: 'classic-facial', name: 'Classic Facial', minutes: 45, description: 'Standard facial with massage and pack.' },
      { slug: 'brightening-facial', name: 'Brightening Facial', minutes: 60, description: 'Longer facial session for dull-looking skin.' },
      { slug: 'party-glow-facial', name: 'Party Glow Facial', minutes: 60, description: 'Facial booked close to a function date.' },
      { slug: 'de-tan-session', name: 'De-Tan Session', minutes: 30, description: 'Sun-tan removal session for face or arms.' },
    ],
  },
  {
    slug: 'hair-reduction',
    name: 'Hair Reduction Treatments',
    summary: 'Threading and waxing for face and body.',
    services: [
      { slug: 'threading-eyebrows', name: 'Threading — Eyebrows', minutes: 15, description: 'Shaping by thread.' },
      { slug: 'threading-upper-lip', name: 'Threading — Upper Lip & Chin', minutes: 15, description: 'Fine facial hair removal by thread.' },
      { slug: 'threading-full-face', name: 'Threading — Full Face', minutes: 30, description: 'Complete face threading.' },
      { slug: 'waxing-arms', name: 'Waxing — Arms', minutes: 20, description: 'Half or full arm waxing.' },
      { slug: 'waxing-legs', name: 'Waxing — Legs', minutes: 35, description: 'Half or full leg waxing.' },
      { slug: 'waxing-underarms', name: 'Waxing — Underarms', minutes: 15, description: 'Underarm waxing.' },
      { slug: 'waxing-full-body', name: 'Waxing — Full Body', minutes: 60, description: 'Full-body waxing session; confirm the areas you want when booking.' },
    ],
  },
  {
    slug: 'eyelid-and-eyebrow',
    name: 'Eyelid & Eyebrow Services',
    summary: 'Brow shaping and eyelid styling done for the day’s look.',
    services: [
      { slug: 'eyebrow-shaping', name: 'Eyebrow Shaping', minutes: 20, description: 'Threading or tweezing to shape the brows.' },
      { slug: 'eyebrow-tinting', name: 'Eyebrow Tinting', minutes: 20, description: 'Brow colour to match your hair shade; the studio confirms the shade with you.' },
      { slug: 'eyelid-taping', name: 'Eyelid Taping / Styling', minutes: 20, description: 'Non-permanent eyelid styling for the makeup look.' },
      { slug: 'eyelash-tinting', name: 'Eyelash Tinting', minutes: 25, description: 'Lash colour so mascara is not needed for the day.' },
    ],
  },
  {
    slug: 'contact-lenses-and-eye-beauty',
    name: 'Contact Lenses & Eye-Area Beauty',
    summary: 'Coloured lens styling and lash work for functions and photos.',
    services: [
      { slug: 'contact-lens-styling', name: 'Contact Lens Styling', minutes: 20, description: 'Insertion and styling with coloured lenses for the look. Bring your own lenses or confirm availability with the studio.' },
      { slug: 'eyelash-extensions', name: 'Eyelash Extensions', minutes: 60, description: 'Individual and volume lash sets.' },
      { slug: 'eyelash-application', name: 'Temporary Lash Application', minutes: 15, description: 'Strip or individual lashes applied for the day.' },
      { slug: 'kajal-eye-styling', name: 'Eye Makeup & Kajal Styling', minutes: 30, description: 'Standalone eye look for a function.' },
    ],
  },
];

async function seedSettings() {
  let inserted = 0;
  for (const [key, value] of SETTINGS) {
    const rows = await db.all(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING RETURNING key',
      key,
      value,
    );
    inserted += rows.length;
  }
  return inserted;
}

async function seedHours() {
  let inserted = 0;
  for (const row of HOURS) {
    const rows = await db.all(
      'INSERT INTO opening_hours (weekday, is_closed, opens_at, closes_at, note) VALUES (?, 0, ?, ?, ?) ON CONFLICT (weekday) DO NOTHING RETURNING weekday',
      row.weekday,
      row.opens,
      row.closes,
      `Placeholder closing time — studio to confirm for ${WEEKDAY_NAMES[row.weekday]}`,
    );
    inserted += rows.length;
  }
  return inserted;
}

async function seedCatalogue() {
  const counts = { categories: 0, services: 0 };
  for (const [categoryIndex, category] of CATALOGUE.entries()) {
    const made = await db.all(
      'INSERT INTO service_categories (slug, name, summary, sort_order) VALUES (?, ?, ?, ?) ON CONFLICT (slug) DO NOTHING RETURNING id',
      category.slug,
      category.name,
      category.summary,
      (categoryIndex + 1) * 10,
    );
    if (made.length) counts.categories += 1;
    const row = made.length
      ? { id: Number(made[0].id) }
      : await db.get('SELECT id FROM service_categories WHERE slug = ?', category.slug);
    for (const [serviceIndex, service] of category.services.entries()) {
      const added = await db.run(
        `INSERT INTO services (category_id, slug, name, description, duration_minutes, price_text, is_bookable, is_active, sort_order)
         VALUES (?, ?, ?, ?, ?, NULL, 1, 1, ?) ON CONFLICT (slug) DO NOTHING`,
        row.id,
        service.slug,
        service.name,
        service.description,
        service.minutes,
        (serviceIndex + 1) * 10,
      );
      counts.services += added.changes;
    }
  }
  return counts;
}

async function seed({ log = console.log } = {}) {
  const settings = await seedSettings();
  const hours = await seedHours();
  const catalogue = await seedCatalogue();
  log(
    `Seed complete — ${settings} settings, ${hours} weekday rows, ` +
      `${catalogue.categories} categories and ${catalogue.services} services added ` +
      '(existing rows left untouched).',
  );
  return { settings, hours, catalogue };
}

module.exports = { seed, CATALOGUE, WEEKDAY_NAMES, SETTINGS };
