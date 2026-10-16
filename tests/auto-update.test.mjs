import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_POLICY,
  normalizePolicy,
  isIdle,
  checkDue,
  busyReason,
  describeKind,
} from "../docker/setup/auto-update.mjs";

describe("auto-update policy", () => {
  it("defaults to off with 3h checks and 30m idle", () => {
    assert.equal(DEFAULT_POLICY.providers.enabled, false);
    assert.equal(DEFAULT_POLICY.t3.enabled, false);
    assert.equal(DEFAULT_POLICY.providers.checkMinutes, 180);
    assert.equal(DEFAULT_POLICY.t3.checkMinutes, 180);
    assert.equal(DEFAULT_POLICY.providers.idleMinutes, 30);
    assert.equal(DEFAULT_POLICY.t3.idleMinutes, 30);
  });

  it("normalizes toggles and clamps ranges", () => {
    const policy = normalizePolicy({
      providers: { enabled: true, checkMinutes: 5, idleMinutes: 1000, includeToolchains: true },
      t3: { enabled: "yes", checkMinutes: 3000, idleMinutes: 1 },
    });
    assert.equal(policy.providers.enabled, true);
    assert.equal(policy.providers.checkMinutes, 15);
    assert.equal(policy.providers.idleMinutes, 480);
    assert.equal(policy.providers.includeToolchains, true);
    assert.equal(policy.t3.enabled, false);
    assert.equal(policy.t3.checkMinutes, 1440);
    assert.equal(policy.t3.idleMinutes, 5);
    assert.equal(policy.t3.stayOnChannel, true);
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
