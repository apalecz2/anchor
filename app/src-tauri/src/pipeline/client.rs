//! Chat-completions client for the local `llama-server`.
//!
//! A port of the streaming half of `app/src/features/llama/llamaClient.ts`. The
//! request body is built from a model's catalog [`RequestSpec`] rather than
//! hardcoded, so a model's sampling settings and chat-template quirks travel with
//! the model instead of being baked into the call site.
//!
//! # The offset contract
//!
//! Each token records the character offset at which it starts in the accumulated
//! content, and `confidence.ts` maps those offsets onto TSV cell ranges to score
//! them. Offsets are counted in **UTF-16 code units**, because that is the space
//! the TypeScript consumer indexes in. Emitting Rust's native UTF-8 byte offsets
//! would desynchronise the mapping from the first non-ASCII token onward — and it
//! would not raise an error, it would silently score the wrong cells.
//!
//! # Why the parser is separate from the transport
//!
//! [`SseAccumulator`] is pure: chunks in, tokens and content out. The response
//! shape is the part most likely to shift under a llama.cpp upgrade, and keeping it
//! free of HTTP and Tauri means it can be tested against recorded frames rather
//! than a running server.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use crate::pipeline::catalog::ModelSpec;

/// One generated token and the model's confidence in it.
///
/// Serialized camelCase to match the `TokenLogprob` the frontend's confidence
/// scoring already consumes, so the artifact drops straight into it with no
/// per-token remapping on the way through.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TokenLogprob {
    pub token: String,
    /// `None` when the server reported no logprob for this token. Recorded rather
    /// than defaulted to 0, which would read as probability 1.0 — a confident lie.
    pub logprob: Option<f64>,
    /// Start offset of this token in the accumulated content, in UTF-16 code units.
    pub char_offset: u32,
}

/// One content part of a chat message.
pub enum ContentPart {
    Text(String),
    /// A base64 data URL, e.g. `data:image/png;base64,...`.
    ImageUrl(String),
}

/// Build the `/v1/chat/completions` body for a model.
///
/// Every sampling field comes from the model's catalog entry. Optional fields are
/// omitted rather than sent as null, because llama.cpp treats an absent key and an
/// explicit null differently for `chat_template_kwargs`.
pub fn build_request_body(model: &ModelSpec, parts: Vec<ContentPart>, max_tokens: u32) -> Value {
    let mut messages: Vec<Value> = Vec::new();

    if let Some(system) = model.request.system_prompt {
        messages.push(json!({
            "role": "system",
            "content": crate::pipeline::catalog::prompt_text(system),
        }));
    }

    let content: Vec<Value> = parts
        .into_iter()
        .map(|part| match part {
            ContentPart::Text(text) => json!({ "type": "text", "text": text }),
            ContentPart::ImageUrl(url) => {
                json!({ "type": "image_url", "image_url": { "url": url } })
            }
        })
        .collect();
    messages.push(json!({ "role": "user", "content": content }));

    let mut body = json!({
        "messages": messages,
        "max_tokens": max_tokens,
        "temperature": model.request.temperature,
        "top_p": model.request.top_p,
        "stream": true,
        "logprobs": model.request.logprobs,
        "top_logprobs": model.request.top_logprobs,
    });

    let map = body.as_object_mut().expect("body is an object");
    if let Some(top_k) = model.request.top_k {
        map.insert("top_k".into(), json!(top_k));
    }
    if let Some(penalty) = model.request.presence_penalty {
        map.insert("presence_penalty".into(), json!(penalty));
    }
    if !model.request.stop.is_empty() {
        map.insert("stop".into(), json!(model.request.stop));
    }
    if let Some(enable_thinking) = model.request.enable_thinking {
        map.insert(
            "chat_template_kwargs".into(),
            json!({ "enable_thinking": enable_thinking }),
        );
    }

    body
}

