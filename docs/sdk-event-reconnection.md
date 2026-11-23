# SDK event subscription: reconnection, cursor continuity and stale streams

Scope: `subscribe()` and `replay()` in [`sdk/src/events/subscribe.ts`](../sdk/src/events/subscribe.ts).
Tests: [`sdk/src/events/subscribe.test.ts`](../sdk/src/events/subscribe.test.ts)
(`subscribe — reconnection`, `replay and gap recovery`).

## Data source and assumptions

- Events come from Horizon's `contractEvents().forContract(id)` builder, either as a stream
  (`.stream({ onmessage, onerror })`) or as paged history (`.order("asc").cursor(c).call()`).
- Each record's `id` is used as its paging token (`event.pagingToken`) and `ledger` as its ledger sequence.
- The SDK does no authentication of its own. Access control is whatever the Horizon endpoint enforces.
  A rejected request (401/403/429/5xx) reaches the SDK as a stream error and is handled like any other (see below).
- Delivery is **at-least-once with best-effort de-duplication**, not exactly-once. Handlers should be idempotent.

## Behaviour contract

| Case | Behaviour |
| --- | --- |
| Normal | Each decoded event that passes `filter` is passed to `handler` once. Its paging token and ledger are then recorded. |
| Repeated | A record whose paging token is already in the de-dupe window (last 1000 tokens) is dropped, both on the live stream and during replay/gap recovery. Records without an `id` cannot be de-duplicated. |
| Interrupted | `onerror` (or a throw from `stream()`) calls `onError`, closes the stream and schedules **one** reconnect. The back-off is 500 ms, doubled per consecutive failure, capped at 30 s. The reconnect resumes with `.cursor(lastProcessedCursor)` when one exists. |
| Healthy again | The back-off resets to 500 ms when the new stream delivers its first message, not when `stream()` merely returns. A server that accepts and then drops the stream is therefore retried at 0.5 s, 1 s, 2 s ... 30 s instead of every 0.5 s. |
| Stale stream | Every stream has a generation id. After an error, or after a newer stream has been opened, `onmessage` / `onerror` from the old stream are ignored. They cannot schedule a second reconnect, double the back-off or deliver events. A stream that errors synchronously inside `stream()` has its returned handle closed immediately. |
| Unsubscribed | `unsubscribe()` is idempotent. It sets `stopped`, cancels any pending reconnect timer and closes the stream. No further handler calls or reconnects happen. Pending replay results are discarded. |
| Unauthorized / permanently failing | There is no terminal state. Errors are reported through `onError` on every attempt and retried at the capped back-off until `unsubscribe()` is called. Callers who need to give up must do so from `onError`. |
| Handler throws | The error is routed to `onError`. The event is **not** recorded as processed, so it can be redelivered by a later replay or reconnect. This is the at-least-once behaviour. |

## Cursor continuity

- `lastProcessedCursor` / `lastProcessedLedger` advance only after an event has been handled (or filtered out).
- With `filter.fromLedger`, history is replayed first and live streaming starts from the final replay cursor.
- Filtered-out events still advance the cursor, so a narrow filter does not re-scan the same range.
- Events that fail to decode or have an unknown type do not advance the cursor.
  They may be re-sent on resume and are dropped again.

## Findings

Verified by reading the code and covered by regression tests:

1. **Back-off never grew.** `connect()` reset the back-off right after `stream()` returned, so every reconnect used 500 ms.
   The old test asserted this but was named "back-off doubles".
2. **Stale callbacks could open parallel streams.** After `onerror` the old stream's callbacks stayed live.
   A late second error would schedule another timer and orphan the first, leaving two streams delivering events.
3. **Synchronous stream failure leaked a handle.** If `onerror` ran inside `stream()`, the handle returned afterwards was
   stored on an already-retired stream and was never closed.

## Residual risk (verified in code, not changed here)

- **Gap detection is a heuristic.** `event.ledger > lastProcessedLedger + 1` also fires when the contract simply emitted nothing
  in the intervening ledgers, which is normal. This costs extra replay requests. De-duplication keeps delivery correct.
- **No gap detection before the first event.** Without `fromLedger`, `lastProcessedLedger` is unset until an event arrives.
  Events emitted during an outage that begins before the first event are not recovered.
- **Concurrent `onmessage` calls are not serialised.** Two events arriving while a gap replay is in flight can interleave.
  Order across the replay/live boundary is not guaranteed, though each token is delivered at most once.
- **Silent stalls are undetected.** There is no idle timeout or heartbeat check. A connection that stops without raising an error is
  never reconnected.
- **Dedupe window is 1000 tokens.** A replay that re-sends records older than the window can redeliver them.
- **`replay()` is not cancellable.** After `unsubscribe()` an in-flight pagination loop finishes its requests,
  and only its handler calls are suppressed.
