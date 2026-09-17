import { invoke } from "@tauri-apps/api/core";

/**
 * What remains of the frontend's model client: stopping the server.
 *
 * Starting a server, building a request and streaming a completion all moved to
 * `src-tauri/src/pipeline/` when the executor took over orchestration. They are not
 * kept here for a future caller, because a client that still resolved a port the
 * frontend no longer tracks would look usable and fail at runtime — a worse starting
 * point for the planned chat feature than an empty one. Chat will be built against
 * the Rust client, which already speaks the same endpoint.
 *
 * Unloading stays on this side because the *policy* is a UI concern: how long to
 * keep a model warm after a job is about what the user is likely to do next, which
 * the backend has no view of. See `LlamaChatContext`.
 */
export const stopLlamaServer = async () => {
    try {
        await invoke("stop_llama_server");
    } catch (err) {
        console.error("Failed to stop llama server:", err);
    }
};
