import { computeRange } from "./compute-range";

export function buildRangeOutputForRows(setorOrGroupId: string, rows: any[]) {
    const consumo_por_economia = computeRange(rows.map(r => r.media_consumo_por_economia));
    const tempo_medio_atraso   = computeRange(rows.map(r => r.media_tempo_atraso));
    const valor_em_aberto      = computeRange(rows.map(r => r.valor_total_aberto));
    const indice_inadimplencia = computeRange(rows.map(r => r.indice_inadimplencia));
    const idade_hidrometro_dias= computeRange(rows.map(r => r.idade_hidrometro_meses), (m) => Math.round(m * 30));
    const taxa_anomalias       = computeRange(rows.map(r => r.taxa_anomalias));
    const desvio_consumo       = computeRange(rows.map(r => r.coef_var_consumo));
  
    return {
      setor_id: setorOrGroupId,
      cadastro: { consumo_por_economia },
      inadimplencia: { tempo_medio_atraso, valor_em_aberto, indice_inadimplencia },
      medicao: { idade_hidrometro_dias, taxa_anomalias, desvio_consumo }
    };
  }