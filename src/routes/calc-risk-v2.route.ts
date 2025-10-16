import { Router } from "express";
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { resolveSetoresFromGroup } from "../helpers";

export const calcRiskV2Router = Router();

/* ============================================================
 * Tipos de dados
 * ============================================================ */

export type UUID = string;

export interface RiskParamsResolved {
  w_atraso: number;
  w_indice: number;
  w_valor_aberto: number;
  w_idade: number;
  w_anomalias: number;
  w_desvio: number;
  fator_normalizacao: number;
}

export interface HistoricoAgregado {
  imovel_id: UUID;
  periodo: string;               // YYYY-MM-01
  janela_meses: number;
  sit_ligacao_agua: string | null;
  municipio: string | null;
  setor: string | null;
  categoria: string | null;

  // Cadastro
  media_consumo_por_economia: number | null;
  zscore_consumo_categoria: number | null;

  // Medição
  idade_hidrometro_meses: number | null;
  taxa_anomalias: number | null;
  coef_var_consumo: number | null;

  // Inadimplência
  media_tempo_atraso: number | null;
  indice_inadimplencia: number | null;
  valor_total_aberto: number | null;
}

export interface RiskScores {
  imovel_id: UUID;
  periodo: string;
  score_cadastro: number;
  score_medicao: number;
  score_inadimplencia: number;
  score_total: number;
  nivel: 'OK' | 'ATENCAO' | 'RISCO';
  // diagnósticos úteis
  zscore_cadastro: number;
  idade_hidrometro_dias: number;
  taxa_anomalias: number;
  desvio_consumo: number;
  tempo_medio_atraso: number;
  indice_inadimplencia: number;
  valor_em_aberto: number;
}

/* ============================================================
 * Utils
 * ============================================================ */

// Normaliza para 0–100 com duas casas
function clamp100(x: number): number {
  const v = Math.max(0, Math.min(100, x));
  return Math.round(v * 100) / 100;
}

// Classificação de risco conforme documentação (score_total já 0–100)
function classify(scoreTotal: number): 'OK' | 'ATENCAO' | 'RISCO' {
  if (scoreTotal < 40) return 'OK';
  if (scoreTotal < 70) return 'ATENCAO';
  return 'RISCO';
}

