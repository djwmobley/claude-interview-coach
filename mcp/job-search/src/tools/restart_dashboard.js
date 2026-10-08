// @ts-check
/**
 * restart_dashboard: stop the one running dashboard process (identified by pidfile, port listener, and
 * command line; see src/core/dashboard-restart.js) and start the "job-search dashboard" scheduled task.
 * Never kills any other process; refuses on zero-ambiguity failures with a clear message.
 */
import { z } from 'zod';
import { restartDashboardReal } from '../core/dashboard-restart.js';
import { repoRoot } from '../core/config.js';

export const schema = {
  ifStale: z.boolean().optional().describe('only restart when the running process started before the repo HEAD commit time'),
};

/** @type {import('./_shared.js').ToolDef} */
export const tool = {
  name: 'restart_dashboard',
  description: 'Restart the local job-search dashboard server so it picks up new code: stops exactly the verified dashboard node process, starts the "job-search dashboard" scheduled task, waits up to 30 s for health. Returns old_pid, new_pid, started_at, http_status, served_commit. ifStale:true restarts only when the process predates the repo HEAD commit.',
  schema,
  async handler(a, deps) {
    return restartDashboardReal({ ifStale: a.ifStale === true }, { env: deps.env, repoRoot: repoRoot() });
  },
};
