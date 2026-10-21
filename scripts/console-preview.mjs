#!/usr/bin/env node
// The real console with in-memory data and no production API. Useful for native
// browser review without installing seven agents or authorizing any writes.
// node scripts/console-preview.mjs [--port 23785]
import http from 'node:http';
import { createRequire } from 'node:module';
import { loadAssets, renderConsole, contentSecurityPolicy } from '../docker/setup/page.mjs';
const require = createRequire(import.meta.url);
const { statusFor, portsFor, fixture } = require('./lib/console-fixtures.cjs');
const { createSkillsFixtures } = require('./lib/skills-fixtures.cjs');
const api = createSkillsFixtures();
const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 23785;
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__setup/' || url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store', 'content-security-policy': contentSecurityPolicy('fixture') });
    res.end(renderConsole({ assets: loadAssets(), nonce: 'fixture', mount: '/__setup', embed: url.searchParams.has('embed') }));
    return;
  }
  const chunks = []; let bytes = 0;
  for await (const chunk of req) { chunks.push(chunk); bytes += chunk.length; if (bytes > 150000) { res.writeHead(413); res.end(); return; } }
  let input;
  try { input = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}; }
  catch { res.writeHead(400); res.end(); return; }
  const result = api.respond(req.method, url, input) || (url.pathname.endsWith('/status') ? { body: statusFor('skills') }
    : url.pathname.endsWith('/ports') ? { body: portsFor('ready') }
      : url.pathname.endsWith('/providers') ? { body: fixture('providers.json') }
        : { status: 404, body: { ok: false, error: 'This is a read-only fixture preview. No live API is connected.' } });
  res.writeHead(result.status || 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(result.body));
}).listen(port, '127.0.0.1', () => console.log(`Fixture console: http://127.0.0.1:${port}/__setup/#instructions/skills (all writes stay in memory)`));
