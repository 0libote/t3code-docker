#!/usr/bin/env node
/*
 * Screenshots of every setup console page, in every state worth seeing, from
 * fixed sample data.
 *
 *   node scripts/console-screens.js [url] [key] [--scenarios ready,setup,attention]
 *     [--routes overview,agents] [--sizes phone,tablet,desktop,embedded]
 *     [--themes light,dark] [--overlays] [--out /tmp/t3-console-screens]
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
 * page overflows. --overlays adds the menus and dialogs people open most, as
 * <size>-<theme>-overlay-<name>.png.
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

const { routesTable, statusFor, portsFor, routeConsole, framed, unlock, visit } = require("./lib/console-fixtures.cjs");
const T3Routes = routesTable();
// Pages, and the second tab of the one that has tabs.
const ROUTES = list("routes", [...T3Routes.PAGES.map((p) => p.route), "instructions/skills", "more"]);
const SIZES = {
  phone: { width: 390, height: 844, scale: 2 },
  tablet: { width: 820, height: 1180, scale: 1 },
  desktop: { width: 1440, height: 900, scale: 1 },
  embedded: { width: 1198, height: 878, scale: 1, embed: true },
};
const sizes = list("sizes", Object.keys(SIZES));
const themes = list("themes", ["light", "dark"]);
const scenarios = list("scenarios", ["ready", "setup", "attention"]);
const withOverlays = args.includes("--overlays");
const withSkillOverlays = args.includes("--skill-overlays");

// The overlays worth a picture: how to reach each from a loaded console. Each
// returns false when the scenario has nothing to open.
const OVERLAYS = [
  ['mcp-inspector', async (t) => {
    await t.evaluate(() => { location.hash = 'mcp'; });
    const edit = await t.waitForSelector('[data-cmd="mcp.view"]', { timeout: 5000 }).catch(() => null);
    if (!edit) return false;
    await edit.click(); await t.waitForSelector('.tc-mcp-inspector'); return true;
  }],
  ["palette", async (t, page) => { await t.evaluate(() => { location.hash = "overview"; }); await page.keyboard.press("Control+k"); await t.waitForSelector(".tc-layer .tc-palette"); return true; }],
  ["device-menu", async (t) => {
    await t.evaluate(() => { location.hash = "access"; });
    const menu = await t.waitForSelector('#page-access [data-cmd="device.menu"]', { timeout: 5000 }).catch(() => null);
    if (!menu) return false;
    await menu.click(); await t.waitForSelector(".tc-layer .tc-menu, .tc-layer .tc-sheet"); return true;
  }],
  ["volume-fix", async (t) => {
    await t.evaluate(() => { location.hash = "server"; });
    const fix = await t.waitForSelector('#page-server [data-cmd="volume.fix"]', { timeout: 5000 }).catch(() => null);
    if (!fix) return false;
    await fix.click(); await t.waitForSelector(".tc-layer .tc-volume-fix"); return true;
  }],
  ["t3-auto-update", async (t) => {
    await t.evaluate(() => { location.hash = "updates"; });
    await (await t.waitForSelector('[data-key="auto-toggle-t3"]')).click();
    await t.waitForSelector(".tc-layer [role=alertdialog]"); return true;
  }],
];

// The same rendered flows as the handoff, with the shared seven-agent data.
const skillSource = async (target) => {
  await target.evaluate(() => { location.hash = 'instructions/skills'; });
  await target.locator('[data-cmd="skills.import"]').filter({ visible: true }).click();
  await target.locator('#skill-source').fill('vercel-labs/skills');
  await target.locator('#skill-source').press('Enter');
  await target.locator('[data-import-all]').check();
};
const skillAgents = async target => {
  await skillSource(target);
  await target.locator('[data-import-next]').click();
  await target.locator('[data-import-replace]').waitFor();
  await target.locator('[data-import-replace]').check();
};
const skillPage = async target => {
  await target.evaluate(() => { location.hash = 'instructions/skills'; });
  await target.locator('#skill-search').fill('');
};
const skillView = async (target, value) => {
  await skillPage(target);
  await target.locator('.tc-lh-filters [data-cmd="skills.show"][data-id="' + value + '"], .tc-sk-agent-chips [data-cmd="skills.show"][data-id="' + value + '"]').filter({ visible: true }).click();
};
const skillChecks = async target => {
  await skillView(target, 'updates');
  await target.locator('[data-cmd="skills.check-updates"]').filter({ visible: true }).click();
  await target.waitForFunction(() => document.querySelectorAll('.tc-ut-row').length === 4 && !document.querySelector('.tc-lh-status')?.textContent.includes('Checking'));
};
const skillLibrary = async target => {
  await skillView(target, 'all');
  await target.locator('[data-cmd="skills.view-menu"]').filter({ visible: true }).click();
  const bundled = target.getByRole('menuitemcheckbox', { name: /Show bundled skills/ });
  if (await bundled.getAttribute('aria-checked') === 'true') await bundled.click();
  else await target.getByRole('menu').press('Escape');
};
const SKILL_OVERLAYS = [
  ['skill-updates-first-check', async target => { await skillView(target, 'updates'); await target.locator('.tc-ut-empty').waitFor(); return true; }],
  ['skill-updates-list', async target => { await skillChecks(target); return true; }],
  ['skill-library-updates', async target => { await skillLibrary(target); return true; }],
  ['skill-view-menu', async target => { await skillLibrary(target); await target.locator('[data-cmd="skills.view-menu"]').filter({ visible: true }).click(); return true; }],
  ['skill-update-inspector', async target => {
    await skillView(target, 'all');
    await target.getByRole('button', { name: 'frontend-design', exact: true }).filter({ visible: true }).click();
    await target.locator('[data-inspect-check-source]').waitFor(); return true;
  }],
  ['skill-update-review', async target => {
    await skillView(target, 'all');
    await target.getByRole('button', { name: 'Review the update for frontend-design', exact: true }).filter({ visible: true }).click();
    await target.locator('[data-update-save]').waitFor(); return true;
  }],
  ['skill-plugin-hooks', async target => {
    await skillView(target, 'all');
    await target.locator('.tc-sk-hook-notice [data-cmd="skills.hooks"], .tc-sk-phone-summary [data-cmd="skills.hooks"]').filter({ visible: true }).click();
    await target.locator('.tc-hk [data-hook-action=trust]').first().waitFor(); return true;
  }],
  ['skill-policy', async (target, page) => {
    if (page.viewportSize().width < 1024) return false;
    await target.evaluate(() => { location.hash = 'instructions/skills'; });
    await target.getByRole('button', { name: 'Claude Code visibility for deep-research: Name only', exact: true }).click();
    await target.getByRole('menuitemradio', { name: /Name only/ }).waitFor(); return true;
  }],
  ['skill-inspector', async target => {
    await target.evaluate(() => { location.hash = 'instructions/skills'; });
    await target.locator('button[data-cmd="skills.view"]').filter({ visible: true, hasText: 'deep-research' }).click();
    await target.locator('.tc-insp-body .tc-code').waitFor(); return true;
  }],
  ['skill-source', async target => { await skillSource(target); await target.locator('[data-import-files=frontend-design]').click(); return true; }],
  ['skill-agents', async target => { await skillAgents(target); return true; }],
  ['skill-result', async target => {
    await skillAgents(target); await target.locator('[data-import-replace]').check();
    await target.locator('[data-import-next]').click(); await target.locator('.tc-result-hero').waitFor(); return true;
  }],
];

// -------------------------------------------------------------- driving --
const overflow = () => {
  const out = [];
  if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page is ${document.documentElement.scrollWidth}px wide in a ${innerWidth}px window`);
  return out;
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
        await routeConsole(page, { status: () => statusFor(scenario), ports: () => portsFor(scenario), skillOptions: { partial: withSkillOverlays } });
        const url = new URL(BASE);
        if (size.embed) { url.searchParams.set("embed", "t3"); url.searchParams.set("theme", theme); }
        const target = size.embed ? await framed(page, url.href) : page;
        if (!size.embed) await page.goto(url.href, { waitUntil: "domcontentloaded" });
        await unlock(target, KEY);
        for (const route of ROUTES) {
          await visit(target, page, route);
          const file = path.join(dir, `${sizeName}-${theme}-${route.replace("/", "-")}.png`);
          if (size.embed) await page.screenshot({ path: file });
          else await page.screenshot({ path: file, fullPage: true });
          for (const issue of await target.evaluate(overflow)) problems.push(`${scenario} ${sizeName} ${theme} ${route}: ${issue}`);
        }
        for (const [name, open] of [...(withOverlays ? OVERLAYS : []), ...(withSkillOverlays ? SKILL_OVERLAYS : [])]) {
          await page.keyboard.press("Escape").catch(() => {});
          await target.evaluate(() => window.scrollTo(0, 0));
          if (!(await open(target, page))) continue;
          await page.waitForTimeout(300);
          await page.screenshot({ path: path.join(dir, `${sizeName}-${theme}-overlay-${name}.png`), fullPage: !size.embed && name === 'skill-library-updates' });
          await page.keyboard.press("Escape");
          await target.waitForSelector(".tc-layer", { state: "detached" }).catch(() => {});
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
