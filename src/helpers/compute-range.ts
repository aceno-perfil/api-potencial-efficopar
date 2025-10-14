export function computeRange(values: number[], transform?: (n: number) => number) {
    const nums: number[] = [];
    for (const v of values || []) {
      if (v === null || v === undefined) continue;
      const n = Number(transform ? transform(Number(v)) : Number(v));
      if (Number.isFinite(n)) nums.push(n);
    }
    if (nums.length === 0) return { min_value: null, max_value: null, quantidade: 0 };
    let min = nums[0], max = nums[0];
    for (const n of nums) { if (n < min) min = n; if (n > max) max = n; }
    return { min_value: min, max_value: max, quantidade: nums.length };
  }