import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';

const source = await readFile(new URL('../docker/setup/client/skill-diff.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source + '\nglobalThis.diff = T3SkillDiff;', context);
const diff = context.diff;
const plain = value => JSON.parse(JSON.stringify(value));
const allLines = hunks => hunks.flatMap(hunk => hunk.lines || []);
const fixture = JSON.parse(await readFile(new URL('../scripts/fixtures/console/skill-update-preview.json', import.meta.url)));

test('the handoff instructions produce three hunks, contextual folds and +6 −3', () => {
  const pair = fixture.changes.find(file => file.name === 'SKILL.md').text;
  const hunks = diff.lines(pair.before, pair.after);
  assert.deepEqual(plain(diff.counts(hunks)), { added: 6, removed: 3 });
  assert.deepEqual(plain(hunks.filter(hunk => hunk.kind === 'hunk').map(hunk => hunk.oldStart)), [1, 18, 39]);
  assert(hunks.some(hunk => hunk.kind === 'fold' && hunk.headings.includes('Layout')));
  const word = allLines(hunks).find(line => line.kind === 'added' && line.text.includes('accessible'));
  assert.match(word.text.slice(word.mark.start, word.mark.end), /accessible/);
});

test('CRLF, empty files and added/removed files preserve numbered content', () => {
  assert.deepEqual(plain(diff.lines('a\r\nb\r\n', 'a\nb\n')), []);
  assert.deepEqual(plain(diff.lines('', '')), []);
  let hunks = diff.lines(null, 'first\nsecond\n');
  assert.deepEqual(plain(allLines(hunks).map(line => [line.kind, line.oldLine, line.newLine])), [['added', null, 1], ['added', null, 2]]);
  hunks = diff.lines('first\nsecond\n', null);
  assert.deepEqual(plain(allLines(hunks).map(line => [line.kind, line.oldLine, line.newLine])), [['removed', 1, null], ['removed', 2, null]]);
});

test('folds retain exact lines at both file edges and include heading names', () => {
  const before = '# Start\n' + 'unchanged\n'.repeat(12) + 'old\n' + 'context\n'.repeat(12) + '# End\n';
  const hunks = diff.lines(before, before.replace('old', 'new'));
  assert.equal(hunks[0].kind, 'fold'); assert.equal(hunks.at(-1).kind, 'fold');
  assert.deepEqual(plain(hunks[0].headings), ['Start']); assert.deepEqual(plain(hunks.at(-1).headings), ['End']);
  const actual = allLines(hunks).filter(line => line.kind !== 'added').map(line => line.text).join('\n') + '\n';
  assert.equal(actual, before);
});

test('word marks pair similar neighboring lines and never split Unicode characters', () => {
  const hunks = diff.lines('Use the old command today.\n😀 same ending\n', 'Use the new command today.\n😃 same ending\n');
  const lines = allLines(hunks);
  assert.equal(lines[0].text.slice(lines[0].mark.start, lines[0].mark.end), 'old');
  assert.equal(lines[2].text.slice(lines[2].mark.start, lines[2].mark.end), 'new');
  const unicode = lines.find(line => line.text.startsWith('😃'));
  assert.equal(unicode.text.slice(unicode.mark.start, unicode.mark.end), '😃');
  assert.ok(allLines(diff.lines('abcd\n', 'wxyz\n')).every(line => !line.mark));
});

test('the line ceiling prevents expensive comparison and leaves both complete-file views available', () => {
  const result = diff.lines('a\n'.repeat(5001), 'b\n');
  assert.equal(result[0].kind, 'limit'); assert.equal(result[0].oldLines, 5001);
  assert.notEqual(diff.lines('a\n'.repeat(5000), '')[0].kind, 'limit');
});

test('sparse and repeated-line comparisons produce an exact LCS', () => {
  let seed = 42;
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed; };
  const check = (a, b) => {
    const rows = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
    for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) rows[i + 1][j + 1] = a[i] === b[j] ? rows[i][j] + 1 : Math.max(rows[i][j + 1], rows[i + 1][j]);
    const hunks = diff.lines(a.join('\n'), b.join('\n')), lines = allLines(hunks);
    const common = hunks.length ? lines.filter(line => line.kind === 'context').length : a.length;
    assert.equal(common, rows[a.length][b.length]);
    if (hunks.length) {
      assert.deepEqual(plain(lines.filter(line => line.kind !== 'added').map(line => line.text)), a);
      assert.deepEqual(plain(lines.filter(line => line.kind !== 'removed').map(line => line.text)), b);
    }
  };
  for (let trial = 0; trial < 100; trial++) check(Array.from({ length: 5 + random() % 25 }, () => String(random() % 5)), Array.from({ length: 5 + random() % 25 }, () => String(random() % 5)));
  check([...Array(300).fill('a'), ...Array(300).fill('b')], [...Array(300).fill('b'), ...Array(300).fill('a')]);
});

test('64 KiB-sized comparisons finish within the 50 ms budget, including repeated lines', () => {
  const files = [
    [Array.from({ length: 4000 }, (_, i) => 'line-' + i).join('\n'), Array.from({ length: 4000 }, (_, i) => 'line-' + (3999 - i)).join('\n')],
    [['a'.repeat(9), 'b'.repeat(9)].flatMap(line => Array(2250).fill(line)).join('\n'), ['b'.repeat(9), 'a'.repeat(9)].flatMap(line => Array(2250).fill(line)).join('\n')],
  ];
  for (const [before, after] of files) {
    assert(Buffer.byteLength(before) <= 65536 && Buffer.byteLength(after) <= 65536);
    diff.lines(before, after);
    const times = Array.from({ length: 5 }, () => { const start = performance.now(); diff.lines(before, after); return performance.now() - start; }).sort((a, b) => a - b);
    assert(times[2] < 50, 'Median diff took ' + times[2].toFixed(1) + ' ms');
  }
});
