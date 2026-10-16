// Smart auto-update policy for providers (agents/toolchains) and T3 Code.
//
// The console never updates anything on its own unless this policy says so.
// When enabled, a background pass checks for new releases every
// `checkMinutes` and installs them only after `idleMinutes` without activity.
//
// Activity here means someone is using the server: setup API traffic (the
// console open and polling counts), a lifecycle install/update in flight, a
// T3 Code update/restart in flight, or the first-start install running. T3
// Code agent turns stop on restart, so deferring while anyone is around is
// the safe default.
export const POLICY_VERSION = 1;

export const DEFAULT_POLICY = Object.freeze({
  version: POLICY_VERSION,
  providers: Object.freeze({
    enabled: false,
    // How often to look for new agent releases.
    checkMinutes: 180,
    // Install only after this long without activity.
    idleMinutes: 30,
    // When true, toolchains, source-control CLIs and added tools update too.
    // When false, only the Agents rows update.
    includeToolchains: false,
  }),
  t3: Object.freeze({
    enabled: false,
    checkMinutes: 180,
    idleMinutes: 30,
    // Auto-update stays within the selected channel; it never switches
    // Stable <-> Nightly on its own.
    stayOnChannel: true,
  }),
});

const clamp = (value, min, max, fallback) => {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

/** Validate user input into a safe policy, keeping unknown fields out. */
export function normalizePolicy(input) {
  const src = input && typeof input === "object" ? input : {};
  const providers = src.providers && typeof src.providers === "object" ? src.providers : {};
  const t3 = src.t3 && typeof src.t3 === "object" ? src.t3 : {};
  return {
    version: POLICY_VERSION,
    providers: {
      enabled: providers.enabled === true,
      checkMinutes: clamp(providers.checkMinutes, 15, 1440, DEFAULT_POLICY.providers.checkMinutes),
      idleMinutes: clamp(providers.idleMinutes, 5, 480, DEFAULT_POLICY.providers.idleMinutes),
      includeToolchains: providers.includeToolchains === true,
    },
    t3: {
      enabled: t3.enabled === true,
      checkMinutes: clamp(t3.checkMinutes, 15, 1440, DEFAULT_POLICY.t3.checkMinutes),
      idleMinutes: clamp(t3.idleMinutes, 5, 480, DEFAULT_POLICY.t3.idleMinutes),
      stayOnChannel: true,
    },
  };
}

export const policyPath = (stateDir) => `${stateDir}/setup/auto-update.json`;
export const statePath = (stateDir) => `${stateDir}/setup/auto-update-state.json`;

export async function readPolicy(fs, stateDir) {
  try {
    const raw = JSON.parse(await fs.readFile(policyPath(stateDir), "utf8"));
    return normalizePolicy(raw);
  } catch {
    return normalizePolicy(null);
  }
}

export async function writePolicy(fs, stateDir, input) {
  const policy = normalizePolicy(input);
  await fs.mkdir(`${stateDir}/setup`, { recursive: true });
  await fs.writeFile(policyPath(stateDir), `${JSON.stringify(policy, null, 2)}\n`);
  return policy;
}

export async function readUpdateState(fs, stateDir) {
  try {
    const raw = JSON.parse(await fs.readFile(statePath(stateDir), "utf8"));
    if (!raw || typeof raw !== "object") throw new Error("bad state");
    return {
      lastProviderCheckAt: Number(raw.lastProviderCheckAt) || null,
      lastT3CheckAt: Number(raw.lastT3CheckAt) || null,
      lastProviderRunAt: Number(raw.lastProviderRunAt) || null,
      lastT3RunAt: Number(raw.lastT3RunAt) || null,
      lastResult: typeof raw.lastResult === "string" ? raw.lastResult.slice(0, 300) : null,
    };
  } catch {
    return { lastProviderCheckAt: null, lastT3CheckAt: null, lastProviderRunAt: null, lastT3RunAt: null, lastResult: null };
  }
}

export async function writeUpdateState(fs, stateDir, patch) {
  const current = await readUpdateState(fs, stateDir);
  const next = { ...current, ...patch };
  await fs.mkdir(`${stateDir}/setup`, { recursive: true });
  await fs.writeFile(statePath(stateDir), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

/** Minutes since `at`, or null when never. */
export const minutesSince = (at, now) => (Number.isFinite(at) && at > 0 ? Math.max(0, (now - at) / 60_000) : null);

/** True when nobody has been active for at least `idleMinutes`. */
export function isIdle({ idleMinutes, lastActivityAt, now = Date.now(), busy = false }) {
  if (busy) return false;
  if (!Number.isFinite(lastActivityAt) || lastActivityAt <= 0) return true;
  return now - lastActivityAt >= idleMinutes * 60_000;
}

/** True when a periodic check is due (never checked counts as due). */
export function checkDue({ checkMinutes, lastCheckAt, now = Date.now() }) {
  if (!Number.isFinite(lastCheckAt) || lastCheckAt <= 0) return true;
  return now - lastCheckAt >= checkMinutes * 60_000;
}

/** Combine the busy signals the server already tracks into one verdict. */
export function busyReason({ lifecycleActive = false, lifecycleQueued = 0, runtimeBusy = false, setupRunning = false, restarting = false } = {}) {
  if (runtimeBusy) return "T3 Code update in progress";
  if (lifecycleActive) return "An install or update is already running";
  if (lifecycleQueued > 0) return "Updates are queued";
  if (setupRunning) return "First-start install is running";
  if (restarting) return "T3 Code is restarting";
  return null;
}

/** Short human summary for the UI, e.g. "On · every 3h · after 30m idle". */
export function describeKind(kind) {
  if (!kind?.enabled) return "Off";
  const every = kind.checkMinutes >= 60 && kind.checkMinutes % 60 === 0
    ? `every ${kind.checkMinutes / 60}h` : `every ${kind.checkMinutes}m`;
  return `On · ${every} · after ${kind.idleMinutes}m idle`;
}
