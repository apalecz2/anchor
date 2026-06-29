import React from 'react';
import Icon from '../components/Icon';

function FeatureCard({ icon, title, body }: { icon: string; title: string; body: string }) {
    return (
        <div className="rounded-[10px] border border-outline-variant bg-surface-container p-6 flex flex-col gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                <Icon name={icon} size={20} weight={300} className="text-primary" />
            </div>
            <h3 className="font-headline-md text-headline-md text-on-surface">{title}</h3>
            <p className="font-body-md text-body-md text-on-surface-variant leading-relaxed">{body}</p>
        </div>
    );
}

function StepRow({ number, title, body }: { number: string; title: string; body: string }) {
    return (
        <div className="flex gap-4 items-start">
            <div className="w-8 h-8 shrink-0 rounded-full bg-primary flex items-center justify-center mt-0.5">
                <span className="font-label-md text-label-md text-on-primary font-semibold">{number}</span>
            </div>
            <div>
                <p className="font-body-lg text-body-lg text-on-surface font-medium">{title}</p>
                <p className="font-body-md text-body-md text-on-surface-variant mt-0.5">{body}</p>
            </div>
        </div>
    );
}

function FormatBadge({ icon, label }: { icon: string; label: string }) {
    return (
        <span className="flex items-center gap-2 px-3 py-1.5 rounded-[10px] border border-outline-variant bg-surface-container font-label-md text-label-md text-on-surface-variant">
            <Icon name={icon} size={14} />
            {label}
        </span>
    );
}

