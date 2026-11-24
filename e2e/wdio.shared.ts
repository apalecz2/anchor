import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Shared between wdio.conf.ts (structural journeys) and wdio.eval.conf.ts (the
// pipeline-accuracy eval suite) so the two configs agree on how the app binary is
// found and how tauri-driver is launched/torn down, without duplicating either.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Resolve the built app binary for this platform. Override with ANCHOR_APP_BIN. */
export function resolveAppBinary(): string {
    return (
        process.env.ANCHOR_APP_BIN ??
        path.resolve(
            __dirname,
            '..',
            'app',
            'src-tauri',
            'target',
            'release',
            process.platform === 'win32' ? 'Anchor.exe' : 'Anchor',
        )
    );
}

export function baseCapabilities(appBinary: string): WebdriverIO.Capabilities[] {
    return [
        {
            // tauri-driver reads this custom capability to know which binary to launch.
            // @ts-expect-error — tauri:options is a tauri-driver extension capability
            'tauri:options': { application: appBinary },
        },
    ];
}

/**
 * tauri-driver speaks WebDriver on :4444 and proxies to the native webview driver.
 * Returns the onPrepare/onComplete/beforeSession hooks a WDIO config needs to spawn
 * and tear it down, with an actionable error if it isn't installed.
 */
export function tauriDriverHooks(): Pick<
    WebdriverIO.Config,
    'onPrepare' | 'onComplete' | 'beforeSession'
> {
    let tauriDriver: ChildProcess | undefined;
    return {
        onPrepare: () => {
            tauriDriver = spawn('tauri-driver', [], {
                stdio: [null, process.stdout, process.stderr],
            });
        },
        onComplete: () => {
            tauriDriver?.kill();
        },
        beforeSession: () => {
            const probe = spawnSync('tauri-driver', ['--help']);
            if (probe.error) {
                throw new Error(
                    'tauri-driver not found on PATH. Install it with: cargo install tauri-driver --locked',
                );
            }
        },
    };
}
