// @ts-check
/**
 * The one phone ping sent when an unattended scan parks Indeed behind a human-verification challenge: a headless
 * haiku `claude -p` child with a fixed prompt on stdin that calls PushNotification once. Kept in its own module
 * so scan-run.js itself never imports the Claude spawner. Resolves, never rejects.
 */
import { runClaudeText, indeedPingArgs, INDEED_PING_PROMPT, buildChildEnv } from './claude-spawn.js';

/**
 * @param {{ configDir: string, signal?: AbortSignal, run?: typeof runClaudeText }} o
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function pingIndeedWaiting(o) {
  try {
    const run = o.run ?? runClaudeText;
    const res = await run(process.env.JOBSEARCH_TRIAGE_CLAUDE_BIN || 'claude', indeedPingArgs({ configDir: o.configDir }), {
      input: INDEED_PING_PROMPT, timeoutMs: 60000, env: buildChildEnv(process.env), signal: o.signal,
    });
    return res && res.ok ? { ok: true } : { ok: false, reason: res && !res.ok ? res.reason : 'unknown' };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message.slice(0, 200) : 'error' };
  }
}