export default function About(): React.ReactElement {
    return (
        <main className="absolute inset-0 overflow-y-auto bg-surface">
            {/* Atmospheric background — matches Dashboard */}
            <div className="absolute inset-0 pointer-events-none opacity-[0.03] bg-[radial-gradient(circle_at_top,var(--tw-gradient-stops))] from-primary via-transparent to-transparent" />

            <div className="relative z-10 max-w-4xl mx-auto px-[--spacing-margin-page] py-16 flex flex-col gap-20">

                {/* ── Hero ── */}
                <section className="flex flex-col gap-6 max-w-2xl">
                    <div className="flex items-center gap-2">
                        <span className="px-3 py-1 rounded-full bg-primary/10 font-label-md text-label-md text-primary border border-primary/20">
                            100% Local · Zero API Costs
                        </span>
                    </div>
                    <h1 className="font-display-lg text-display-lg text-primary tracking-tight">
                        Your documents.<br />Your data.<br />Your machine.
                    </h1>
                    <p className="font-body-lg text-body-lg text-on-surface-variant max-w-xl">
                        Anchor transforms unstructured documents — handwritten notes, image-based tables, scanned
                        PDFs — into clean, structured data. Everything runs locally on your hardware. Nothing leaves
                        your machine.
                    </p>
                </section>

                {/* ── The Problem ── */}
                <section className="flex flex-col gap-8">
                    <div>
                        <h2 className="font-headline-lg text-headline-lg text-on-surface mb-3">The problem with document data</h2>
                        <p className="font-body-lg text-body-lg text-on-surface-variant max-w-2xl">
                            Most valuable data is trapped in formats machines can't read — PDFs rendered as images,
                            tables photographed on phones, handwritten records never digitized. Getting that data out
                            today means one of two things: expensive cloud APIs that expose your most sensitive
                            information, or hours of manual re-entry riddled with human error.
                        </p>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                        {[
                            { icon: 'cloud_off', label: 'Cloud APIs expose sensitive records to third-party servers' },
                            { icon: 'schedule', label: 'Manual data entry is slow, costly, and error-prone' },
                            { icon: 'search_off', label: 'Verification is tedious — no link between source and output' },
                        ].map(({ icon, label }) => (
                            <div key={icon} className="flex gap-3 items-start rounded-[10px] border border-outline-variant bg-surface-container p-4">
                                <Icon name={icon} size={18} weight={300} className="text-on-surface-variant shrink-0 mt-0.5" />
                                <p className="font-body-md text-body-md text-on-surface-variant">{label}</p>
                            </div>
                        ))}
                    </div>
                </section>

                {/* ── Core Capabilities ── */}
                <section className="flex flex-col gap-8">
                    <h2 className="font-headline-lg text-headline-lg text-on-surface">What Anchor does</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <FeatureCard
                            icon="lock"
                            title="Complete privacy"
                            body="All OCR, AI inference, and extraction runs on your CPU or GPU. No telemetry, no cloud calls, no model APIs. Sensitive medical, legal, and financial records never leave your machine."
                        />
                        <FeatureCard
                            icon="visibility"
                            title="Human-in-the-loop verification"
                            body="A split-screen interface shows the source document alongside the extracted table. Click any cell to highlight the exact region of the document it was read from. Cells with no matching OCR source are flagged so you know what to check."
                        />
                        <FeatureCard
                            icon="thermostat"
                            title="Per-cell confidence scoring"
                            body="Every extracted cell is color-coded green, yellow, or red based on a blend of AI token log-probability and Tesseract OCR word confidence. The minimum token probability is tracked separately to catch a single shaky digit hiding inside an otherwise confident number."
                        />
                        <FeatureCard
                            icon="account_tree"
                            title="Deterministic source matching"
                            body="A code-based reading-order walk links each extracted cell back to the OCR words it came from — no extra model tokens, no latency. A fuzzy second pass recovers single-character OCR misreads and flags them as approximate so you know exactly what to double-check."
                        />
                    </div>
                </section>

                {/* ── How It Works ── */}
                <section className="flex flex-col gap-8">
                    <div>
                        <h2 className="font-headline-lg text-headline-lg text-on-surface mb-2">How it works</h2>
                        <p className="font-body-md text-body-md text-on-surface-variant">Nine steps from raw file to verified structured data.</p>
                    </div>
                    <div className="flex flex-col gap-5">
                        <StepRow
                            number="1"
                            title="Ingest & validate"
                            body="Drop a PDF, PNG, or JPEG. Anchor validates the format and checks whether the document contains extractable content."
                        />
                        <StepRow
                            number="2"
                            title="OCR"
                            body="Files are rendered to high-resolution images (PDFs at 2000 px wide via PDFium; direct image uploads as-is) and then passed through Tesseract for word-level text and bounding boxes."
                        />
                        <StepRow
                            number="3"
                            title="OCR image preprocessing"
                            body="A separate copy is prepared just for Tesseract — converted to grayscale and, for small image uploads, upscaled with Lanczos resampling. Binarization is left to Tesseract's own thresholding, which handles thin antialiased glyphs better than a hard threshold. The original image is untouched and is what the AI and the UI see. When a copy is upscaled, every returned bounding box is divided back by the scale factor so click-to-highlight boxes always land on the right spot in the original image."
                        />
                        <StepRow
                            number="4"
                            title="Context assembly"
                            body="OCR words are sanitized and sorted into reading order. Two views are built from the same word array: spatially-aligned text that preserves column layout for the AI, and an indexed word list with bounding boxes for provenance matching."
                        />
                        <StepRow
                            number="5"
                            title="Stage 1 — AI extraction"
                            body="The local vision-language model reads the document image alongside the spatially-arranged OCR text and emits a clean CSV table. It runs with greedy decoding and no constraints — the settings that produce reliably correct output. Token log-probabilities are captured during streaming."
                        />
                        <StepRow
                            number="6"
                            title="Stage 2 — Provenance matching"
                            body="A deterministic algorithm walks the CSV cells and OCR words in parallel, in the same reading order. Each cell is linked to the OCR word it came from — even when dozens of cells share identical values, sequence position disambiguates them. No model tokens, no latency."
                        />
                        <StepRow
                            number="7"
                            title="Confidence scoring"
                            body="Each cell receives three signals: AI token log-probability (mean and minimum), Tesseract OCR word confidence, and source agreement. These are blended into a trust level — high, medium, or low — that drives the color heatmap in the output table."
                        />
                        <StepRow
                            number="8"
                            title="Human verification"
                            body="The output table color-codes every cell by trust level. Click any cell to highlight its exact source region on the document. Cells the model read from the image with no matching OCR word are marked with an unverified-source badge, and cells that only approximately match the OCR (e.g. a single misread character) are marked with an approximate-match badge at a lowered confidence."
                        />
                        <StepRow
                            number="9"
                            title="Export"
                            body="Save verified data as CSV, HTML, Markdown, or plain text. The model is unloaded from RAM after the job completes to free resources."
                        />
                    </div>
                </section>

                {/* ── Technical Stack ── */}
                <section className="flex flex-col gap-6">
                    <h2 className="font-headline-lg text-headline-lg text-on-surface">Under the hood</h2>
                    <div className="rounded-[10px] border border-outline-variant bg-surface-container divide-y divide-outline-variant">
                        {[
                            { label: 'Interface', value: 'React + TypeScript', note: 'Type-safe, high-interactivity UI' },
                            { label: 'Framework', value: 'Tauri', note: 'Lightweight native desktop shell — lower overhead than Electron' },
                            { label: 'AI runtime', value: 'llama.cpp server', note: 'Model-agnostic inference; swap models without rebuilding' },
                            { label: 'Vision model', value: 'Qwen3.5-4b (multimodal)', note: 'Handles vision tasks and OCR validation locally' },
                            { label: 'OCR engine', value: 'Tesseract', note: 'Word-level bounding boxes and per-character confidence' },
                            { label: 'Image preprocessing', value: 'image (Rust)', note: 'Grayscale and Lanczos upscaling before OCR; Tesseract handles binarization internally — no system OpenCV dependency' },
                            { label: 'PDF rendering', value: 'PDFium', note: 'High-fidelity 2000px renders from native PDF pages' },
                            { label: 'Storage', value: 'SQLite (local)', note: 'Session and file metadata stored entirely on-device' },
                        ].map(({ label, value, note }) => (
                            <div key={label} className="flex items-start gap-4 px-5 py-4">
                                <p className="font-label-md text-label-md text-on-surface-variant w-32 shrink-0 mt-0.5">{label}</p>
                                <div>
                                    <p className="font-body-md text-body-md text-on-surface font-medium">{value}</p>
                                    <p className="font-body-sm text-body-sm text-on-surface-variant">{note}</p>
                                </div>
                            </div>
                        ))}
                    </div>
                </section>

                {/* ── Supported Formats ── */}
                <section className="flex flex-col gap-6">
                    <h2 className="font-headline-lg text-headline-lg text-on-surface">Supported formats</h2>
                    <div className="flex flex-col gap-4">
                        <div>
                            <p className="font-label-md text-label-md text-on-surface-variant mb-3 uppercase tracking-wider">Input</p>
                            <div className="flex flex-wrap gap-2">
                                <FormatBadge icon="picture_as_pdf" label="PDF" />
                                <FormatBadge icon="image" label="PNG" />
                                <FormatBadge icon="image" label="JPEG" />
                            </div>
                        </div>
                        <div>
                            <p className="font-label-md text-label-md text-on-surface-variant mb-3 uppercase tracking-wider">Output</p>
                            <div className="flex flex-wrap gap-2">
                                <FormatBadge icon="table_chart" label="CSV" />
                                <FormatBadge icon="code" label="HTML" />
                                <FormatBadge icon="notes" label="Markdown" />
                                <FormatBadge icon="article" label="Plain text" />
                            </div>
                        </div>
                    </div>
                </section>

                {/* ── Hardware section ── */}
                <section className="flex flex-col gap-6 pb-4">
                    <h2 className="font-headline-lg text-headline-lg text-on-surface">Adapts to your hardware</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div className="rounded-[10px] border border-outline-variant bg-surface-container p-6 flex flex-col gap-3">
                            <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">GPU acceleration</p>
                            <h3 className="font-headline-md text-headline-md text-on-surface">Automatic detection</h3>
                            <p className="font-body-md text-body-md text-on-surface-variant">
                                On first run, Anchor detects your graphics card and downloads the matching
                                accelerated build — NVIDIA (CUDA), AMD (ROCm), or Apple Silicon (Metal).
                            </p>
                        </div>
                        <div className="rounded-[10px] border border-outline-variant bg-surface-container p-6 flex flex-col gap-3">
                            <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">CPU fallback</p>
                            <h3 className="font-headline-md text-headline-md text-on-surface">Runs on any machine</h3>
                            <p className="font-body-md text-body-md text-on-surface-variant">
                                No GPU required — Anchor runs the full pipeline on your CPU, and a GPU build
                                automatically falls back to CPU if acceleration can't initialize.
                            </p>
                        </div>
                    </div>
                    <p className="font-body-md text-body-md text-on-surface-variant">
                        The AI model and platform binaries (~3.5 GB) are downloaded once on first launch and SHA-256 verified.
                    </p>
                </section>

            </div>
        </main>
    );
}