'use strict';
/** Reads the service catalogue for the public pages and the booking form. */
const db = require('../db');

function categories({ activeOnly = true, bookableOnly = false } = {}) {
  const cats = db.all(
    `SELECT id, slug, name, summary, sort_order
     FROM service_categories
     ${activeOnly ? 'WHERE is_active = 1' : ''}
     ORDER BY sort_order, name`,
  );
  if (!cats.length) return [];
  const ids = cats.map((c) => c.id);
  const services = db.all(
    `SELECT id, category_id, slug, name, description, duration_minutes, price_text, is_bookable, sort_order
     FROM services
     WHERE category_id IN (${ids.map(() => '?').join(',')}) ${activeOnly ? 'AND is_active = 1' : ''}
     ${bookableOnly ? 'AND is_bookable = 1' : ''}
     ORDER BY sort_order, name`,
    ...ids,
  );
  const byCategory = new Map();
  for (const service of services) {
    if (!byCategory.has(service.category_id)) byCategory.set(service.category_id, []);
    byCategory.get(service.category_id).push(service);
  }
  return cats.map((cat) => ({ ...cat, services: byCategory.get(cat.id) || [] }));
}

function categoryBySlug(slug, { activeOnly = true } = {}) {
  const cat = db.get(
    `SELECT * FROM service_categories WHERE slug = ?${activeOnly ? ' AND is_active = 1' : ''}`,
    slug,
  );
  if (!cat) return null;
  const services = db.all(
    `SELECT id, category_id, slug, name, description, duration_minutes, price_text, is_bookable, sort_order
     FROM services WHERE category_id = ?${activeOnly ? ' AND is_active = 1' : ''}
     ORDER BY sort_order, name`,
    cat.id,
  );
  return { ...cat, services };
}

function allBookableServices() {
  return db.all(
    `SELECT s.id, s.slug, s.name, s.duration_minutes, s.price_text, c.name AS category_name, c.slug AS category_slug
     FROM services s JOIN service_categories c ON c.id = s.category_id
     WHERE s.is_active = 1 AND s.is_bookable = 1 AND c.is_active = 1
     ORDER BY c.sort_order, s.sort_order, s.name`,
  );
}

function bookableServicesGrouped() {
  const groups = new Map();
  for (const row of allBookableServices()) {
    if (!groups.has(row.category_name)) groups.set(row.category_name, []);
    groups.get(row.category_name).push(row);
  }
  return [...groups.entries()].map(([name, services]) => ({ name, services }));
}

function serviceBySlug(slug) {
  return db.get(
    `SELECT s.*, c.name AS category_name, c.slug AS category_slug
     FROM services s JOIN service_categories c ON c.id = s.category_id
     WHERE s.slug = ? AND s.is_active = 1`,
    slug,
  );
}

function catalogueStats() {
  return {
    categories: Number(db.get('SELECT COUNT(*) AS n FROM service_categories WHERE is_active = 1').n),
    services: Number(db.get('SELECT COUNT(*) AS n FROM services WHERE is_active = 1').n),
    bookable: Number(db.get('SELECT COUNT(*) AS n FROM services WHERE is_active = 1 AND is_bookable = 1').n),
  };
}

module.exports = { categories, categoryBySlug, allBookableServices, bookableServicesGrouped, serviceBySlug, catalogueStats };
