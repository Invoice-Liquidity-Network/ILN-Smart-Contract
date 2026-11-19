import React from "react";

interface TokenLogoProps {
  code: string;
  size?: number;
  className?: string;
}

const TOKEN_COLORS: Record<string, { bg: string; text: string }> = {
  XLM:  { bg: "#000000", text: "#ffffff" },
  USDC: { bg: "#2775CA", text: "#ffffff" },
  BTC:  { bg: "#F7931A", text: "#ffffff" },
  ETH:  { bg: "#627EEA", text: "#ffffff" },
};

export function TokenLogo({ code, size = 32, className }: TokenLogoProps) {
  const colors = TOKEN_COLORS[code.toUpperCase()] ?? { bg: "#6B7280", text: "#ffffff" };
  const fontSize = Math.round(size * 0.35);

  return (
    <span
      className={className}
      role="img"
      aria-label={`${code} token logo`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        backgroundColor: colors.bg,
        color: colors.text,
        fontSize,
        fontWeight: 700,
        fontFamily: "sans-serif",
        userSelect: "none",
        flexShrink: 0,
      }}
    >
      {code.slice(0, 3).toUpperCase()}
    </span>
  );
}
