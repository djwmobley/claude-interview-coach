// @ts-check
/**
 * Assisted apply driver under its assisted name. The implementation stays in
 * src/apply/easy-apply-driver.js because test/easy-apply-lint.test.js pins that file as the only module
 * allowed to act on the page; this module only re-exports it.
 */
export { createAssistedDriver, createEasyApplyDriver, PAGE_FUNCTION } from '../easy-apply-driver.js';
