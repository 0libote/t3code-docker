// Seed T3's native folder preference before the server and provider sync start.
// A later choice in T3, including clearing the preference, belongs to the user.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson, runtimePaths, writeJson } from "./state.mjs";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const MISSING = Symbol("missing project defaults");
const validRecord = (record) => object(record) && record.schema === 1
  && (record.directory === null || (typeof record.directory === "string" && path.isAbsolute(record.directory)));

export async function seedProjectDefaults(env = process.env) {
  const workspace = env.T3_WORKSPACE;
  if (typeof workspace !== "string" || !path.isAbsolute(workspace) || workspace.includes("\0")) {
    throw new Error("T3_WORKSPACE must be an absolute directory path.");
  }
  const directory = path.resolve(workspace);
  const paths = runtimePaths(env);
  const settingsFile = path.join(paths.home, "userdata/settings.json");
  const recordFile = path.join(paths.root, "project-defaults.json");
  const settings = await readJson(settingsFile, {});
  const record = await readJson(recordFile, MISSING);
  if (!object(settings) || (settings.addProjectBaseDirectory !== undefined
    && typeof settings.addProjectBaseDirectory !== "string")) {
    throw new Error("T3's folder preference is unreadable; existing settings were kept.");
  }
  if (record !== MISSING && !validRecord(record)) {
    throw new Error("The saved folder default is unreadable; existing settings were kept.");
  }
  const current = settings.addProjectBaseDirectory;
  const managed = record === MISSING
    ? !current?.trim()
    : record.directory !== null && current === record.directory;
  const nextRecord = { schema: 1, directory: managed ? directory : null };
  const changed = managed && current !== directory;
  if (changed) {
    await fs.mkdir(directory, { recursive: true });
    await fs.access(directory, fs.constants.W_OK | fs.constants.X_OK);
    await writeJson(settingsFile, { ...settings, addProjectBaseDirectory: directory });
  }
  if (record === MISSING || record.directory !== nextRecord.directory) await writeJson(recordFile, nextRecord);
  return { changed, managed, directory: managed ? directory : null };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try {
    const result = await seedProjectDefaults();
    console.log(result.managed
      ? "project browsing and clone default: T3_WORKSPACE"
      : "keeping the user's project folder preference");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
