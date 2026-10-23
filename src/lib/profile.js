'use strict';
/**
 * What a customer profile needs before the studio will hold a chair time, and
 * the maths behind the completion bar on /account/profile.
 *
 * The percentages are the ones the studio asked for, one step per detail:
 * name 20, phone 40, age 60, profile photo 80, and the address + Block pair
 * closing it at 100. Filling them in order lands on exactly those numbers, and
 * each step is worth the same, so a profile with three details done reads 60%
 * whether or not they were entered in order.
 *
 * The tick that appears at 100 means "this customer has told us everything the
 * booking form needs". It is not an identity check and the templates say so.
 */
const { normalizeText, normalizeMultiline, normalizePhone } = require('./validate');

/** The seven Blocks of Bhadrak district the studio serves. Dropdown values, and the allowlist. */
const BLOCKS = [
  'Bhadrak Block',
  'Basudevpur Block',
  'Bhandaripokhari Block',
  'Bonth Block',
  'Chandabali Block',
  'Dhamnagar Block',
  'Tihidi Block',
];

const ADDRESS_MAX = 300;
const AGE_MIN = 1;
const AGE_MAX = 120;

function isBlock(value) {
  return BLOCKS.includes(normalizeText(value, 40));
}

function normalizeAddress(value) {
  return normalizeMultiline(value, ADDRESS_MAX);
}

function normalizeAge(value) {
  const raw = normalizeText(value, 4);
  if (!/^\d{1,3}$/.test(raw)) return null;
  const age = Number(raw);
  return age >= AGE_MIN && age <= AGE_MAX ? age : null;
}

function hasPhone(user) {
  return (normalizePhone(user && user.phone).replace(/\D/g, '') || '').length >= 6;
}

function hasAge(user) {
  return normalizeAge(user && user.age) !== null;
}

function hasAddress(user) {
  return Boolean(normalizeAddress(user && user.address));
}

function hasBlock(user) {
  return isBlock(user && user.block);
}

function hasPhoto(user) {
  return Boolean(user && user.photo_path);
}

/**
 * Server-side validation for the three fields this module owns. Everything
 * returns a finished sentence for the form, or null when the value is usable.
 */
function ageError(value, { required = false } = {}) {
  const raw = normalizeText(value, 4);
  if (!raw) return required ? 'Enter your age in years.' : null;
  if (!/^\d{1,3}$/.test(raw)) return 'Enter your age as a whole number of years.';
  const age = Number(raw);
  if (age < AGE_MIN || age > AGE_MAX) return `Enter an age between ${AGE_MIN} and ${AGE_MAX} years.`;
  return null;
}

function addressError(value, { required = false } = {}) {
  const tidy = normalizeMultiline(value, 5000);
  if (!tidy) return required ? 'Write the address the studio should reach you at.' : null;
  if (tidy.length > ADDRESS_MAX) return `Keep the address under ${ADDRESS_MAX} characters — this one is ${tidy.length}.`;
  return null;
}

function blockError(value, { required = false } = {}) {
  const block = normalizeText(value, 40);
  if (!block) return required ? 'Choose the Block you live in from the list.' : null;
  if (!BLOCKS.includes(block)) return 'Choose one of the Blocks in the list — the studio serves seven around Bhadrak.';
  return null;
}

/**
 * Percent plus the step list the bar renders, and the field-level booleans a
 * template can point a customer at. Never any of the customer's actual values.
 */
function completeness(user) {
  const fields = {
    name: Boolean(normalizeText(user && user.name, 80)),
    phone: hasPhone(user),
    age: hasAge(user),
    photo: hasPhoto(user),
    address: hasAddress(user),
    block: hasBlock(user),
  };
  const steps = [
    { key: 'name', label: 'Name', percent: 20, done: fields.name },
    { key: 'phone', label: 'Phone number', percent: 40, done: fields.phone },
    { key: 'age', label: 'Age', percent: 60, done: fields.age },
    { key: 'photo', label: 'Profile photo', percent: 80, done: fields.photo },
    { key: 'place', label: 'Address and Block', percent: 100, done: fields.address && fields.block },
  ];
  const done = steps.filter((step) => step.done).length;
  const percent = done * 20;
  const missing = [];
  if (!fields.name) missing.push('name');
  if (!fields.phone) missing.push('phone number');
  if (!fields.age) missing.push('age');
  if (!fields.photo) missing.push('profile photo');
  if (!fields.address) missing.push('address');
  if (!fields.block) missing.push('Block');
  return { percent, complete: percent === 100, steps, missing, fields };
}

function isProfileComplete(user) {
  return completeness(user).complete;
}

module.exports = {
  BLOCKS,
  ADDRESS_MAX,
  AGE_MIN,
  AGE_MAX,
  completeness,
  isProfileComplete,
  isBlock,
  normalizeAddress,
  normalizeAge,
  ageError,
  addressError,
  blockError,
  hasPhone,
  hasAge,
  hasAddress,
  hasBlock,
  hasPhoto,
};
