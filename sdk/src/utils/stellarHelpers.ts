/**
 * Shared Stellar utility functions used across the ILN SDK, CLI, and E2E tests.
 *
 * Centralising these here removes duplicate implementations and keeps behaviour
 * consistent across the monorepo.
 */

/** Length of a Stellar StrKey-encoded G-address. */
const G_ADDRESS_LENGTH = 56;

/**
 * Returns `true` if `address` is a syntactically valid Stellar G-address
 * (starts with "G" and is exactly 56 characters long).
 *
 * This is a cheap structural check — it does NOT verify the checksum embedded
 * in the StrKey encoding. Use `@stellar/stellar-sdk`'s `Keypair.fromPublicKey`
 * when you need full StrKey validation.
 */
export function isValidGAddress(address: string): boolean {
  return (
    typeof address === "string" &&
    address.length === G_ADDRESS_LENGTH &&
    address.startsWith("G")
  );
}

/**
 * Resolves a Stellar G-address to its Federation address (e.g. `alice*iln.network`).
 *
 * Calls the Stellar Federation server at `federation.stellar.org` using the
 * `forward` type lookup. Returns `null` when no Federation record exists for
 * the address or when the network request fails gracefully.
 *
 * @param gAddress - A valid Stellar G-address
 */
export async function resolveFederationAddress(
  gAddress: string
): Promise<string | null> {
  try {
    const url = `https://federation.stellar.org/?q=${encodeURIComponent(gAddress)}&type=id`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = (await res.json()) as { stellar_address?: string };
    return json.stellar_address ?? null;
  } catch {
    return null;
  }
}

/**
 * Funds a testnet account via Friendbot.
 *
 * @throws {Error} If called in a mainnet context (`STELLAR_NETWORK=mainnet`)
 *   or if Friendbot returns a non-OK response.
 *
 * @param address - The G-address to fund
 */
export async function friendbotFund(address: string): Promise<void> {
  if (process.env.STELLAR_NETWORK === "mainnet") {
    throw new Error("friendbotFund() must not be called on mainnet");
  }
  const url = `https://friendbot.stellar.org?addr=${encodeURIComponent(address)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Friendbot failed (${res.status}): ${body}`);
  }
}

/**
 * Returns a display-friendly truncation of a Stellar address or transaction hash.
 *
 * @param address - The full address or hash to truncate
 * @param chars   - Number of characters to keep from each end (default: 4)
 *
 * @example
 * truncateAddress("GABCD...XYZ", 4) // "GABC...WXYZ"
 */
export function truncateAddress(address: string, chars = 4): string {
  if (typeof address !== "string" || address.length === 0) return "";
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}
