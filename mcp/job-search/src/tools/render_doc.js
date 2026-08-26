// @ts-check
/**
 * render_doc (spec 12a): preflight + DOCX rendering through the Python
 * converters. See core/render.js for the checks.
 */
import { z } from 'zod';
import { renderDoc, KINDS } from '../core/render.js';

export const schema = {
  kind: z.enum(KINDS),
  source: z.string().min(1).max(300).describe('repo-relative .md (or .txt for cover letters) path'),
  outName: z.string().max(80).optional().describe('human file name without extension, e.g. "Jordan Reyes - CTO"; required for resumes and cover letters'),
  checkOnly: z.boolean().default(false),
  force: z.boolean().default(false).describe('overwrite an existing DOCX (never one that is open in Word)'),
  allowMissing: z.array(z.string().max(60)).max(10).optional().describe('companies approved for omission from a resume'),
};

/** @type {import('./_shared.js').ToolDef} */
export const tool = {
  name: 'render_doc',
  description: 'Preflight a resume, cover letter, or cheat sheet markdown (em-dash, en-dash, scare quotes, buzzwords, problem-comparison reframe, resume structure, role inclusion, PMP wording, Jenkon title, output naming) and render the DOCX with the repo converters. Fails closed on any check; returns LOCKED when the DOCX is open in Word. Never opens the file.',
  schema,
  async handler(a) {
    return renderDoc({ kind: a.kind, source: a.source, outName: a.outName, checkOnly: a.checkOnly, force: a.force, allowMissing: a.allowMissing ?? [] });
  },
};
