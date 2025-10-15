/**
 * Calcula o score de medição baseado em histórico, anomalias e idade do hidrômetro
 */

interface MedicaoWeights {
  w_idade: number;
  w_anomalias: number;
  w_desvio: number;
}

interface ComputeMedicaoScoreParams {
  sitLigacaoAgua: string;
  consumoHistorico: number[];
  anomaliasCount: number;
  observacoesCount: number;
  idadeMeses: number;
  weights: MedicaoWeights;
}

/**
 * Calcula score de medição ponderado
 * @param params Dados do histórico de medição e pesos
 * @returns Score de 0-100
 */
export function computeMedicaoScore(
  params: ComputeMedicaoScoreParams
): number {
  const {
    sitLigacaoAgua,
    consumoHistorico,
    anomaliasCount,
    observacoesCount,
    idadeMeses,
    weights,
  } = params;

  // Se não está ligado, score é 0
  if (sitLigacaoAgua.toLowerCase() !== "ligado") {
    return 0;
  }

  const n = consumoHistorico.length;

  // Taxa de anomalias
  let taxaAnomalias = 0;
  if (observacoesCount > 0) {
    taxaAnomalias = anomaliasCount / observacoesCount;
  }

  // Desvio padrão / coeficiente de variação
  let desvio = 0;
  if (n > 0) {
    const avg = consumoHistorico.reduce((s, x) => s + x, 0) / n;
    const varpop =
      consumoHistorico.reduce((s, x) => s + Math.pow(x - avg, 2), 0) / n;
    const std = Math.sqrt(varpop);
    desvio = avg > 0 ? std / avg : 0;
  }

  // Score ponderado
  const wSum = weights.w_idade + weights.w_anomalias + weights.w_desvio || 1;
  const score =
    (idadeMeses * weights.w_idade +
      taxaAnomalias * weights.w_anomalias +
      desvio * weights.w_desvio) /
    wSum;

  return score;
}

