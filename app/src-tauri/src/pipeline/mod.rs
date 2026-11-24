//! The manifest-driven extraction pipeline.
//!
//! The pipeline is described as data — a [`catalog`] of models and ordered presets —
//! rather than hardcoded into a single call path. [`executor`] walks those steps for
//! one page, [`client`] talks to the local `llama-server`, [`prompt`] derives the
//! prompt inputs from OCR words, [`budget`] decides how much output can fit, and
//! [`surya`] reads a grounding model's boxes back out.
//!
//! # Built ahead of its callers
//!
//! The executor drives extraction today, but parts of this subtree run ahead of the
//! presets that will use them — [`surya`] has no caller until a grounding preset
//! ships, and the catalog carries vocabulary (the `chat` role, the `block` grounding
//! tier) that nothing consumes yet. That makes them legitimately unused in a plain
//! build, hence the crate-lint allow below — the same reasoning that keeps `menu`
//! compiled on every platform. The tests are what keep it honest meanwhile: `prompt`
//! is pinned to golden files the Vitest suite writes, `catalog` validates itself, and
//! `surya` is held to the band and block shapes the P0 spike actually recorded.
//!
//! Applied once here rather than per file; lint levels propagate into submodules.

#![allow(dead_code)]

pub mod budget;
pub mod catalog;
pub mod client;
pub mod custom;
pub mod executor;
pub mod prompt;
pub mod surya;
