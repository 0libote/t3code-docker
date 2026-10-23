import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Command from '../docker/setup/client/mcp-command.js';
import { parseMcpSnippet } from '../docker/setup/mcp/parse.mjs';
const cases = JSON.parse(readFileSync(new URL('./fixtures/mcp-snippets.json', import.meta.url))).cases;
for (const item of cases) test('MCP snippet: ' + item.id, () => {
  const actual = parseMcpSnippet(item.input);
  for (const [key, value] of Object.entries(item.expect)) assert.deepEqual(actual[key], value, key);
});
test('command display round-trips losslessly without expansion', () => {
  const argv = ['tool', '', ' leading ', 'a\nb', "a'b", 'a"b', '$HOME', '$(touch /tmp/oops)', '*', '\\'];
  assert.deepEqual(Command.lex(Command.line(argv)), argv);
  assert.equal(Command.needsRows(argv), true);
  assert.throws(() => Command.lex('tool "unfinished'), /quote/);
});
test('parser is bounded, duplicate aware and does not reinterpret broken data as commands', () => {
  assert.match(parseMcpSnippet('x'.repeat(65537)).errors[0], /too long/);
  assert.match(parseMcpSnippet('{"mcpServers":{"x":{"command":"a","command":"b"}}}').errors[0], /JSON/);
  assert.equal(parseMcpSnippet('[broken').servers.length, 0);
  assert.equal(parseMcpSnippet('{"mcpServers":{"x":{"command":"a","args":"oops"}}}').servers.length, 0);
  const ref = parseMcpSnippet('{"url":"https://docs.example.test/mcp","headers":{"Authorization":"${TOKEN}"}}');
  assert.deepEqual(ref.placeholders, []); assert.match(ref.notes.join(), /resolved differently/);
  const sse = parseMcpSnippet('https://docs.example.test/sse');
  assert.match(sse.errors[0], /SSE-only/);
});
