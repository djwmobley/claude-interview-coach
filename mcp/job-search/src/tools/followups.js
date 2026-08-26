// @ts-check
/**
 * followups (spec section 5 / 12b): create, list, complete, snooze, cancel.
 * Calendar events are created through the injected calendar deps when
 * notify includes 'calendar'; calendar failure surfaces as a warning.
 */
import { z } from 'zod';
import { createFollowup, listFollowups, completeFollowup, snoozeFollowup, cancelFollowup, formatFollowup, CHANNELS, NOTIFY, STATUSES } from '../core/followups.js';
import { JobSearchError } from '../core/errors.js';

export const schema = {
  action: z.enum(['create', 'list', 'complete', 'snooze', 'cancel']),
  id: z.number().int().positive().optional(),
  contact: z.string().max(120).optional(),
  org: z.string().max(120).optional(),
  listing_id: z.number().int().positive().optional(),
  due_at: z.string().max(30).optional().describe('ISO date or datetime'),
  channel: z.enum(CHANNELS).optional(),
  action_text: z.string().max(400).optional().describe('what to do, e.g. "phone 469-404-8664 if still silent"'),
  notify: z.array(z.enum(NOTIFY)).max(2).optional().describe("default ['email']; add 'calendar' for a 30-min event with a 60-min popup"),
  snoozed_until: z.string().max(30).optional(),
  status: z.array(z.enum(STATUSES)).max(4).optional().describe('list filter; default open+snoozed'),
  limit: z.number().int().min(1).max(25).default(25),
};

/** @type {import('./_shared.js').ToolDef} */
export const tool = {
  name: 'followups',
  description: 'Track follow-up threads (phone/email/linkedin) with due dates. create|list|complete|snooze|cancel. A daily digest of due items is emailed by bin/remind.js; notify:["email","calendar"] also books a calendar event.',
  schema,
  async handler(a, deps) {
    const calendar = deps.calendar ? await deps.calendar() : null;
    return deps.withClient(async (c) => {
      switch (a.action) {
        case 'create': {
          if (!a.channel) throw new JobSearchError('VALIDATION', 'channel is required');
          const { row, warnings } = await createFollowup(c, {
            contact: a.contact ?? '',
            org: a.org ?? null,
            listing_id: a.listing_id ?? null,
            due_at: a.due_at ?? '',
            channel: a.channel,
            action: a.action_text ?? '',
            notify: a.notify,
            created_from: 'mcp',
          }, { calendar });
          return { ok: true, row: formatFollowup(row), id: row.id, calendar_event_id: row.calendar_event_id, warnings };
        }
        case 'list': {
          const { rows, total } = await listFollowups(c, { status: a.status, limit: a.limit });
          return { ok: true, total, rows: rows.map(formatFollowup) };
        }
        case 'complete': {
          if (!a.id) throw new JobSearchError('VALIDATION', 'id is required');
          const { row, warnings } = await completeFollowup(c, a.id, { calendar });
          return { ok: true, row: formatFollowup(row), warnings };
        }
        case 'snooze': {
          if (!a.id) throw new JobSearchError('VALIDATION', 'id is required');
          if (!a.snoozed_until) throw new JobSearchError('VALIDATION', 'snoozed_until is required');
          const { row, warnings } = await snoozeFollowup(c, a.id, a.snoozed_until);
          return { ok: true, row: formatFollowup(row), warnings };
        }
        case 'cancel': {
          if (!a.id) throw new JobSearchError('VALIDATION', 'id is required');
          const { row, warnings } = await cancelFollowup(c, a.id, { calendar });
          return { ok: true, row: formatFollowup(row), warnings };
        }
        default:
          throw new JobSearchError('VALIDATION', 'unknown action');
      }
    });
  },
};
