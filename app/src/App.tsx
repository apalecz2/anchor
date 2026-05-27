import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { resolveResource } from "@tauri-apps/api/path";
import "./App.css";

type TraceSeverity = "info" | "progress" | "success" | "error";

type TraceItem = {
  id: number;
  message: string;
  detail?: string;
  severity: TraceSeverity;
};

const stripThinkBlocks = (content: string) => content.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/g, "").trim();

const parseThinkBlocks = (content: string) => {
  const thinkingBlocks = Array.from(content.matchAll(/<think>([\s\S]*?)(?:<\/think>|$)/g), match => match[1].trim()).filter(Boolean);

  return {
    visibleContent: stripThinkBlocks(content),
    thinking: thinkingBlocks.join("\n").trim(),
    hasThinking: thinkingBlocks.length > 0,
    isThinkingOpen: /<think>[\s\S]*$/.test(content) && !/<\/think>\s*$/.test(content),
  };
};

const getPlatformKey = () => {
  const platform = navigator.platform.toLowerCase();

  if (platform.includes("win")) {
    return "windows";
  }

  if (platform.includes("mac")) {
    return "macos";
  }

  if (platform.includes("linux")) {
    return "linux";
  }

  return "unknown";
};

const getLlamaServerResourceCandidates = () => {
  switch (getPlatformKey()) {
    case "windows":
      return [
        "binaries/windows/llama-server.exe",
        "binaries/llama-server.exe",
      ];
    case "macos":
      return [
        "binaries/macos/llama-server-aarch64-apple-darwin",
        "binaries/llama-server-aarch64-apple-darwin",
      ];
    case "linux":
      return [
        "binaries/linux/llama-server",
        "binaries/llama-server",
      ];
    default:
      return ["binaries/llama-server"];
  }
};

// Helper function to format message content
const MessageContent = ({ content, thinking, isStreaming }: { content: string, thinking?: string, isStreaming?: boolean }) => {
  const parsedContent = parseThinkBlocks(content);
  const visibleContent = parsedContent.visibleContent;
  const thinkingContent = thinking ?? parsedContent.thinking;
  const showThinkingBlock = Boolean(thinkingContent) || Boolean(isStreaming);
  const showVisiblePlaceholder = !visibleContent && !thinkingContent && !isStreaming;

  return (
    <div className="flex flex-col">
      {showThinkingBlock && (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-amber-950 shadow-inner shadow-amber-100/40">
          <div className="flex items-center justify-between gap-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-amber-800">
            <span>Thinking</span>
            {isStreaming && <span className="rounded-full bg-amber-200/80 px-2 py-0.5 text-[10px] tracking-[0.18em] text-amber-900">Live</span>}
          </div>
          <pre className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-amber-950/90">
            {thinkingContent || "Thinking..."}
          </pre>
        </div>
      )}
      {visibleContent ? (
        <p className="whitespace-pre-wrap leading-relaxed">{visibleContent}</p>
      ) : showVisiblePlaceholder ? (
        <p className="whitespace-pre-wrap leading-relaxed">[No visible response text]</p>
      ) : null}
    </div>
  );
};

// Represents a file attached to a specific message or pending to be attached
type FileAttachment = {
  name: string;
  type: string;
  data: string; // base64 string
};

type AppMessage = {
  id: number;
  role: 'user'|'model';
  content: string;
  thinking?: string;
  isStreaming?: boolean;
  attachments?: FileAttachment[];
};

