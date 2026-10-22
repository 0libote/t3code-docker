// Thin CLI over the same service used by the console. Mutating clean/trim
// commands require --yes; previews and status never remove files.
import { createStorageManager } from "../index.mjs";
import { GB } from "./policy.mjs";
import { CACHES, CACHE_IDS } from "./caches.mjs";
import { pathToFileURL } from "node:url";

const BUDGET_FLAGS = CACHES.map(({ id, budgetKey, label }) => [`--${id}-budget`, budgetKey, label]);

const usage = `Usage: t3-storage <command> [options]

  status [--json]                  disk space and the last cached inventory
  scan [--json]                    measure visible storage now
  clean (${[...CACHE_IDS, "all"].join("|")}) [--dry-run|--yes] [--json]
  trim [--dry-run|--yes] [--json]   review/remove older managed tool versions
  policy [--json]                  show maintenance preferences
  policy --automatic on|off --retain-versions on|off
         --automatic-caches <${CACHE_IDS.join(",")}>
         ${BUDGET_FLAGS.map(([flag]) => flag).join(" <GB> ")} <GB> [--json]

Clean and trim default to a preview. --yes applies the reviewed action.
Cleanup never removes projects, sign-ins, conversations, or backups.
Exit codes: 0 success; 1 operation failed; 2 usage; 3 busy/stale preview.
`;
const bytes = (n) => n == null ? "unknown" : n >= GB ? `${(n / GB).toFixed(1)} GB` : `${(n / 1_000_000).toFixed(1)} MB`;