/// Accumulates a server-sent-event stream into content plus per-token logprobs.
///
/// Mirrors the frontend parser, including its fallbacks: a delta carrying no
/// logprobs still contributes its visible text with a `None` logprob, so the
/// "server stopped reporting logprobs" case degrades the heatmap instead of losing
/// the table.
#[derive(Default)]
pub struct SseAccumulator {
    /// Bytes of a line not yet terminated by a newline.
    partial: String,
    content: String,
    logprobs: Vec<TokenLogprob>,
    char_offset: u32,
    finish_reason: Option<String>,
    saw_usable_logprob: bool,
}

impl SseAccumulator {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed one chunk of the response body. Returns the text appended by this chunk,
    /// so the caller can forward it as a delta without re-sending the whole content.
    pub fn push_chunk(&mut self, chunk: &str) -> String {
        self.partial.push_str(chunk);

        // Split on newlines, keeping any unterminated remainder for the next chunk.
        let mut lines: Vec<String> = self
            .partial
            .split('\n')
            .map(|l| l.trim_end_matches('\r').to_owned())
            .collect();
        self.partial = lines.pop().unwrap_or_default();

        let before = self.content.len();
        for line in lines {
            self.push_line(&line);
        }
        self.content[before..].to_owned()
    }

    fn push_line(&mut self, line: &str) {
        let Some(data) = line.strip_prefix("data: ") else {
            return;
        };
        let data = data.trim();
        if data.is_empty() || data == "[DONE]" {
            return;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(data) else {
            // A malformed frame is skipped rather than aborting the stream, matching
            // the frontend: one bad line should not discard a table.
            return;
        };
        let Some(choice) = parsed.get("choices").and_then(|c| c.get(0)) else {
            return;
        };

        // The terminating chunk carries finish_reason ("stop" | "length" | ...) on a
        // choice whose delta is usually empty — capture it regardless.
        if let Some(reason) = choice.get("finish_reason").and_then(Value::as_str) {
            self.finish_reason = Some(reason.to_owned());
        }

        // A single delta can carry several tokens, each with its own logprob, so the
        // whole array is walked rather than just its first entry.
        let entries = choice
            .get("logprobs")
            .and_then(|l| l.get("content"))
            .and_then(Value::as_array);

        match entries {
            Some(entries) if !entries.is_empty() => {
                for entry in entries {
                    let token = entry.get("token").and_then(Value::as_str).unwrap_or("");
                    if token.is_empty() {
                        continue;
                    }
                    let logprob = entry.get("logprob").and_then(Value::as_f64);
                    if logprob.is_some() {
                        self.saw_usable_logprob = true;
                    }
                    self.append(token, logprob);
                }
            }
            _ => {
                // No logprobs for this delta. Still surface the visible text,
                // recording a null logprob so scoring excludes rather than trusts it.
                let token = choice
                    .get("delta")
                    .and_then(|d| d.get("content"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !token.is_empty() {
                    self.append(token, None);
                }
            }
        }
    }

    fn append(&mut self, token: &str, logprob: Option<f64>) {
        self.logprobs.push(TokenLogprob {
            token: token.to_owned(),
            logprob,
            char_offset: self.char_offset,
        });
        // UTF-16 units: the offset space the TypeScript consumer indexes in.
        self.char_offset += token.encode_utf16().count() as u32;
        self.content.push_str(token);
    }

    pub fn content(&self) -> &str {
        &self.content
    }

    /// True when content arrived but not one token carried a usable logprob — the
    /// server's logprobs contract no longer matches what confidence scoring expects.
    /// Surfaced loudly because the symptom is otherwise just an all-grey heatmap.
    pub fn logprobs_missing(&self) -> bool {
        !self.content.is_empty() && !self.saw_usable_logprob
    }

    pub fn finish(self) -> CompletionResult {
        CompletionResult {
            content: self.content,
            logprobs: self.logprobs,
            finish_reason: self.finish_reason,
        }
    }
}

#[derive(Serialize, Debug, Clone)]
pub struct CompletionResult {
    pub content: String,
    pub logprobs: Vec<TokenLogprob>,
    pub finish_reason: Option<String>,
}

/// Message shown when a run is cancelled. The executor surfaces it as a neutral
/// state rather than a failure, so it is a single spelling both sides agree on.
pub const CANCELLED_MESSAGE: &str = "Extraction was cancelled.";

/// How long to wait for the next chunk before treating the stream as stalled. A
/// loaded model can be slow to emit its first token, so this is generous.
const STREAM_STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

/// Stream a completion, forwarding text deltas to `on_delta`.
///
/// Cancellation races the read rather than being polled between chunks: one step is
/// a single long await, and dropping the response is what actually aborts the HTTP
/// request mid-token.
pub async fn stream_completion(
    base_url: &str,
    body: Value,
    token: &CancellationToken,
    mut on_delta: impl FnMut(&str),
) -> Result<CompletionResult, String> {
    let client = reqwest::Client::new();
    // Serialized here rather than via `.json()`: reqwest is built with
    // `default-features = false` for a smaller binary, so its json helper is absent.
    let request = client
        .post(format!("{base_url}/v1/chat/completions"))
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send();

    let mut response = tokio::select! {
        biased;
        _ = token.cancelled() => return Err(CANCELLED_MESSAGE.into()),
        result = request => result.map_err(|e| format!("request to the model server failed: {e}"))?,
    };

    if !response.status().is_success() {
        return Err(format!(
            "model server returned HTTP {}",
            response.status().as_u16()
        ));
    }

    let mut accumulator = SseAccumulator::new();
    loop {
        let next = tokio::select! {
            biased;
            _ = token.cancelled() => return Err(CANCELLED_MESSAGE.into()),
            chunk = tokio::time::timeout(STREAM_STALL_TIMEOUT, response.chunk()) => chunk,
        };

        match next {
            Ok(Ok(Some(bytes))) => {
                let text = String::from_utf8_lossy(&bytes);
                let delta = accumulator.push_chunk(&text);
                if !delta.is_empty() {
                    on_delta(&delta);
                }
            }
            Ok(Ok(None)) => break,
            Ok(Err(e)) => return Err(format!("model stream error: {e}")),
            Err(_) => return Err("the model server stopped responding".into()),
        }
    }

    if accumulator.logprobs_missing() {
        eprintln!(
            "[anchor] llama-server returned no usable token logprobs — confidence scoring \
             will be degraded. Verify the pinned llama.cpp build's logprobs response shape."
        );
    }

    Ok(accumulator.finish())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pipeline::catalog::QWEN_3_5_4B;

    fn frame(json: &str) -> String {
        format!("data: {json}\n")
    }

    // ---- request body ----

    /// The body must reproduce what `extractTableFromImage` sends today, field for
    /// field — this is the contract the current extraction quality rests on.
    #[test]
    fn qwen_body_matches_the_frontend_request() {
        let body = build_request_body(
            &QWEN_3_5_4B,
            vec![
                ContentPart::ImageUrl("data:image/png;base64,AAAA".into()),
                ContentPart::Text("prompt".into()),
            ],
            1234,
        );

        assert_eq!(body["max_tokens"], 1234);
        assert_eq!(body["temperature"], 0.0);
        assert_eq!(body["top_p"], 1.0);
        assert_eq!(body["top_k"], 1);
        assert_eq!(body["presence_penalty"], 0.0);
        assert_eq!(body["stream"], true);
        assert_eq!(body["logprobs"], true);
        assert_eq!(body["top_logprobs"], 0);
        assert_eq!(body["stop"][0], "<|im_start|>");
        assert_eq!(body["stop"][1], "<|im_end|>");
        assert_eq!(body["chat_template_kwargs"]["enable_thinking"], false);

        // System turn first, then the user turn with image before text.
        assert_eq!(body["messages"][0]["role"], "system");
        assert!(body["messages"][0]["content"]
            .as_str()
            .unwrap()
            .starts_with("You are a structured data extractor."));
        assert_eq!(body["messages"][1]["role"], "user");
        assert_eq!(body["messages"][1]["content"][0]["type"], "image_url");
        assert_eq!(body["messages"][1]["content"][1]["type"], "text");
    }

    /// Surya takes no system turn and no Qwen-specific keys. Absent, not null —
    /// llama.cpp distinguishes the two for `chat_template_kwargs`.
    #[test]
    fn a_model_without_qwen_quirks_omits_those_keys_entirely() {
        let mut surya = QWEN_3_5_4B;
        surya.request.system_prompt = None;
        surya.request.top_k = None;
        surya.request.presence_penalty = None;
        surya.request.stop = &[];
        surya.request.enable_thinking = None;

        let body = build_request_body(&surya, vec![ContentPart::Text("x".into())], 10);
        let map = body.as_object().unwrap();
        assert!(!map.contains_key("top_k"));
        assert!(!map.contains_key("presence_penalty"));
        assert!(!map.contains_key("stop"));
        assert!(!map.contains_key("chat_template_kwargs"));
        assert_eq!(body["messages"].as_array().unwrap().len(), 1);
        assert_eq!(body["messages"][0]["role"], "user");
    }

    // ---- SSE parsing ----

    #[test]
    fn parses_tokens_and_logprobs_with_running_offsets() {
        let mut acc = SseAccumulator::new();
        acc.push_chunk(&frame(
            r#"{"choices":[{"logprobs":{"content":[{"token":"Course","logprob":-0.1}]}}]}"#,
        ));
        acc.push_chunk(&frame(
            r#"{"choices":[{"logprobs":{"content":[{"token":"\t","logprob":-0.2},{"token":"Grade","logprob":-0.3}]}}]}"#,
        ));
        acc.push_chunk(&frame(
            r#"{"choices":[{"finish_reason":"stop","delta":{}}]}"#,
        ));

        let result = acc.finish();
        assert_eq!(result.content, "Course\tGrade");
        assert_eq!(result.finish_reason.as_deref(), Some("stop"));
        assert_eq!(
            result
                .logprobs
                .iter()
                .map(|t| (t.token.as_str(), t.char_offset))
                .collect::<Vec<_>>(),
            vec![("Course", 0), ("\t", 6), ("Grade", 7)]
        );
    }

    /// The trap this module exists to avoid: offsets index UTF-16 units, because
    /// that is what the TypeScript consumer slices with. A 1-character accented
    /// token must advance the offset by 1, not by its 2 UTF-8 bytes.
    #[test]
    fn offsets_advance_by_utf16_units_not_bytes() {
        let mut acc = SseAccumulator::new();
        acc.push_chunk(&frame(
            r#"{"choices":[{"logprobs":{"content":[{"token":"é","logprob":-0.1},{"token":"x","logprob":-0.2}]}}]}"#,
        ));
        let result = acc.finish();
        assert_eq!("é".len(), 2, "two UTF-8 bytes");
        assert_eq!(result.logprobs[0].char_offset, 0);
        assert_eq!(result.logprobs[1].char_offset, 1, "not 2");
    }

    /// Frames do not arrive aligned to line boundaries; a token split across two
    /// reads must not be dropped or duplicated.
    #[test]
    fn reassembles_frames_split_across_chunk_boundaries() {
        let full =
            frame(r#"{"choices":[{"logprobs":{"content":[{"token":"Hello","logprob":-0.5}]}}]}"#);
        let (a, b) = full.split_at(20);

        let mut acc = SseAccumulator::new();
        assert_eq!(acc.push_chunk(a), "", "no complete line yet");
        assert_eq!(acc.push_chunk(b), "Hello");
        assert_eq!(acc.finish().content, "Hello");
    }

    #[test]
    fn push_chunk_returns_only_the_newly_appended_text() {
        let mut acc = SseAccumulator::new();
        let first = acc.push_chunk(&frame(
            r#"{"choices":[{"logprobs":{"content":[{"token":"aa","logprob":-0.1}]}}]}"#,
        ));
        let second = acc.push_chunk(&frame(
            r#"{"choices":[{"logprobs":{"content":[{"token":"bb","logprob":-0.1}]}}]}"#,
        ));
        assert_eq!(first, "aa");
        assert_eq!(second, "bb", "a delta, not the accumulated content");
        assert_eq!(acc.content(), "aabb");
    }

    /// A delta with no logprobs object still contributes its visible text, with a
    /// null logprob so scoring excludes it rather than reading it as certainty.
    #[test]
    fn falls_back_to_delta_content_when_logprobs_are_absent() {
        let mut acc = SseAccumulator::new();
        acc.push_chunk(&frame(r#"{"choices":[{"delta":{"content":"plain"}}]}"#));
        let result = acc.finish();
        assert_eq!(result.content, "plain");
        assert_eq!(result.logprobs.len(), 1);
        assert_eq!(result.logprobs[0].logprob, None);
    }

    #[test]
    fn a_missing_logprob_value_is_none_not_zero() {
        let mut acc = SseAccumulator::new();
        acc.push_chunk(&frame(
            r#"{"choices":[{"logprobs":{"content":[{"token":"x"}]}}]}"#,
        ));
        let result = acc.finish();
        // 0.0 would mean probability 1.0 — a confident lie about an unknown.
        assert_eq!(result.logprobs[0].logprob, None);
    }

    #[test]
    fn detects_a_stream_that_carried_no_usable_logprobs() {
        let mut acc = SseAccumulator::new();
        acc.push_chunk(&frame(r#"{"choices":[{"delta":{"content":"text"}}]}"#));
        assert!(acc.logprobs_missing());

        let mut ok = SseAccumulator::new();
        ok.push_chunk(&frame(
            r#"{"choices":[{"logprobs":{"content":[{"token":"x","logprob":-0.1}]}}]}"#,
        ));
        assert!(!ok.logprobs_missing());

        // An empty stream is not a missing-logprobs problem, it is just empty.
        assert!(!SseAccumulator::new().logprobs_missing());
    }

    #[test]
    fn ignores_keepalives_done_markers_and_malformed_frames() {
        let mut acc = SseAccumulator::new();
        acc.push_chunk("\n");
        acc.push_chunk(": keepalive\n");
        acc.push_chunk("data: \n");
        acc.push_chunk("data: [DONE]\n");
        acc.push_chunk("data: {not json\n");
        acc.push_chunk("data: {\"choices\":[]}\n");
        acc.push_chunk(&frame(
            r#"{"choices":[{"logprobs":{"content":[{"token":"ok","logprob":-0.1}]}}]}"#,
        ));
        assert_eq!(acc.finish().content, "ok");
    }

    #[test]
    fn handles_crlf_line_endings() {
        let mut acc = SseAccumulator::new();
        acc.push_chunk(
            "data: {\"choices\":[{\"logprobs\":{\"content\":[{\"token\":\"x\",\"logprob\":-0.1}]}}]}\r\n",
        );
        assert_eq!(acc.finish().content, "x");
    }

    #[test]
    fn captures_a_length_finish_reason_for_truncation_reporting() {
        let mut acc = SseAccumulator::new();
        acc.push_chunk(&frame(
            r#"{"choices":[{"finish_reason":"length","delta":{}}]}"#,
        ));
        assert_eq!(acc.finish().finish_reason.as_deref(), Some("length"));
    }

    /// Cancellation is checked before the request is even issued, so a token that
    /// was already cancelled never reaches the server.
    #[tokio::test]
    async fn an_already_cancelled_token_aborts_before_sending() {
        let token = CancellationToken::new();
        token.cancel();
        let result = stream_completion(
            "http://127.0.0.1:1", // nothing listening; must not be reached
            json!({}),
            &token,
            |_| {},
        )
        .await;
        assert_eq!(result.unwrap_err(), CANCELLED_MESSAGE);
    }
}
