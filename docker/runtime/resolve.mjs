import { runtimePaths, selectedRuntime } from "./state.mjs";
try { console.log((await selectedRuntime(runtimePaths())).binary); }
catch (error) { console.error(`t3-admin: ${error.message}`); process.exitCode = 1; }
