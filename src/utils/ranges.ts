// utils/ranges.ts
// -------------------------------------------------------
// Utilitários para cálculo de ranges e histogramas
// -------------------------------------------------------

// Quebras default por feature (ajuste conforme sua realidade)
// Obs.: mantenha poucas faixas para reduzir tokens.
export const DEFAULT_BREAKS: Record<string, number[]> = {
    meter_age_years: [5, 10, 15],
    anomaly_rate: [0.03, 0.07, 0.12],
    consumption_cv: [0.10, 0.25, 0.40],
    inconsistencias_rate: [0.10, 0.30, 0.50],
    delinquency_days: [30, 90, 180],
    open_invoices_count: [1, 3, 6],
    open_amount_ratio: [0.10, 0.30, 0.60],
};

// Monta bins [null,b1], [b1,b2], ..., [bN,null]
export function buildRangesFromBreaks(breaks: number[]): Array<[number | null, number | null]> {
    const arr: Array<[number | null, number | null]> = [];
    if (!breaks.length) return [[null, null]];
    arr.push([null, breaks[0]]);
    for (let i = 0; i < breaks.length - 1; i++) {
        arr.push([breaks[i], breaks[i + 1]]);
    }
    arr.push([breaks[breaks.length - 1], null]);
    return arr;
}

// Calcula contagem por bin
export function histogram(values: number[], breaks: number[]) {
    const ranges = buildRangesFromBreaks(breaks);
    const counts = new Array(ranges.length).fill(0);
    for (const v of values) {
        let idx = -1;
        // Semântica: (a,b] para bins internos; (-inf,b1], (b1,b2], ... (bN,+inf)
        for (let i = 0; i < ranges.length; i++) {
            const [a, b] = ranges[i];
            const okLower = a === null ? true : v > a;
            const okUpper = b === null ? true : v <= b;
            if (okLower && okUpper) {
                idx = i;
                break;
            }
        }
        if (idx >= 0) counts[idx]++;
    }
    return ranges.map((r, i) => ({ range: r, count: counts[i] }));
}
