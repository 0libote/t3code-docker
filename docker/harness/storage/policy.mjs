// Shared storage preferences. Both the console and harness lifecycle read
// this file; a missing file has safe defaults, a corrupt one permits no pruning.
import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { CACHES, CACHE_IDS } from "./caches.mjs";

export const GB = 1_000_000_000;
export const DEFAULT_POLICY = Object.freeze({
  schema: 1, automatic: false, retainManagedVersions: true,
  automaticCaches: CACHE_IDS,
  ...Object.fromEntries(CACHES.map((cache) => [cache.budgetKey, cache.defaultGB * GB])),
});
export const BUDGET_KEYS = Object.freeze(CACHES.map(({ budgetKey }) => budgetKey));

export const storageStateDir = (env, userHome) => path.join(env.T3CODE_HOME || path.join(userHome, ".t3"), "setup");
export const policyPath = (env, userHome) => path.join(storageStateDir(env, userHome), "storage-policy.json");
export const policyRevision = (policy, error = null) => createHash("sha256").update(JSON.stringify({ policy, error })).digest("hex");

export function validatePolicy(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Storage preferences must be an object.");
  const allowed = new Set(Object.keys(DEFAULT_POLICY));
  if (Object.keys(input).some((key) => !allowed.has(key))) throw new Error("Unknown storage preference.");
  if (input.schema !== undefined && input.schema !== 1) throw new Error("Unsupported storage preferences.");
  const value = { ...DEFAULT_POLICY, ...input, schema: 1 };
  for (const key of ["automatic", "retainManagedVersions"]) {
    if (typeof value[key] !== "boolean") throw new Error("Storage switches must be on or off.");
  }
  if (!Array.isArray(value.automaticCaches) || value.automaticCaches.length > CACHE_IDS.length
    || new Set(value.automaticCaches).size !== value.automaticCaches.length
    || value.automaticCaches.some((id) => !CACHE_IDS.includes(id))) throw new Error("Choose valid caches for automatic cleanup.");
  value.automaticCaches = [...value.automaticCaches];
  if (value.automatic && !value.automaticCaches.length) throw new Error("Choose at least one cache, or turn automatic cleanup off.");
  for (const key of BUDGET_KEYS) {
    if (!Number.isSafeInteger(value[key]) || value[key] < GB / 4 || value[key] > 500 * GB) {
      throw new Error("Cache limits must be between 0.25 and 500 GB.");
    }
  }
  return value;
}

export async function readPolicy(file, io = fs) {
  try {
    const input = JSON.parse(await io.readFile(file, "utf8"));
    // Older opt-ins covered Go and npm only. An image upgrade must never
    // silently expand the set of tools whose caches are cleaned in background.
    if (input && typeof input === "object" && !Array.isArray(input) && input.automaticCaches === undefined) input.automaticCaches = ["go", "npm"];
    return { policy: validatePolicy(input), error: null };
  }
  catch (error) {
    if (error.code === "ENOENT") return { policy: { ...DEFAULT_POLICY }, error: null };
    return { policy: { ...DEFAULT_POLICY, automatic: false, retainManagedVersions: false }, error: "Storage preferences could not be read. Automatic cleanup is paused." };
  }
}

/** Complete, private, atomic writes. Temporary files are removed on failure. */
export async function writeStorageJson(file, value, io = fs) {
  await io.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await io.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    await io.rename(temporary, file);
  } finally {
    try { await io.unlink(temporary); } catch { /* not created, or already renamed */ }
  }
}
