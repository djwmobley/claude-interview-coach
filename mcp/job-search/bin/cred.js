#!/usr/bin/env node
// @ts-check
/**
 * Credential Manager CLI (apply pipeline slice 4, plan section "5a. Credential prompt"), the
 * "dashboard not open" equivalent of components/credential-prompt.js. Never prints or accepts a password
 * as a command-line argument -- `set` reads it from a hidden terminal prompt (or generates one), `list`
 * only ever shows target names.
 *
 *   node bin/cred.js set <tenantHost> [--user email] [--generate]
 *   node bin/cred.js list
 *   node bin/cred.js delete <target>
 */
import { credentialTarget, createCredentials, generatePassword } from '../src/core/credentials.js';
import { errFields } from '../src/core/errors.js';

const USAGE = [
  'usage: node bin/cred.js set <tenantHost> [--user email] [--generate]',
  '       node bin/cred.js list',
  '       node bin/cred.js delete <target>',
].join('\n');

const DEFAULT_ACCOUNT_EMAIL = 'djwmobley@gmail.com';

/**
 * Re-exported from src/core/credentials.js (moved there in apply pipeline slice 6, single source of
 * truth) so this CLI's own generate flag and test/cred-cli.test.js's existing import both keep working.
 * src/apply/worker.js's ctx.credentials.generatePassword calls the same underlying function directly.
 */
export { generatePassword };

/**
 * Read one line from stdin with terminal echo suppressed (a hidden password prompt), Windows-console
 * safe: toggles raw mode on process.stdin rather than relying on a TTY feature not every Windows terminal
 * host implements consistently.
 * @param {string} promptText
 * @returns {Promise<string>}
 */
export function promptHidden(promptText) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(promptText);
    if (!stdin.isTTY) {
      // Non-interactive stdin (e.g. piped input in a test or a script): read one line plainly, no
      // masking possible or needed.
      let buf = '';
      const onData = (/** @type {Buffer} */ chunk) => {
        buf += chunk.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl !== -1) {
          stdin.off('data', onData);
          resolve(buf.slice(0, nl).replace(/\r$/, ''));
        }
      };
      stdin.on('data', onData);
      stdin.on('error', reject);
      return;
    }
    let input = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    // Control characters compared by code point (never as a literal byte in source): 3 = Ctrl+C (ETX),
    // 8 = backspace (BS), 127 = delete (DEL) -- the two characters a real terminal's own backspace key
    // sends, depending on the terminal.
    const CTRL_C = 3;
    const BACKSPACE = 8;
    const DELETE = 127;
    const onData = (/** @type {string} */ chunk) => {
      for (const ch of chunk) {
        const code = ch.codePointAt(0);
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(input);
          return;
        }
        if (code === CTRL_C) {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          reject(new Error('cancelled'));
          return;
        }
        if (code === BACKSPACE || code === DELETE) {
          input = input.slice(0, -1);
          continue;
        }
        input += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** @param {string[]} argv */
export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command === 'set') {
    /** @type {{ command: 'set', tenantHost: string|null, user: string, generate: boolean, help: boolean }} */
    const out = { command: 'set', tenantHost: null, user: DEFAULT_ACCOUNT_EMAIL, generate: false, help: false };
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--user') out.user = rest[++i] ?? out.user;
      else if (a === '--generate') out.generate = true;
      else if (a === '--help' || a === '-h') out.help = true;
      else if (!a.startsWith('--') && out.tenantHost === null) out.tenantHost = a;
    }
    return out;
  }
  if (command === 'list') return { command: 'list', help: rest.includes('--help') || rest.includes('-h') };
  if (command === 'delete') return { command: 'delete', target: rest.find((a) => !a.startsWith('--')) ?? null, help: rest.includes('--help') || rest.includes('-h') };
  return { command: null, help: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    console.log(USAGE);
    process.exit(args.command ? 0 : 1);
    return;
  }
  const credentials = createCredentials();

  try {
    if (args.command === 'set') {
      if (!args.tenantHost) {
        console.error('cred.js: <tenantHost> is required');
        console.log(USAGE);
        process.exit(1);
        return;
      }
      const target = credentialTarget(args.tenantHost);
      const password = args.generate ? generatePassword() : await promptHidden('Password: ');
      await credentials.write(target, args.user, password);
      if (args.generate) {
        console.log(`Generated a new password for ${target}.`);
      }
      console.log(`Saved credential: ${target} (user: ${args.user})`);
      return;
    }
    if (args.command === 'list') {
      const targets = await credentials.list();
      if (targets.length === 0) {
        console.log('No ic-jobsearch credentials stored.');
        return;
      }
      for (const t of targets) console.log(t);
      return;
    }
    if (args.command === 'delete') {
      if (!args.target) {
        console.error('cred.js: <target> is required');
        console.log(USAGE);
        process.exit(1);
        return;
      }
      const deleted = await credentials.delete(args.target);
      console.log(deleted ? `Deleted credential: ${args.target}` : `No credential found for: ${args.target}`);
      return;
    }
  } catch (err) {
    const f = errFields(err);
    console.error(`cred.js: ${f.err_code}: ${f.err_message}`);
    process.exit(1);
  }
}

const isMain = process.argv[1] && process.argv[1].endsWith('cred.js');
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
