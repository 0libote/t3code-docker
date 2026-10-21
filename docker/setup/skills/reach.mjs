// Describe discovery, never grant write authority. Import/file APIs revalidate it.
import path from "node:path";
import { constants } from "node:fs";

async function resolveRoot(io, directory) {
  try { return await io.realpath(directory); }
  catch (error) {
    if (error.code !== "ENOENT" || path.dirname(directory) === directory) throw error;
    // A dangling symlink must not masquerade as a creatable missing folder.
    if (await io.lstat(directory).then(() => true, () => false)) throw error;
    return path.join(await resolveRoot(io, path.dirname(directory)), path.basename(directory));
  }
}
async function writableRoot(io, directory) {
  try {
    const stat = await io.stat(directory);
    if (!stat.isDirectory()) return false;
    await io.access(directory, constants.W_OK | constants.X_OK);
    return true;
  } catch (error) {
    return error.code === "ENOENT" && path.dirname(directory) !== directory ? writableRoot(io, path.dirname(directory)) : false;
  }
}
export async function skillReach({ providers, rootsFor, policyFor, io }) {
  const facts = await Promise.all(providers.map(async ({ id }) => {
    const policy = await policyFor(id);
    return Promise.all(rootsFor(id).map(async entry => {
      const resolvedPath = await resolveRoot(io, entry.path).catch(() => null);
      const own = entry.source === "Provider";
      const eligible = policy.creationTargets.some(target => target.path === entry.path);
      return { ...entry, provider: id, own, resolvedPath, writable: Boolean(eligible && resolvedPath && await writableRoot(io, resolvedPath)) };
    }));
  }));
  const physical = new Map();
  for (const fact of facts.flat()) {
    const key = fact.resolvedPath || fact.path;
    if (!physical.has(key)) physical.set(key, { path: fact.path, resolvedPath: fact.resolvedPath,
      paths: [], source: fact.source, scope: fact.scope, owner: null, owners: [], readers: [], writableOwners: [], writable: false });
    const root = physical.get(key);
    if (!root.paths.includes(fact.path)) root.paths.push(fact.path);
    if (!root.readers.includes(fact.provider)) root.readers.push(fact.provider);
    if (fact.own) {
      root.owner ||= fact.provider;
      root.source = "Provider";
      if (!root.owners.includes(fact.provider)) root.owners.push(fact.provider);
      if (fact.writable && !root.writableOwners.includes(fact.provider)) root.writableOwners.push(fact.provider);
    }
    root.writable ||= fact.writable;
  }
  return { ok: true, roots: [...physical.values()] };
}
