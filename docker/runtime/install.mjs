// Image-only installer; runtime updates continue through the container supervisor.
import { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { releaseForVersion, unpackRelease, executableVersion } from "./releases.mjs";

export async function installImageRelease(version, arch, destination, { fetcher = fetch, run = promisify(execFile) } = {}) {
  let stage;
  try {
    if (!destination || !path.isAbsolute(destination)) throw new Error("Expected version, architecture and an absolute destination.");
    const release = await releaseForVersion(version, { arch, fetcher });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    stage = await fs.mkdtemp(path.join(path.dirname(destination), ".t3-install-"));
    const unpacked = await unpackRelease(stage, release, { fetcher, run });
    // Cross builds verify the checksum and archive root; native CI smoke tests
    // run the executable on both architectures.
    if (arch === process.arch) {
      const result = await run(path.join(unpacked, "t3"), ["--version"], { timeout: 30_000 });
      if (executableVersion(result.stdout) !== version) throw new Error("The downloaded executable reports a different version.");
    }
    // Staging on the state volume is private, but the root-owned image runtime
    // and its generated audit manifest must be readable by the t3 user.
    await fs.chmod(unpacked, 0o755);
    await fs.chmod(path.join(unpacked, "package.json"), 0o644);
    await fs.rename(unpacked, destination);
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [version, arch, destination] = process.argv.slice(2);
  try {
    await installImageRelease(version, arch, destination);
    console.log(`[t3code] installed ${version} from its verified GitHub CLI archive (${arch})`);
  } catch (error) {
    console.error(`[t3code] ${error.message}`);
    process.exitCode = 1;
  }
}
