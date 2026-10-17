import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POLICY,
  POLICY_VERSION,
  normalizePolicy,
  readUpdateState,
  isIdle,
  checkDue,
  busyReason,
  describeKind,
  dueUpdates,
} from "../docker/setup/auto-update.mjs";

describe("auto-update policy", () => {
  it("defaults every independent kind to off with 3h checks and 30m idle", () => {
    assert.equal(POLICY_VERSION, 2);
    for (const kind of ["providers", "toolchains", "t3"]) {
      assert.equal(DEFAULT_POLICY[kind].enabled, false, kind);
      assert.equal(DEFAULT_POLICY[kind].checkMinutes, 180, kind);
      assert.equal(DEFAULT_POLICY[kind].idleMinutes, 30, kind);
    }
  });

  it("normalizes each kind independently and clamps ranges", () => {
    const policy = normalizePolicy({
      providers: { enabled: false, checkMinutes: 5, idleMinutes: 1000 },
      toolchains: { enabled: true, checkMinutes: 3000, idleMinutes: 1 },
      t3: { enabled: "yes", checkMinutes: 60, idleMinutes: 90 },
    });
    assert.deepEqual(policy.providers, { enabled: false, checkMinutes: 15, idleMinutes: 480 });
    assert.deepEqual(policy.toolchains, { enabled: true, checkMinutes: 1440, idleMinutes: 5 });
    assert.equal(policy.t3.enabled, false);
    assert.equal(policy.t3.checkMinutes, 60);
    assert.equal(policy.t3.idleMinutes, 90);
    assert.equal(policy.t3.stayOnChannel, true);
  });

  it("migrates legacy included toolchains without enabling previously inert updates", () => {
    const active = normalizePolicy({
      providers: { enabled: true, checkMinutes: 120, idleMinutes: 45, includeToolchains: true },
    });
    assert.deepEqual(active.toolchains, { enabled: true, checkMinutes: 120, idleMinutes: 45 });

    const inert = normalizePolicy({
      providers: { enabled: false, checkMinutes: 120, idleMinutes: 45, includeToolchains: true },
    });
    assert.deepEqual(inert.toolchains, { enabled: false, checkMinutes: 120, idleMinutes: 45 });
  });

  it("reads toolchain state and seeds its check time from the legacy shared check", async () => {
    const fs = { readFile: async () => JSON.stringify({ lastProviderCheckAt: 1234, lastResult: "done" }) };
    const state = await readUpdateState(fs, "/state");
    assert.equal(state.lastToolchainCheckAt, 1234);
    assert.equal(state.lastToolchainRunAt, null);
  });

  it("rejects non-objects to defaults", () => {
    assert.deepEqual(normalizePolicy(null), JSON.parse(JSON.stringify(DEFAULT_POLICY)));
  });
});

describe("auto-update scheduling", () => {
  it("is due when never checked", () => {
    assert.equal(checkDue({ checkMinutes: 180, lastCheckAt: null, now: 1000 }), true);
  });

  it("is due after the interval", () => {
    const now = 10 * 60_000;
    assert.equal(checkDue({ checkMinutes: 5, lastCheckAt: now - 6 * 60_000, now }), true);
    assert.equal(checkDue({ checkMinutes: 5, lastCheckAt: now - 4 * 60_000, now }), false);
  });

  it("is idle after idleMinutes without activity", () => {
    const now = 1_700_000_000_000;
    assert.equal(isIdle({ idleMinutes: 30, lastActivityAt: now - 31 * 60_000, now }), true);
    assert.equal(isIdle({ idleMinutes: 30, lastActivityAt: now - 29 * 60_000, now }), false);
    assert.equal(isIdle({ idleMinutes: 30, lastActivityAt: null, now }), true);
  });

  it("is never idle while busy", () => {
    const now = 1_700_000_000_000;
    assert.equal(isIdle({ idleMinutes: 30, lastActivityAt: now - 60 * 60_000, now, busy: true }), false);
  });

  it("names the busy reason", () => {
    assert.equal(busyReason({}), null);
    assert.match(busyReason({ lifecycleActive: true }), /already running/);
    assert.match(busyReason({ runtimeBusy: true }), /T3 Code update/);
    assert.match(busyReason({ setupRunning: true }), /First-start/);
  });

  it("describes each kind for the UI", () => {
    assert.equal(describeKind({ enabled: false }), "Off");
    assert.equal(describeKind({ enabled: true, checkMinutes: 180, idleMinutes: 30 }), "On · every 3h · after 30m idle");
  });
});

describe("auto-update due selection", () => {
  const isNewer = (latest, current) => latest > current;
  const base = {
    harnessIds: new Set(["claude", "codex"]),
    skipIds: new Set(["antigravity"]),
    isNewer,
  };

  it("selects installed harnesses with a strictly newer release only", () => {
    const latest = { "harness:claude": "2", "harness:codex": "1", "harness:antigravity": "9" };
    const jobs = dueUpdates({
      ...base,
      harnesses: [
        { id: "claude", installed: true, installedVersion: "1" },
        { id: "codex", installed: true, installedVersion: "1" },
        { id: "antigravity", installed: true, installedVersion: "1" },
        { id: "other", installed: true, installedVersion: "1" },
      ],
      toolchains: null,
      latestFor: (key) => latest[key] ?? null,
    });
    assert.deepEqual(jobs, [{ target: "harness", id: "claude" }]);
  });

  it("skips busy, missing and older-known rows", () => {
    const jobs = dueUpdates({
      ...base,
      harnesses: [
        { id: "claude", installed: true, installedVersion: "2", inProgress: true },
        { id: "codex", installed: true, installedVersion: "3" },
      ],
      toolchains: null,
      latestFor: () => "2",
    });
    assert.deepEqual(jobs, []);
  });

  it("includes toolchains, source control and added tools when asked", () => {
    const latest = { "toolchain:go": "2", "toolchain:glab": "2", "package:npm:prettier": "2", "toolchain:gh": "2" };
    const jobs = dueUpdates({
      ...base,
      harnesses: [],
      toolchains: {
        toolchains: [{ id: "go", installed: true, version: "1" }],
        sourceControl: [{ id: "glab", installed: true, version: "1" }, { id: "gh", installed: true, version: "1", inImage: true }],
        packages: [{ id: "npm:prettier", installed: true, version: "1" }],
      },
      latestFor: (key) => latest[key] ?? null,
    });
    assert.deepEqual(jobs, [
      { target: "toolchain", id: "go" },
      { target: "toolchain", id: "glab" },
      { target: "package", id: "npm:prettier" },
    ]);
  });

  it("falls back to a plain difference when versions cannot be ordered", () => {
    const jobs = dueUpdates({
      ...base,
      isNewer: () => { throw new Error("unparseable"); },
      harnesses: [{ id: "claude", installed: true, installedVersion: "dev-1" }],
      toolchains: null,
      latestFor: () => "dev-2",
    });
    assert.deepEqual(jobs, [{ target: "harness", id: "claude" }]);
  });
});
