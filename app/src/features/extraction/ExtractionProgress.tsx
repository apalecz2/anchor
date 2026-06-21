import React from 'react';
import Icon from '../../components/Icon';
import type { ExtractionPhase } from '../llama/useLlamaChat';

// Ordered stages shown in the table-extraction progress stepper. The order matches
// the phase transitions in requestTableFormat (useLlamaChat).
const EXTRACTION_STEPS: { key: Exclude<ExtractionPhase, 'idle'>; label: string; hint?: string }[] = [
    { key: 'starting', label: 'Loading AI model', hint: 'First run can take a minute while the model loads into memory.' },
    { key: 'preparing', label: 'Reading image' },
    { key: 'generating', label: 'Generating table' },
    { key: 'finalizing', label: 'Matching to source & saving' },
];

export function ExtractionProgress({ phase }: { phase: ExtractionPhase }): React.ReactElement {
    const currentStep = EXTRACTION_STEPS.findIndex(s => s.key === phase);
    return (
        <ol className="space-y-3">
            {EXTRACTION_STEPS.map((step, i) => {
                const status = i < currentStep ? 'done' : i === currentStep ? 'active' : 'pending';
                return (
                    <li key={step.key} className="flex items-start gap-3">
                        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                            {status === 'done' ? (
                                <Icon name="check_circle" size={20} className="text-primary" />
                            ) : status === 'active' ? (
                                <Icon name="progress_activity" size={20} className="animate-spin text-primary" />
                            ) : (
                                <span className="h-3 w-3 rounded-full border-2 border-outline-variant" />
                            )}
                        </span>
                        <div className="flex flex-col">
                            <span className={`text-sm ${
                                status === 'pending'
                                    ? 'text-on-surface-variant/50'
                                    : status === 'active'
                                        ? 'font-medium text-on-surface'
                                        : 'text-on-surface-variant'
                            }`}>
                                {step.label}
                            </span>
                            {status === 'active' && step.hint && (
                                <span className="text-xs text-on-surface-variant/70">{step.hint}</span>
                            )}
                        </div>
                    </li>
                );
            })}
        </ol>
    );
}
