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
pub mod copilot;
pub mod devin;
pub mod enable;
pub mod governance;
pub mod integrations;
pub mod limits;
pub mod manifest;
pub mod opencode;
pub mod pricing;
pub mod transcripts;

/// Serialises the tests that set environment variables.
///
/// `set_var` is process-global and the test harness is multi-threaded, so two
/// tests pointing `CODEX_HOME` at different directories will read each other's.
/// `tests/machine.rs` already holds a lock of its own for exactly this; the
/// unit tests need one too, and it has to be the same lock for all of them.
#[cfg(test)]
pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
