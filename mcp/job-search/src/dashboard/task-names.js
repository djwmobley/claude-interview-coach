// @ts-check
/**
 * Task Scheduler task names shared between routes/summary.js's "next scheduled scan" query and
 * scripts/register-dashboard-task.ps1. SCAN_TASK_NAME matches the existing "job-search scan" task
 * registered per README's Task Scheduler section (unchanged by this PR); DASHBOARD_TASK_NAME is the new
 * task scripts/register-dashboard-task.ps1 writes (registered by the operator, not by this code).
 */
export const SCAN_TASK_NAME = 'job-search scan';
export const DASHBOARD_TASK_NAME = 'job-search dashboard';
