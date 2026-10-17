import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseSkillSource, resolveSkillSource, runSourceGit, SOURCE_LIMITS } from "../docker/setup/skills/sources.mjs";
import { skillMetadata } from "../docker/setup/skills.mjs";
const markdown = (name = "review", body = "Review changes.") => `---\nname: '${name}'\ndescription: >\n  Review useful\n  changes.\n---\n${body}\n`;
async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "t3-source-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const put = async (name, data) => { const file = path.join(home, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, data); return file; };
  return { home, put, resolve: (source, options = {}) => resolveSkillSource(source, { home, metadata: skillMetadata, ...options }) };
}

test("source parsing accepts repository, tree, raw, skills.sh, local and copied command formats", () => {
  const parse = (input) => parseSkillSource(input, "/home/fixture");
  assert.equal(parse("vercel-labs/skills").source, "https://github.com/vercel-labs/skills.git");
  assert.equal(parse("https://github.com/org/repo.git").source, "https://github.com/org/repo.git");
  assert.equal(parse("org/repo@review").filter, "review");
  const tree = parse("https://github.com/org/repo/tree/main/skills/review");
  assert.equal(tree.ref, "main"); assert.equal(tree.subpath, "skills/review");
  assert.equal(parse("https://github.com/org/repo/blob/main/skills/review/SKILL.md").source, "https://raw.githubusercontent.com/org/repo/main/skills/review/SKILL.md");
  assert.equal(parse("https://skills.sh/org/repo/review").filter, "review");
  assert.equal(parse("git@github.com:org/repo.git").type, "git");
  assert.equal(parse("ssh://git@git.example.com/org/repo").type, "git");
  assert.equal(parse("https://git.example.com/org/repo.git").type, "git");
  assert.equal(parse("https://gitlab.com/group/subgroup/repo/-/tree/v1/skills").subpath, "skills");
  assert.equal(parse("~/my-skills").source, "/home/fixture/my-skills");
  assert.equal(parse('npx skills add org/repo --skill "review" -g -y').filter, "review");
  for (const prefix of ["pnpm dlx skills", "bunx skills", "npx -y skills@1.7.2"]) assert.equal(parse(prefix + " add org/repo").type, "git");
  for (const input of [null, "", "--help", "file:///etc/passwd", "ext::sh", "https://user:token@example.com/skill", "npx skills add org/repo --agent codex", "npx skills add org/repo ; touch /tmp/owned", "org/repo\n--all"]) assert.throws(() => parse(input), { code: "invalid" });
});

test("local discovery snapshots full skill folders, bytes and executability without following links", async (t) => {
  const f = await fixture(t); await f.put("skills/review/SKILL.md", markdown());
  const script = await f.put("skills/review/scripts/check.sh", "#!/bin/sh\nexit 0\n"); await fs.chmod(script, 0o755);
  await f.put("skills/review/references/guide.md", "Reference");
  const secret = await f.put("secret", "Do not import"); await fs.symlink(secret, path.join(f.home, "skills/review/linked"));
  const result = await f.resolve(path.join(f.home, "skills"));
  assert.equal(result.skills.length, 1); assert.equal(result.skills[0].description, "Review useful changes.");
  assert.equal(result.skills[0].files.length, 3); assert.equal(result.skills[0].files.find((file) => file.name.endsWith(".sh")).mode, 0o700);
  assert.ok(result.warnings.some((warning) => warning.includes("symlink")));
  await fs.writeFile(script, "Changed after preview");
  assert.equal(result.skills[0].files.find((file) => file.name.endsWith(".sh")).data.toString(), "#!/bin/sh\nexit 0\n");
});

test("source limits and validation reject oversized content, duplicates, empty and nested installations", async (t) => {
  const f = await fixture(t);
  const single = await f.put("single.md", markdown()); assert.equal((await f.resolve(single)).skills[0].name, "review");
  await fs.writeFile(single, "# Not a skill"); await assert.rejects(f.resolve(single), /No valid/);
  await fs.writeFile(single, markdown("review", "x".repeat(65536))); await assert.rejects(f.resolve(single), { code: "too_large" });
  await f.put("nested/SKILL.md", markdown("outer")); await f.put("nested/inner/SKILL.md", markdown("inner"));
  const nested = await f.resolve(path.join(f.home, "nested")); assert.deepEqual(nested.skills.map((skill) => skill.name), ["inner"]); assert.ok(nested.warnings.length);
  await f.put("duplicate/a/SKILL.md", markdown()); await f.put("duplicate/b/SKILL.md", markdown());
  await assert.rejects(f.resolve(path.join(f.home, "duplicate")), { code: "conflict" });
  await f.put("large/SKILL.md", markdown()); const large = await f.put("large/data", ""); await fs.truncate(large, SOURCE_LIMITS.fileBytes + 1);
  await assert.rejects(f.resolve(path.join(f.home, "large")), { code: "too_large" });
});

