// Pure line comparison. No DOM, IO, markdown parsing or source execution.
const T3SkillDiff = (() => {
  'use strict';
  const MAX_LINES = 5000;
  const split = text => {
    if (!text) return [];
    const lines = String(text).replace(/\r\n/g, '\n').split('\n');
    if (lines.at(-1) === '') lines.pop();
    return lines;
  };
  const popcount = value => {
    value -= (value >>> 1) & 0x55555555;
    value = (value & 0x33333333) + ((value >>> 2) & 0x33333333);
    return (((value + (value >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  };
  // Hunt–Szymanski is fast for sparse matches. Repeated lines can otherwise
  // produce millions of links, so use the same exact LCS as bit-vector rows
  // there. The 5,000-line ceiling bounds those rows to under 5 MiB.
  const matching = (before, after) => {
    const positions = new Map();
    after.forEach((line, index) => {
      if (!positions.has(line)) positions.set(line, []);
      positions.get(line).push(index);
    });
    const pairs = before.reduce((count, line) => count + (positions.get(line)?.length || 0), 0);
    if (!pairs) return [];
    if (pairs <= 50000) {
      const tails = [], links = [];
      before.forEach((line, old) => {
        const matches = positions.get(line) || [];
        for (let at = matches.length - 1; at >= 0; at--) {
          const next = matches[at];
          let low = 0, high = tails.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (tails[middle] < next) low = middle + 1; else high = middle;
          }
          if (tails[low] === next) continue;
          tails[low] = next;
          links[low] = { old, next, previous: links[low - 1] };
        }
      });
      const matches = [];
      for (let link = links.at(-1); link; link = link.previous) matches.push([link.old, link.next]);
      return matches.reverse();
    }
    const words = Math.ceil(after.length / 32), stride = words + 1;
    const rows = new Uint32Array((before.length + 1) * words);
    const counts = new Uint16Array((before.length + 1) * stride);
    const masks = new Map();
    for (const [line, indices] of positions) {
      const mask = new Uint32Array(words);
      for (const index of indices) mask[index >>> 5] |= 1 << (index & 31);
      masks.set(line, mask);
    }
    for (let i = 0; i < before.length; i++) {
      const previous = i * words, current = previous + words, mask = masks.get(before[i]);
      let carry = 1, borrow = 0, count = 0;
      for (let word = 0; word < words; word++) {
        const prior = rows[previous + word];
        const x = (prior | (mask?.[word] || 0)) >>> 0;
        const y = ((prior << 1) | carry) >>> 0;
        carry = prior >>> 31;
        const difference = x - y - borrow;
        borrow = difference < 0 ? 1 : 0;
        const value = x & ~difference;
        rows[current + word] = value;
        count += popcount(value);
        counts[(i + 1) * stride + word + 1] = count;
      }
    }
    const scoreAt = (row, column) => {
      const word = column >>> 5, bits = column & 31;
      return counts[row * stride + word] + (bits ? popcount(rows[row * words + word] & (0xffffffff >>> (32 - bits))) : 0);
    };
    let old = before.length, next = after.length, score = scoreAt(old, next);
    const matches = [];
    while (old && next) {
      if (before[old - 1] === after[next - 1]) { matches.push([--old, --next]); score--; }
      else if (scoreAt(old - 1, next) === score) old--;
      else next--;
    }
    return matches.reverse();
  };
  const wordMarks = (removed, added) => {
    const before = Array.from(removed.text), after = Array.from(added.text);
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
    while (suffix < Math.min(before.length, after.length) - prefix && before.at(-suffix - 1) === after.at(-suffix - 1)) suffix++;
    if (2 * (prefix + suffix) / (before.length + after.length || 1) <= 0.4) return;
    for (const [line, characters] of [[removed, before], [added, after]]) {
      const start = characters.slice(0, prefix).join('').length;
      const end = characters.slice(0, characters.length - suffix).join('').length;
      if (start < end) line.mark = { start, end };
    }
  };
  const lines = (installed, incoming) => {
    const before = split(installed), after = split(incoming);
    if (before.length > MAX_LINES || after.length > MAX_LINES) return [{ kind: 'limit', oldLines: before.length, newLines: after.length }];
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(before.length, after.length) && before[prefix] === after[prefix]) prefix++;
    while (suffix < Math.min(before.length, after.length) - prefix && before.at(-suffix - 1) === after.at(-suffix - 1)) suffix++;
    const matches = Array.from({ length: prefix }, (_, i) => [i, i]);
    matches.push(...matching(before.slice(prefix, before.length - suffix), after.slice(prefix, after.length - suffix)).map(([old, next]) => [old + prefix, next + prefix]));
    for (let i = suffix; i > 0; i--) matches.push([before.length - i, after.length - i]);
    const operations = [];
    let old = 0, next = 0;
    const add = kind => {
      operations.push({ kind, text: kind === 'added' ? after[next] : before[old], oldLine: kind === 'added' ? null : old + 1,
        newLine: kind === 'removed' ? null : next + 1, oldPosition: old + 1, newPosition: next + 1 });
      if (kind !== 'added') old++;
      if (kind !== 'removed') next++;
    };
    for (const [oldMatch, newMatch] of [...matches, [before.length, after.length]]) {
      while (old < oldMatch) add('removed');
      while (next < newMatch) add('added');
      if (old < before.length) add('context');
    }
    // Pair adjacent removed/added blocks in order. Compare code points so a
    // mark cannot split a surrogate pair in text supplied by a repository.
    for (let at = 0; at < operations.length;) {
      if (operations[at].kind !== 'removed') { at++; continue; }
      const removed = [], added = [];
      while (operations[at]?.kind === 'removed') removed.push(operations[at++]);
      while (operations[at]?.kind === 'added') added.push(operations[at++]);
      for (let i = 0; i < Math.min(removed.length, added.length); i++) wordMarks(removed[i], added[i]);
    }
    const ranges = [];
    operations.forEach((line, index) => {
      if (line.kind === 'context') return;
      const start = Math.max(0, index - 2), end = Math.min(operations.length, index + 3), previous = ranges.at(-1);
      if (previous && start <= previous.end) previous.end = end;
      else ranges.push({ start, end });
    });
    const hunks = [];
    const fold = (start, end) => {
      if (start === end) return;
      const lines = operations.slice(start, end);
      hunks.push({ kind: 'fold', id: 'fold-' + start, lines,
        headings: lines.filter(line => /^\s*#{1,6}\s+/.test(line.text)).map(line => line.text.replace(/^\s*#{1,6}\s+/, '').trim()) });
    };
    if (!ranges.length) return [];
    let at = 0;
    for (const { start, end } of ranges) {
      fold(at, start);
      const lines = operations.slice(start, end), first = lines[0];
      hunks.push({ kind: 'hunk', id: 'hunk-' + start, oldStart: first.oldPosition, newStart: first.newPosition, lines });
      at = end;
    }
    fold(at, operations.length);
    return hunks;
  };
  const counts = hunks => hunks.reduce((result, hunk) => {
    for (const line of hunk.lines || []) {
      if (line.kind === 'added') result.added++;
      if (line.kind === 'removed') result.removed++;
    }
    return result;
  }, { added: 0, removed: 0 });
  return { lines, counts };
})();
