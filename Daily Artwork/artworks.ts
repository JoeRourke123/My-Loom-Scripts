// The Recipe seam. pipeline.ts never mentions artworks; this file never mentions the database,
// leases, retries or HTTP. It is the whole of what changed between Daily Poem and Daily Artwork —
// the engine was copied across untouched.

import { z } from 'zod';
import { askJSON, askProseAll } from './pipeline';
import type { PlanResult, Recipe, Subject, WriteContext } from './pipeline';

const SEARCHES = 6;
const SECTIONS = 7;
const SECTION_WORDS = 300;

// ---------------------------------------------------------------------------------------------
// Picking

export function dayIndex(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

// artworks.jsonl is written in reading order by build-art-corpus.py — artists round-robined,
// British interleaved proportionally through the two years — so the pick is a plain modulo over a
// pre-permuted file. Deterministic for any date, no repeats for 730 days, and the same work again
// after a delete. Every image in it was fetched and measured during the build, so a shipped row is
// a guarantee that the picture exists and is big enough to fill a phone screen.
export async function pickArtwork(date: string): Promise<Subject> {
  const raw = await Loom.files.read('artworks.jsonl');
  const lines = raw.split('\n').filter((l) => l.length > 1);
  if (!lines.length) throw new Error('artworks.jsonl is empty — it may still be downloading from iCloud');
  const i = ((dayIndex(date) % lines.length) + lines.length) % lines.length;
  const work = JSON.parse(lines[i]);
  return {
    ...work,
    // Subject requires `author`; the engine uses it for the notification body and the byline.
    author: work.artist,
  };
}

function describe(a: Subject): string {
  const bits = [`“${a.title}” by ${a.author}`];
  if (a.year) bits.push(`painted ${a.year}`);
  if (a.movementLabel) bits.push(`catalogued under ${a.movementLabel}`);
  return bits.join(', ');
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
  'You are the commissioning editor of a serious art magazine, planning a long feature built ' +
  'around a single painting. You are curious, specific, and allergic to gallery-wall platitudes.';

function planPrompt(a: Subject): string {
  return [
    `Today's work is ${describe(a)}.`,
    '',
    'Plan a 7-section feature about it. What is interesting about THIS work and THIS artist should',
    'drive the plan — do not fall back on a template.',
    '',
    'Cover a genuine spread. Strong candidates, not a required list:',
    '- who the artist was, and what their life was actually like',
    '- how and when this particular work came to be made, and for whom',
    '- the movement it is filed under, and what that movement was arguing for',
    '- the historical moment around it',
    '- how it was received, sold, hung, attacked or ignored',
    '- what the artist changed about how painting was done',
    '- where the work and the artist stand now, and who they influenced',
    '- an argument, a controversy, or an unresolved attribution',
    '',
    'Return JSON with exactly these fields:',
    '{',
    '  "title": "a magazine headline for the feature — not just the work\'s title",',
    '  "standfirst": "one or two sentences of deck copy under the headline",',
    `  "queries": [${SEARCHES} web search queries that would surface real material.`,
    `     Make ONE of them exactly: "${a.title}" ${a.author} painting`,
    '     Aim another at a museum, gallery or catalogue page for the work.',
    '     Use the others for the artist, the movement and the period.],',
    `  "sections": [${SECTIONS} objects, each:`,
    '     { "heading": "a real headline, not a label like Background",',
    '       "angle": "one sentence on what this section argues or reveals",',
    '       "imageQuery": "a Wikipedia article title likely to have a good photograph or painting ' +
      'for this section — a person, place, movement, building or a DIFFERENT artwork" }]',
    '}',
    '',
    // The subject painting is already the full-screen backdrop. A Wikipedia copy of it would be a
    // different URL, so the engine's image de-dupe cannot catch it — only this rule can.
    `IMPORTANT: no imageQuery may be "${a.title}" or any attempt to find this same work. The reader`,
    'is already looking at it. Point the image lookups at people, places, movements and other works.',
  ].join('\n');
}

async function plan(a: Subject, attempt: number): Promise<PlanResult> {
  const raw = await askJSON(planPrompt(a), PLAN_ROLE, attempt);
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`plan JSON failed validation: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ').slice(0, 200)}`);
  }
  const p = parsed.data;
  const own = String(a.title || '').toLowerCase().trim();
  return {
    title: p.title,
    standfirst: p.standfirst,
    queries: dedupe(p.queries).slice(0, SEARCHES),
    sections: p.sections.slice(0, SECTIONS).map((s) => ({
      ...s,
      // Belt and braces on the rule above — if it asked for the work itself anyway, fall back to
      // the artist, who always has a page worth illustrating.
      imageQuery: s.imageQuery.toLowerCase().trim() === own ? String(a.author) : s.imageQuery,
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
  'You are a staff writer for a serious art magazine. You write clear, specific, grown-up prose: ' +
  'concrete detail over adjectives, real names and dates, no throat-clearing. You never invent a ' +
  'fact, a date, a quotation, or a description of something you have not seen.';

function writePrompt(ctx: WriteContext): string {
  const a = ctx.subject;
  const section = ctx.sections[ctx.index];
  const outline = ctx.sections.map((s, i) =>
    `${i + 1}. ${s.heading}${i === ctx.index ? '   <-- you are writing this one' : ''}`,
  ).join('\n');

  return [
    `FEATURE: ${ctx.title}`,
    ctx.standfirst,
    '',
    `THE WORK: ${describe(a)}`,
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
    // THE rule for this project. There is no vision model behind Loom.ai and the dataset carries a
    // description for barely 1% of works, so every visual claim would be invention — and unlike a
    // fabricated URL, nothing downstream can detect a fabricated brushstroke.
    '- You have NOT seen this painting. Nothing about its appearance — colour, composition,',
    '  brushwork, the sitter\'s expression, what is in the background, how big it is — may appear',
    '  in your prose unless a source above describes it in those words. This is the single most',
    '  important rule here.',
    '- The reader is looking at the picture right now, full screen, behind your text. You are not',
    '  there to describe it to them. Write what is DOCUMENTED: who made it, when, why, who paid',
    '  for it, where it hung, what was argued about it, what the movement wanted.',
    '- Every concrete detail — a place, a date, a price, a name — must come from a source above.',
    '  If you are reaching for something to fill the paragraph, stop instead.',
    '- Do NOT repeat the section heading — start with the prose.',
    '- NEVER put words in quotation marks unless they appear verbatim in a source above.',
    '- Markdown links only to the source URLs listed above, and only where a claim needs one.',
    '- Link a short phrase of two to five words from your own sentence. Never a bare number like',
    '  [1], and never a whole sentence copied out of the source.',
    '- No bullet lists unless the material genuinely is a list.',
  ].filter(Boolean).join('\n');
}

// One batched call for every section still needing a body. Ordering matches the input, and a ''
// entry means that section failed — pipeline.ts retries only those.
async function writeAll(contexts: WriteContext[]): Promise<string[]> {
  return askProseAll(contexts.map(writePrompt), WRITE_ROLE);
}

// ---------------------------------------------------------------------------------------------

export const recipe: Recipe = {
  table: 'articles',
  searches: SEARCHES,
  sections: SECTIONS,
  pick: pickArtwork,
  plan,
  writeAll,
};
