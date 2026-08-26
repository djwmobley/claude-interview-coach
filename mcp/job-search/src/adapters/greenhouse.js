// @ts-check
/**
 * Greenhouse adapter (fetch): boards-api per configured board, client-side
 * title filter. One list call per board (the API returns every open job);
 * detail (`content`) is fetched per job only through fetchDetail so the
 * list call stays small.
 *
 *   list    GET https://boards-api.greenhouse.io/v1/boards/<board>/jobs
 *   detail  GET https://boards-api.greenhouse.io/v1/boards/<board>/jobs/<id>
 */
import { defineAdapter, rawListing, titleMatches, isoDate, decodeEntities, remoteFromText } from './base.js';
import { normalizeUrl } from '../core/normalize.js';

const API = 'https://boards-api.greenhouse.io/v1/boards';

/**
 * @param {string} board
 */
function listUrl(board) {
  const u = new URL(`${API}/${encodeURIComponent(board)}/jobs`);
  return u.toString();
}

/**
 * Map one API job object to a RawListing. Exported for tests.
 * @param {any} job
 * @param {{ board: string, company: string }} b
 */
export function mapJob(job, b) {
  const id = job && job.id != null ? String(job.id) : null;
  if (!id || !/^\d+$/.test(id)) return null;
  const abs = typeof job.absolute_url === 'string' ? job.absolute_url : '';
  const canonical = normalizeUrl(abs);
  const url = canonical.kind === 'canonical' && canonical.source === 'greenhouse' ? abs : `https://boards.greenhouse.io/${b.board}/jobs/${id}`;
  const location = job.location && typeof job.location.name === 'string' ? job.location.name.trim() : null;
  const remote = remoteFromText(`${job.title ?? ''} ${location ?? ''}`);
  const content = typeof job.content === 'string' ? decodeEntities(job.content) : null;
  return rawListing({
    source: 'greenhouse',
    externalId: `${b.board}/${id}`,
    url,
    title: String(job.title ?? ''),
    company: String(job.company_name ?? b.company ?? ''),
    location,
    remoteMode: remote.remoteMode,
    remoteDeclared: remote.remoteDeclared,
    postedAt: isoDate(job.first_published ?? job.updated_at ?? null),
    description: content,
  });
}

export const greenhouse = defineAdapter({
  name: 'greenhouse',
  needsBrowser: false,
  dateOrdered: false,
  domains: ['boards-api.greenhouse.io', 'boards.greenhouse.io', 'job-boards.greenhouse.io', 'boards.eu.greenhouse.io', 'my.greenhouse.io'],
  pathPatterns: ['^/v1/boards/[a-z0-9-]+/jobs(/\\d+)?(\\?|$)', '^/[a-z0-9-]+/jobs/\\d+/?(\\?|$)'],
  blindSpots: [
    'only boards listed in ats-boards.json are scanned; a company not in the list is invisible',
    'title filter is a substring match on the profile terms; a role titled without any term is missed',
    'salary is not in the list payload; it is parsed from the detail content only when the role clears the prescore gate',
  ],
  async *search(profile, ctx) {
    const boards = ctx.config.atsBoards.greenhouse.filter((b) => b.enabled);
    for (const b of boards) {
      const query = `board:${b.board}`;
      await ctx.reservePage();
      const res = await ctx.fetchJson(listUrl(b.board));
      const jobs = res.json && typeof res.json === 'object' && Array.isArray(/** @type {any} */ (res.json).jobs) ? /** @type {any} */ (res.json).jobs : null;
      if (res.status !== 200 || !jobs) {
        yield { kind: 'warning', code: res.status === 404 ? 'BOARD_NOT_FOUND' : 'BAD_RESPONSE', message: `greenhouse board ${b.board}: HTTP ${res.status}`, query };
        yield { kind: 'batch', query, pageIndex: 1, parsed: 0, status: res.status, url: `${API}/${b.board}/jobs` };
        continue;
      }
      let parsed = 0;
      let stop = false;
      for (const job of jobs) {
        const l = mapJob(job, b);
        if (!l || !titleMatches(l.title, profile)) continue;
        parsed++;
        const d = yield { kind: 'listing', query, pageIndex: 1, listing: l };
        if (d && d.stopQuery) {
          stop = true;
          break;
        }
      }
      ctx.log({ evt: 'greenhouse_board', board: b.board, jobs: jobs.length, matched: parsed });
      yield { kind: 'batch', query, pageIndex: 1, parsed, status: res.status, url: `${API}/${b.board}/jobs` };
      if (stop) continue;
    }
  },
  async fetchDetail(listing, ctx) {
    const n = normalizeUrl(listing.url_normalized ?? listing.url ?? null);
    const m = n.external_id ? /^greenhouse:([a-z0-9-]+)\/(\d+)$/.exec(n.external_id) : null;
    if (!m) return { description: null };
    await ctx.reserveDetail();
    const res = await ctx.fetchJson(`${API}/${m[1]}/jobs/${m[2]}`);
    const j = /** @type {any} */ (res.json);
    if (res.status !== 200 || !j || typeof j.content !== 'string') return { description: null };
    return { description: decodeEntities(j.content) };
  },
});
