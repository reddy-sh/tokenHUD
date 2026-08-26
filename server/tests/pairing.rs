//! The pairing code is a contract between three implementations: this server,
//! the cloud ingest function (`amplify/functions/ingest/protocol.ts`), and the
//! browser that mints the link (`site/src/lib/enrollment.js`). A person is
//! asked to compare the code their terminal printed against the code the
//! portal shows, and to refuse the machine if they differ — so a divergence
//! here does not degrade the handshake, it inverts it, telling someone the
//! truth is a mismatch.
//!
//! Nothing in any type system holds three languages to one derivation. These
//! vectors do: the same table is asserted in `protocol.test.mjs` (Node) and
//! `site/tests/portal.spec.js` (browser). If you change the derivation, all
//! three fail together — which is the point. Do not edit a vector to make a
//! test pass.

use tokenhud_server::board::pairing_code;

const VECTORS: &[(&str, &str)] = &[
    ("", "FRM-2XH"),
    ("a", "CY4-X6K"),
    ("tokenhud", "K63-CWT"),
    ("DdI0kK2mBcCLpCoOtdgKrHRVJnUCLZbXDDvKfdG-P9k", "C3D-3TH"),
    ("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", "DMA-8SQ"),
];

#[test]
fn the_pairing_code_is_the_same_in_every_implementation() {
    for (token, expected) in VECTORS {
        assert_eq!(
            &pairing_code(token),
            expected,
            "pairing code for {token:?} drifted — the terminal and the portal \
             now disagree, and the person comparing them is told to refuse a \
             machine that is fine"
        );
    }
}

#[test]
fn the_alphabet_cannot_be_read_two_ways() {
    // A code read aloud over a call must have one spelling: no 0/O, 1/I/L, U/V.
    let codes: String = VECTORS.iter().map(|(t, _)| pairing_code(t)).collect();
    for ambiguous in ['0', 'O', '1', 'I', 'L', 'U'] {
        assert!(
            !codes.contains(ambiguous),
            "{ambiguous} is ambiguous when read aloud"
        );
    }
}

#[test]
fn the_shape_is_always_three_dash_three() {
    for token in ["", "a", "tokenhud", &"z".repeat(200)] {
        let code = pairing_code(token);
        assert_eq!(code.len(), 7, "{code} is not XXX-XXX");
        assert_eq!(code.chars().nth(3), Some('-'));
        assert!(code
            .chars()
            .filter(|c| *c != '-')
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()));
    }
}
