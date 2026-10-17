// Unit tests for OpenCode credential handling across its two storages.
//
//   node --test tests/opencode-auth.test.mjs
//
// OpenCode 1.x keeps provider keys in auth.json; 2.x stores accounts in its
// database and answers `auth list --format json`. The setup service
// (docker/setup/opencode-auth.mjs) and the harness probe
// (docker/harness/probe.mjs) each implement the list shapes because neither
// can import the other in the image; these tests pin both to the same
// behavior so the mirror cannot drift silently.
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
  assert.throws(() => setup.parseAuthList("no authenticated integrations\n"), /no list/);
  assert.throws(() => probe.parseOpenCodeAuthList("{\"not\":\"a list\"}"), /no list/);
  assert.throws(() => setup.parseAuthList("[bad"), SyntaxError);
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

test("import entries carry the key as a stored account", () => {
  const first = setup.buildImportEntry("anthropic", "sk-ant-test");
  const second = setup.buildImportEntry("anthropic", "sk-ant-test");
  assert.equal(first.integrationID, "anthropic");
  assert.equal(first.label, "API key");
  assert.equal(first.active, true);
  assert.deepEqual(first.value, { type: "key", key: "sk-ant-test" });
  assert.match(first.id, /^cred_setup_[0-9a-f]+$/);
  assert.notEqual(first.id, second.id, "ids stay unique across imports");
  // The shape `auth import` decodes: no extra fields, nothing missing.
  assert.deepEqual(Object.keys(first).sort(), ["active", "id", "integrationID", "label", "value"]);
});
