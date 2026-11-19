describe('E2E: Stellar node smoke test', () => {
  const rpcUrl = process.env.STELLAR_RPC_URL;

  it('should have STELLAR_RPC_URL environment variable set', () => {
    expect(rpcUrl).toBeDefined();
    expect(rpcUrl).toBe('http://localhost:8000');
  });

  it('should be able to reach the Stellar node', async () => {
    const res = await fetch(`${rpcUrl}/ledger`);
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data).toHaveProperty('sequence');
    expect(typeof data.sequence).toBe('number');
  });

  it('should have contract IDs available', () => {
    expect(process.env.INVOICE_LIQUIDITY_ID).toBeDefined();
    expect(process.env.ILN_GOVERNANCE_ID).toBeDefined();
    expect(process.env.ILN_DISTRIBUTION_ID).toBeDefined();
    expect(process.env.INSURANCE_POOL_ID).toBeDefined();
    expect(process.env.REPUTATION_BONUS_ID).toBeDefined();
  });
});
