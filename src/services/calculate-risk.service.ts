/**
 * Service principal para calcular risco de imóveis
 */

import {
  resolveRiskEscopo,
  fetchRiskWeights,
  computeCadastroScore,
  computeInadimplenciaScore,
  computeMedicaoScore,
  computeRiskLevel,
} from "../helpers";
import { fetchRiskData } from "./fetch-risk-data.service";

type RiscoImovel = {
    imovel_id: string;
    periodo: string;
    score_cadastro: number;
    score_inadimplencia: number;
    score_medicao: number;
    score_total: number;
    nivel: string;
    mensagem: string;
    created_at: string;
    updated_at: string;
}

interface CalculateRiskParams {
  escopo: string;
  identificadores: string[];
  periodo: string;
  janela_meses: number;
}

interface CalculateRiskResult {
  rowsToUpsert: RiscoImovel[];
  imovelIds: string[];
  setoresFiltro: string[] | null;
  grupoId: string | null;
}

const WEIGHT_DEFAULTS: Record<string, number> = {
  w_atraso: 0.5,
  w_indice: 0.3,
  w_valor_aberto: 0.2,
  w_idade: 0.4,
  w_anomalias: 0.3,
  w_desvio: 0.3,
};



/**
 * Orquestra todo o fluxo de cálculo de risco
 * @param params Parâmetros do cálculo
 * @returns Linhas para upsert e informações do escopo
 */
