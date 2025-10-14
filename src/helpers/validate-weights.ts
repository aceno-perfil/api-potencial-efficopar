export function validateWeights(item: any) {
    const wInad = [
      Number(item?.inadimplencia?.w_atraso ?? 0),
      Number(item?.inadimplencia?.w_indice ?? 0),
      Number(item?.inadimplencia?.w_valor_aberto ?? 0),
    ];
    const wMed = [
      Number(item?.medicao?.w_idade ?? 0),
      Number(item?.medicao?.w_anomalias ?? 0),
      Number(item?.medicao?.w_desvio ?? 0),
    ];
    const sum = (arr: number[]) => arr.reduce((a,b)=>a+b,0);
    const closeTo1 = (x: number) => Math.abs(x - 1) <= 0.001;
  
    if (!closeTo1(sum(wInad))) throw new Error("inadimplencia weights must sum to 1");
    if (!closeTo1(sum(wMed))) throw new Error("medicao weights must sum to 1");
  
    const zw = Number(item?.cadastro?.z_warn);
    const zr = Number(item?.cadastro?.z_risk);
    if (!(zw < zr)) throw new Error("cadastro.z_warn must be < cadastro.z_risk");
  
    const pmin = Number(item?.potencial?.pot_min);
    const pmax = Number(item?.potencial?.pot_max);
    if (!(pmin <= pmax)) throw new Error("potencial.pot_min must be <= potencial.pot_max");
  }