/**
 * Calcula o score de inadimplência baseado em histórico de faturas e pagamentos
 */

interface InadimplenciaWeights {
  w_atraso: number;
  w_indice: number;
  w_valor_aberto: number;
}

interface FaturaData {
  atraso: number;
  abertoNoFim: boolean;
  abertoNoTitulo: number;
}

export interface InadimplenciaMetrics {
  total: number;
  atrasoMedia: number;
  abertoQtd: number;
  abertoValor: number;
  indice: number;
}

interface ComputeInadimplenciaScoreResult {
  score: number;
  metrics: InadimplenciaMetrics;
}

/**
 * Calcula score de inadimplência ponderado
 * @param faturas Array de dados de faturas do imóvel
 * @param weights Pesos para cada componente
 * @returns Score e métricas agregadas
 */
export function computeInadimplenciaScore(
  faturas: FaturaData[],
  weights: InadimplenciaWeights
): ComputeInadimplenciaScoreResult {
  if (!faturas || faturas.length === 0) {
    return {
      score: 0,
      metrics: {
        total: 0,
        atrasoMedia: 0,
        abertoQtd: 0,
        abertoValor: 0,
        indice: 0,
      },
    };
  }

  const total = faturas.length;
  const faturasComAtraso = faturas.filter((x) => x.atraso > 0);
  const atrasoMedia =
    faturasComAtraso.length > 0
      ? faturasComAtraso.reduce((s, x) => s + x.atraso, 0) /
        faturasComAtraso.length
      : 0;

  const abertoQtd = faturas.filter((x) => x.abertoNoFim).length;
  const abertoValor = faturas
    .filter((x) => x.abertoNoFim)
    .reduce((s, x) => s + x.abertoNoTitulo, 0);

  const indice = total > 0 ? abertoQtd / total : 0;

  const metrics: InadimplenciaMetrics = {
    total,
    atrasoMedia: isFinite(atrasoMedia) ? atrasoMedia : 0,
    abertoQtd,
    abertoValor,
    indice,
  };

  // Score ponderado
  const wSum = weights.w_atraso + weights.w_indice + weights.w_valor_aberto || 1;
  const score =
    (metrics.atrasoMedia * weights.w_atraso +
      metrics.indice * weights.w_indice +
      metrics.abertoValor * weights.w_valor_aberto) /
    wSum;

  return { score, metrics };
}