export async function calculateRisk(
  params: CalculateRiskParams
): Promise<CalculateRiskResult> {
  const { escopo, identificadores, periodo, janela_meses } = params;

  // Preparar datas
  const vMes = new Date(periodo);
  const vMonthStr = `${vMes.getUTCFullYear()}-${String(
    vMes.getUTCMonth() + 1
  ).padStart(2, "0")}`;
  const vMesISO = `${vMonthStr}-01`;
  const vFim = new Date(
    Date.UTC(vMes.getUTCFullYear(), vMes.getUTCMonth() + 1, 1)
  );
  const vIni = new Date(
    Date.UTC(vMes.getUTCFullYear(), vMes.getUTCMonth() - Number(janela_meses), 1)
  );

  // 1) Resolver escopo
  const { setoresFiltro, grupoId } = await resolveRiskEscopo({
    escopo,
    identificadores,
  });

  console.log("Setores filtro", setoresFiltro);
  console.log("Grupo id", grupoId);

  // 2) Buscar todos os dados necessários
  const data = await fetchRiskData({
    imovelIds: [], // será filtrado no service
    vMesISO,
    vIni,
    vFim,
    setoresFiltro,
  });

  const imovelIds = data.imoveis.map((r: any) => r.id);

  console.log("Total de imóveis", imovelIds.length);
  console.log("Total de setores filtro", setoresFiltro?.length ?? 0);
  console.log("Grupo id", grupoId);

  console.log("Fetching risk weights");
  // 3) Buscar pesos
  const { setorWeights, groupWeights } = await fetchRiskWeights({
    setoresFiltro,
    grupoId,
    vMonthStr,
    janela_meses,
  });

  console.log("Setor weights", setorWeights);
  console.log("Group weights", groupWeights);

  // Helper para resolver pesos por imóvel
  function resolveWeightsForImovel(imovelId: string) {
    const setor = data.setorByImovel.get(imovelId) || "";
    const sw = setor ? setorWeights.get(setor) : undefined;
    const get = (k: string) =>
      sw?.get(k) ?? groupWeights.get(k) ?? WEIGHT_DEFAULTS[k];
    return {
      // inadimplência
      w_atraso: get("w_atraso"),
      w_indice: get("w_indice"),
      w_valor_aberto: get("w_valor_aberto"),

      // medição
      w_idade: get("w_idade"),
      w_anomalias: get("w_anomalias"),
      w_desvio: get("w_desvio"),

      // cadastro
      z_warn: get("z_warn"),
      z_risk: get("z_risk"),

      // potencial
      pot_min: get("pot_min"),
      pot_max: get("pot_max"),
    };
  }

  // 4) Calcular scores de cadastro para todos os imóveis
  const scoreCadastroByImovel = new Map<string, number>();
  for (const imv of data.imoveis) {
    const id = imv.id;
    const key = `${data.municipioByImovel.get(id)}|||${data.catByImovel.get(id)}`;
    const grp = data.scgMap.get(key) || { media: 0, std: 0 };

    const score = computeCadastroScore({
      sitLigacaoAgua: data.sitAguaByImovel.get(id) || "",
      qtdEconomias: data.ecoByImovel.get(id) || 0,
      consumo: data.consumoPorImovel.get(id) || 0,
      grupoMedia: grp.media,
      grupoStd: grp.std,
    });

    scoreCadastroByImovel.set(id, score);
  }

  // 5) Processar inadimplência por imóvel
  const auxAgg = new Map<string, any[]>();

  for (const f of data.faturas) {
    const imovelId = data.faturaImovel.get(f.medicao_id);
    if (!imovelId || !imovelIds.includes(imovelId)) continue;

    const venc = new Date(
      f.vencimento_atual ?? f.vencimento_original ?? vMesISO
    );
    const valTotal = Number(
      f.valor_total ??
        Number(f.valor_agua ?? 0) +
          Number(f.valor_esgoto ?? 0) +
          Number(f.valor_debitos ?? 0) -
          Number(f.valor_creditos ?? 0) +
          Number(f.valor_impostos ?? 0)
    );
    const pay = data.payByFat.get(f.id);
    const pago = Number(pay?.valor_pago ?? 0);
    const dtPag = pay?.data_pagamento ? new Date(pay.data_pagamento) : null;

    let atraso = 0;
    if (venc) {
      if (dtPag && dtPag > venc)
        atraso = Math.round(
          (dtPag.getTime() - venc.getTime()) / (1000 * 60 * 60 * 24)
        );
      else if (!dtPag)
        atraso = Math.round(
          (vFim.getTime() - venc.getTime()) / (1000 * 60 * 60 * 24)
        );
    }
    const abertoNoFim = pago < valTotal && (!dtPag || dtPag >= vFim);
    const abertoNoTitulo = Math.max(0, valTotal - pago);

    if (!auxAgg.has(imovelId)) auxAgg.set(imovelId, []);
    auxAgg.get(imovelId)!.push({ atraso, abertoNoFim, abertoNoTitulo });
  }

  // 6) Calcular idade do hidrômetro
  function idadeMeses(imovelId: string) {
    const diStr = data.lastInstByImovel.get(imovelId);
    if (!diStr) return 0;
    const di = new Date(diStr);
    let months =
      (vFim.getUTCFullYear() - di.getUTCFullYear()) * 12 +
      (vFim.getUTCMonth() - di.getUTCMonth());
    if (months < 0) months = 0;
    return months;
  }

  // 7) Montar linhas para upsert
  const rowsToUpsert: any[] = [];
  for (const imv of data.imoveis) {
    const id = imv.id;
    const w = resolveWeightsForImovel(id);

    // Cadastro
    const scoreCad = scoreCadastroByImovel.get(id) ?? 0;

    // Inadimplência
    const faturas = auxAgg.get(id) || [];
    const { score: scoreInad } = computeInadimplenciaScore(faturas, {
      w_atraso: w.w_atraso,
      w_indice: w.w_indice,
      w_valor_aberto: w.w_valor_aberto,
    });

    // Medição
    const scoreMed = computeMedicaoScore({
      sitLigacaoAgua: data.sitAguaByImovel.get(id) || "",
      consumoHistorico: data.consHistByImovel.get(id) || [],
      anomaliasCount: data.anomCountByImovel.get(id) ?? 0,
      observacoesCount: data.obsCountByImovel.get(id) ?? 0,
      idadeMeses: idadeMeses(id),
      weights: {
        w_idade: w.w_idade,
        w_anomalias: w.w_anomalias,
        w_desvio: w.w_desvio,
      },
    });

    // Nível e mensagem
    const { scoreTotal, nivel, mensagem } = computeRiskLevel({
      scoreCadastro: scoreCad,
      scoreInadimplencia: scoreInad,
      scoreMedicao: scoreMed,
    });

    rowsToUpsert.push({
      imovel_id: id,
      periodo: vMesISO,
      score_cadastro: round2(scoreCad),
      score_inadimplencia: round2(Math.max(0, Math.min(100, scoreInad))),
      score_medicao: round2(Math.max(0, Math.min(100, scoreMed))),
      score_total: round2(scoreTotal),
      nivel,
      mensagem,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  return { rowsToUpsert, imovelIds, setoresFiltro, grupoId };
}

function round2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

