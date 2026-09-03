// @ts-check
/**
 * Compensation floor resolution (one-click apply PR A, spec item 2). A total classification over the
 * whole location_norm/remote_mode vocabulary src/core/normalize.js produces: every input maps to exactly
 * one of two floors, never a third "unscored"/"unknown" branch. The two floors themselves are config
 * (config/auto-apply.json's `floors`), never hardcoded here -- resolveFloor() takes them as a parameter so
 * a config change never requires a code change.
 *
 * "Texas or remote" gets the LOWER floor (225000): a remote or Texas-based role is treated as home-turf,
 * commanding a lower minimum than an out-of-state relocation. Every other value -- including a plain
 * onsite US location outside Texas, an unresolved/absent location, and a legacy-unknown row -- gets the
 * HIGHER "relocation" floor (275000): the default assumption for anything that is not demonstrably
 * texas-or-remote is that accepting it would mean relocating, which commands a higher floor. This mirrors
 * the "friction over silent escape" rule for validation gates (CLAUDE.md): the narrower, cheaper branch
 * (225000) is reached only by an explicit, positive match; everything else -- including any location value
 * this function has never seen before -- falls to the safer, higher floor rather than silently landing in
 * the cheaper one.
 */

/**
 * @typedef {Object} SalaryFloors
 * @property {number} texas_or_remote
 * @property {number} relocation
 */

const TEXAS_CITY_RE = /^city-.*-tx$/;

/**
 * @param {{ locationNorm: string|null|undefined, remoteMode: string|null|undefined }} input
 * @param {SalaryFloors} floors
 * @returns {number}
 */
export function resolveFloor(input, floors) {
  const locationNorm = typeof input.locationNorm === 'string' ? input.locationNorm : '';
  const remoteMode = input.remoteMode ?? null;
  const isTexasOrRemote = remoteMode === 'remote'
    || locationNorm.startsWith('remote-')
    || locationNorm === 'state-tx'
    || TEXAS_CITY_RE.test(locationNorm);
  return isTexasOrRemote ? floors.texas_or_remote : floors.relocation;
}
