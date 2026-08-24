//! The TokenHUD agent as a library.
//!
//! `main.rs` is the loop, the POST and the spool; everything it reads the
//! machine with lives here. Split out for two reasons, one immediate and one
//! coming:
//!
//!   · `tests/machine.rs` runs the real collectors against the real machine,
//!     which needs them reachable from outside the binary.
//!   · The macOS menu bar app links this crate rather than shelling out to it.
//!     A C ABI over these functions is a small step; a C ABI over a binary is
//!     a process to supervise.

pub mod codex;
pub mod collect;
pub mod limits;
pub mod manifest;
pub mod pricing;
pub mod transcripts;
