import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from '../src/delivery/signature';

describe('HMAC signature', () => {
  it('produces stable signatures for the same payload', () => {
    const a = signPayload('secret', '{"x":1}');
    const b = signPayload('secret', '{"x":1}');
    expect(a).toBe(b);
  });

  it('verifies a valid signature', () => {
    const sig = signPayload('s3cr3t', 'hello');
    expect(verifySignature('s3cr3t', 'hello', sig)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const sig = signPayload('s3cr3t', 'hello');
    expect(verifySignature('s3cr3t', 'hello world', sig)).toBe(false);
  });

  it('rejects a wrong key', () => {
    const sig = signPayload('s3cr3t', 'hello');
    expect(verifySignature('other', 'hello', sig)).toBe(false);
  });

  it('rejects a signature with different length', () => {
    expect(verifySignature('s', 'p', 'short')).toBe(false);
  });
});