test("HTTP sources bound streaming bodies, preserve Markdown as text, and extract catalog links without running HTML", async (t) => {
  const f = await fixture(t);
  const body = markdown("review", '</textarea><script>throw new Error("untrusted")</script>');
  const direct = await f.resolve("https://example.com/SKILL.md", { fetcher: async () => new Response(body) });
  assert.equal(direct.skills[0].content, body); assert.equal(direct.skills[0].files.length, 1);
  const catalog = await f.resolve("https://agenticskills.io/skills", { fetcher: async () => new Response('<a href="https://github.com/org/repo/tree/main/skills/review">Skill</a><a href="/skills/frontend-design">Frontend Design</a><a href="javascript:alert(1)">Bad</a><a href="https://github.com/org/repo/issues">Issue</a><a href="https://github.com/org/repo/tree/main/skills/review">Duplicate</a>', { headers: { "content-type": "text/html" } }) });
  assert.equal(catalog.links.length, 2); assert.ok(catalog.links.some((link) => link.source === "https://agenticskills.io/skills/frontend-design")); assert.deepEqual(catalog.skills, []);
  await assert.rejects(f.resolve("https://example.com/SKILL.md", { fetcher: async () => new Response("missing", { status: 404 }) }), /HTTP 404/);
  await assert.rejects(f.resolve("https://example.com/SKILL.md", { fetcher: async () => new Response("x".repeat(1024 * 1024 + 1)) }), { code: "too_large" });
  await assert.rejects(f.resolve("https://example.com/SKILL.md", { fetcher: async () => new Response("ignored", { headers: { "content-length": "99999999" } }) }), { code: "too_large" });
});

test("Git discovery reads bounded blobs without checkout, shell execution, hooks, symlinks or submodules", async (t) => {
  const f = await fixture(t), calls = [], body = markdown();
  let temporary;
  const run = async (command, args, options) => {
    calls.push(args); assert.equal(command, "git"); assert.equal(options.env.GIT_TERMINAL_PROMPT, "0"); assert.ok(options.signal); assert.ok(options.timeout <= 45000);
    if (args.includes("clone")) { temporary = args.at(-1); assert.ok(args.includes("--no-checkout")); assert.ok(args.includes("protocol.ext.allow=never")); return { stdout: Buffer.alloc(0) }; }
    if (args.includes("ls-remote")) return { stdout: Buffer.alloc(0) };
    if (args.includes("ls-tree")) return { stdout: Buffer.from(`100644 blob ${"a".repeat(40)} ${Buffer.byteLength(body)}\tskills/review/SKILL.md\0` + `100755 blob ${"b".repeat(40)} 5\tskills/review/check.sh\0` + `120000 blob ${"c".repeat(40)} 12\tskills/review/secret\0` + `160000 commit ${"d".repeat(40)} -\tsubmodule\0`) };
    assert.ok(args.includes("cat-file")); return { stdout: Buffer.from(args.at(-1) === "a".repeat(40) ? body : "check") };
  };
  const result = await f.resolve("https://github.com/org/repo/tree/main/skills/review", { run });
  assert.equal(result.skills[0].files.length, 2); assert.equal(result.warnings.length, 2);
  assert.equal(calls.filter((args) => args.includes("cat-file")).length, 2);
  await assert.rejects(fs.stat(path.dirname(temporary)), { code: "ENOENT" });
});


test("Git subprocesses bound storage/output and terminate their process group on timeout", async (t) => {
  const f = await fixture(t);
  const options = { env: process.env, signal: AbortSignal.timeout(2000), directory: f.home, maxBuffer: 1024 };
  const success = await runSourceGit(process.execPath, ["-e", "process.stdout.write('ok')"], options);
  assert.equal(success.stdout.toString(), "ok");
  await assert.rejects(runSourceGit(process.execPath, ["-e", "process.stdout.write('x'.repeat(5000)); setTimeout(()=>{},2000)"], options), { code: "too_large" });
  await assert.rejects(runSourceGit(process.execPath, ["-e", "setTimeout(()=>{},2000)"], { ...options, signal: AbortSignal.timeout(100) }), { code: "unavailable" });
  const large = await f.put("large-pack", ""); await fs.truncate(large, 64 * 1024 * 1024 + 1);
  await assert.rejects(runSourceGit(process.execPath, ["-e", "throw new Error('must not run')"], options), { code: "too_large" });
});


