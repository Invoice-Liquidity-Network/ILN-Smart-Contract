//! Issue #1036 — fail-closed structural verification of the persisted fund queue.
//!
//! `join_fund_queue` maintains a sorted-descending snapshot-score queue
//! (`lib.rs`, insert at the first strictly-lower-score position) and
//! `recover_fund_queue` preserves that order when it filters the evicted
//! winner out. `resolve_fund_queue`'s own doc-comment *asserts* the ordering
//! property but never *checks* it: everything downstream (the top-score scan,
//! the PRNG narrowing, the tie fan-out envelope) silently trusts whatever
//! `Vec<LpFundRequest>` the persistent store returns.
//!
//! # Why this exists
//!
//! Persistent state can be archived and restored, and a hand-corrupted
//! `DataKey::FundQueue(id)` entry (or a future migration bug) breaks three
//! assumptions at once:
//!
//! 1. **Monotonicity** (`queue[i].score >= queue[i+1].score`) — the invariant
//!    `join_fund_queue`'s sorted insertion and `recover_fund_queue`'s
//!    order-preserving filter maintain. A violation means the queue no longer
//!    reflects the admission/displacement policy.
//! 2. **Uniqueness** (no `Address` appears twice) — the dedupe in
//!    `join_fund_queue` is enforced only at join time; a duplicated persisted
//!    entry hands one LP multiple draws in the tie scan, i.e. a direct
//!    fairness bypass.
//! 3. **Bounded length** (`queue.len() <= MAX_FUND_QUEUE_LEN`) — the PRNG
//!    narrowing (`gen_range::<u64>` cast to `u32`) and the
//!    `queue_resolution_tie_fanout` resource envelope are only provably safe
//!    under the cap. A longer persisted vector means corruption.
//!
//! # Equal-score candidate group (Issue #1039)
//!
//! The doc-comment this module replaced claimed that "all entries tied for
//! the top score form a contiguous prefix (`queue[0..tied_count]`)". **That
//! is false since Issue #1019.** The queue's *sort key* is the join-time
//! snapshot score, while `resolve_fund_queue`'s *ranking key* is each LP's
//! **current** score, so the entries that tie at the current maximum are
//! generally scattered across the queue — never merely a prefix. The real
//! invariant, stated and enforced here, is:
//!
//! * every LP whose current score equals the maximum is a candidate;
//! * nothing else is;
//! * membership never depends on join order (position in the persisted
//!   vector is irrelevant to candidacy).
//!
//! [`top_score_and_equal_candidates`] is the fused single-pass engine
//! `resolve_fund_queue` uses to compute `(best_score, candidate group)` —
//! one `get_lp_score` read per entry instead of the pre-#1039 two scans
//! (50 reads instead of 100 at the cap; see Issue #1040's static
//! before/after). [`current_score_max`] and [`equal_score_candidate_group`]
//! are the same invariant expressed as standalone diagnostics — the
//! definition of the group, used by tests and off-chain verifiers.
//!
//! # Failure policy
//!
//! Verification is fail-closed: on any violation `resolve_fund_queue` emits
//! `fund_queue_ordering_rejected` (plus the house `queue_resolve_attempt`
//! `success=false` marker) and returns `Err`. It never re-sorts, never
//! de-duplicates, never skips — a silent repair would paper over exactly the
//! state-corruption class this guard exists to surface.
//!
//! # Guard ordering (authorization-adjacent)
//!
//! The check runs *after* the paused / exists / already-resolved /
//! queueable / empty / fail-closed-opened_at / MEV-maturity gates and *before*
//! any read of the queue's contents for scoring. The maturity gate is a
//! caller-facing refusal and must stay first (a caller who has not waited
//! `QUEUE_DELAY_LEDGERS` must learn `QueueNotMature`, not an internal
//! integrity verdict); the structural check is a state-integrity guard and
//! belongs before the queue is used. See
//! `tests_queue_ordering_verification::test_ordering_check_runs_after_maturity_gate`.

use crate::invoice::LpFundRequest;
use soroban_sdk::{Address, Env, Vec};

/// The structural violations [`verify_fund_queue_ordering`] detects.
///
/// Crate-internal on purpose: it is an implementation detail of
/// `resolve_fund_queue`'s fail-closed guard, not contract surface. It maps
/// onto the single `fund_queue_ordering_rejected` event via
/// [`QueueInvariantViolation::descriptor`].
pub(crate) enum QueueInvariantViolation {
    /// `queue[index + 1].score > queue[index].score` — the persisted order is
    /// no longer sorted descending by snapshot score.
    NonMonotonic {
        index: u32,
        observed: u32,
        expected: u32,
    },
    /// The entry at `index` duplicates the LP of an earlier entry.
    Duplicate { index: u32, first: u32 },
    /// The persisted queue is `len` entries long; the cap is
    /// `crate::constants::MAX_FUND_QUEUE_LEN`.
    TooLong { len: u32 },
}

