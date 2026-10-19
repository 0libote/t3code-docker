#!/usr/bin/env node
/*
 * Screenshots of every setup console page, in every state worth seeing, from
 * fixed sample data.
 *
 *   node scripts/console-screens.js [url] [key] [--scenarios ready,setup,attention]
 *     [--routes overview,agents] [--sizes phone,tablet,desktop,embedded]
 *     [--themes light,dark] [--out /tmp/t3-console-screens]
 *
 * Point it at a running console (scripts/dev-console.mjs serves one at the
 * default address with the key "dev"). The console's own code renders every
 * page; only its data is replaced: /status, /ports, /providers and the skills
 * inventories come from scripts/fixtures/console, shifted to the present and
 * changed per scenario, and every POST is answered here without reaching the
 * server. So nothing it shows depends on, or changes, the machine it runs on.
 *
 * Scenarios:
 *   ready      set up, a few updates offered, nothing wrong
 *   setup      a fresh container: no public URL, no devices, first start installing
 *   attention  set up, with what can go wrong at once: a signed-out agent, a
 *              failed toolchain, a port that would not publish, a filling disk,
 *              an anonymous home volume and an older image's settings
 *
 * Images go to <out>/<scenario>/<size>-<theme>-<route>.png, full page. Each
 * page is also checked for horizontal overflow; the run exits non-zero if any
 * page overflows.
 */
const fs = require("node:fs");
const path = require("node:path");
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("playwright-core")); }

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf("--" + name);
  return i === -1 ? fallback : args[i + 1];
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const BASE = positional[0] || "http://127.0.0.1:23780/__setup/";
const KEY = positional[1] || "dev";
const OUT = flag("out", process.env.T3_CONSOLE_SCREENS || "/tmp/t3-console-screens");
const list = (name, all) => (flag(name) ? flag(name).split(",").filter(Boolean) : all);
const CHROME = process.env.CHROME_PATH || "/usr/bin/chromium";

const FIXTURES = path.join(__dirname, "fixtures", "console");
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8"));

// Routes as the console names them, read from its own table.
const T3Routes = (() => {
  const vm = require("node:vm");
  const context = vm.createContext({ URL });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "docker/setup/client/routes.js"), "utf8"), context);
  return vm.runInContext("T3Routes", context);
})();
const ROUTES = list("routes", [...T3Routes.PAGES.map((p) => p.route), "more"]);
const SIZES = {
  phone: { width: 390, height: 844, scale: 2 },
  tablet: { width: 820, height: 1180, scale: 1 },
  desktop: { width: 1440, height: 900, scale: 1 },
  embedded: { width: 1198, height: 878, scale: 1, embed: true },
};
const sizes = list("sizes", Object.keys(SIZES));
const themes = list("themes", ["light", "dark"]);
const scenarios = list("scenarios", ["ready", "setup", "attention"]);

// ------------------------------------------------------------ the data --
/** Move every timestamp in a fixture by the same amount, so "2 hours ago" stays true today. */
const shiftTimes = (value, by) => {
  if (Array.isArray(value)) return value.map((v) => shiftTimes(v, by));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shiftTimes(v, by)]));
  if (typeof value === "number" && value > 1.6e12 && value < 2.2e12) return value + by;
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) return new Date(Date.parse(value) + by).toISOString();
  return value;
};

const harness = (s, id) => s.harnesses.find((h) => h.id === id);
const SCENARIOS = {
  ready: (s) => {
    s.paths.volumeKind = "durable";
    return s;
  },
  setup: (s, now) => {
    s.publicUrl = null;
    s.publicUrlSource = null;
    s.sessions = [];
    s.events = [];
    s.paths.volumeKind = "durable";
    s.connect = { ...s.connect, state: "off" };
    const installing = ["opencode", "go", "rust", "bun", "deno", "uv"];
    s.setup = {
      state: "running", startedAt: now - 90_000, finishedAt: null, current: "opencode",
      items: s.setup.items.map((item) => ({ ...item, state: item.id === "opencode" ? "installing" : installing.includes(item.id) ? "pending" : "done",
        progress: item.id === "opencode" ? { phase: "downloading", done: 41_000_000, total: 96_000_000 } : undefined })),
    };
    for (const h of s.harnesses) {
      if (h.managedBy) continue;
      if (h.id === "claude" || h.id === "codex") { h.signedIn = false; h.credentialsPresent = false; h.latestVersion = h.installedVersion; }
      else Object.assign(h, { installed: false, runnable: false, version: null, installedVersion: null, signedIn: null, credentialsPresent: false });
    }
    for (const t of s.toolchains) if (installing.includes(t.id)) Object.assign(t, { installed: false, version: null });
    s.packages = [];
    return s;
  },
  attention: (s) => {
    Object.assign(harness(s, "codex"), { signedIn: false });
    Object.assign(s.toolchains.find((t) => t.id === "go"), { failed: true, failure: "Download timed out after 120 s", operation: "update" });
    s.storage.disk = { ...s.storage.disk, usedPercent: 86, availableBytes: 29_000_000_000 };
    s.legacyEnv = ["GOROOT", "PATH"];
    s.paths.volumeKind = "anonymous";
    return s;
  },
};
const PORTS = {
  ready: (p, now) => ({ ...p, tunnels: [{ port: 5173, state: "open", url: "https://quiet-river-1234.trycloudflare.com", startedAt: now - 12 * 60_000 }] }),
  setup: (p) => ({ ...p, listening: [], details: [], tunnels: [] }),
  attention: (p) => ({ ...p, tunnels: [{ port: 8787, state: "failed", error: "The tunnel could not reach Cloudflare’s edge" }] }),
};

