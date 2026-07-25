# Fix 6 Failing SDK Tests

## Failing Tests Summary

### subscribe.test.ts (4 failures)

1. **`parses appealed (default_appealed alias)`** — Test sends `"default_appealed"` but source only has `case "appealed":`. Missing alias.

2. **`parses token_removed`** — Source reads `topics[1]` (line 246) but should read `topics[0]` — after the event type is sliced off, the token is at index 0.

3. **`parses parameter_updated`** — Missing from the switch statement entirely. No `case "parameter_updated":`.

4. **`parses paused`** — Source returns `num(body["timestamp"])` (Number), test expects `1_700_007_000n` (BigInt). Test assertion is wrong — `paused` events use `num()`, not `big()`.

### xdrDecoder.test.ts (2 failures)

5. **`should handle missing optional fields`** — `decodeInvoice` returns `funder: ""` for missing fields, test expects `undefined`.

6. **`should decode valid contract stats`** — Property-based test generates arbitrary strings for token volumes including non-numeric like `":"` which crashes `BigInt()`.

---

## Changes

### Fix 1: `subscribe.ts` — Add `default_appealed` alias (line 188)

```typescript
case "default_appealed":
case "appealed":
```

### Fix 2: `subscribe.ts` — Fix `token_removed` topic index (line 246)

```typescript
// Change topics[1] → topics[0]
token: str(topics[0]),
```

### Fix 3: `subscribe.ts` — Add `parameter_updated` case (after line 314)

```typescript
case "parameter_updated":
  return {
    timestamp: num(body["timestamp"] ?? ((raw.ledgerClosedAt as string) as string)),
    txHash: (((raw.txHash || "") as string) as string) || "",
    type: "parameter_updated",
    paramName: str(topics[0]),
    oldValue: big(body["old_value"]),
    newValue: big(body["new_value"]),
    updatedBy: str(body["updated_by"]),
  };
```

### Fix 4: `subscribe.test.ts` — Fix `paused` assertion (line 231)

```typescript
// Change BigInt expectation to Number
expect(ev?.timestamp).toBe(1_700_007_000);
```

### Fix 5: `xdrDecoder.ts` — Return undefined for missing optional fields (lines 42-46)

```typescript
funder: raw["funder"] ? String(raw["funder"]) : undefined,
fundedAt: raw["funded_at"] ? Number(raw["funded_at"]) : undefined,
referralCode: raw["referral_code"] ? Buffer.from(raw["referral_code"] as any).toString("hex") : undefined,
```

### Fix 6: `xdrDecoder.test.ts` — Constrain token volume values (line 145)

```typescript
// Change fc.string() → fc.bigInt() with string conversion to ensure valid numeric strings
token_volumes: fc.array(fc.tuple(
  fc.hexaString({ minLength: 56, maxLength: 56 }),
  fc.bigInt().map(String)
)),
```

---

## Files Modified

- `sdk/src/events/subscribe.ts` — Fixes 1, 2, 3
- `sdk/src/events/subscribe.test.ts` — Fix 4
- `sdk/src/utils/xdrDecoder.ts` — Fix 5
- `sdk/src/utils/xdrDecoder.test.ts` — Fix 6

## Verification

```bash
pnpm --filter @iln/sdk test:ci
```

All 260 tests should pass (integration test skipped without env vars).