impl QueueInvariantViolation {
    /// Project the violation onto the `fund_queue_ordering_rejected` payload
    /// `(index, observed, expected)`:
    ///
    /// * `NonMonotonic` — `index` = position `i` of the ordered pair,
    ///   `observed` = `queue[i + 1].score`, `expected` = `queue[i].score`
    ///   (the violating entry must not exceed the entry before it).
    /// * `Duplicate` — `index` = position of the later duplicate,
    ///   `observed` = 2 (the LP occurs twice), `expected` = 1 (dedupe cap).
    /// * `TooLong` — `index` = 0 sentinel, `observed` = `queue.len()`,
    ///   `expected` = `MAX_FUND_QUEUE_LEN`.
    pub(crate) fn descriptor(&self) -> (u32, u32, u32) {
        match self {
            QueueInvariantViolation::NonMonotonic {
                index,
                observed,
                expected,
            } => (*index, *observed, *expected),
            QueueInvariantViolation::Duplicate { index, .. } => (*index, 2, 1),
            QueueInvariantViolation::TooLong { len } => {
                (0, *len, crate::constants::MAX_FUND_QUEUE_LEN)
            }
        }
    }
}

/// Verify the persisted queue's structural invariants without touching it.
///
/// Reads only: no re-sorting, no de-duplication, no truncation — the queue
/// argument is `&Vec`, and violations are reported, never repaired. Cost is
/// O(len^2) worst case for the duplicate scan, bounded by
/// `MAX_FUND_QUEUE_LEN` (50) once the length check has passed.
pub(crate) fn verify_fund_queue_ordering(
    env: &Env,
    queue: &Vec<LpFundRequest>,
) -> Result<(), QueueInvariantViolation> {
    // `env` is part of the mandated verification signature (every helper in
    // this module takes it for uniformity); the three checks proper read only
    // the persisted vector, which is the point — no live state can mask
    // corruption of the stored queue.
    let _ = env;

    // Length first — it is the precondition that makes the scans below
    // bounded work, and it is the cheapest check.
    if queue.len() > crate::constants::MAX_FUND_QUEUE_LEN {
        return Err(QueueInvariantViolation::TooLong { len: queue.len() });
    }

    // Monotonicity over snapshot scores (descending, ties allowed).
    if queue.len() > 1 {
        for i in 0..queue.len() - 1 {
            let current = queue.get(i).unwrap();
            let next = queue.get(i + 1).unwrap();
            if next.score > current.score {
                return Err(QueueInvariantViolation::NonMonotonic {
                    index: i,
                    observed: next.score,
                    expected: current.score,
                });
            }
        }
    }

    // Uniqueness over LP addresses. `join_fund_queue`'s dedupe is join-time
    // only; a duplicated persisted entry is a fairness bypass (multiple
    // draws for one LP in the tie scan), so it fails closed here.
    for i in 0..queue.len() {
        let lp_i: Address = queue.get(i).unwrap().lp;
        for j in (i + 1)..queue.len() {
            if queue.get(j).unwrap().lp == lp_i {
                return Err(QueueInvariantViolation::Duplicate { index: j, first: i });
            }
        }
    }

    Ok(())
}

// ----------------------------------------------------------------
// Issue #1039 — equal-score candidate group
// ----------------------------------------------------------------

/// The maximum *current* reputation score among the queue's entries.
///
/// Diagnostic definition of the ranking key: one `get_lp_score` read per
/// entry. `resolve_fund_queue` uses the fused
/// [`top_score_and_equal_candidates`] instead (single pass).
pub(crate) fn current_score_max(env: &Env, queue: &Vec<LpFundRequest>) -> u32 {
    let mut best: u32 = 0;
    for i in 0..queue.len() {
        let s = crate::invoice::get_lp_score(env, &queue.get(i).unwrap().lp);
        if s > best {
            best = s;
        }
    }
    best
}

/// The indices whose *current* score equals `best` — the equal-score
/// candidate group.
///
/// Diagnostic definition of the group: the result is exactly
/// `{ i : get_lp_score(queue[i].lp) == best }`, in ascending index order,
/// each index appearing once. It is NOT a prefix (`queue[0..tied_count]`):
/// because the queue is sorted by join-time snapshot score while candidacy
/// is defined on current score, the group can be scattered anywhere
/// (Issue #1039). The caller is expected to have obtained `best` from
/// [`current_score_max`] on the same queue.
pub(crate) fn equal_score_candidate_group(
    env: &Env,
    queue: &Vec<LpFundRequest>,
    best: u32,
) -> Vec<u32> {
    let mut group: Vec<u32> = Vec::new(env);
    for i in 0..queue.len() {
        if crate::invoice::get_lp_score(env, &queue.get(i).unwrap().lp) == best {
            group.push_back(i);
        }
    }
    group
}

/// Fused single-pass computation of the current maximum score and its
/// candidate group — the engine behind `resolve_fund_queue`'s winner scan.
///
/// Reads each entry's current score exactly once (O(len) storage reads,
/// worst case `MAX_FUND_QUEUE_LEN` at the cap; the pre-#1039 two-scan form
/// read 2x per entry). Maintains the classic top-tie-set accumulator: a new
/// strictly-higher score resets the group to the current index; an
/// equal-to-best score appends it. This yields, identically to the two
/// standalone helpers composed,
/// `(current_score_max(env, queue), equal_score_candidate_group(env, queue, best))`
/// — in particular the group may be scattered across the queue, and its
/// membership never depends on join order.
pub(crate) fn top_score_and_equal_candidates(
    env: &Env,
    queue: &Vec<LpFundRequest>,
) -> (u32, Vec<u32>) {
    let mut best: u32 = 0;
    let mut group: Vec<u32> = Vec::new(env);
    for i in 0..queue.len() {
        let s = crate::invoice::get_lp_score(env, &queue.get(i).unwrap().lp);
        if s > best {
            best = s;
            group = Vec::new(env);
            group.push_back(i);
        } else if s == best {
            group.push_back(i);
        }
    }
    (best, group)
}
