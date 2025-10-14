export const monthStart = (d: string) => {
    const x = new Date(d);
    const y = x.getUTCFullYear();
    const m = x.getUTCMonth();
    return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  };