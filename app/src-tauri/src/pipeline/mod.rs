//! The manifest-driven extraction pipeline.
//!
//! The pipeline is described as data — a [`catalog`] of models and ordered presets —
//! rather than hardcoded into a single call path. [`executor`] walks those steps for
//! one page, [`client`] talks to the local `llama-server`, [`prompt`] derives the
//! prompt inputs from OCR words, and [`budget`] decides how much output can fit.
//!
//! # Built ahead of its callers
//!
//! The UI still orchestrates extraction itself; these modules are registered and
//! tested but not yet driven by it, so the two implementations can be compared
//! before the default moves. That makes parts of this subtree legitimately unused in
//! a plain build, hence the crate-lint allow below — the same reasoning that keeps
//! `menu` compiled on every platform. The tests are what keep it honest meanwhile:
//! `prompt` is pinned to golden files the Vitest suite writes, and `catalog`
//! validates itself.
//!
//! Applied once here rather than per file; lint levels propagate into submodules.

#![allow(dead_code)]

pub mod budget;
pub mod catalog;
pub mod client;
pub mod executor;
pub mod prompt;
