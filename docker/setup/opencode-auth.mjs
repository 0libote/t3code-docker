// Shared credential contract; image setup and harness live in separate /opt trees.
import { existsSync } from 'node:fs';
const local = new URL('../harness/opencode-auth.mjs', import.meta.url);
const shared = await import(existsSync(local) ? local.href : 'file:///opt/t3-harness/opencode-auth.mjs');
export const { openCodeMajor, parseAuthList, storedCredentials, storedIntegrationIds,
  hasStoredCredentials, isOpenCodeProviderId, createOpenCodeAuth } = shared;
