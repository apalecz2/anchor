import { useEffect, useRef, useState } from "react";
import "./App.css";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { useLlamaChat } from "./features/llama/useLlamaChat";
import { OcrWorkspace } from "./features/ocr/OcrWorkspace";

type ActiveWorkspace = "ocr" | "chat";

function App() {
    const [activeWorkspace, setActiveWorkspace] = useState<ActiveWorkspace>("ocr");
    const [input, setInput] = useState("");

    const {
        isServerReady,
        isLoading,
        messages,
        pendingAttachment,
        attachImage,
        removePendingAttachment,
        sendMessage,
    } = useLlamaChat();

    const messagesEndRef = useRef<HTMLDivElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    };

    useEffect(() => {
        scrollToBottom();
    }, [messages]);

    const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        void attachImage(file).finally(() => {
            if (fileInputRef.current) {
                fileInputRef.current.value = "";
            }
        });
    };

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault();

        const wasSent = await sendMessage(input);

        if (wasSent) {
            setInput("");
        }
    };

    const markdownComponents = {
        p: ({ children }: { children?: React.ReactNode }) => <p className="mb-3 last:mb-0 whitespace-pre-wrap leading-relaxed">{children}</p>,
        ul: ({ children }: { children?: React.ReactNode }) => <ul className="mb-3 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }: { children?: React.ReactNode }) => <ol className="mb-3 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
        li: ({ children }: { children?: React.ReactNode }) => <li className="leading-relaxed">{children}</li>,
        table: ({ children }: { children?: React.ReactNode }) => (
            <div className="my-3 overflow-x-auto rounded-xl border border-slate-200 bg-white">
                <table className="min-w-full border-collapse text-left text-sm">{children}</table>
            </div>
        ),
        thead: ({ children }: { children?: React.ReactNode }) => <thead className="bg-slate-100 text-xs uppercase tracking-[0.16em] text-slate-500">{children}</thead>,
        tbody: ({ children }: { children?: React.ReactNode }) => <tbody className="divide-y divide-slate-200">{children}</tbody>,
        tr: ({ children }: { children?: React.ReactNode }) => <tr className="align-top">{children}</tr>,
        th: ({ children }: { children?: React.ReactNode }) => <th className="border-b border-slate-200 px-3 py-2 font-semibold text-slate-600">{children}</th>,
        td: ({ children }: { children?: React.ReactNode }) => <td className="border-b border-slate-200 px-3 py-2 text-slate-800">{children}</td>,
        code: ({ inline, children, className }: { inline?: boolean; children?: React.ReactNode; className?: string }) =>
            inline ? (
                <code className="rounded bg-slate-200 px-1.5 py-0.5 font-mono text-[0.85em] text-slate-800">{children}</code>
            ) : (
                <code className={className}>{children}</code>
            ),
        pre: ({ children }: { children?: React.ReactNode }) => <pre className="mb-3 overflow-x-auto rounded-xl bg-slate-950 p-4 text-sm text-slate-100 last:mb-0">{children}</pre>,
        blockquote: ({ children }: { children?: React.ReactNode }) => <blockquote className="mb-3 border-l-4 border-slate-300 pl-4 text-slate-600 last:mb-0">{children}</blockquote>,
    };

    return (
        <main className="flex h-screen max-h-screen flex-col bg-slate-50 p-4 font-sans text-slate-900">
            <div className="mb-4 flex flex-col gap-3 rounded-3xl border border-slate-200 bg-white px-5 py-4 shadow-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h1 className="text-2xl font-semibold tracking-tight text-slate-900">Local Data Extraction AI</h1>
                        <p className="mt-1 text-sm text-slate-500">OCR in WASM on one side, llama-backed extraction on the other.</p>
                    </div>

                    <div className="flex items-center gap-2 rounded-2xl bg-slate-100 p-1">
                        <button
                            type="button"
                            onClick={() => setActiveWorkspace("ocr")}
                            className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${activeWorkspace === "ocr" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
                        >
                            OCR
                        </button>
                        <button
                            type="button"
                            onClick={() => setActiveWorkspace("chat")}
                            className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${activeWorkspace === "chat" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"}`}
                        >
                            Chat
                        </button>
                    </div>
                </div>

                <div className="flex items-center gap-2 text-sm">
                    <span className={`rounded-full border px-3 py-1 font-medium ${isServerReady ? "border-emerald-200 bg-emerald-50 text-emerald-700" : "border-amber-200 bg-amber-50 text-amber-700"}`}>
                        {isServerReady ? "Backend Ready" : "Loading Inference Engine"}
                    </span>
                </div>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
                {activeWorkspace === "ocr" ? (
                    <OcrWorkspace />
                ) : !isServerReady ? (
                    <div className="flex h-full flex-col items-center justify-center rounded-3xl border border-slate-200 bg-white shadow-sm">
                        <div className="mb-6 h-12 w-12 animate-spin rounded-full border-b-4 border-slate-900"></div>
                        <h2 className="text-xl font-semibold text-slate-800">Loading Inference Engine</h2>
                        <p className="mt-3 max-w-sm text-center text-sm leading-relaxed text-slate-500">
                            Starting local model backend. This may take a moment.
                        </p>
                    </div>
                ) : (
                    <div className="flex h-full flex-col rounded-3xl border border-slate-200 bg-white shadow-sm">
                        <div className="flex-1 overflow-y-auto p-4">
                            {messages.length === 0 && (
                                <div className="flex h-full items-center justify-center text-center text-slate-400">
                                    <p>Attach an image and ask a question to extract data.</p>
                                </div>
                            )}

                            <div className="flex flex-col gap-4">
                                {messages.map((msg) => (
                                    <div key={msg.id} className={`max-w-[85%] rounded-2xl p-4 ${msg.role === "user" ? "self-end rounded-br-sm bg-slate-900 text-white shadow-md" : "self-start rounded-bl-sm border border-slate-200 bg-slate-100 text-slate-800 shadow-sm"}`}>

                                        {msg.attachments && msg.attachments.length > 0 && (
                                            <div className="mb-3 flex flex-wrap gap-2">
                                                {msg.attachments.map((att, i) => (
                                                    <div key={i} className={`flex items-center gap-2 rounded px-3 py-1.5 text-xs ${msg.role === "user" ? "bg-white/15" : "border border-slate-300 bg-white"}`}>
                                                        <svg className="h-4 w-4 opacity-75" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                                                        <span className="max-w-37.5 truncate font-medium">{att.name}</span>
                                                        <span className="ml-1 text-[10px] uppercase opacity-75">IMAGE</span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}

                                        {msg.role === "assistant" && msg.thinking ? (
                                            <details open={msg.isThinkingOpen ?? false} className="mb-3 rounded-xl border border-slate-200 bg-white/70 px-3 py-2">
                                                <summary className="cursor-pointer list-none text-sm font-medium text-slate-600">Thinking</summary>
                                                <div className="mt-2 text-sm text-slate-500">
                                                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                                                        {msg.thinking}
                                                    </ReactMarkdown>
                                                </div>
                                            </details>
                                        ) : null}

                                        {msg.content ? (
                                            <div className="leading-relaxed text-slate-800">
                                                {msg.role === "assistant" ? (
                                                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                                                        {msg.content}
                                                    </ReactMarkdown>
                                                ) : (
                                                    <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                                                )}
                                            </div>
                                        ) : msg.isStreaming && msg.role === "assistant" && !msg.thinking ? (
                                            <p className="whitespace-pre-wrap leading-relaxed text-slate-500">Thinking...</p>
                                        ) : null}
                                    </div>
                                ))}
                                <div ref={messagesEndRef} />
                            </div>
                        </div>

                        <form className="relative flex flex-col gap-2 border-t border-slate-200 p-4" onSubmit={handleSend}>

                            {pendingAttachment && (
                                <div className="absolute bottom-full left-4 right-4 mb-3 flex items-center gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3 shadow-sm transition-all">
                                    <div className="rounded-md bg-slate-200 p-2 text-slate-700">
                                        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                                    </div>
                                    <div className="flex-1 overflow-hidden">
                                        <p className="truncate text-sm font-medium text-slate-800">{pendingAttachment.name}</p>
                                        <p className="truncate text-xs text-slate-500">{pendingAttachment.type || "Unknown type"}</p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={removePendingAttachment}
                                        className="rounded-full p-1.5 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500"
                                    >
                                        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                    </button>
                                </div>
                            )}

                            <div className="flex items-center gap-2">
                                <input
                                    type="file"
                                    ref={fileInputRef}
                                    onChange={handleFileChange}
                                    accept="image/*"
                                    className="hidden"
                                />
                                <button
                                    type="button"
                                    onClick={() => fileInputRef.current?.click()}
                                    disabled={isLoading}
                                    className="rounded-xl border border-transparent p-3 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 disabled:opacity-50"
                                    title="Attach Image"
                                >
                                    <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                                </button>

                                <input
                                    className="flex-1 rounded-xl border border-slate-300 bg-white p-3.5 text-slate-900 shadow-sm transition-all focus:outline-none focus:ring-2 focus:ring-slate-900"
                                    value={input}
                                    onChange={(e) => setInput(e.target.value)}
                                    placeholder="Ask about the attached image..."
                                    disabled={isLoading}
                                />

                                <button
                                    className="rounded-xl bg-slate-900 px-6 py-3.5 font-medium text-white shadow-sm transition-all hover:bg-slate-800 disabled:opacity-50"
                                    type="submit"
                                    disabled={isLoading || (!input.trim() && !pendingAttachment)}
                                >
                                    Send
                                </button>
                            </div>
                        </form>
                    </div>
                )}
            </div>
        </main>
    );
}

export default App;