// YYYY-MM-01 (date) -> "YYYY-MM" (string) para bater com o padrão do nome
function toYYYYMM(periodo: string | Date): string {
  const d = new Date(periodo);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// Monta sufixo "::YYYY-MM::Xm"
function suffix(periodoYYYYMM: string, janelaMeses: number): string {
  return `::${periodoYYYYMM}::${janelaMeses}m`;
}

/* ============================================================
 * Leitura de parâmetros (com padrões distintos por tabela)
 * ============================================================
 *
 * - parametros_risco_grupo.nome => "[KEY]::[PERIODO]::[JANELA]m"
 * - parametros_risco.nome       => "[SETOR]__[KEY]::[PERIODO]::[JANELA]m"
 *
 * Chaves esperadas: w_atraso, w_indice, w_valor_aberto, w_idade, w_anomalias,
 *                   w_desvio, fator_normalizacao
 *
 * Regras:
 *   1) Tenta parâmetros por SETOR (parametros_risco).
 *   2) Se ausente, tenta parâmetros por GRUPO (parametros_risco_grupo).
 *   3) Se ausente, aplica defaults seguros.
 */

const EXPECTED_KEYS = [
  'w_atraso',
  'w_indice',
  'w_valor_aberto',
  'w_idade',
  'w_anomalias',
  'w_desvio',
  'fator_normalizacao',
] as const;

type ExpectedKey = typeof EXPECTED_KEYS[number];

async function fetchResolvedParams(
  client: SupabaseClient,
  setor: string | null,
  grupoId: UUID | null,
  periodo: string,        // YYYY-MM-01
  janelaMeses: number
): Promise<RiskParamsResolved> {
  const periodKey = toYYYYMM(periodo);
  const nameSuffix = suffix(periodKey, janelaMeses);

  // Defaults caso não exista nada no banco
  const defaults: RiskParamsResolved = {
    w_atraso: 1,
    w_indice: 1,
    w_valor_aberto: 1,
    w_idade: 1,
    w_anomalias: 1,
    w_desvio: 1,
    fator_normalizacao: 10,
  };

  // 1) Busca por SETOR em parametros_risco
  let bySector: Partial<Record<ExpectedKey, number>> = {};
  if (setor) {
    const { data: pr, error: e1 } = await client
      .from('parametros_risco')
      .select('nome, valor_num, ativo')
      .eq('ativo', true);

    if (e1) throw e1;

    // Filtra apenas os que casam com "[SETOR]__[KEY]::YYYY-MM::Xm"
    pr?.forEach((row) => {
      const nome: string = row.nome;
      if (!nome.startsWith(`${setor}__`)) return;
      if (!nome.endsWith(nameSuffix)) return;
      const inner = nome.slice((setor + '__').length, nome.length - nameSuffix.length); // KEY
      if ((EXPECTED_KEYS as readonly string[]).includes(inner) && typeof row.valor_num === 'number') {
        bySector[inner as ExpectedKey] = row.valor_num as number;
      }
    });
  }

  // 2) Busca por GRUPO em parametros_risco_grupo (apenas keys ausentes)
  let byGroup: Partial<Record<ExpectedKey, number>> = {};
  if (grupoId) {
    const { data: prg, error: e2 } = await client
      .from('parametros_risco_grupo')
      .select('grupo_id, nome, valor_num, ativo')
      .eq('grupo_id', grupoId)
      .eq('ativo', true);

    if (e2) throw e2;

    prg?.forEach((row) => {
      const nome: string = row.nome; // "[KEY]::YYYY-MM::Xm"
      if (!nome.endsWith(nameSuffix)) return;
      const key = nome.slice(0, nome.length - nameSuffix.length); // KEY
      if ((EXPECTED_KEYS as readonly string[]).includes(key) && typeof row.valor_num === 'number') {
        byGroup[key as ExpectedKey] = row.valor_num as number;
      }
    });
  }

  // 3) Mescla: setor > grupo > default
  const merged: RiskParamsResolved = {
    w_atraso: bySector.w_atraso ?? byGroup.w_atraso ?? defaults.w_atraso,
    w_indice: bySector.w_indice ?? byGroup.w_indice ?? defaults.w_indice,
    w_valor_aberto: bySector.w_valor_aberto ?? byGroup.w_valor_aberto ?? defaults.w_valor_aberto,
    w_idade: bySector.w_idade ?? byGroup.w_idade ?? defaults.w_idade,
    w_anomalias: bySector.w_anomalias ?? byGroup.w_anomalias ?? defaults.w_anomalias,
    w_desvio: bySector.w_desvio ?? byGroup.w_desvio ?? defaults.w_desvio,
    fator_normalizacao: bySector.fator_normalizacao ?? byGroup.fator_normalizacao ?? defaults.fator_normalizacao,
  };

  return merged;
}

/* ============================================================
 * Mapeamentos auxiliares: setor -> grupo_id
 * ============================================================ */

async function fetchSetorToGrupoId(client: SupabaseClient): Promise<Record<string, UUID>> {
  const { data, error } = await client.from('setor_grupo').select('setor, grupo_id');
  if (error) throw error;
  const map: Record<string, UUID> = {};
  (data ?? []).forEach((row) => {
    if (row.setor) map[row.setor] = row.grupo_id;
  });
  return map;
}

/* ============================================================
 * Leitura base: imovel_historico_agregado + imovel (para situacao água)
 * ============================================================ */

async function fetchHistorico(
  client: SupabaseClient,
  periodo: string,        // YYYY-MM-01
  janelaMeses: number
): Promise<HistoricoAgregado[]> {
  console.log(`[fetchHistorico] Buscando dados para periodo=${periodo}, janela=${janelaMeses}`);
  
  // Busca os agregados no período/janela (sem join, pega campos diretos da tabela)
  const { data, error } = await client
    .from('imovel_historico_agregado')
    .select('*')
    .eq('periodo', periodo)
    .eq('janela_meses', janelaMeses);

  if (error) {
    console.error('[fetchHistorico] Erro ao buscar dados:', error);
    throw error;
  }

  console.log(`[fetchHistorico] Encontrados ${data?.length ?? 0} registros`);
  if (data && data.length > 0) {
    console.log('[fetchHistorico] Exemplo de registro:', {
      imovel_id: data[0]?.imovel_id,
      setor: data[0]?.setor,
      sit_ligacao_agua: data[0]?.sit_ligacao_agua,
      periodo: data[0]?.periodo,
    });
  }

  // Normaliza shape (usa campos diretos da tabela agregada)
  return (data ?? []).map((row: any) => ({
    imovel_id: row.imovel_id,
    periodo: row.periodo,
    janela_meses: row.janela_meses,
    sit_ligacao_agua: row.sit_ligacao_agua ?? null,
    municipio: row.municipio ?? null,
    setor: row.setor ?? null,
    categoria: row.categoria ?? null,
    media_consumo_por_economia: num(row.media_consumo_por_economia),
    zscore_consumo_categoria: num(row.zscore_consumo_categoria),
    idade_hidrometro_meses: num(row.idade_hidrometro_meses),
    taxa_anomalias: num(row.taxa_anomalias),
    coef_var_consumo: num(row.coef_var_consumo),
    media_tempo_atraso: num(row.media_tempo_atraso),
    indice_inadimplencia: num(row.indice_inadimplencia),
    valor_total_aberto: num(row.valor_total_aberto),
  }));
}

function num(x: any): number | null {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

/* ============================================================
 * Cálculo de riscos para um imóvel (record) + parâmetros
 * ============================================================ */

function computeScoresForRecord(
  h: HistoricoAgregado,
  p: RiskParamsResolved
): RiskScores {
  // Cadastro
  const zCad = h.zscore_consumo_categoria ?? 0;
  const scoreCadastro =
    h.sit_ligacao_agua === 'ATIVA'
      ? Math.abs(zCad) * (p.fator_normalizacao ?? 10)
      : 0;

  // Medição
  const idadeDias = (h.idade_hidrometro_meses ?? 0) * 30.0;
  const tAnom = h.taxa_anomalias ?? 0;
  const desv = h.coef_var_consumo ?? 0;
  const wDenMed = (p.w_idade ?? 1) + (p.w_anomalias ?? 1) + (p.w_desvio ?? 1);
  const scoreMedicao =
    h.sit_ligacao_agua === 'ATIVA'
      ? (idadeDias * (p.w_idade ?? 1) + tAnom * (p.w_anomalias ?? 1) + desv * (p.w_desvio ?? 1)) /
        (wDenMed || 1)
      : 0;

  // Inadimplência
  const tAtraso = h.media_tempo_atraso ?? 0;
  const indInad = h.indice_inadimplencia ?? 0;
  const vAberto = h.valor_total_aberto ?? 0;
  const wDenInad = (p.w_atraso ?? 1) + (p.w_indice ?? 1) + (p.w_valor_aberto ?? 1);
  const scoreInad =
    (tAtraso * (p.w_atraso ?? 1) + indInad * (p.w_indice ?? 1) + vAberto * (p.w_valor_aberto ?? 1)) /
    (wDenInad || 1);

  // Total (antes de normalizar)
  const totalRaw = scoreCadastro + scoreMedicao - scoreInad;

  // Normalizações finais 0–100
  const score_cadastro = clamp100(scoreCadastro);
  const score_medicao = clamp100(scoreMedicao);
  const score_inadimplencia = clamp100(scoreInad);
  const score_total = clamp100(totalRaw);
  const nivel = classify(score_total);

  return {
    imovel_id: h.imovel_id,
    periodo: h.periodo,
    score_cadastro,
    score_medicao,
    score_inadimplencia,
    score_total,
    nivel,
    zscore_cadastro: zCad ?? 0,
    idade_hidrometro_dias: idadeDias,
    taxa_anomalias: tAnom,
    desvio_consumo: desv,
    tempo_medio_atraso: tAtraso,
    indice_inadimplencia: indInad,
    valor_em_aberto: vAberto,
  };
}

/* ============================================================
 * API principal: calcula para todos os imóveis do período/janela
 * e (opcional) persiste nas tabelas de saída.
 * ============================================================ */

export interface ComputeOptions {
  persistRisk?: boolean;       // grava em risco_imovel_mensal
  persistPotential?: boolean;  // grava em potencial_receita_imovel (numéricos)
}

export async function computeRisksForPeriod(
  supabaseUrl: string,
  supabaseServiceKey: string,
  periodo: string,     // ex: '2025-09-01'
  janelaMeses = 12,
  options: ComputeOptions = {}
): Promise<RiskScores[]> {
  console.log(`[computeRisksForPeriod] Iniciando cálculo para periodo=${periodo}, janela=${janelaMeses}`);
  const client = createClient(supabaseUrl, supabaseServiceKey, { auth: { persistSession: false } });

  // 1) Carrega mapeamento setor -> grupo_id (para buscar parametros por grupo quando necessário)
  const setorToGrupo = await fetchSetorToGrupoId(client);
  console.log(`[computeRisksForPeriod] Mapeamento setor->grupo carregado: ${Object.keys(setorToGrupo).length} setores`);

  // 2) Carrega agregados por imóvel
  const historicos = await fetchHistorico(client, periodo, janelaMeses);
  console.log(`[computeRisksForPeriod] Total de históricos carregados: ${historicos.length}`);

  // 3) Para cada imóvel, resolve parâmetros (setor/grupo) e calcula
  const results: RiskScores[] = [];
  for (const h of historicos) {
    const grupoId = h.setor ? setorToGrupo[h.setor] ?? null : null;
    const params = await fetchResolvedParams(client, h.setor, grupoId, periodo, janelaMeses);
    const scores = computeScoresForRecord(h, params);
    results.push(scores);
  }
  console.log(`[computeRisksForPeriod] Total de scores calculados: ${results.length}`);

  // 4) Persistência opcional
  if (options.persistRisk && results.length) {
    console.log(`[computeRisksForPeriod] Persistindo ${results.length} registros em risco_imovel_mensal`);
    // Upsert básico por (imovel_id, periodo)
    const payload = results.map((r) => ({
      imovel_id: r.imovel_id,
      periodo: r.periodo,
      score_cadastro: r.score_cadastro,
      score_inadimplencia: r.score_inadimplencia,
      score_medicao: r.score_medicao,
      score_total: r.score_total,
      nivel: r.nivel,
      mensagem: null as string | null,
    }));

    const { error: eRisk } = await client.from('risco_imovel_mensal').upsert(payload, {
      onConflict: 'imovel_id,periodo',
      ignoreDuplicates: false,
    });
    if (eRisk) {
      console.error('[computeRisksForPeriod] Erro ao persistir em risco_imovel_mensal:', eRisk);
      throw eRisk;
    }
    console.log('[computeRisksForPeriod] Dados persistidos em risco_imovel_mensal com sucesso');
  }

  if (options.persistPotential && results.length) {
    console.log(`[computeRisksForPeriod] Persistindo ${results.length} registros em potencial_receita_imovel`);
    // ⚠️ Apenas atualiza registros existentes, não cria novos (campos obrigatórios não preenchidos)
    // Busca registros existentes primeiro
    const imovelIds = results.map(r => r.imovel_id);
    const { data: existingRecords } = await client
      .from('potencial_receita_imovel')
      .select('imovel_id, periodo')
      .eq('periodo', results[0]?.periodo)
      .in('imovel_id', imovelIds);
    
    if (existingRecords && existingRecords.length > 0) {
      const existingSet = new Set(existingRecords.map(r => r.imovel_id));
      const payload = results
        .filter(r => existingSet.has(r.imovel_id))
        .map((r) => ({
          imovel_id: r.imovel_id,
          periodo: r.periodo,
          potencial_score: r.score_total,
          potencial_cadastro: r.score_cadastro,
          potencial_medicao: r.score_medicao,
          potencial_inadimplencia: r.score_inadimplencia,
        }));

      if (payload.length > 0) {
        const { error: ePot } = await client.from('potencial_receita_imovel').upsert(payload, {
          onConflict: 'imovel_id,periodo',
          ignoreDuplicates: false,
        });
        if (ePot) {
          console.error('[computeRisksForPeriod] Erro ao persistir em potencial_receita_imovel:', ePot);
          throw ePot;
        }
        console.log(`[computeRisksForPeriod] Atualizados ${payload.length} registros em potencial_receita_imovel`);
      } else {
        console.log('[computeRisksForPeriod] Nenhum registro existente para atualizar em potencial_receita_imovel');
      }
    } else {
      console.log('[computeRisksForPeriod] Nenhum registro existente em potencial_receita_imovel, pulando atualização');
    }
  }

  return results;
}

/**
 * POST /v2/calc-risk
 * Body:
 * {
 *   "escopo": "setor" | "grupo" | "all",
 *   "identificadores": ["101","102"] | ["<uuid-grupo>"], // opcional se escopo=all
 *   "periodo": "YYYY-MM-01",
 *   "janela_meses": 6,
 *   "reprocess": false
 * }
 */
calcRiskV2Router.post("/v2/calc-risk", async (req, res) => {
  try {
    const {
      escopo = "all",
      identificadores = [],
      periodo,
      janela_meses,
      reprocess = false,
    } = req.body ?? {};

    // Validações de entrada
    if (!periodo) {
      return res
        .status(400)
        .json({ error: "periodo (YYYY-MM-01) é obrigatório" });
    }
    if (!janela_meses || Number(janela_meses) <= 0) {
      return res.status(400).json({ error: "janela_meses deve ser > 0" });
    }
    if (!["setor", "grupo", "all"].includes(String(escopo))) {
      return res
        .status(400)
        .json({ error: "escopo deve ser 'setor' | 'grupo' | 'all'" });
    }

    // Calcular período ISO - garantir formato YYYY-MM-01
    let vMesISO: string;
    if (periodo.length === 7 && periodo.match(/^\d{4}-\d{2}$/)) {
      // Formato YYYY-MM
      vMesISO = `${periodo}-01`;
    } else if (periodo.length === 10 && periodo.match(/^\d{4}-\d{2}-\d{2}$/)) {
      // Formato YYYY-MM-DD
      vMesISO = periodo;
    } else {
      // Tenta parsear como data
      const vMes = new Date(periodo);
      if (isNaN(vMes.getTime())) {
        return res.status(400).json({ error: "Formato de período inválido. Use YYYY-MM ou YYYY-MM-DD" });
      }
      const vMonthStr = `${vMes.getUTCFullYear()}-${String(
        vMes.getUTCMonth() + 1
      ).padStart(2, "0")}`;
      vMesISO = `${vMonthStr}-01`;
    }

    console.log({
      escopo,
      identificadores,
      periodo_original: periodo,
      periodo_iso: vMesISO,
      janela_meses,
      reprocess,
    });
    console.log("Calculando risco V2 para o período", vMesISO);

    // Obter variáveis de ambiente
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: "Configuração do Supabase ausente" });
    }

    // Determinar setores para filtragem
    let setoresFiltro: string[] = [];
    let grupoId: string | null = null;

    if (escopo === "setor") {
      setoresFiltro = identificadores.map(String);
    } else if (escopo === "grupo") {
      if (!identificadores || identificadores.length === 0) {
        return res.status(400).json({ error: "escopo 'grupo' requer identificadores" });
      }
      grupoId = String(identificadores[0]);
      console.log("grupoId", grupoId);
      setoresFiltro = await resolveSetoresFromGroup(grupoId);
    }
    // escopo === "all": setoresFiltro fica vazio (não filtra)

    // Reprocess: apaga dados existentes antes de calcular
    if (reprocess) {
      console.log("Deletando dados existentes para periodo:", vMesISO);
      const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
      
      // Se não for "all", busca os imovel_ids dos setores para deletar apenas esses
      if (escopo !== "all" && setoresFiltro.length > 0) {
        console.log(`Buscando imóveis dos setores: ${setoresFiltro.join(', ')}`);
        const { data: imoveisData } = await client
          .from("imovel_historico_agregado")
          .select("imovel_id")
          .eq("periodo", vMesISO)
          .eq("janela_meses", Number(janela_meses))
          .in("setor", setoresFiltro);
        
        if (imoveisData && imoveisData.length > 0) {
          const imovelIds = imoveisData.map((r: any) => r.imovel_id);
          console.log(`Preparando para deletar ${imovelIds.length} registros em batches`);
          
          // Delete em batches de 500 para evitar timeout ou limites do Supabase
          const BATCH_SIZE = 500;
          let totalDeleted = 0;
          
          for (let i = 0; i < imovelIds.length; i += BATCH_SIZE) {
            const batch = imovelIds.slice(i, i + BATCH_SIZE);
            console.log(`Deletando batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(imovelIds.length / BATCH_SIZE)} (${batch.length} registros)`);
            
            const { error: delErr } = await client
              .from("risco_imovel_mensal")
              .delete()
              .eq("periodo", vMesISO)
              .in("imovel_id", batch);
            
            if (delErr) {
              console.error(`Erro ao deletar batch ${Math.floor(i / BATCH_SIZE) + 1}:`, delErr);
              throw delErr;
            }
            
            totalDeleted += batch.length;
            console.log(`Batch deletado. Progresso: ${totalDeleted}/${imovelIds.length}`);
          }
          
          console.log(`✓ Total de ${totalDeleted} registros deletados com sucesso`);
        } else {
          console.log("Nenhum imóvel encontrado para deletar");
        }
      } else {
        // Deleta todos os registros do período
        console.log("Deletando todos os registros do período");
        const { error: delErr } = await client
          .from("risco_imovel_mensal")
          .delete()
          .eq("periodo", vMesISO);
        
        if (delErr) {
          console.error("Erro ao deletar dados:", delErr);
          throw delErr;
        }
        console.log("Registros deletados com sucesso");
      }
    }

    // Executar cálculo de risco
    console.log("Executando cálculo de risco");
    const allResults = await computeRisksForPeriod(
      SUPABASE_URL,
      SUPABASE_SERVICE_KEY,
      vMesISO,
      Number(janela_meses),
      {
        persistRisk: true,
        persistPotential: false, // Desabilitado: tabela tem campos obrigatórios (motivo, acao_sugerida, etc)
      }
    );

    // Filtrar resultados por escopo
    let filteredResults = allResults;
    if (escopo !== "all" && setoresFiltro.length > 0) {
      // Busca os setores dos imóveis para filtrar
      const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
      const { data: historicosData } = await client
        .from("imovel_historico_agregado")
        .select("imovel_id, setor")
        .eq("periodo", vMesISO)
        .eq("janela_meses", Number(janela_meses))
        .in("setor", setoresFiltro);

      const imovelIdsNoEscopo = new Set(
        (historicosData ?? []).map((r: any) => r.imovel_id)
      );

      filteredResults = allResults.filter((r) =>
        imovelIdsNoEscopo.has(r.imovel_id)
      );
    }

    return res.json({
      periodo: vMesISO,
      janela_meses: Number(janela_meses),
      escopo,
      filtros: { setores: setoresFiltro, grupo_id: grupoId },
      result: {
        total_calculated: allResults.length,
        filtered_count: filteredResults.length,
        processed: filteredResults.length,
      },
    });
  } catch (e: any) {
    console.error("[POST /v2/calc-risk] error", e);
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
});
