import React from 'react';

function FeatureCard({ icon, title, body }: { icon: string; title: string; body: string }) {
    return (
        <div className="rounded-[10px] border border-outline-variant bg-surface-container p-6 flex flex-col gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                <span
                    className="material-symbols-outlined text-primary"
                    style={{ fontSize: '20px', fontVariationSettings: "'wght' 300" }}
                >
                    {icon}
                </span>
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
            <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>{icon}</span>
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
                        Artifact transforms unstructured documents — handwritten notes, image-based tables, scanned
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
                                <span
                                    className="material-symbols-outlined text-on-surface-variant shrink-0 mt-0.5"
                                    style={{ fontSize: '18px', fontVariationSettings: "'wght' 300" }}
                                >
                                    {icon}
                                </span>
                                <p className="font-body-md text-body-md text-on-surface-variant">{label}</p>
                            </div>
                        ))}
                    </div>
                </section>

                {/* ── Core Capabilities ── */}
                <section className="flex flex-col gap-8">
                    <h2 className="font-headline-lg text-headline-lg text-on-surface">What Artifact does</h2>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <FeatureCard
                            icon="lock"
                            title="Complete privacy"
                            body="All OCR, AI inference, and extraction runs on your CPU or GPU. No telemetry, no cloud calls, no model APIs. Sensitive medical, legal, and financial records never leave your machine."
                        />
                        <FeatureCard
                            icon="visibility"
                            title="Human-in-the-loop verification"
                            body="A split-screen interface shows the source document alongside extracted data. Every field is linked back to its origin — click a value to see exactly where it came from in the original file."
                        />
                        <FeatureCard
                            icon="thermostat"
                            title="Confidence heatmap"
                            body="Low-confidence regions are highlighted directly on the document. Artifact combines Tesseract OCR confidence scores with AI token probabilities to tell you exactly what to double-check."
                        />
                        <FeatureCard
                            icon="auto_awesome"
                            title="Smart routing"
                            body="Machine-readable PDFs skip OCR entirely and are processed directly by the AI. Image-based or handwritten documents are routed through the full pipeline automatically."
                        />
                        <FeatureCard
                            icon="memory"
                            title="Stateful multi-page extraction"
                            body="Column names, data types, and extraction context are carried forward across pages. Long documents are processed coherently, not as isolated snippets."
                        />
                        <FeatureCard
                            icon="speed"
                            title="Background queue processing"
                            body="Submit a batch and keep working. The extraction pipeline runs in the background, queuing jobs intelligently so the UI stays responsive even during heavy processing."
                        />
                    </div>
                </section>

                {/* ── How It Works ── */}
                <section className="flex flex-col gap-8">
                    <div>
                        <h2 className="font-headline-lg text-headline-lg text-on-surface mb-2">How it works</h2>
                        <p className="font-body-md text-body-md text-on-surface-variant">Seven steps from raw file to verified structured data.</p>
                    </div>
                    <div className="flex flex-col gap-5">
                        <StepRow
                            number="1"
                            title="Ingest & validate"
                            body="Drop a PDF, PNG, or JPEG. Artifact validates the format and checks whether the document contains extractable content."
                        />
                        <StepRow
                            number="2"
                            title="Smart OCR"
                            body="Non-machine-readable files are rendered to high-resolution images and passed through Tesseract to produce baseline text with word-level bounding boxes. Machine-readable PDFs skip this step."
                        />
                        <StepRow
                            number="3"
                            title="Context assembly"
                            body="The AI model is loaded into RAM. A prompt is constructed from the document image (vision input), Tesseract output, and any user-supplied guidelines such as expected column names or formats."
                        />
                        <StepRow
                            number="4"
                            title="Stateful extraction"
                            body="The local vision-language model processes the document and emits structured output. Multi-page files carry forward context so column headers discovered on page 1 apply to data on page 10."
                        />
                        <StepRow
                            number="5"
                            title="Confidence mapping"
                            body="Fuzzy sequence matching aligns AI output tokens back to OCR bounding boxes. Token log-probabilities and Tesseract confidence scores are combined into a per-word confidence signal."
                        />
                        <StepRow
                            number="6"
                            title="Human verification"
                            body="The split-screen UI renders the heatmap over the original document. Review flagged regions, edit values inline, and accept or reject each extraction."
                        />
                        <StepRow
                            number="7"
                            title="Export"
                            body="Save verified data as CSV, Excel (XLSX), Markdown, or plain text. The model is unloaded from RAM after the job completes to free resources."
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
                                <FormatBadge icon="grid_on" label="Excel (XLSX)" />
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
                            <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">Low-end mode</p>
                            <h3 className="font-headline-md text-headline-md text-on-surface">8 GB RAM minimum</h3>
                            <p className="font-body-md text-body-md text-on-surface-variant">
                                Vision models are disabled. A lightweight ~2B LLM handles formatting and cleanup,
                                paired with Tesseract for text extraction.
                            </p>
                        </div>
                        <div className="rounded-[10px] border border-outline-variant bg-surface-container p-6 flex flex-col gap-3">
                            <p className="font-label-md text-label-md text-on-surface-variant uppercase tracking-wider">High-end mode</p>
                            <h3 className="font-headline-md text-headline-md text-on-surface">Full pipeline</h3>
                            <p className="font-body-md text-body-md text-on-surface-variant">
                                Full vision models with larger context windows. Richer multi-modal understanding
                                for complex tables, mixed layouts, and handwritten content.
                            </p>
                        </div>
                    </div>
                    <p className="font-body-md text-body-md text-on-surface-variant">
                        Artifact dynamically caps and prioritizes threads to keep the UI responsive and leave
                        headroom for your OS and other applications. Cross-platform on macOS, Windows, and Linux.
                    </p>
                </section>

            </div>
        </main>
    );
}