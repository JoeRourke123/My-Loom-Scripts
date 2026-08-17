// The Recipe seam. pipeline.ts never mentions poems; this file never mentions the database,
// leases, retries or HTTP. To build "Daily Film" or "Daily Painting" later, replace this file and
// three literals in main.ts — everything else is engine.

import { z } from 'zod';
import { askJSON, askProseAll } from './pipeline';
import type { PlanResult, Recipe, Subject, WriteContext } from './pipeline';

const SEARCHES = 6;
const SECTIONS = 7;
const SECTION_WORDS = 320;

// ---------------------------------------------------------------------------------------------
// Picking

export function dayIndex(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
}

// poems.jsonl is written in reading order by build-corpus.py — strands interleaved proportionally,
// authors round-robined — so the pick is a plain modulo over a pre-permuted file. That buys, for
// free: determinism for any date past or future, no repeats for a full 730-day cycle, and the same
// poem on rebuild after a delete. All the balancing lives offline where there are real tools.
export async function pickPoem(date: string): Promise<Subject> {
  const raw = await Loom.files.read('poems.jsonl');
  const lines = raw.split('\n').filter((l) => l.length > 1);
  if (!lines.length) throw new Error('poems.jsonl is empty — it may still be downloading from iCloud');
  // Parses one line, never all 730.
  const i = ((dayIndex(date) % lines.length) + lines.length) % lines.length;
  const poem = JSON.parse(lines[i]);
  return { ...poem, id: String(poem.id) };
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
  'You are the commissioning editor of a serious poetry magazine, planning a long illustrated ' +
  'feature about a single poem. You are curious, specific and allergic to generic literary filler.';

function planPrompt(poem: Subject): string {
  return [
    `Today's poem is “${poem.title}” by ${poem.author}.`,
    poem.strandLabel ? `It sits in our ${poem.strandLabel} strand.` : '',
    '',
    'THE POEM:',
    poem.excerpt || poem.text,
    poem.truncated ? '\n[The poem is longer than shown.]' : '',
    '',
    `Plan a ${SECTIONS}-section feature about it. Read the poem first and let what is actually`,
    'interesting about THIS poem drive the plan — do not fall back on a template.',
    '',
    'Cover a genuine spread. Strong candidates, not a required list:',
    '- who the poet was, and what their life was actually like',
    '- how and when this particular poem came to be written',
    '- the movement or circle it belongs to, and what that movement was arguing for',
    '- the historical moment around it',
    '- the craft: form, metre, imagery, the specific moves this poem makes',
    '- how it was received at the time, and by whom',
    '- its afterlife: who it influenced, where it turns up now',
    '- an argument, a controversy, or an unresolved question about it',
    '',
    'Return JSON with exactly these fields:',
    '{',
    '  "title": "a magazine headline for the feature — not just the poem\'s title",',
    '  "standfirst": "one or two sentences of deck copy under the headline",',
    `  "queries": [${SEARCHES} web search queries that would surface real material for this feature;`,
    '     make them specific, include the poet\'s full name where it helps, vary them],',
    `  "sections": [${SECTIONS} objects, each:`,
    '     { "heading": "a real headline, not a label like Background",',
    '       "angle": "one sentence on what this section argues or reveals",',
    '       "imageQuery": "a Wikipedia article title likely to have a good photograph or painting ' +
      'for this section — a person, place, movement, artwork or event" }]',
    '}',
  ].filter(Boolean).join('\n');
}

async function plan(poem: Subject, attempt: number): Promise<PlanResult> {
  const raw = await askJSON(planPrompt(poem), PLAN_ROLE, attempt);
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`plan JSON failed validation: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ').slice(0, 200)}`);
  }
  const p = parsed.data;
  return {
    title: p.title,
    standfirst: p.standfirst,
    queries: dedupe(p.queries).slice(0, SEARCHES),
    // Clamp rather than reject: a model that returns 6 or 8 sections has still done the job, and
    // unitsTotal is derived from the real count anyway.
    sections: p.sections.slice(0, SECTIONS),
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
  'You are a staff writer for a serious poetry magazine. You write clear, specific, grown-up ' +
  'prose: concrete detail over adjectives, real names and dates, no throat-clearing, no summary ' +
  'of what you are about to say. You never invent a fact, a date or a quotation.';

function writePrompt(ctx: WriteContext): string {
  const section = ctx.sections[ctx.index];
  const outline = ctx.sections.map((s, i) =>
    `${i + 1}. ${s.heading}${i === ctx.index ? '   <-- you are writing this one' : ''}`,
  ).join('\n');

  return [
    `FEATURE: ${ctx.title}`,
    ctx.standfirst,
    '',
    `THE POEM — “${ctx.subject.title}” by ${ctx.subject.author}:`,
    ctx.subject.excerpt || ctx.subject.text,
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
      : '(none returned — write from the poem itself and say plainly where the record is thin)',
    '',
    `Write up to about ${SECTION_WORDS} words of markdown body text for this section.`,
    // Observed live: given a word target and thin sources, the model pads to length by inventing
    // circumstantial detail (a house in the wrong city, a plausible date). Explicitly licensing a
    // short section removes the pressure that causes it. This matters more than any of the rules
    // below, because no filter downstream can catch a confidently wrong fact.
    'Length is a ceiling, not a target. A solid 150 words beats a padded 320 — if the sources only',
    'support a little, write a little, and say plainly where the record is thin.',
    'Rules:',
    '- Do NOT repeat the section heading — start with the prose.',
    '- Every concrete detail — a place, a date, a number, a name — must come from the poem or the',
    '  sources above. If you are reaching for something to fill the paragraph, stop instead.',
    '- Markdown links only to the source URLs listed above, and only where a claim needs one.',
    '- Link a short phrase of two to five words from your own sentence. Never a bare number like',
    '  [1], and never a whole sentence copied out of the source.',
    '- Quote the poem where it earns it, in a > blockquote.',
    // Observed live: given thin sources the model will manufacture a plausible period quotation
    // and attribute it. stripUnknownLinks catches invented URLs but nothing catches invented
    // quotation marks, so the prompt has to.
    '- NEVER put words in quotation marks unless they appear verbatim in the poem above or in one',
    '  of the sources above. Paraphrase instead. An invented quotation is the worst thing you can',
    '  do here.',
    '- If the sources do not support a claim, leave it out or say the record is unclear.',
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
  pick: pickPoem,
  plan,
  writeAll,
};
