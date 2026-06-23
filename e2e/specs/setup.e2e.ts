import { browser, $, expect } from '@wdio/globals';

// TEST_PLAN §7 journey 1: First-run setup — automatic.
// Requires a fresh AppData and ANCHOR_R2_BASE pointing at the local fixture
// asset server (small stand-in binaries/models with known SHA-256), so the wizard
// runs end to end without 3.5 GB of real downloads.
describe('First-run setup — automatic', () => {
    it('runs the wizard to completion and loads the main app', async () => {
        // Welcome step is shown on a fresh install.
        const welcome = await $('h1*=Welcome, h2*=Welcome, *=Get started');
        await expect(welcome).toBeExisting();

        // Choose the one-click Automatic path.
        const automatic = await $('button*=Automatic');
        await automatic.click();

        // Install step: the overall progress bar advances against the fixture server.
        const progress = await $('[role="progressbar"], progress');
        await expect(progress).toBeExisting();

        // Wait for the Complete step (generous: fixture assets are tiny).
        const launch = await $('button*=Launch');
        await launch.waitForExist({ timeout: 120_000 });
        await launch.click();

        // Main app loaded — the upload/dashboard surface is visible.
        const dashboard = await $('*=Upload, *=Drop, *=New session');
        await expect(dashboard).toBeExisting();
    });
});
