export function formatPrice(p: number): string {
  if (p <= 0) return "N/A";
  if (p >= 0.01) return `$${p.toFixed(4)}`;
  if (p >= 0.000001) return `$${p.toFixed(8)}`;
  return `$${p.toExponential(3)}`;
}
