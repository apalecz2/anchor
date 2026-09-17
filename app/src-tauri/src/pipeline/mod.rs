//! The manifest-driven extraction pipeline.
//!
//! The pipeline is described as data — a `catalog` of models and ordered presets —
//! rather than hardcoded into a single call path. This module is where that
//! description lives and, in later phases, where it is executed: model residency,
//! the chat-completions client, and the executor that walks a preset's steps all
//! land here beside the catalog they read.
//!
//! Today it is the catalog alone. Nothing runs it yet; the current extraction path
//! still orchestrates from the frontend.

pub mod catalog;
