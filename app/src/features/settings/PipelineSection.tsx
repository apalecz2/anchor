import React, { useEffect, useState } from 'react';
import Icon from '../../components/Icon';
import {
    listPipelinePresets,
    persistPreset,
    presetCaveat,
    type PresetOption,
} from './pipelinePresets';

/**
 * Settings ▸ Pipeline — which sequence of models runs an extraction.
 *
 * The choice is persisted to AppData rather than to webview storage, because it
 * decides what a *complete install* looks like: `check_setup_complete` reads it before
 * any webview storage exists, and the executor runs whatever it names. That is also
 * why an un-downloaded preset is labelled rather than hidden — selecting one is a
 * legitimate thing to do, but it sends the next launch back through setup, and the
 * user should learn that here rather than by being dropped into the wizard.
 */
export default function PipelineSection(): React.ReactElement {
    const [presets, setPresets] = useState<PresetOption[] | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        listPipelinePresets()
            .then(rows => { if (!cancelled) setPresets(rows); })
            .catch(() => { if (!cancelled) setPresets([]); });
        return () => { cancelled = true; };
    }, []);

    const choose = async (id: string) => {
        if (!presets) return;
        setBusy(true);
        setError(null);
        // Optimistic: the radio should move under the cursor, not after a round trip.
        // Reverted from the reload below if the write actually failed.
        const previous = presets;
        setPresets(presets.map(p => ({ ...p, selected: p.id === id })));
        try {
            await persistPreset(id);
            setPresets(await listPipelinePresets());
        } catch (err) {
            setPresets(previous);
            setError(typeof err === 'string' ? err : 'That pipeline could not be selected.');
        } finally {
            setBusy(false);
        }
    };

    if (presets === null) {
        return (
            <div className="rounded-[10px] border border-outline-variant bg-surface-container p-5">
                <p className="font-body-sm text-body-sm text-on-surface-variant">Checking…</p>
            </div>
        );
    }

    // One pipeline means no choice to offer; a radio list of one reads as a bug.
    if (presets.length < 2) {
        const only = presets[0];
        return (
            <div className="rounded-[10px] border border-outline-variant bg-surface-container p-5">
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                    {only ? `Anchor runs the ${only.label} pipeline: ${only.description}` : 'No pipeline is available.'}
                </p>
            </div>
        );
    }

    return (
        <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
            {presets.map(preset => {
                const caveat = presetCaveat(preset);
                return (
                    <label
                        key={preset.id}
                        className={`flex items-start gap-3 px-5 py-4 cursor-pointer transition-colors hover:bg-on-surface/[0.03] ${busy ? 'opacity-60 pointer-events-none' : ''}`}
                    >
                        <input
                            type="radio"
                            name="pipeline-preset"
                            checked={preset.selected}
                            onChange={() => void choose(preset.id)}
                            className="mt-1 shrink-0 accent-primary"
                        />
                        <div className="min-w-0">
                            <p className="font-body-md text-body-md text-on-surface font-medium">
                                {preset.label}
                                <span className="ml-2 font-body-sm text-body-sm text-on-surface-variant font-normal">
                                    {(preset.download_mb / 1000).toFixed(1)} GB of models
                                </span>
                            </p>
                            <p className="font-body-sm text-body-sm text-on-surface-variant mt-0.5">
                                {preset.description}
                            </p>
                            {caveat && (
                                <p className="flex items-start gap-1.5 mt-1.5 font-body-sm text-body-sm text-on-surface-variant">
                                    <Icon
                                        name={preset.supported ? 'download' : 'warning'}
                                        size={16}
                                        className={`shrink-0 mt-px ${preset.supported ? '' : 'text-error'}`}
                                    />
                                    <span>{caveat}</span>
                                </p>
                            )}
                        </div>
                    </label>
                );
            })}
            {error && (
                <p role="alert" className="flex items-start gap-2 px-5 py-3 font-body-sm text-body-sm text-error">
                    <Icon name="error" size={18} className="shrink-0 mt-px" />
                    <span>{error}</span>
                </p>
            )}
        </div>
    );
}
