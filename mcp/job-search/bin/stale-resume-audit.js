#!/usr/bin/env node
// @ts-check
/**
 * Read-only audit: every currently linked resume (ic_job_documents kind resume, plus any document an
 * application references through resume_doc_id) that FAILS the resume content gate against the CURRENT
 * data/project-index.md. Dry run only: this script issues SELECTs and reads files; it never writes to the
 * database or to disk.
 *
 *   node bin/stale-resume-audit.js [--json] [--help]
 *
 * Prints one line per failing resume (or JSON with --json). Exit 0 = every linked resume passes,
 * exit 2 = at least one fails, exit 1 = the audit itself could not run.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot } from '../src/core/config.js';
import { connectDedicated } from '../src/core/db.js';
import { resolveOutputPath } from '../src/core/documents.js';
import { checkResumeFile } from '../src/core/resume-content-gate.js';

const USAGE = 'usage: node bin/stale-resume-audit.js [--json] [--help]';

/**
 * @param {import('pg').ClientBase} client
 * @param {{ outputRoot: string, indexPath: string }} o
 * @returns {Promise<{ checked: number, failing: Array<{ listing_id: number, title: string|null, company: string|null, rel_path: string, missing: string[], reason: string|null, application_status: string|null }> }>}
 */
export async function auditStaleResumes(client, o) {
  const docs = await client.query(
    `SELECT d.id, d.listing_id, d.rel_path, l.title, l.company,
            (SELECT string_agg(a.state, ',' ORDER BY a.id) FROM ic_job_applications a WHERE a.resume_doc_id = d.id) AS app_states
       FROM ic_job_documents d
       LEFT JOIN ic_job_listings l ON l.id = d.listing_id
      WHERE d.kind = 'resume' OR d.id IN (SELECT resume_doc_id FROM ic_job_applications WHERE resume_doc_id IS NOT NULL)
      ORDER BY d.id`,
  );
  const failing = [];
  for (const d of docs.rows) {
    const resolved = resolveOutputPath(o.outputRoot, String(d.rel_path));
    const verdict = resolved.ok
      ? checkResumeFile(resolved.absPath, o.indexPath)
      : { ok: false, missing: /** @type {string[]} */ ([]), reason: `path not usable (${resolved.reason})` };
    if (verdict.ok) continue;
    failing.push({
      listing_id: Number(d.listing_id), title: d.title ?? null, company: d.company ?? null, rel_path: String(d.rel_path),
      missing: verdict.missing, reason: verdict.reason, application_status: d.app_states ?? null,
    });
  }
  return { checked: docs.rowCount ?? docs.rows.length, failing };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    process.exit(0);
  }
  const root = repoRoot();
  const client = await connectDedicated();
  try {
    const { checked, failing } = await auditStaleResumes(client, { outputRoot: path.join(root, 'output'), indexPath: path.join(root, 'data', 'project-index.md') });
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ checked, failing }, null, 2));
    } else {
      console.log(`checked ${checked} linked resume(s); ${failing.length} fail the content gate`);
      for (const f of failing) {
        console.log(`listing ${f.listing_id} | ${f.title ?? '?'} | ${f.company ?? '?'} | ${f.rel_path} | missing: ${f.missing.join('; ') || f.reason} | application: ${f.application_status ?? 'none'}`);
      }
    }
    process.exitCode = failing.length ? 2 : 0;
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
