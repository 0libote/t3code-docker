// OpenCode credentials across its two storages, for the setup service's
// explicit actions (save a key, remove one, list configured providers).
//
// OpenCode 1.x keeps provider keys in ~/.local/share/opencode/auth.json.
// OpenCode 2.x stores accounts (API keys, OAuth grants, ...) in its SQLite
// database, imports that file once during migration, and never writes it
// back - so a 2.x install must be driven through its `auth` commands.
//
// The list shapes below mirror docker/harness/probe.mjs, which answers the
// same question for status polls through the harness manager. The setup
// service cannot import the harness by relative path (in the image the two
// are separate /opt trees resolved at runtime), so the few pure helpers are
// mirrored here. Keep the two in sync.

import { randomBytes } from "node:crypto";

/** Major version of an OpenCode release string, or null when unknown. */
export function openCodeMajor(version) {
  const match = /^v?(\d+)\./.exec(String(version ?? "").trim());
  return match ? Number(match[1]) : null;
}

/** Parse `opencode auth list --format json`, tolerating log chatter before it. */
export function parseAuthList(text) {
  const start = String(text ?? "").indexOf("[");
  if (start < 0) throw new Error("OpenCode returned no list");
  const list = JSON.parse(String(text).slice(start));
  if (!Array.isArray(list)) throw new Error("OpenCode returned an invalid list");
  return list;
}

/**
 * Stored accounts as { integration, id, label }. Environment connections
 * (`type: "env"`) are left out: they are not credentials this setup manages,
 * and removing them is `unset the variable`, not `auth logout`.
 */
export function storedCredentials(list) {
  return (list ?? []).flatMap((integration) =>
    (integration?.connections ?? [])
      .filter((connection) => connection?.type === "credential")
      .map((connection) => ({
        integration: integration.id,
        id: connection.id,
        label: connection.label ?? null,
      })));
}

/** Integration ids holding at least one stored account, sorted. */
export function storedIntegrationIds(list) {
  return [...new Set(
    storedCredentials(list).map((credential) => credential.integration).filter(Boolean),
  )].sort();
}

/** Whether the list holds at least one stored account. */
export function hasStoredCredentials(list) {
  return storedCredentials(list).length > 0;
}

// Provider ids as OpenCode's catalog spells them. Dots are in the catalog
// too (wafer.ai); this only ever becomes a key in a JSON object or an
// integration id argument, never a path segment.
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export function isOpenCodeProviderId(value) {
  return PROVIDER_ID.test(String(value ?? ""));
}

/**
 * One credential entry for `opencode auth import` (which takes the shape
 * `auth export` prints). The id only has to be unique in the destination's
 * database; an entry whose id already exists there is skipped by the import.
 */
export function buildImportEntry(providerId, key) {
  return {
    id: `cred_setup_${randomBytes(8).toString("hex")}`,
    integrationID: providerId,
    label: "API key",
    active: true,
    value: { type: "key", key },
  };
}
