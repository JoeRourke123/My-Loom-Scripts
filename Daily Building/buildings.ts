// The Recipe seam. pipeline.ts never mentions buildings; this file never mentions the database,
// leases, retries or HTTP. Third subject on the same engine.

import { z } from 'zod';
import { askJSON, askProseAll } from './pipeline';
import type { PlanResult, Recipe, Subject, WriteContext } from './pipeline';

const SEARCHES = 6;
const SECTIONS = 7;
const SECTION_WORDS = 300;

// The span of the shipped corpus, printed by build-arch-corpus.py. Used to place a building on the
// timeline rule — the sheet's signature. A self-check asserts these still bracket the data.
export const EARLIEST = -2560;
export const LATEST = 2026;

// ---------------------------------------------------------------------------------------------
// Picking

export function dayIndex(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

// buildings.jsonl is written in reading order by the builder — sorted by year, then dealt into
// seven era-strata and interleaved — so consecutive days jump across centuries instead of walking
// forward through time. The pick is a plain modulo over that pre-permuted file.
export async function pickBuilding(date: string): Promise<Subject> {
  const raw = await Loom.files.read('buildings.jsonl');
  const lines = raw.split('\n').filter((l) => l.length > 1);
  if (!lines.length) throw new Error('buildings.jsonl is empty — it may still be downloading from iCloud');
  const i = ((dayIndex(date) % lines.length) + lines.length) % lines.length;
  const b = JSON.parse(lines[i]);
  return {
    ...b,
    // Subject requires title/author; the engine uses them for the notification and the byline.
    title: b.name,
    author: b.architect,
  };
}

// -2560 reads as "2560 BC", which is what anyone writing about the Great Pyramid needs.
export function era(year: number): string {
  return year < 0 ? `${Math.abs(year)} BC` : String(year);
}

function describe(b: Subject): string {
  const who = b.architect && !/^(various|unknown)$/i.test(b.architect)
    ? `by ${b.architect}` : '(architect not recorded)';
  return `${b.name}, ${who}, completed ${era(b.year)}, in ${b.location} — catalogued as ${b.style}`;
}

// ---------------------------------------------------------------------------------------------
// Planning

const PlanSchema = z.object({
  title: z.string().min(3),
  standfirst: z.string().min(10),
  queries: z.array(z.string().min(3)).min(2),
  sections: z.array(z.object({
    heading: z.string().min(2),
    angle: z.string().min(5),
    imageQuery: z.string().min(2),
  })).min(3),
});

const PLAN_ROLE =
  'You are the commissioning editor of a serious architecture magazine, planning a long feature ' +
  'about a single building. You are interested in how buildings actually get made — clients, ' +
  'money, politics, engineering, and who had to live with the result.';

function planPrompt(b: Subject): string {
  return [
    `Today's building is ${describe(b)}.`,
    '',
    'Plan a 7-section feature about it. What is genuinely interesting about THIS building should',
    'drive the plan — do not fall back on a template.',
    '',
    'Cover a genuine spread. Strong candidates, not a required list:',
    '- who commissioned it, why, and what it cost',
    '- the architect, and where this sits in their work',
    '- the structural or engineering problem it had to solve',
    '- the site, the city, and what was there before',
    '- the style or movement, and what that movement was arguing for',
    '- how it was received — by critics, by the public, by the people who use it',
    '- what happened to it since: alteration, restoration, near-demolition, listing',
    '- its influence on what was built afterwards',
    '',
    'Return JSON with exactly these fields:',
    '{',
    '  "title": "a magazine headline for the feature — not just the building\'s name",',
    '  "standfirst": "one or two sentences of deck copy under the headline",',
    `  "queries": [${SEARCHES} web search queries that would surface real material.`,
    `     Make ONE of them exactly: ${b.name} ${b.location} architecture`,
    '     Aim the others at the architect, the client, the engineering, the style and the reception.],',
    `  "sections": [${SECTIONS} objects, each:`,
    '     { "heading": "a real headline, not a label like Background",',
    '       "angle": "one sentence on what this section argues or reveals",',
    '       "imageQuery": "a Wikipedia article title likely to have a good photograph for this ' +
      'section — the architect, the city, the movement, a related building, or a material" }]',
    '}',
    '',
    // The building's own photograph is already the plate at the top of the sheet.
    `IMPORTANT: no imageQuery may be "${b.name}" or any attempt to find this same building. The`,
    'reader is already looking at it. Point the lookups at people, cities, movements and OTHER works.',
  ].join('\n');
}

async function plan(b: Subject, attempt: number): Promise<PlanResult> {
  const raw = await askJSON(planPrompt(b), PLAN_ROLE, attempt);
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`plan JSON failed validation: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ').slice(0, 200)}`);
  }
  const p = parsed.data;
  const own = String(b.name || '').toLowerCase().trim();
  const fallback = /^(various|unknown)$/i.test(String(b.architect)) ? String(b.style) : String(b.architect);
  return {
    title: p.title,
    standfirst: p.standfirst,
    queries: dedupe(p.queries).slice(0, SEARCHES),
    sections: p.sections.slice(0, SECTIONS).map((s) => ({
      ...s,
      imageQuery: s.imageQuery.toLowerCase().trim() === own ? fallback : s.imageQuery,
    })),
  };
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  return list.filter((s) => {
    const k = s.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Writing

const WRITE_ROLE =
  'You are a staff writer for a serious architecture magazine. You write clear, specific, ' +
  'grown-up prose: concrete detail over adjectives, real names, dates, budgets and materials, no ' +
  'throat-clearing. You never invent a fact, a date, a quotation, or a description of something ' +
  'you have not seen.';

function writePrompt(ctx: WriteContext): string {
  const b = ctx.subject;
  const section = ctx.sections[ctx.index];
  const outline = ctx.sections.map((s, i) =>
    `${i + 1}. ${s.heading}${i === ctx.index ? '   <-- you are writing this one' : ''}`,
  ).join('\n');

  return [
    `FEATURE: ${ctx.title}`,
    ctx.standfirst,
    '',
    `THE BUILDING: ${describe(b)}`,
    '',
    'FULL OUTLINE (so you do not repeat what other sections cover):',
    outline,
    '',
    ctx.previous ? `The previous section opened: “${ctx.previous}”\n` : '',
    `YOUR SECTION: ${section.heading}`,
    `Its job: ${section.angle}`,
    '',
    'RESEARCH — these are the only sources you may cite:',
    ctx.sources.length
      ? ctx.sources.map((s, i) => `[${i + 1}] ${s.title}\n    ${s.url}\n    ${s.content.slice(0, 900)}`).join('\n\n')
      : '(none returned — say plainly that the record is thin and write only what is certain)',
    '',
    `Write up to about ${SECTION_WORDS} words of markdown body text for this section.`,
    'Length is a ceiling, not a target. A solid 150 words beats a padded 300.',
    '',
    'Rules:',
    // Same class of failure as the artwork project: there is no vision model behind Loom.ai, so
    // every visual claim is invention, and nothing downstream can detect a fabricated cornice.
    '- You have NOT seen this building or its photograph. Nothing about its appearance — the',
    '  colour of the stone, how the light falls, what the entrance looks like, how it sits against',
    '  the skyline — may appear in your prose unless a source above describes it in those words.',
    '- The reader is looking at a photograph of it right now. You are not there to describe it.',
    '  Write what is DOCUMENTED: who paid, who objected, what it cost, how it is built, what was',
    '  demolished to make room, what happened to it afterwards.',
    '- Dimensions, dates, budgets and material names must come from a source above. Architecture',
    '  writing is full of confidently wrong numbers; do not add to it.',
    '- Do NOT repeat the section heading — start with the prose.',
    '- NEVER put words in quotation marks unless they appear verbatim in a source above.',
    '- Markdown links only to the source URLs listed above, and only where a claim needs one.',
    '- Link a short phrase of two to five words from your own sentence. Never a bare number like',
    '  [1], and never a whole sentence copied out of the source.',
    '- No bullet lists unless the material genuinely is a list.',
  ].filter(Boolean).join('\n');
}

async function writeAll(contexts: WriteContext[]): Promise<string[]> {
  return askProseAll(contexts.map(writePrompt), WRITE_ROLE);
}

// ---------------------------------------------------------------------------------------------

export const recipe: Recipe = {
  table: 'articles',
  searches: SEARCHES,
  sections: SECTIONS,
  pick: pickBuilding,
  plan,
  writeAll,
};
