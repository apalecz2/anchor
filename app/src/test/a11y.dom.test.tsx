import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { axe } from 'vitest-axe';
import * as matchers from 'vitest-axe/matchers';
import ConfirmDialog from '../components/ConfirmDialog';
import { WordEditModal } from '../features/extraction/WordEditModal';

expect.extend(matchers);

// Tier 5 (release-gated) accessibility seed: assert zero axe violations on the
// dialogs. Extend this list as new pages/dialogs are built (TEST_PLAN §9).
describe('accessibility — dialogs have no axe violations', () => {
    it('ConfirmDialog', async () => {
        const { container } = render(
            <ConfirmDialog
                open
                title="Delete session?"
                description="This cannot be undone."
                onConfirm={() => {}}
                onCancel={() => {}}
            />,
        );
        expect(await axe(container)).toHaveNoViolations();
    });

    it('WordEditModal', async () => {
        const { container } = render(
            <WordEditModal initialData={{ text: 'hi' }} onSave={() => {}} onClose={() => {}} />,
        );
        expect(await axe(container)).toHaveNoViolations();
    });
});
