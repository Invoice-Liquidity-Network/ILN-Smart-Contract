import React, { useState } from "react";

interface AddressDisplayProps {
  address: string;
  chars?: number;
  copyable?: boolean;
  className?: string;
}

function truncate(address: string, chars: number): string {
  if (address.length <= chars * 2 + 3) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

export function AddressDisplay({
  address,
  chars = 6,
  copyable = false,
  className,
}: AddressDisplayProps) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard not available */
    }
  }

  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontFamily: "monospace" }}
    >
      <span title={address}>{truncate(address, chars)}</span>
      {copyable && (
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy address"}
          style={{
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "2px 4px",
            borderRadius: 4,
            fontSize: 11,
            color: copied ? "#22c55e" : "#6b7280",
          }}
        >
          {copied ? "✓" : "⎘"}
        </button>
      )}
    </span>
  );
}
