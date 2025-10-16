/**
 * Calcula o score de cadastro baseado no consumo por economia vs. grupo de referência
 */

interface ComputeCadastroScoreParams {
  sitLigacaoAgua: string;
  qtdEconomias: number;
  consumo: number;
  grupoMedia: number;
  grupoStd: number;
}

/**
 * Calcula score de cadastro usando z-score
 * @param params Dados do imóvel e grupo de referência
 * @returns Score escalado de 0-100
 */
export function computeCadastroScore(
  params: ComputeCadastroScoreParams
): number {
  const { sitLigacaoAgua, qtdEconomias, consumo, grupoMedia, grupoStd } = params;

  // Se não está ligado, score é 0
  if (sitLigacaoAgua.toLowerCase() !== "ligado") {
    return 0;
  }

  // Consumo por economia
  const consumoPorEconomia = qtdEconomias > 0 ? consumo / qtdEconomias : 0;

  // Z-score vs. grupo de referência
  const z =
    grupoStd > 0 ? (consumoPorEconomia - grupoMedia) / grupoStd : 0;

  // Escala: abs(z) * 20, limitado a 0-100
  const scoreCadastro = Math.max(0, Math.min(100, Math.abs(z) * 20));

  return scoreCadastro;
}

