// @ts-check
/**
 * Compensation floor resolution (one-click apply PR A, spec item 2). A total classification over the
 * whole location_norm/remote_mode vocabulary src/core/normalize.js produces: every input maps to exactly
 * one of two floors, never a third "unscored"/"unknown" branch. The two floors themselves are config
 * (config/auto-apply.json's `floors`), never hardcoded here -- resolveFloor() takes them as a parameter so
 * a config change never requires a code change.
 *
 * CALLER CONTRACT: this function assumes non-US listings have already been excluded upstream. It has no
 * notion of "non-US" as a category of its own -- a `remote-de`, `country-de`, or similar non-US signal
 * falls through to the (higher) relocation floor by default, but that is a byproduct of the total
 * classification below, not a deliberate non-US branch. Callers MUST filter out non-US listings before
 * calling resolveFloor(), the same way they already must before treating any dollar floor as meaningful.
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
 *
 * Total classification, first match wins (see src/core/normalize.js roughly lines 640-730 for the real
 * location_norm vocabulary this is built against -- notably a Texas city value has NO "city-" prefix, e.g.
 * "houston-tx", not "city-houston-tx"):
 *   1. TEXAS      -- loc matches /^[a-z0-9'.-]+-tx$/ (covers "houston-tx", "state-tx", "remote-us-tx").
 *                    An "unknown:<sha1>" value contains a colon, which the character class excludes, so it
 *                    can never accidentally match here.
 *   2. REMOTE     -- loc === 'remote', or loc starts with 'remote-us', or (remoteMode === 'remote' and loc
 *                    does not itself start with 'remote-'). A non-US remote signal such as 'remote-de'
 *                    deliberately does NOT qualify here and falls through to OTHER_US/UNKNOWN below.
 *   3. UNKNOWN    -- loc === '' (absent/never normalized), loc starts with 'unknown:', or loc ===
 *                    'legacy-unknown'.
 *   4. OTHER_US   -- everything else (e.g. 'country-us', 'state-ny', 'denver-co').
 * TEXAS and REMOTE resolve to floors.texas_or_remote; UNKNOWN and OTHER_US resolve to floors.relocation
 * (the conservative default for anything not demonstrably texas-or-remote).
 *
 * Never throws: a non-object `input` or `floors` is treated as `{}` rather than raising, and a
 * non-string/absent locationNorm or remoteMode is treated as the empty string.
 */

/**
 * @typedef {Object} SalaryFloors
 * @property {number} texas_or_remote
 * @property {number} relocation
 */

const TEXAS_RE = /^[a-z0-9'.-]+-tx$/;

/**
 * @param {{ locationNorm?: string|null|undefined, remoteMode?: string|null|undefined }} input
 * @param {SalaryFloors} floors
 * @returns {number}
 */
export function resolveFloor(input, floors) {
  const safeInput = input !== null && typeof input === 'object' ? input : {};
  const safeFloors = floors !== null && typeof floors === 'object' ? floors : /** @type {any} */ ({});

  const loc = typeof safeInput.locationNorm === 'string' ? safeInput.locationNorm.trim().toLowerCase() : '';
  const mode = typeof safeInput.remoteMode === 'string' ? safeInput.remoteMode.trim().toLowerCase() : '';

  const isTexas = TEXAS_RE.test(loc);
  const isRemote = !isTexas && (
    loc === 'remote'
    || loc.startsWith('remote-us')
    || (mode === 'remote' && !loc.startsWith('remote-'))
  );

  return (isTexas || isRemote) ? safeFloors.texas_or_remote : safeFloors.relocation;
}
