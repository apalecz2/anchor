// WebdriverIO + tauri-driver configuration (TEST_PLAN §4.3).
//
// tauri-driver bridges WebDriver to the platform webview (WebView2 on Windows,
// WKWebView via WKWebView's WebDriver on macOS) and launches the built app binary.
// It must be installed once on the host:  cargo install tauri-driver --locked
//
// The app is exercised as a RELEASE build with a test profile that points R2_BASE
// at a local fixture asset server (set ANCHOR_R2_BASE) so the setup wizard runs
// without multi-GB downloads. Build it first:  (cd ../app && npm run tauri build)

import { baseCapabilities, resolveAppBinary, tauriDriverHooks } from './wdio.shared.ts';

export const config: WebdriverIO.Config = {
    runner: 'local',
    framework: 'mocha',
    specs: ['./specs/**/*.e2e.ts'],
    maxInstances: 1, // a single app instance; journeys are stateful
    capabilities: baseCapabilities(resolveAppBinary()),
    reporters: ['spec'],
    hostname: '127.0.0.1',
    port: 4444,
    logLevel: 'info',
    mochaOpts: { ui: 'bdd', timeout: 120_000 },
    ...tauriDriverHooks(),
};
