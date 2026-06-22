import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// WebdriverIO + tauri-driver configuration (TEST_PLAN §4.3).
//
// tauri-driver bridges WebDriver to the platform webview (WebView2 on Windows,
// WKWebView via WKWebView's WebDriver on macOS) and launches the built app binary.
// It must be installed once on the host:  cargo install tauri-driver --locked
//
// The app is exercised as a RELEASE build with a test profile that points R2_BASE
// at a local fixture asset server (set ARTIFACT_R2_BASE) so the setup wizard runs
// without multi-GB downloads. Build it first:  (cd ../app && npm run tauri build)

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Resolve the built app binary for this platform. Override with ARTIFACT_APP_BIN.
const APP_BINARY =
    process.env.ARTIFACT_APP_BIN ??
    path.resolve(
        __dirname,
        '..',
        'app',
        'src-tauri',
        'target',
        'release',
        process.platform === 'win32' ? 'app.exe' : 'app',
    );

let tauriDriver: ChildProcess | undefined;

export const config: WebdriverIO.Config = {
    runner: 'local',
    framework: 'mocha',
    specs: ['./specs/**/*.e2e.ts'],
    maxInstances: 1, // a single app instance; journeys are stateful
    capabilities: [
        {
            // tauri-driver reads this custom capability to know which binary to launch.
            // @ts-expect-error — tauri:options is a tauri-driver extension capability
            'tauri:options': { application: APP_BINARY },
        },
    ],
    reporters: ['spec'],
    hostname: '127.0.0.1',
    port: 4444,
    logLevel: 'info',
    mochaOpts: { ui: 'bdd', timeout: 120_000 },

    // tauri-driver speaks WebDriver on :4444 and proxies to the native webview driver.
    onPrepare: () => {
        tauriDriver = spawn('tauri-driver', [], { stdio: [null, process.stdout, process.stderr] });
    },
    onComplete: () => {
        tauriDriver?.kill();
    },

    // Ensure tauri-driver is installed before a run, with an actionable error.
    beforeSession: () => {
        const probe = spawnSync('tauri-driver', ['--help']);
        if (probe.error) {
            throw new Error(
                'tauri-driver not found on PATH. Install it with: cargo install tauri-driver --locked',
            );
        }
    },
};