function App() {
  const [isServerReady, setIsServerReady] = useState(false);
  const [messages, setMessages] = useState<AppMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<FileAttachment | null>(null);
  const [systemTrace, setSystemTrace] = useState<TraceItem[]>([]);
  const [requestTrace, setRequestTrace] = useState<TraceItem[]>([]);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const traceCounterRef = useRef(0);
  const messageCounterRef = useRef(0);
  const serverReadyLoggedRef = useRef(false);

  const allocateMessageId = () => {
    messageCounterRef.current += 1;
    return messageCounterRef.current;
  };

  const pushTrace = (target: "system" | "request", message: string, severity: TraceSeverity = "info", detail?: string) => {
    const item = {
      id: traceCounterRef.current + 1,
      message,
      detail,
      severity,
    };

    traceCounterRef.current += 1;
    if (target === "system") {
      setSystemTrace(prev => [...prev.slice(-5), item]);
    } else {
      setRequestTrace(prev => [...prev.slice(-7), item]);
    }
  };

  useEffect(() => {
    let healthCheckInterval: ReturnType<typeof setInterval>;
    
    const startLlamaServer = async () => {
      try {
        const llamaServerCandidates = getLlamaServerResourceCandidates();
        const llamaServerPath = await invoke<string>("resolve_llama_server_path");

        const modelPath = await resolveResource('models/Qwen3.5-4B-Q4_K_M.gguf');
        const mmprojPath = await resolveResource('models/mmproj-F16.gguf');
        
        console.log("Resolved model absolute path:", modelPath);
        console.log("Resolved mmproj absolute path:", mmprojPath);
        console.log("Using llama-server command:", llamaServerPath);
        console.log("Llama server path candidates:", llamaServerCandidates);
        pushTrace("system", "Resolved local model resources", "info", `${modelPath} | ${mmprojPath}`);
        pushTrace("system", "Launching local multimodal server", "progress", llamaServerPath);

        const pid = await invoke<number>("start_llama_server", {
          modelPath,
          mmprojPath,
          llamaServerPath,
        });

        console.log("Llama server spawned with PID: ", pid);
        pushTrace("system", "Local server process spawned", "success", `PID ${pid}`);
      } catch (err) {
        console.error("Failed to spawn llama server:", err);
        pushTrace("system", "Failed to start local server", "error", String(err));
      }
    };

    const checkServerHealth = async () => {
      try {
        const response = await fetch('http://127.0.0.1:8080/health');
        return response.status === 200;
      } catch (error) {
        return false;
      }
    };
    
    // Bug: Called twice, also no cleanup
    startLlamaServer();

    healthCheckInterval = setInterval(async () => {
      const isHealthy = await checkServerHealth();
      setIsServerReady(isHealthy);
      if (isHealthy && !serverReadyLoggedRef.current) {
        pushTrace("system", "Local inference backend is ready", "success", "Health check returned 200");
        serverReadyLoggedRef.current = true;
      }
      if (!isHealthy) {
        serverReadyLoggedRef.current = false;
      }
    }, 2000);

    return () => {
      clearInterval(healthCheckInterval);
    };
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const dataUrl = event.target?.result as string;
      // Extract just the base64 part
      const base64Data = dataUrl.split(',')[1];
      
      setPendingAttachment({
        name: file.name,
        type: file.type || "application/octet-stream",
        data: base64Data
      });

      pushTrace(
        "system",
        file.type.startsWith("image/") ? "Prepared image attachment" : "Prepared document attachment",
        "info",
        `${file.name} · ${file.type || "unknown type"}`
      );
    };
    reader.readAsDataURL(file);
    
    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleSend = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!input.trim() && !pendingAttachment) || !isServerReady || isLoading) return;

    const userMsg = input.trim();
    const currentAttachment = pendingAttachment;
    const userMessageId = allocateMessageId();
    const assistantMessageId = allocateMessageId();

    setRequestTrace([]);
    pushTrace("request", "Building request payload", "progress", "Combining conversation history and the new turn");
    
    setInput("");
    setPendingAttachment(null);
    setMessages(prev => [...prev, { 
      id: userMessageId,
      role: 'user', 
      content: userMsg,
      attachments: currentAttachment ? [currentAttachment] : undefined
    }, {
      id: assistantMessageId,
      role: 'model',
      content: '',
      thinking: '',
      isStreaming: true,
    }]);
    
    setIsLoading(true);

    const apiMessages: any[] = [];
    const allMessagesList = [...messages, { id: userMessageId, role: 'user', content: userMsg, attachments: currentAttachment ? [currentAttachment] : undefined }];
    const hasImageAttachment = Boolean(currentAttachment && currentAttachment.type.startsWith("image/"));

    if (currentAttachment) {
      pushTrace(
        "request",
        hasImageAttachment ? "Image attachment queued for multimodal analysis" : "File attachment will be embedded as text",
        "info",
        `${currentAttachment.name} · ${currentAttachment.type}`
      );
    }
    
    allMessagesList.forEach(msg => {
      let contentArray: any[] = [];
      
      if (msg.attachments && msg.attachments.length > 0) {
        msg.attachments.forEach(att => {
          if (att.type.startsWith('image/')) {
            contentArray.push({
              type: "image_url",
              image_url: {
                url: `data:${att.type};base64,${att.data}`
              }
            });
          } else {
            try {
              const textContent = atob(att.data);
              contentArray.push({
                type: "text",
                text: `[Attached File: ${att.name}]\n\`\`\`\n${textContent}\n\`\`\`\n`
              });
            } catch (e) {
              contentArray.push({
                type: "text",
                text: `[Error decoding attached file: ${att.name}]\n`
              });
            }
          }
        });
      }
      
      if (msg.content) {
        contentArray.push({
          type: "text",
          text: msg.content
        });
      }

      apiMessages.push({
        role: msg.role === 'model' ? 'assistant' : 'user',
        content: contentArray.length === 1 && contentArray[0].type === 'text' ? contentArray[0].text : contentArray
      });
    });

    const requestBody = {
      messages: apiMessages,
      max_tokens: 1024,
      temperature: 0.7,
      stream: true,
      stop: ["<|im_start|>", "<|im_end|>"]
    };

    pushTrace(
      "request",
      "Sending chat completion request",
      "progress",
      `${apiMessages.length} message(s), ${currentAttachment ? 1 : 0} attachment(s), stream=true`
    );

    try {
      const response = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });

      if (response.ok) {
        const reader = response.body?.getReader();

        if (!reader) {
          throw new Error('Streaming response body is unavailable.');
        }

        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let rawAssistantContent = '';
        let sawModelToken = false;

        const updateStreamingMessage = (nextContent: string, nextThinking: string) => {
          setMessages(prev => prev.map(msg => msg.id === assistantMessageId ? {
            ...msg,
            content: nextContent,
            thinking: nextThinking,
            isStreaming: true,
          } : msg));
        };

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) {
              continue;
            }

            const data = line.slice(6).trim();

            if (!data || data === '[DONE]') {
              continue;
            }

            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta ?? {};
              const reasoningToken = delta.reasoning ?? delta.thinking ?? delta.reasoning_content ?? '';
              const contentToken = delta.content ?? '';

              if (reasoningToken) {
                rawAssistantContent += `<think>${reasoningToken}</think>`;
              }

              if (contentToken) {
                rawAssistantContent += contentToken;
              }

              if (reasoningToken || contentToken) {
                const parsedAssistantContent = parseThinkBlocks(rawAssistantContent);
                updateStreamingMessage(parsedAssistantContent.visibleContent, parsedAssistantContent.thinking);
                sawModelToken = true;
              }
            } catch (streamError) {
              console.error('Stream parse error:', streamError, data);
            }
          }
        }

        const finalAssistantContent = parseThinkBlocks(rawAssistantContent);
        setMessages(prev => prev.map(msg => msg.id === assistantMessageId ? {
          ...msg,
          content: finalAssistantContent.visibleContent,
          thinking: finalAssistantContent.thinking,
          isStreaming: false,
        } : msg));

        if (sawModelToken) {
          pushTrace("request", "Received model response stream", "success", `HTTP ${response.status}`);
        } else {
          pushTrace("request", "Model response stream completed", "success", `HTTP ${response.status}`);
        }
      } else {
        console.error('Server returned an error:', response.statusText);
        pushTrace("request", "Model request failed", "error", `HTTP ${response.status} ${response.statusText}`);
        setMessages(prev => prev.map(msg => msg.id === assistantMessageId ? {
          ...msg,
          content: 'Error: Failed to fetch response.',
          thinking: '',
          isStreaming: false,
        } : msg));
      }
    } catch (error) {
      console.error('Request failed:', error);
      pushTrace("request", "Request exception", "error", String(error));
      setMessages(prev => prev.map(msg => msg.id === assistantMessageId ? {
        ...msg,
        content: 'Error: Request failed.',
        thinking: '',
        isStreaming: false,
      } : msg));
    } finally {
      setIsLoading(false);
    }
  };

  const removePendingAttachment = () => {
    setPendingAttachment(null);
  }

  return (
    <main className="flex flex-col h-screen max-h-screen bg-gray-50 p-4 font-sans text-gray-900">
      <h1 className="text-2xl font-bold text-center text-gray-800 mb-2 tracking-tight">Local Data Extraction AI</h1>

      <div className="mb-3 grid gap-3 lg:grid-cols-2">
        <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600">Live system trace</h2>
            <span className={`text-xs font-medium px-2.5 py-1 rounded-full border ${isServerReady ? 'bg-green-50 text-green-700 border-green-200' : 'bg-amber-50 text-amber-700 border-amber-200'}`}>
              {isServerReady ? 'Ready' : 'Starting'}
            </span>
          </div>
          <div className="mt-3 space-y-2 text-sm">
            {systemTrace.length === 0 ? (
              <p className="text-gray-400">Waiting for server startup and resource loading events.</p>
            ) : systemTrace.map(item => (
              <div key={item.id} className="flex gap-3 rounded-lg bg-gray-50 px-3 py-2 border border-gray-100">
                <span className={`mt-0.5 h-2.5 w-2.5 rounded-full flex-none ${item.severity === 'success' ? 'bg-green-500' : item.severity === 'error' ? 'bg-red-500' : item.severity === 'progress' ? 'bg-blue-500' : 'bg-gray-400'}`} />
                <div className="min-w-0">
                  <p className="font-medium text-gray-800">{item.message}</p>
                  {item.detail && <p className="text-xs text-gray-500 mt-0.5 truncate">{item.detail}</p>}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-600">Current analysis trace</h2>
            <span className={`text-xs font-medium px-2.5 py-1 rounded-full border ${isLoading ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-gray-50 text-gray-600 border-gray-200'}`}>
              {isLoading ? 'Running' : 'Idle'}
            </span>
          </div>
          <div className="mt-3 space-y-2 text-sm">
            {requestTrace.length === 0 ? (
              <p className="text-gray-400">Send a prompt or attach an image to see request assembly and photo-analysis steps.</p>
            ) : requestTrace.map(item => (
              <div key={item.id} className="flex gap-3 rounded-lg bg-gray-50 px-3 py-2 border border-gray-100">
                <span className={`mt-0.5 h-2.5 w-2.5 rounded-full flex-none ${item.severity === 'success' ? 'bg-green-500' : item.severity === 'error' ? 'bg-red-500' : item.severity === 'progress' ? 'bg-blue-500' : 'bg-gray-400'}`} />
                <div className="min-w-0">
                  <p className="font-medium text-gray-800">{item.message}</p>
                  {item.detail && <p className="text-xs text-gray-500 mt-0.5 truncate">{item.detail}</p>}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-gray-500 leading-relaxed">
            The app surfaces transparent request steps and image handling metadata. It does not expose hidden model chain-of-thought.
          </p>
        </section>
      </div>

      {!isServerReady ? (
        <div className="flex-1 flex flex-col items-center justify-center bg-white rounded-xl shadow-sm border border-gray-200">
          <div className="animate-spin rounded-full h-12 w-12 border-b-4 border-blue-600 mb-6"></div>
          <h2 className="text-xl font-semibold text-gray-800">Loading Inference Engine</h2>
          <p className="text-gray-500 text-sm mt-3 max-w-sm text-center leading-relaxed">
            Starting llama.cpp and allocating model weights to system memory. This may take a few moments depending on your hardware limits.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-2 text-center text-sm">
            <span className="px-4 py-1.5 rounded-full text-green-700 bg-green-100 font-medium border border-green-200 shadow-sm">
              Backend Ready
            </span>
          </div>

          <div className="flex-1 overflow-y-auto bg-white rounded-xl shadow-sm p-4 mb-4 flex flex-col gap-6 border border-gray-200">
            {messages.length === 0 && (
              <div className="text-gray-400 text-center mt-auto mb-auto">
                <p>Welcome! Attach a document or image, or type a message to begin.</p>
              </div>
            )}
            
            {messages.map((msg) => (
              <div key={msg.id} className={`p-4 rounded-2xl max-w-[85%] ${msg.role === 'user' ? 'bg-blue-600 text-white self-end rounded-br-sm shadow-md' : 'bg-gray-100 text-gray-800 self-start rounded-bl-sm shadow-sm border border-gray-200'}`}>
                
                {/* Render Attachments in History */}
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-2">
                    {msg.attachments.map((att, i) => (
                      <div key={i} className={`text-xs px-3 py-1.5 rounded flex items-center gap-2 ${msg.role === 'user' ? 'bg-white/20' : 'bg-white border border-gray-300'}`}>
                        <svg className="w-4 h-4 opacity-75" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                        <span className="truncate max-w-37.5 font-medium">{att.name}</span>
                        {att.type.startsWith('image/') && (
                          <span className="text-[10px] uppercase opacity-75 ml-1">IMAGE</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                
                {msg.role === 'model' ? (
                  <MessageContent content={msg.content} thinking={msg.thinking} isStreaming={msg.isStreaming} />
                ) : msg.content ? (
                  <MessageContent content={msg.content} />
                ) : null}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>

          <form className="flex flex-col gap-2 relative" onSubmit={handleSend}>
            
            {/* Pending Attachment Preview */}
            {pendingAttachment && (
              <div className="flex items-center gap-3 p-3 bg-blue-50 border border-blue-100 rounded-lg absolute bottom-[110%] left-0 right-0 shadow-sm transition-all">
                <div className="p-2 bg-blue-100 rounded-md text-blue-600">
                   <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                </div>
                <div className="flex-1 overflow-hidden">
                  <p className="text-sm font-medium text-gray-800 truncate">{pendingAttachment.name}</p>
                  <p className="text-xs text-gray-500 truncate">{pendingAttachment.type || 'Unknown type'}</p>
                </div>
                <button 
                  type="button"
                  onClick={removePendingAttachment}
                  className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded-full transition-colors"
                >
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
            )}

            <div className="flex gap-2 items-center">
              <input 
                type="file" 
                ref={fileInputRef}
                onChange={handleFileChange}
                className="hidden" 
              />
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={isLoading}
                className="p-3 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded-xl transition-colors disabled:opacity-50 border border-transparent"
                title="Attach Document or Image"
              >
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
              </button>
              
              <input
                className="flex-1 p-3.5 rounded-xl border border-gray-300 shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-black transition-all bg-white"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask something about your data..."
                disabled={isLoading}
              />
              
              <button 
                className="px-6 py-3.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 font-medium shadow-sm transition-all"
                type="submit" 
                disabled={isLoading || (!input.trim() && !pendingAttachment)}
              >
                Send
              </button>
            </div>
          </form>
        </>
      )}
    </main>
  );
}

export default App;
