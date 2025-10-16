/**
 * Determina o nível de risco e gera mensagem descritiva
 */

interface ComputeRiskLevelParams {
  scoreCadastro: number;
  scoreInadimplencia: number;
  scoreMedicao: number;
}

interface ComputeRiskLevelResult {
  scoreTotal: number;
  nivel: string;
  mensagem: string;
}

/**
 * Calcula score total, determina nível e gera mensagem
 * @param params Scores individuais de cada dimensão
 * @returns Score total, nível (RISCO/ATENCAO/OK) e mensagem descritiva
 */
export function computeRiskLevel(
  params: ComputeRiskLevelParams
): ComputeRiskLevelResult {
  const { scoreCadastro, scoreInadimplencia, scoreMedicao } = params;

  // Score total: cadastro + medição - inadimplência
  const scoreTotalRaw = scoreCadastro + scoreMedicao - scoreInadimplencia;
  const scoreTotal = Math.max(0, Math.min(100, scoreTotalRaw));

  // Determinar nível
  let nivel: string;
  if (scoreTotal >= 70) {
    nivel = "RISCO";
  } else if (scoreTotal >= 40) {
    nivel = "ATENCAO";
  } else {
    nivel = "OK";
  }

  // Gerar mensagem descritiva
  const cadClamped = Math.max(0, Math.min(100, scoreCadastro));
  const inadClamped = Math.max(0, Math.min(100, scoreInadimplencia));
  const medClamped = Math.max(0, Math.min(100, scoreMedicao));

  const mensagem = `cad=${cadClamped.toFixed(2)}, inad=${inadClamped.toFixed(
    2
  )}, med=${medClamped.toFixed(2)} (total=${scoreTotal.toFixed(2)})`;

  return { scoreTotal, nivel, mensagem };
}

