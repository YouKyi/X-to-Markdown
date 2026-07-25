// Two repository rules that are cheap to break and expensive to notice, checked
// on every `pnpm check` rather than remembered.
//
//   1. No fixture may carry `relationship_perspectives`. A raw X capture records,
//      for every participant, whether the capturing user follows, is followed by,
//      blocks, mutes or can DM them. This repository is public. The pruner strips
//      it; this asserts the pruner actually ran.
//
//   2. No em dash, en dash, or their HTML entities. The one exemption is text
//      written by someone on X, which is quoted verbatim in fixtures, goldens and
//      the assertions over them - changing an author's punctuation would make the
//      fixture a fiction.
//
// Run directly: `node tools/check-hygiene.mjs`.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Escapes rather than literals: this file is tracked, so a literal dash here
// would make the checker fail on itself.
const DASHES = new RegExp('[\\u2013\\u2014]|&[mn]dash;', 'g');

// Whole trees where every occurrence is author text, quoted verbatim.
const DASH_EXEMPT_TREES = ['test/fixtures/', 'test/golden/'];

// Files that carry a known, counted amount of author text. The count is exact so
// that a *new* dash still fails here: if a legitimate change moves the number,
// update it in the same commit and say why.
const DASH_EXEMPT_FILES = new Map([
  // The golden output block, reproduced from test/golden/simple-thread.md.
  ['README.md', 1],
  // The same reply, asserted verbatim.
  ['test/parse.test.ts', 1],
  ['test/render.test.ts', 1],
]);

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

const failures = [];

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue; // binary, or removed from the working tree; neither is our business
  }

  // The captures themselves, not test/fixtures/README.md, which names the field
  // in order to explain why it must never appear.
  if (
    file.startsWith('test/fixtures/') &&
    file.endsWith('.json') &&
    text.includes('relationship_perspectives')
  ) {
    failures.push(
      `${file}: contains relationship_perspectives. Re-run tools/prune-fixture.mjs; ` +
        `never commit an unpruned capture.`,
    );
  }

  if (DASH_EXEMPT_TREES.some((tree) => file.startsWith(tree))) continue;

  const found = text.match(DASHES)?.length ?? 0;
  const allowed = DASH_EXEMPT_FILES.get(file) ?? 0;
  if (found > allowed) {
    failures.push(
      `${file}: ${found} em/en dash occurrence(s), ${allowed} allowed. ` +
        `Use a hyphen or rewrite the sentence.`,
    );
  } else if (found < allowed) {
    failures.push(
      `${file}: ${found} em/en dash occurrence(s) but ${allowed} are allowlisted in ` +
        `tools/check-hygiene.mjs. Lower the count there.`,
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(`hygiene: ${files.length} tracked files clean`);