const statusFor = (scenario) => {
  const base = fixture("status.json");
  const now = Date.now();
  const shifted = shiftTimes(base, now - base.storage.at);
  return SCENARIOS[scenario](shifted, now);
};
const portsFor = (scenario) => PORTS[scenario](fixture("ports.json"), Date.now());

// -------------------------------------------------------------- driving --
const overflow = () => {
  const out = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page is ${document.documentElement.scrollWidth}px wide in a ${innerWidth}px window`);
  return out;
};

/** The console in a frame on its own origin, as T3 Code's settings show it. */
const framed = async (page, url) => {
  const host = new URL("/__console-screens-host", url).href;
  await page.route(host, (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><style>html,body{margin:0;height:100%}iframe{display:block;border:0;width:100%;height:100%}</style><iframe src="${url}"></iframe>`,
  }));
  await page.goto(host, { waitUntil: "domcontentloaded" });
  return (await page.waitForSelector("iframe")).contentFrame();
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--no-sandbox"] });
  const problems = [];
  try {
    for (const scenario of scenarios) {
      const dir = path.join(OUT, scenario);
      fs.mkdirSync(dir, { recursive: true });
      for (const sizeName of sizes) for (const theme of themes) {
        const size = SIZES[sizeName];
        const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: size.scale, colorScheme: theme, reducedMotion: "reduce" });
        const page = await context.newPage();
        await page.route("**/*", (route) => {
          const request = route.request();
          const url = new URL(request.url());
          const at = (suffix) => url.pathname.endsWith(suffix);
          if (request.method() === "POST" && !at("/login")) return route.fulfill({ json: { ok: true } });
          if (at("/status")) return route.fulfill({ json: statusFor(scenario) });
          if (at("/ports")) return route.fulfill({ json: portsFor(scenario) });
          if (at("/providers")) return route.fulfill({ json: fixture("providers.json") });
          if (at("/context/skills")) {
            const provider = url.searchParams.get("provider") || "claude";
            const name = `skills-${provider}.json`;
            return fs.existsSync(path.join(FIXTURES, name)) ? route.fulfill({ json: fixture(name) })
              : route.fulfill({ json: { ok: true, provider, coverage: "files", skills: [], roots: [] } });
          }
          return route.continue();
        });
        const url = new URL(BASE);
        if (size.embed) { url.searchParams.set("embed", "t3"); url.searchParams.set("theme", theme); }
        const target = size.embed ? await framed(page, url.href) : page;
        if (!size.embed) await page.goto(url.href, { waitUntil: "domcontentloaded" });
        await target.waitForSelector("input[type=password]");
        await target.fill("input[type=password]", KEY);
        await target.click("button[type=submit]");
        await target.waitForSelector("#page-overview .tc-page-head", { timeout: 30000 });
        for (const route of ROUTES) {
          await target.evaluate((r) => { location.hash = r; window.scrollTo(0, 0); }, route);
          await target.waitForSelector(`#page-${route}:not([hidden]) .tc-page-head`, { timeout: 30000 });
          await target.evaluate(() => document.fonts.ready);
          // Inventories and the ports list arrive after the page; let them land.
          await page.waitForTimeout(route === "context" ? 1200 : 400);
          const file = path.join(dir, `${sizeName}-${theme}-${route}.png`);
          if (size.embed) await page.screenshot({ path: file });
          else await page.screenshot({ path: file, fullPage: true });
          for (const issue of await target.evaluate(overflow)) problems.push(`${scenario} ${sizeName} ${theme} ${route}: ${issue}`);
        }
        await context.close();
      }
      console.log(`${scenario}: ${path.join(OUT, scenario)}`);
    }
  } finally {
    await browser.close();
  }
  for (const problem of problems) console.log("  " + problem);
  process.exit(problems.length ? 1 : 0);
})().catch((error) => { console.error(error); process.exit(2); });
