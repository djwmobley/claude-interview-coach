// @ts-check
/**
 * Test helper: launch a THROWAWAY headless Chrome (fresh temp profile, random debugging port, never the
 * operator's scan Chrome or daily driver) plus a loopback HTTP server for test/fixtures/easy-apply/, so the
 * assisted Easy Apply driver's in-page code runs against a real DOM. Returns null when no Chrome/Edge
 * binary is found (the calling suite then skips; see its blind-spots note).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const CANDIDATES = [
  process.env.EASY_APPLY_TEST_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((p) => typeof p === 'string' && p);

export function findChromeBinary() {
  for (const p of CANDIDATES) {
    try {
      if (fs.existsSync(/** @type {string} */ (p))) return /** @type {string} */ (p);
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * @param {string} fixtureDir
 * @returns {Promise<null | { wsUrl: string, baseUrl: string, close: () => Promise<void> }>}
 */
export async function launchHeadlessChrome(fixtureDir) {
  const bin = findChromeBinary();
  if (!bin) return null;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-apply-test-chrome-'));
  const child = spawn(bin, [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
    '--no-default-browser-check', '--disable-extensions', '--disable-background-networking', '--window-size=1280,900', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  const wsUrl = await new Promise((resolve, reject) => {
    let buf = '';
    const t = setTimeout(() => reject(new Error('headless Chrome did not report a DevTools URL')), 20000);
    child.stderr.on('data', (c) => {
      buf += c.toString('utf8');
      const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
      if (m) {
        clearTimeout(t);
        resolve(m[1]);
      }
    });
    child.on('exit', () => { clearTimeout(t); reject(new Error('headless Chrome exited early')); });
  });
  const server = http.createServer((req, res) => {
    const name = path.basename(decodeURIComponent(String(req.url ?? '/').split('?')[0]));
    const file = path.join(fixtureDir, name);
    if (!name.endsWith('.html') || !fs.existsSync(file)) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(fs.readFileSync(file));
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const addr = /** @type {import('node:net').AddressInfo} */ (server.address());
  return {
    wsUrl,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    async close() {
      await new Promise((resolve) => { server.close(() => resolve(undefined)); });
      child.kill();
      await new Promise((r) => { setTimeout(r, 300); });
      try {
        fs.rmSync(profile, { recursive: true, force: true });
      } catch {
        /* Chrome may still hold a lock briefly on Windows; the OS temp cleaner gets it */
      }
    },
  };
}
