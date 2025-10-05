// Arredonda p/ 2 casas
export const round2 = (n: number) => Math.round(n * 100) / 100;

// Pega valor numérico seguro (fallback 0)
export const num = (v: number | null | undefined, fallback = 0) => (Number.isFinite(v as number) ? Number(v) : fallback);
