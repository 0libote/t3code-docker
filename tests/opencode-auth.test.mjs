// Shared OpenCode credential schema and version handling for setup and probes.
import assert from "node:assert/strict";
import test from "node:test";

import * as setup from "../docker/setup/opencode-auth.mjs";
import * as probe from "../docker/harness/probe.mjs";

const LIST = [
  { id: "anthropic", name: "Anthropic", connections: [
    { type: "credential", id: "cred_1", label: "API key", method: "key" },
    { type: "env", name: "ANTHROPIC_API_KEY" },
  ] },
  { id: "openai", name: "OpenAI", connections: [
    { type: "credential", id: "cred_2", label: "Work", method: "oauth" },
    { type: "credential", id: "cred_3", label: "API key", method: "key" },
  ] },
  { id: "ollama", name: "Ollama", connections: [] },
];
const TEXT = `starting server...\n${JSON.stringify(LIST, null, 2)}\n`;

test("major versions split the 1.x file from the 2.x database", () => {
  for (const [version, major] of [
    ["1.18.31", 1], ["1.14.19", 1], ["2.0.27", 2], ["2.0.18", 2],
    ["v2.1.0", 2], [" 2.0.27 ", 2], ["", null], [null, null], [undefined, null],
  ]) {
    assert.equal(setup.openCodeMajor(version), major, `setup ${version}`);
    assert.equal(probe.openCodeMajor(version), major, `probe ${version}`);
  }
});

test("auth list output parses past log chatter, on both sides", () => {
  assert.deepEqual(setup.parseAuthList(TEXT), LIST);
  assert.deepEqual(probe.parseOpenCodeAuthList(TEXT), LIST);
  assert.deepEqual(setup.parseAuthList("[]"), []);
  assert.throws(() => setup.parseAuthList("no authenticated integrations\n"), /unreadable/);
  assert.throws(() => probe.parseOpenCodeAuthList("{\"not\":\"a list\"}"), /unreadable/);
  assert.throws(() => setup.parseAuthList("[bad"), /unreadable/);
});

test("only stored accounts count, on both sides", () => {
  const envOnly = [{ id: "anthropic", connections: [{ type: "env", name: "ANTHROPIC_API_KEY" }] }];
  assert.equal(setup.hasStoredCredentials(LIST), true);
  assert.equal(probe.openCodeHasStoredCredentials(LIST), true);
  assert.equal(setup.hasStoredCredentials([]), false);
  assert.equal(probe.openCodeHasStoredCredentials([]), false);
  assert.equal(setup.hasStoredCredentials(envOnly), false, "env is not a stored account");
  assert.equal(probe.openCodeHasStoredCredentials(envOnly), false, "env is not a stored account");
  assert.deepEqual(setup.storedIntegrationIds(LIST), ["anthropic", "openai"]);
  assert.deepEqual(probe.openCodeStoredIntegrationIds(LIST), ["anthropic", "openai"]);
  assert.deepEqual(setup.storedCredentials(LIST), [
    { integration: "anthropic", id: "cred_1", label: "API key" },
    { integration: "openai", id: "cred_2", label: "Work" },
    { integration: "openai", id: "cred_3", label: "API key" },
  ]);
  assert.deepEqual(probe.openCodeStoredCredentials(LIST), setup.storedCredentials(LIST));
});

test("provider ids accept the catalog's spellings and nothing path-like", () => {
  for (const id of ["anthropic", "openai", "deepseek", "openrouter", "wafer.ai", "x-ai", "a"]) {
    assert.equal(setup.isOpenCodeProviderId(id), true, id);
  }
  for (const id of ["", "../x", "/abs", "a/b", "UPPER", "has space", "a".repeat(41)]) {
    assert.equal(setup.isOpenCodeProviderId(id), false, id);
  }
});
