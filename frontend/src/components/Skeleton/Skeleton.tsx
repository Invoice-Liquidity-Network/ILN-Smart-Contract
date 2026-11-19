import React from "react";

interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  borderRadius?: string | number;
  className?: string;
  "aria-label"?: string;
}

export function Skeleton({
  width = "100%",
  height = 16,
  borderRadius = 4,
  className,
  "aria-label": ariaLabel = "Loading…",
}: SkeletonProps) {
  return (
    <span
      role="status"
      aria-label={ariaLabel}
      className={className}
      style={{
        display: "inline-block",
        width,
        height,
        borderRadius,
        background: "linear-gradient(90deg, #e5e7eb 25%, #f3f4f6 50%, #e5e7eb 75%)",
        backgroundSize: "200% 100%",
        animation: "iln-skeleton-shimmer 1.4s ease-in-out infinite",
      }}
    />
  );
}