test("copied tree URLs resolve slash-containing refs; GitLab file URLs and wildcard commands stay scoped", async (t) => {
  const f = await fixture(t), calls = [], body = markdown();
  const run = async (command, args) => {
    calls.push(args);
    if (args.includes("ls-remote")) return { stdout: Buffer.from(`${"a".repeat(40)}\trefs/heads/feature\n${"b".repeat(40)}\trefs/heads/feature/skills\n`) };
    if (args.includes("clone")) return { stdout: Buffer.alloc(0) };
    if (args.includes("ls-tree")) return { stdout: Buffer.from(`100644 blob ${"a".repeat(40)} ${body.length}\tskills/review/SKILL.md\0`) };
    return { stdout: Buffer.from(body) };
  };
  const source = "https://github.com/org/repo/tree/feature/skills/skills/review";
  assert.equal((await f.resolve(source, { run })).skills[0].name, "review");
  const clone = calls.find((args) => args.includes("clone")); assert.equal(clone[clone.indexOf("--branch") + 1], "feature/skills");
  assert.equal(calls.find((args) => args.includes("ls-tree")).at(-1), "skills/review");
  assert.equal(parseSkillSource("npx skills add org/repo --skill '*'", f.home).filter, null);
  const raw = "https://gitlab.com/group/subgroup/repo/-/raw/main/skills/review/SKILL.md";
  assert.deepEqual(parseSkillSource(raw.replace("/-/raw/", "/-/blob/"), f.home), { type: "url", source: raw, filter: null });
  assert.equal(parseSkillSource(raw, f.home).type, "url");
  for (const source of ["https://github.com/org/repo/tree", "https://gitlab.com/org/repo/-/tree", "https://gitlab.com/org/repo/-/blob/main"]) assert.throws(() => parseSkillSource(source, f.home), { code: "invalid" });
});

test("an unrelated oversized skill cannot prevent selecting or listing a valid sibling", async (t) => {
  const f = await fixture(t), body = markdown(); let openedLarge = false;
  const run = async (command, args) => {
    if (args.includes("clone")) return { stdout: Buffer.alloc(0) };
    if (args.includes("ls-tree")) return { stdout: Buffer.from(`100644 blob ${"a".repeat(40)} 105146\tskills/claude-api/SKILL.md\0` + `100644 blob ${"b".repeat(40)} ${body.length}\tskills/review/SKILL.md\0`) };
    if (args.at(-1) === "a".repeat(40)) openedLarge = true;
    return { stdout: Buffer.from(body) };
  };
  for (const source of ["org/repo", "org/repo@review"]) {
    const result = await f.resolve(source, { run }); assert.deepEqual(result.skills.map((skill) => skill.name), ["review"]);
    assert.ok(result.warnings.some((warning) => warning.includes("claude-api") && warning.includes("64 KiB")));
  }
  assert.equal(openedLarge, false);
  await assert.rejects(f.resolve("org/repo@claude-api", { run }), { code: "too_large" });
});

test("repository discovery prefers published skills over private workflow instructions, while explicit folders still work", async (t) => {
  const f = await fixture(t);
  await f.put("library/skills/find-skills/SKILL.md", markdown("find-skills"));
  await f.put("library/.factory/workflows/triage/skills/triage/SKILL.md", markdown("triage"));
  const library = await f.resolve(path.join(f.home, "library")); assert.deepEqual(library.skills.map((skill) => skill.name), ["find-skills"]);
  const explicit = await f.resolve(path.join(f.home, "library/.factory/workflows/triage/skills/triage")); assert.deepEqual(explicit.skills.map((skill) => skill.name), ["triage"]);
  await f.put("custom/deep/bundles/review/SKILL.md", markdown("review"));
  assert.equal((await f.resolve(path.join(f.home, "custom"))).skills[0].name, "review", "Custom layouts retain bounded recursive discovery as a fallback");
  await f.put("custom/SKILL.md", "An invalid placeholder");
  assert.equal((await f.resolve(path.join(f.home, "custom"))).skills[0].name, "review", "An invalid placeholder cannot suppress the custom-layout fallback");
});
