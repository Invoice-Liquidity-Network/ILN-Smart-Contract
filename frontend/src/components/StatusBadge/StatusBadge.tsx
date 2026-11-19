import React from "react";

export type InvoiceStatus =
  | "PENDING"
  | "FUNDED"
  | "PAID"
  | "CANCELLED"
  | "EXPIRED"
  | "DISPUTED";

interface StatusBadgeProps {
  status: InvoiceStatus;
  className?: string;
}

const STATUS_CONFIG: Record<
  InvoiceStatus,
  { label: string; bg: string; text: string; dot: string }
> = {
  PENDING:   { label: "Pending",   bg: "#fef9c3", text: "#854d0e", dot: "#ca8a04" },
  FUNDED:    { label: "Funded",    bg: "#dbeafe", text: "#1e40af", dot: "#3b82f6" },
  PAID:      { label: "Paid",      bg: "#dcfce7", text: "#166534", dot: "#22c55e" },
  CANCELLED: { label: "Cancelled", bg: "#f3f4f6", text: "#374151", dot: "#9ca3af" },
  EXPIRED:   { label: "Expired",   bg: "#fee2e2", text: "#991b1b", dot: "#ef4444" },
  DISPUTED:  { label: "Disputed",  bg: "#fde8d8", text: "#9a3412", dot: "#f97316" },
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.CANCELLED;

  return (
    <span
      className={className}
      role="status"
      aria-label={`Invoice status: ${cfg.label}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        paddingInline: 8,
        paddingBlock: 3,
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: "0.04em",
        backgroundColor: cfg.bg,
        color: cfg.text,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          backgroundColor: cfg.dot,
          flexShrink: 0,
        }}
      />
      {cfg.label}
    </span>
  );
}