export async function runStorageCli(args, { create = createStorageManager, out = console.log, err = console.error } = {}) {
  if (!args.length || args.includes("--help") || args[0] === "help") { out(usage); return args.length ? 0 : 2; }
  const command = args[0], rest = args.slice(1);
  const json = rest.includes("--json"), apply = rest.includes("--yes"), dryRun = rest.includes("--dry-run");
  const budgetFlags = BUDGET_FLAGS.map(([flag]) => flag);
  const allowed = new Set(["--json", "--yes", "--dry-run", "--automatic", "--automatic-caches", "--retain-versions", ...budgetFlags]);
  const positional = [], values = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg.startsWith("--") && !allowed.has(arg)) { err(`Unknown option: ${arg}\n${usage}`); return 2; }
    if (["--automatic", "--automatic-caches", "--retain-versions", ...budgetFlags].includes(arg)) {
      if (!rest[i + 1] || rest[i + 1].startsWith("--")) { err(`Missing value for ${arg}`); return 2; }
      values[arg] = rest[++i];
    } else if (!arg.startsWith("--")) positional.push(arg);
  }
  if (!["status", "scan", "clean", "trim", "policy"].includes(command)
    || (command === "clean" ? positional.length !== 1 || ![...CACHE_IDS, "all"].includes(positional[0]) : positional.length)
    || (command !== "policy" && Object.keys(values).length) || (apply && dryRun)
    || (!["clean", "trim"].includes(command) && (apply || dryRun))) { err(usage); return 2; }
  const storage = create({ intervalMs: 0, refreshAfterCleanup: false });
  try {
    let result;
    if (command === "status" || command === "scan") {
      if (command === "scan") await storage.refresh();
      const status = await storage.status();
      if (json) out(JSON.stringify(status));
      else {
        out(status.disk ? `Filesystem: ${bytes(status.disk.availableBytes)} available · ${status.disk.usedPercent}% used` : "Filesystem usage could not be read.");
        if (status.at) {
          for (const row of status.categories) out(`  ${row.label.padEnd(24)} ${bytes(row.bytes)}${row.unavailable ? ` · ${row.unavailable}` : ""}`);
          out(`Cached data available for review: ${bytes(status.cleanableBytes)}`);
          out(`Measured: ${new Date(status.at).toISOString()}`);
        } else out("No inventory yet. Run t3-storage scan to measure folders.");
        if (status.error) out(status.error);
      }
      return status.disk ? 0 : 1;
    }
    if (command === "policy") {
      const currentStatus = await storage.status(), current = currentStatus.policy;
      const next = { ...current };
      if ("--automatic-caches" in values) next.automaticCaches = values["--automatic-caches"] === "none" ? [] : values["--automatic-caches"].split(",");
      for (const [flag, key] of [["--automatic", "automatic"], ["--retain-versions", "retainManagedVersions"]]) {
        if (!(flag in values)) continue;
        if (!["on", "off"].includes(values[flag])) { err(`${flag} must be on or off.`); return 2; }
        next[key] = values[flag] === "on";
      }
      for (const [flag, key] of BUDGET_FLAGS) {
        if (flag in values) {
          const budget = Number(values[flag]);
          if (!Number.isFinite(budget) || budget < 0.25 || budget > 500) { err(`${flag} must be between 0.25 and 500 GB.`); return 2; }
          next[key] = Math.round(budget * GB);
        }
      }
      result = Object.keys(values).length ? await storage.setPolicy(next, { expectedRevision: currentStatus.policyRevision }) : { ok: true, policy: current };
      if (!json && result.ok) {
        out(`Cache maintenance: ${result.policy.automatic ? "on (after 10 idle minutes)" : "off"}`);
        out(`Automatic caches: ${result.policy.automaticCaches.join(", ") || "none"}`);
        for (const [, key, name] of BUDGET_FLAGS) out(`  ${name} limit: ${bytes(result.policy[key])}`);
        out(`Managed version retention: ${result.policy.retainManagedVersions ? "on" : "off"}`);
        return 0;
      }
    } else if (command === "clean") {
      const preview = await storage.previewClean(positional[0] === "all" ? CACHE_IDS : positional);
      const eligible = preview.caches?.filter((cache) => cache.eligible).map((cache) => cache.id) || [];
      if (!apply || !preview.ok) result = preview;
      else if (eligible.length) result = { ...await storage.clean(eligible, { token: preview.token }), kept: preview.caches.filter((cache) => !cache.eligible) };
      else {
        const attention = preview.caches.find((cache) => cache.status === "busy" || (positional[0] !== "all" && cache.status !== "empty"));
        result = attention ? { ok: false, code: attention.status === "busy" ? "busy" : "unavailable", error: attention.detail, caches: preview.caches }
          : { ...preview, dryRun: false, note: "No eligible cached data to remove. Unavailable and protected caches are kept." };
      }
    } else {
      const preview = await storage.previewVersions();
      result = !apply || !preview.ok ? preview : await storage.trimVersions({ token: preview.token });
      if (!apply) result.dryRun = true;
    }
    if (json) out(JSON.stringify(result));
    else if (!result.ok) err(result.error || "Storage action could not finish.");
    else if (result.note && !result.estimatedBytes && !result.dryRun) {
      out(result.note);
      for (const cache of result.caches || []) out(`  ${cache.label || cache.id}: kept · ${cache.reason || 'No eligible data'}`);
    }
    else if (result.dryRun) {
      out(command === "clean" ? `Review: ${bytes(result.estimatedBytes)} of cached data eligible for cleanup.` : `Preview: approximately ${bytes(result.estimatedBytes)} reclaimable.`);
      if (result.note) out(result.note);
      if (result.caches) for (const cache of result.caches) out(`  ${cache.label || cache.id}: ${bytes(cache.bytes)}${cache.eligible ? " · ready" : ` · kept: ${cache.reason}`}`);
      if (result.items) for (const item of result.items) out(`  ${item.name} ${item.version}: ${item.eligible ? "can remove" : item.reason}`);
      out("Rerun with --yes to apply. Current and required versions are kept.");
    } else out(command === "trim" ? `Removed ${result.removed?.length || 0} older versions.` : `Removed ${bytes(result.removedCacheBytes)} of cached data. Shared file blocks may remain allocated.`);
    return result.ok ? 0 : ["busy", "stale-preview", "stale-policy"].includes(result.code) ? 3 : 1;
  } catch (error) { err(`Storage action failed: ${error.message}`); return 1; }
  finally { storage.stop(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runStorageCli(process.argv.slice(2));
