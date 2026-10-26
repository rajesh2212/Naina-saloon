'use strict';
/**
 * `npm run create-admin` — make (or promote) the first salon staff login.
 *
 * Reads BOOTSTRAP_ADMIN_EMAIL / _NAME / _PASSWORD from .env when present,
 * otherwise asks on the terminal. Nothing is hard-coded, and the password is
 * stored only as a bcrypt hash.
 */
const readline = require('node:readline/promises');
const { stdin, stdout } = require('node:process');
const db = require('../src/db');
const { migrate } = require('../src/db/migrate');
const users = require('../src/lib/users');
const studio = require('../src/lib/settings');
const v = require('../src/lib/validate');

const isInteractive = Boolean(stdin.isTTY) && process.argv.indexOf('--non-interactive') === -1;

function fromEnv() {
  return {
    email: v.normalizeEmail(process.env.BOOTSTRAP_ADMIN_EMAIL || ''),
    name: v.normalizeText(process.env.BOOTSTRAP_ADMIN_NAME || '', 80),
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD || '',
  };
}

async function ask(rl, question, value, validate) {
  if (value) {
    const error = validate ? validate(value) : null;
    if (!error) return value;
    stdout.write(`The ${question} in .env is not usable: ${error}\n`);
  }
  if (!isInteractive) {
    throw new Error(`No ${question} supplied and no terminal available for prompts.`);
  }
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await rl.question(`Enter the ${question}: `);
    const trimmed = answer.trim();
    const error = validate ? validate(trimmed) : null;
    if (!error) return trimmed;
    stdout.write(`  ${error}\n`);
  }
  throw new Error('Too many invalid answers.');
}

async function askSecret(rl) {
  const existing = fromEnv().password;
  if (existing && !v.passwordError(existing)) return existing;
  if (!isInteractive) throw new Error('No BOOTSTRAP_ADMIN_PASSWORD and no terminal for prompts.');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const first = await rl.question('Enter a password for the staff login (10+ characters, letter + number): ');
    const error = v.passwordError(first, { name: 'salon' });
    if (error) {
      stdout.write(`  ${error}\n`);
      // eslint-disable-next-line no-continue
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const again = await rl.question('Type it again to confirm: ');
    if (again !== first) {
      stdout.write('  The two entries did not match.\n');
      // eslint-disable-next-line no-continue
      continue;
    }
    return first;
  }
  throw new Error('Could not agree on a password.');
}

async function main() {
  await migrate({ log: () => {} });
  await studio.applySalonZone();

  stdout.write('\nSalon staff login for Naina Beauty Parlour\n');
  const admins = await users.countAdmins();
  stdout.write(admins ? `${admins} staff account(s) already exist.\n` : 'No staff account exists yet.\n');

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const env = fromEnv();
    const email = await ask(rl, 'staff email address', env.email, v.emailError);
    const name = await ask(rl, 'name shown in the staff area', env.name || 'Salon team', null);
    const password = await askSecret(rl);

    const outcome = await users.promote(email, name, password);
    if (outcome.created) {
      stdout.write(
        `\nCreated staff account #${outcome.user.id} for ${outcome.user.email} with role=admin ` +
          '(password stored as a bcrypt hash).\n',
      );
    } else {
      stdout.write(
        `\nAccount #${outcome.user.id} (${outcome.user.email}) already existed and is now role=admin. ` +
          'Their previous password still works.\n',
      );
    }
    stdout.write('Sign in at /auth/login, then open the staff portal at /portal. Change this password from the account page when convenient.\n\n');
  } catch (error) {
    stdout.write(`\nStopped: ${error.message}\n`);
    stdout.write('Usage: BOOTSTRAP_ADMIN_EMAIL=staff@example.com BOOTSTRAP_ADMIN_NAME="Salon team" BOOTSTRAP_ADMIN_PASSWORD="choose-a-good-one" npm run create-admin\n');
    process.exitCode = 1;
  } finally {
    rl.close();
    // The pool keeps the event loop alive until it is closed.
    await db.closeDatabase();
  }
}

main();
