// Pipeline-accuracy eval suite (docs/TESTING.md, docs/TEST_PLAN.md).
//
// Drives the real app through the same tauri-driver bridge as wdio.conf.ts, but
// against the eval-data/ corpus rather than the tiny structural fixtures. A run's
// length is a function of sample size × preset count × real LLM inference speed,
// not a constant, so the suite timeout below is set very large rather than
// disabled outright — see SUITE_TIMEOUT_MS for why `0` doesn't actually mean "no
// timeout" here. Correctness bounding for any single image still happens inside
// the spec (ANCHOR_EVAL_TIMEOUT_MS), independent of this ceiling. Local/manual
// only: never wired into CI. See e2e/eval/config.ts for the ANCHOR_EVAL_* env
// vars, and the prerequisites note in docs/TESTING.md (a real setup wizard run,
// with actual models installed, must already be complete on this machine).

import { baseCapabilities, resolveAppBinary, tauriDriverHooks } from './wdio.shared.ts';

// A literal `0` looks like "no timeout" in plain Mocha, but WDIO wraps every test
// with its own command-timeout tracker that computes `remaining = timeout -
// elapsed`; with timeout 0 that goes negative and the test fails almost
// instantly ("Timeout after -Nms"). 24h comfortably exceeds any realistic
// sample-size × preset-count × inference-speed combination while staying finite.
const SUITE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

export const config: WebdriverIO.Config = {
    runner: 'local',
    framework: 'mocha',
    specs: ['./eval/*.spec.ts'],
    maxInstances: 1,
    capabilities: baseCapabilities(resolveAppBinary()),
    reporters: ['spec'],
    hostname: '127.0.0.1',
    port: 4444,
    logLevel: 'info',
    mochaOpts: { ui: 'bdd', timeout: SUITE_TIMEOUT_MS },
    ...tauriDriverHooks(),
};
