import { useEffect, useState } from 'react';
import { Command } from '@tauri-apps/plugin-shell';
import { resolveResource } from '@tauri-apps/api/path';

export default function App() {
  const [input, setInput] = useState('');
  const [image, setImage] = useState(null);
  const [response, setResponse] = useState('');
  const [serverReady, setServerReady] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);

  // Convert uploaded image to Base64 for the API
  const handleImageChange = (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => setImage(reader.result);
      reader.readAsDataURL(file);
    } else {
      setImage(null);
    }
  };

  useEffect(() => {
    let childProcess = null;

    async function startEngine() {
      try {
        // 1. Get the absolute path to the bundled model on the user's OS
        const modelPath = await resolveResource('models/Qwen3.5-4B-Q4_K_M.gguf');
        
// NOTE: 
// On an 8GB Mac, you MUST use a smaller model file (like Qwen 0.5B or a Q4_K_M quantization of Gemma 2B).
// The 8.2GB Q8_0 model physically cannot fit into 8GB of RAM.
        
        const mmprojPath = await resolveResource('models/mmproj-F16.gguf');
        
        // 2. Spawn the sidecar with strictly imposed memory and CPU throttles
        const command = Command.sidecar('binaries/llama-server', [
          '-m', modelPath,
          '--mmproj', mmprojPath,
          // Expand the context window to support the large number of tokens an image represents
          '-c', '6144',       
          '-b', '256',        // Lower logical batch size to reduce peak prompt memory
          '-np', '1',         // Force exactly ONE server slot (disables parallel inferencing RAM duplication)
          '-ctk', 'q8_0',     // 8-bit quantize the Key cache context
          '-ctv', 'q8_0',     // 8-bit quantize the Value cache context
          '--threads', '2',   // Hard cap CPU threads to prevent system freezing
          '--port', '8082'    // Use 8082 to avoid conflicts
        ]);

        childProcess = await command.spawn();
        
        command.on('close', data => {
          console.log(`command finished with code ${data.code} and signal ${data.signal}`);
        });
        command.on('error', error => { console.error(`command error: ${error}`); setResponse(`Engine error: ${error}`); });
        command.stdout.on('data', line => console.log(`command stdout: "${line}"`));
        command.stderr.on('data', line => { console.error(`command stderr: ${line}`); if (line.toLowerCase().includes('error')) setResponse(`Engine stderr: ${line}`); });
        
        // Poll the server until the model is fully loaded into RAM
        const checkHealth = setInterval(async () => {
          try {
            const res = await fetch('http://127.0.0.1:8082/health');
            const data = await res.json();
            if (res.ok && data.status === "ok") {
              setServerReady(true);
              clearInterval(checkHealth);
            }
          } catch (e) {
            // Still loading or couldn't connect yet
          }
        }, 1000);
      } catch (error) {
        console.error("Failed to start llama-server:", error);
        setResponse(`Failed to start llama-server engine: ${error.message || error}`);
      }
    }

    startEngine();

    // 3. Clean up the sidecar when the app closes
    return () => {
      if (childProcess) childProcess.kill();
    };
  }, []);

  const handleExtract = async () => {
    if (!serverReady || isProcessing) return;
    
    setIsProcessing(true);
    setResponse('Waking up AI engine... (This may take a moment to begin formulating thoughts)');

    try {
      // Structure the payload for standard text OR multi-modal visual inputs
      let messageContent = input ? `Extract the data from this: ${input}` : "Extract the table from this image into a markdown table.";
      
      if (image) {
        messageContent = [
          { type: 'text', text: input ? `Context: ${input}\n\nExtract the table from this image into a markdown table.` : 'Extract the table from this image into a markdown table.' },
          { type: 'image_url', image_url: { url: image } }
        ];
      }

      // 4. Interface with the local server using streaming
      const res = await fetch('http://127.0.0.1:8082/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: messageContent }],
          temperature: 0.1, // Keep it low for extraction tasks
          stream: true      // Request a streaming response to view output in real-time
        })
      });

      if (!res.ok) {
        const data = await res.json();
        setResponse(`Error: ${data.error?.message || res.statusText}`);
        setIsProcessing(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let accumulatedResponse = '';
      let isFirstToken = true;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n');
        
        for (const line of lines) {
          if (line.startsWith('data: ') && !line.includes('[DONE]')) {
            try {
              const parsed = JSON.parse(line.slice(6));
              const token = parsed.choices[0]?.delta?.content || '';
              if (token) {
                if (isFirstToken) {
                  isFirstToken = false;
                  accumulatedResponse = ''; // Clear loading message on first received token
                }
                accumulatedResponse += token;
                setResponse(accumulatedResponse);
              }
            } catch (e) {
              console.error('Stream parse error', e);
            }
          }
        }
      }
    } catch (error) {
      setResponse(`Error connecting to AI engine: ${error.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <input 
          type="file" 
          accept="image/*" 
          onChange={handleImageChange} 
          style={{ width: '100%' }}
        />
        {image && (
          <img 
            src={image} 
            alt="Upload Preview" 
            style={{ marginTop: 10, maxHeight: 150, borderRadius: 8, display: 'block' }} 
          />
        )}
      </div>
      <textarea
        value={input}
        onChange={(e) => setInput(e.target.value)} 
        placeholder="Paste raw vendor data or provide image context here..."
        rows={5}
        style={{ width: '100%', marginBottom: 10 }}
      />
      <button onClick={handleExtract} disabled={!serverReady || isProcessing}>
        {!serverReady ? 'Loading AI Engine...' : isProcessing ? 'Extracting Data...' : 'Process Locally'}
      </button>
      <pre style={{ marginTop: 20, whiteSpace: 'pre-wrap', backgroundColor: '#f1f1f1', padding: '15px', borderRadius: '8px', minHeight: '50px' }}>
        {response || 'AI Response will appear here...'}
      </pre>
    </div>
  );
}