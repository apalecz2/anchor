import { useState, useEffect, useRef } from "react";
import { Command } from "@tauri-apps/plugin-shell";
import { resolveResource } from "@tauri-apps/api/path";
import "./App.css";

// Helper function to format message content
const MessageContent = ({ content, isModel }: { content: string, isModel?: boolean }) => {
  let formattedContent;
  // Check if content contains <think> block
  if (!content.includes('<think>')) {
    formattedContent = <p className="whitespace-pre-wrap leading-relaxed">{content}</p>;
  } else {
    // Very basic parser for <think>...</think>
    const parts = content.split(/(<think>[\s\S]*?<\/think>)/g);
    
    formattedContent = (
      <>
        {parts.map((part, i) => {
          if (part.startsWith('<think>') && part.endsWith('</think>')) {
            const innerContent = part.substring(7, part.length - 8).trim();
            return (
              <details key={i} className="mb-2">
                <summary className="cursor-pointer text-sm text-gray-500 font-medium select-none">Model Thoughts</summary>
                <div className="mt-1 p-2 bg-gray-300/50 rounded text-sm italic text-gray-700 whitespace-pre-wrap border-l-2 border-gray-400">
                  {innerContent}
                </div>
              </details>
            );
          }
          // Normal text
          return part.trim() ? <p key={i} className="whitespace-pre-wrap mb-2 last:mb-0 leading-relaxed">{part.trim()}</p> : null;
        })}
      </>
    );
  }

  return (
    <div className="flex flex-col">
      <div>{formattedContent}</div>
      {isModel && (
        <details className="mt-3 opacity-60 hover:opacity-100 transition-opacity border-t border-gray-400/30 pt-2">
          <summary className="cursor-pointer text-xs font-mono select-none">Raw LLM Output</summary>
          <pre className="mt-2 p-3 bg-gray-900 text-gray-100 rounded-md text-xs font-mono whitespace-pre-wrap overflow-x-auto shadow-inner">
            {content}
          </pre>
        </details>
      )}
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
  role: 'user'|'model';
  content: string;
  attachments?: FileAttachment[];
};

function App() {
  const [isServerReady, setIsServerReady] = useState(false);
  const [messages, setMessages] = useState<AppMessage[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<FileAttachment | null>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let healthCheckInterval: ReturnType<typeof setInterval>;
    let childProcess: any = null;
    
    const startLlamaServer = async () => {
      try {
        const modelPath = await resolveResource('models/Qwen3.5-4B-Q4_K_M.gguf');
        const mmprojPath = await resolveResource('models/mmproj-F16.gguf');
        
        console.log("Resolved model absolute path:", modelPath);
        console.log("Resolved mmproj absolute path:", mmprojPath);

        const command = Command.sidecar('binaries/llama-server', [
          '-m', modelPath,
          '--mmproj', mmprojPath, // Provide multimodal projector for vision understanding
          '--port', '8080',
          '-c', '4096' // Increased context window slightly for files/images
        ]);
        
        command.on('close', data => console.log(`command finished with code ${data.code}`));
        command.on('error', error => console.error(`command error: "${error}"`));
        command.stdout.on('data', line => console.log(`stdout: "${line}"`));
        command.stderr.on('data', line => console.log(`stderr: "${line}"`));

        childProcess = await command.spawn();
        
        console.log("Llama server spawned with PID: ", childProcess.pid);
      } catch (err) {
        console.error("Failed to spawn llama server:", err);
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
    
    startLlamaServer();

    healthCheckInterval = setInterval(async () => {
      const isHealthy = await checkServerHealth();
      setIsServerReady(isHealthy);
    }, 2000);

    return () => {
      clearInterval(healthCheckInterval);
      if (childProcess) {
        childProcess.kill();
      }
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
    
    setInput("");
    setPendingAttachment(null);
    setMessages(prev => [...prev, { 
      role: 'user', 
      content: userMsg,
      attachments: currentAttachment ? [currentAttachment] : undefined
    }]);
    
    setIsLoading(true);

    const apiMessages: any[] = [];
    const allMessagesList = [...messages, { role: 'user', content: userMsg, attachments: currentAttachment ? [currentAttachment] : undefined }];
    
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
      stream: false,
      stop: ["<|im_start|>", "<|im_end|>"]
    };

    try {
      const response = await fetch('http://127.0.0.1:8080/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(requestBody)
      });

      if (response.ok) {
        const data = await response.json();
        console.log('API Response:', data);
        
        let responseMessage = 'Error: No response generated.';
        if (data.choices && data.choices.length > 0) {
          if (data.choices[0].message && data.choices[0].message.content !== undefined) {
             responseMessage = data.choices[0].message.content;
          }
        }
        
        setMessages(prev => [...prev, { role: 'model', content: responseMessage }]);
      } else {
        console.error('Server returned an error:', response.statusText);
        setMessages(prev => [...prev, { role: 'model', content: 'Error: Failed to fetch response.' }]);
      }
    } catch (error) {
      console.error('Request failed:', error);
      setMessages(prev => [...prev, { role: 'model', content: 'Error: Request failed.' }]);
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
            
            {messages.map((msg, idx) => (
              <div key={idx} className={`p-4 rounded-2xl max-w-[85%] ${msg.role === 'user' ? 'bg-blue-600 text-white self-end rounded-br-sm shadow-md' : 'bg-gray-100 text-gray-800 self-start rounded-bl-sm shadow-sm border border-gray-200'}`}>
                
                {/* Render Attachments in History */}
                {msg.attachments && msg.attachments.length > 0 && (
                  <div className="mb-3 flex flex-wrap gap-2">
                    {msg.attachments.map((att, i) => (
                      <div key={i} className={`text-xs px-3 py-1.5 rounded flex items-center gap-2 ${msg.role === 'user' ? 'bg-white/20' : 'bg-white border border-gray-300'}`}>
                        <svg className="w-4 h-4 opacity-75" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
                        <span className="truncate max-w-[150px] font-medium">{att.name}</span>
                        {att.type.startsWith('image/') && (
                          <span className="text-[10px] uppercase opacity-75 ml-1">IMAGE</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                
                {msg.content && <MessageContent content={msg.content} isModel={msg.role === 'model'} />}
              </div>
            ))}
            
            {isLoading && (
              <div className="p-4 rounded-2xl max-w-[85%] bg-gray-100 text-gray-700 self-start italic shadow-sm border border-gray-200 rounded-bl-sm flex items-center gap-3">
                <div className="animate-pulse flex space-x-1.5">
                  <div className="h-2 w-2 bg-blue-500 rounded-full"></div>
                  <div className="h-2 w-2 bg-blue-500 rounded-full"></div>
                  <div className="h-2 w-2 bg-blue-500 rounded-full"></div>
                </div>
                <span className="text-sm font-medium text-gray-500">Processing...</span>
              </div>
            )}
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
