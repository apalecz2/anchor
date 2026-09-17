import React, { useEffect, useState } from 'react';
import Icon from '../../components/Icon';
import {
    clearCustomModel,
    fileNameOf,
    formatModelSize,
    getCustomModel,
    setCustomModel,
    MAX_CUSTOM_CTX,
    MIN_CUSTOM_CTX,
    type CustomModel,
} from './customModel';

/**
 * Settings ▸ AI model — the slot for a GGUF the user supplies themselves.
 *
 * This replaced two free-text path fields that wrote to localStorage and were read by
 * nothing: the section said "saved paths take effect on next server start", and since
 * the executor began resolving model paths from the catalog that was simply untrue.
 * A control that claims to change behaviour and does not is worse than no control.
 *
 * Everything shown here is deliberately blunt about what Anchor does and does not
 * know. Bundled models are pinned by SHA-256 and verified byte for byte on download;
 * this one is whatever file the user pointed at. Saying so plainly, once, in the place
 * the choice is made, is the honest version of an "advanced" label.
 */
export default function CustomModelSection(): React.ReactElement {
    const [model, setModel] = useState<CustomModel | null>(null);
    const [loading, setLoading] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [ctx, setCtx] = useState(8192);

    useEffect(() => {
        let cancelled = false;
        getCustomModel()
            .then(found => {
                if (cancelled) return;
                setModel(found);
                if (found) setCtx(found.ctx);
            })
            .catch(() => { /* absent or unreadable reads as "none chosen" */ })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, []);

    const choose = async () => {
        setError(null);
        const { open } = await import('@tauri-apps/plugin-dialog');
        const picked = await open({
            filters: [{ name: 'GGUF model', extensions: ['gguf'] }],
            multiple: false,
        });
        if (typeof picked !== 'string') return;

        setBusy(true);
        try {
            // The backend validates and is the only thing that decides. Its message is
            // shown verbatim rather than replaced with a generic failure, because it
            // says *which* check failed — missing file, wrong extension, not actually
            // a GGUF — and that is the difference between a fixable mistake and a
            // mystery.
            setModel(await setCustomModel(picked, ctx));
        } catch (err) {
            setError(typeof err === 'string' ? err : 'That file could not be used.');
        } finally {
            setBusy(false);
        }
    };

    const forget = async () => {
        setBusy(true);
        setError(null);
        try {
            await clearCustomModel();
            setModel(null);
        } catch (err) {
            setError(typeof err === 'string' ? err : 'Could not remove the model.');
        } finally {
            setBusy(false);
        }
    };

    const applyCtx = async (next: number) => {
        setCtx(next);
        if (!model) return;
        setBusy(true);
        setError(null);
        try {
            setModel(await setCustomModel(model.weightsPath, next));
        } catch (err) {
            setError(typeof err === 'string' ? err : 'That context size could not be used.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="rounded-[10px] border border-outline-variant bg-surface-container p-5 flex flex-col gap-4">
            {loading ? (
                <p className="font-body-sm text-body-sm text-on-surface-variant">Checking…</p>
            ) : model ? (
                <>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                            <p className="font-body-md text-body-md text-on-surface font-medium truncate">
                                {fileNameOf(model.weightsPath)}
                            </p>
                            <p
                                className="font-body-sm text-body-sm text-on-surface-variant truncate"
                                title={model.weightsPath}
                            >
                                {formatModelSize(model.weightsBytes)} · {model.weightsPath}
                            </p>
                        </div>
                        <button
                            type="button"
                            onClick={forget}
                            disabled={busy}
                            className="px-4 py-2 rounded-lg border border-outline text-on-surface font-label-md text-label-md hover:bg-on-surface/5 transition-colors disabled:opacity-50"
                        >
                            Use the built-in model
                        </button>
                    </div>

                    <label className="flex flex-wrap items-center gap-3 font-body-sm text-body-sm text-on-surface-variant">
                        <span className="text-on-surface">Context size</span>
                        <input
                            type="number"
                            min={MIN_CUSTOM_CTX}
                            max={MAX_CUSTOM_CTX}
                            step={1024}
                            value={ctx}
                            disabled={busy}
                            onChange={e => setCtx(Number(e.target.value))}
                            onBlur={e => {
                                const next = Number(e.target.value);
                                if (next !== model.ctx) void applyCtx(next);
                            }}
                            className="w-28 px-3 py-1.5 rounded-lg border border-outline bg-surface text-on-surface font-body-sm text-body-sm"
                        />
                        <span>tokens — must be large enough for a page of text plus its table.</span>
                    </label>
                </>
            ) : (
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="font-body-sm text-body-sm text-on-surface-variant max-w-prose">
                        Anchor is using the model it downloaded during setup. To use a different
                        one, choose a GGUF file already on this computer.
                    </p>
                    <button
                        type="button"
                        onClick={choose}
                        disabled={busy}
                        className="px-4 py-2 rounded-lg bg-primary text-on-primary font-label-md text-label-md hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                        Choose a model file…
                    </button>
                </div>
            )}

            {error && (
                <p role="alert" className="flex items-start gap-2 font-body-sm text-body-sm text-error">
                    <Icon name="error" size={18} className="shrink-0 mt-px" />
                    <span>{error}</span>
                </p>
            )}

            {/* Shown whether or not a model is chosen: before, it is what the user is
                agreeing to; after, it is why a bad result is not necessarily a bug. */}
            <p className="flex items-start gap-2 pt-3 border-t border-outline-variant font-body-sm text-body-sm text-on-surface-variant">
                <Icon name="info" size={18} className="shrink-0 mt-px" />
                <span>
                    Models you supply are <strong className="text-on-surface">not verified</strong>.
                    Anchor checks that the file is a GGUF and nothing else — it cannot confirm where
                    it came from or that it produces correct tables, and the confidence colours will
                    mean less for its output. Models downloaded during setup are checked against a
                    known fingerprint. Your file stays where it is; Anchor only remembers the path.
                </span>
            </p>
        </div>
    );
}
