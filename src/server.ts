// server.ts
// -------------------------------------------------------
// API de cálculo por estratégia de RANGES + POLICY local
// -------------------------------------------------------
// Requisitos de env:
// - OPENAI_API_KEY
// - SUPABASE_URL
// - SUPABASE_SERVICE_KEY
// - ASSISTANT_ID (assistant com o prompt e response format novos)

import "dotenv/config";
import express, { Request, Response } from "express";
import OpenAI from "openai";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// -----------------------------
// Tipagens (policy e dados)
// -----------------------------

// Regra por pedaços para uma feature (igual ao $defs/piecewise_rule)
type PiecewiseRule = {
  feature: string;
  breaks: number[];          // limites crescentes (N)
  values: number[];          // tamanho N+1, valores 0..1
  higher_is_risk: boolean;   // informativo; mapping já traz 0..1 calibrado
};

// Estrutura da policy retornada pelo assistant
type PotencialReceitaPolicy = {
  policy_id: string;
  periodo: string;
  weights: {
    cadastro: number;
    medicao: number;
    inadimplencia: number;
  };
  mappings: {
    cadastro: PiecewiseRule[];
    medicao: PiecewiseRule[];
    inadimplencia: PiecewiseRule[];
  };
  penalties?: {
    inadimplencia_score_penalty?: {
      trigger_feature: string;
      trigger_threshold: number;
      curve: "linear" | "log";
      max_penalty: number;
    };
  };
  classification: {
    score_thresholds: {
      baixo: number;  // ex.: 40
      medio: number;  // ex.: 70
      alto: number;   // ex.: 100
    };
    nenhum_if_all_potentials_below: number; // ex.: 0.05
  };
  templates: {
    motivo: Record<"MEDICAO_DOMINANTE" | "CADASTRO_DOMINANTE" | "INAD_ALTA" | "DADOS_INSUFICIENTES" | "BALANCEADO", string>;
    acao_sugerida: Record<"MEDICAO_DOMINANTE" | "CADASTRO_DOMINANTE" | "INAD_ALTA" | "DADOS_INSUFICIENTES" | "BALANCEADO", string>;
    justificativa_curta: Record<"MEDICAO_DOMINANTE" | "CADASTRO_DOMINANTE" | "INAD_ALTA" | "DADOS_INSUFICIENTES" | "BALANCEADO", string>;
  };
  meta: {
    validity_days: number;
    notes?: string;
  };
};

// Registro vindo do Supabase (ajuste os nomes conforme seu schema real)
type ImovelAgregado = {
  imovel_id: string;
  periodo: string; // YYYY-MM-DD
  setor: string;
  meter_age_years?: number | null;
  anomaly_rate?: number | null;           // 0..1
  consumption_cv?: number | null;         // 0..?
  inconsistencias_rate?: number | null;   // 0..1
  delinquency_days?: number | null;       // dias
  open_invoices_count?: number | null;
  open_amount_ratio?: number | null;      // 0..1
  // ... outros campos que não usamos no cálculo
};

// Saída a persistir
type PotencialOutput = {
  imovel_id: string;
  periodo: string;
  potencial_score: number | null;
  potencial_nivel: "NENHUM" | "BAIXO" | "MEDIO" | "ALTO" | null;
  potencial_cadastro: number | null;
  potencial_medicao: number | null;
  potencial_inadimplencia: number | null;
  motivo: string;
  acao_sugerida: string;
  justificativa_curta: string;
  erro: string | null; // JSON string de auditoria quando houver
};

// -----------------------------
// Setup
// -----------------------------

const app = express();
app.use(express.json());
const PORT = Number(process.env.PORT || 3000);

const supabase: SupabaseClient = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ASSISTANT_ID = process.env.ASSISTANT_ID!;

// Cache simples em memória de policy por (periodo,setor)
const policyCache = new Map<string, { policy: PotencialReceitaPolicy; cachedAt: number }>();

// -----------------------------
// Utilidades diversas
// -----------------------------

// Valida UUID
function isValidUUID(uuid?: string | null): boolean {
  if (!uuid || typeof uuid !== "string") return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
}

// Valida período YYYY-MM-DD
function isValidPeriod(periodo?: string | null): boolean {
  if (!periodo || typeof periodo !== "string") return false;
  return /^\d{4}-\d{2}-\d{2}$/.test(periodo);
}

// Cria auditoria de erro em string JSON
function criarAuditoriaErro(
  tipoErro: string,
  dadosOriginais: unknown,
  erro: unknown,
  contexto: Record<string, unknown> = {}
): string {
  const e = (erro as any) || {};
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    tipo_erro: tipoErro,
    erro_mensagem: e.message || String(erro),
    dados_originais: dadosOriginais,
    contexto,
    stack_trace: e.stack || null,
  });
}

// Arredonda p/ 2 casas
const round2 = (n: number) => Math.round(n * 100) / 100;

// Pega valor numérico seguro (fallback 0)
const num = (v: number | null | undefined, fallback = 0) => (Number.isFinite(v as number) ? Number(v) : fallback);

// -----------------------------
// BUSCA de dados no Supabase
// -----------------------------

async function buscarImoveis(periodo: string, setor: string): Promise<ImovelAgregado[]> {
  const { data, error } = await supabase
    .from("imovel_historico_agregado")
    .select("*")
    .eq("periodo", periodo)
    .eq("setor", setor);

  if (error) throw error;
  return (data || []) as ImovelAgregado[];
}

// -----------------------------
// RANGES (histogramas) para o assistant
// -----------------------------

// Quebras default por feature (ajuste conforme sua realidade)
// Obs.: mantenha poucas faixas para reduzir tokens.
const DEFAULT_BREAKS: Record<string, number[]> = {
  meter_age_years: [5, 10, 15],
  anomaly_rate: [0.03, 0.07, 0.12],
  consumption_cv: [0.10, 0.25, 0.40],
  inconsistencias_rate: [0.10, 0.30, 0.50],
  delinquency_days: [30, 90, 180],
  open_invoices_count: [1, 3, 6],
  open_amount_ratio: [0.10, 0.30, 0.60],
};

// Monta bins [null,b1], [b1,b2], ..., [bN,null]
function buildRangesFromBreaks(breaks: number[]): Array<[number | null, number | null]> {
  const arr: Array<[number | null, number | null]> = [];
  if (!breaks.length) return [[null, null]];
  arr.push([null, breaks[0]]);
  for (let i = 0; i < breaks.length - 1; i++) {
    arr.push([breaks[i], breaks[i + 1]]);
  }
  arr.push([breaks[breaks.length - 1], null]);
  return arr;
}

// Calcula contagem por bin
function histogram(values: number[], breaks: number[]) {
  const ranges = buildRangesFromBreaks(breaks);
  const counts = new Array(ranges.length).fill(0);
  for (const v of values) {
    let idx = -1;
    // Semântica: (a,b] para bins internos; (-inf,b1], (b1,b2], ... (bN,+inf)
    for (let i = 0; i < ranges.length; i++) {
      const [a, b] = ranges[i];
      const okLower = a === null ? true : v > a;
      const okUpper = b === null ? true : v <= b;
      if (okLower && okUpper) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) counts[idx]++;
  }
  return ranges.map((r, i) => ({ range: r, count: counts[i] }));
}

// Constrói payload agregado compacto para o assistant
function buildAggregatedPayload(periodo: string, imoveis: ImovelAgregado[]) {
  const features: Record<string, any[]> = {};
  const featureNames = Object.keys(DEFAULT_BREAKS);

  for (const fname of featureNames) {
    const breaks = DEFAULT_BREAKS[fname];
    const values = imoveis
      .map((r) => num((r as any)[fname], NaN))
      .filter((v) => Number.isFinite(v));
    const bins = histogram(values, breaks);
    features[fname] = bins.map((b) => ({
      range: b.range,
      count: b.count,
    }));
  }

  return {
    periodo,
    features,
    stats: {
      pop_total: imoveis.length,
    },
  };
}

// -----------------------------
// Chamada ao assistant (pega policy)
// -----------------------------

async function obterPolicyPorRanges(aggregatedPayload: any): Promise<PotencialReceitaPolicy> {
  // Cache por período (você pode incluir setor no cache key se desejar políticas por setor)
  const cacheKey = aggregatedPayload.periodo;
  const cached = policyCache.get(cacheKey);
  if (cached) {
    // Mantém simples: ignora validade; ou valide via meta.validity_days
    return cached.policy;
  }

  const thread = await openai.beta.threads.create();
  await openai.beta.threads.messages.create(thread.id, {
    role: "user",
    content: JSON.stringify(aggregatedPayload),
  });

  let run = await openai.beta.threads.runs.create(thread.id, {
    assistant_id: ASSISTANT_ID,
  });

  while (run.status !== "completed" && run.status !== "failed") {
    await new Promise((r) => setTimeout(r, 1000));
    run = await openai.beta.threads.runs.retrieve(thread.id, run.id);
  }

  if (run.status === "failed") {
    throw new Error("Assistant failed to create policy from ranges");
  }

  const messages = await openai.beta.threads.messages.list(thread.id);
  const last = messages.data.find((m) => m.role === "assistant");
  const raw = last?.content?.[0] && (last.content[0] as any).text?.value;
  if (!raw) throw new Error("Empty assistant response");

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    throw new Error(`Policy JSON parse error: ${e.message}`);
  }

  // Aqui assumimos que o assistant respeita o schema estrito
  policyCache.set(cacheKey, { policy: parsed as PotencialReceitaPolicy, cachedAt: Date.now() });
  return parsed as PotencialReceitaPolicy;
}

// -----------------------------
// Aplicação da policy por imóvel
// -----------------------------

// Avalia uma peça piecewise (retorna 0..1). Se valor ausente → 0.
function evalPiecewise(rule: PiecewiseRule, row: ImovelAgregado): number {
  const vRaw = (row as any)[rule.feature] as number | null | undefined;
  if (!Number.isFinite(vRaw as number)) return 0;
  const v = Number(vRaw);
  const ranges = buildRangesFromBreaks(rule.breaks);

  // Mesma semântica dos bins do histograma: (-inf,b1], (b1,b2], ..., (bN,+inf)
  let idx = -1;
  for (let i = 0; i < ranges.length; i++) {
    const [a, b] = ranges[i];
    const okLower = a === null ? true : v > a;
    const okUpper = b === null ? true : v <= b;
    if (okLower && okUpper) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return 0;

  const val = rule.values[idx];
  // values já vêm calibrados 0..1 pelo assistant; apenas garante limites
  return Math.max(0, Math.min(1, Number(val)));
}

// Agrega múltiplas rules de uma família (cadastro/medicao/inadimplencia) como média simples
function familyPotential(rules: PiecewiseRule[], row: ImovelAgregado): { value: number; missing: boolean } {
  if (!rules || !rules.length) return { value: 0, missing: true };
  let sum = 0;
  let used = 0;
  let anyMissing = false;

  for (const r of rules) {
    const raw = (row as any)[r.feature];
    const has = Number.isFinite(raw as number);
    const score = evalPiecewise(r, row);
    if (has) {
      sum += score;
      used++;
    } else {
      anyMissing = true;
    }
  }

  if (!used) return { value: 0, missing: true };
  return { value: sum / used, missing: anyMissing };
}

function classifyScore(score: number, policy: PotencialReceitaPolicy, cad: number, med: number, inad: number): "NENHUM" | "BAIXO" | "MEDIO" | "ALTO" {
  const thr = policy.classification.score_thresholds;
  const allBelow = cad < policy.classification.nenhum_if_all_potentials_below
    && med < policy.classification.nenhum_if_all_potentials_below
    && inad < policy.classification.nenhum_if_all_potentials_below;
  if (allBelow) return "NENHUM";
  if (score < thr.baixo) return "BAIXO";
  if (score < thr.medio) return "MEDIO";
  return "ALTO";
}

function pickTemplateKey(cad: number, med: number, inad: number, anyMissing: boolean): "MEDICAO_DOMINANTE" | "CADASTRO_DOMINANTE" | "INAD_ALTA" | "DADOS_INSUFICIENTES" | "BALANCEADO" {
  if (anyMissing) return "DADOS_INSUFICIENTES";
  if (inad < 0.3) return "INAD_ALTA";
  if (med > cad && med - cad > 0.1) return "MEDICAO_DOMINANTE";
  if (cad > med && cad - med > 0.1) return "CADASTRO_DOMINANTE";
  return "BALANCEADO";
}

function applyPenalty(baseScore01: number, row: ImovelAgregado, policy: PotencialReceitaPolicy): number {
  const pen = policy.penalties?.inadimplencia_score_penalty;
  if (!pen) return baseScore01;

  const vRaw = (row as any)[pen.trigger_feature] as number | null | undefined;
  if (!Number.isFinite(vRaw as number)) return baseScore01;

  const v = Number(vRaw);
  if (v <= pen.trigger_threshold) return baseScore01;

  // Implementação simples: penalidade fixa ao cruzar o limiar (mantendo no intervalo 0..1)
  // TODO: se necessário, evoluir para curva linear/log com escala definida.
  const penalized = Math.max(0, baseScore01 - num(pen.max_penalty, 0.1));
  return penalized;
}

// Converte uma policy + linha em PotencialOutput
function calcularPotenciais(row: ImovelAgregado, policy: PotencialReceitaPolicy): PotencialOutput {
  const cad = familyPotential(policy.mappings.cadastro, row);
  const med = familyPotential(policy.mappings.medicao, row);
  const ina = familyPotential(policy.mappings.inadimplencia, row);

  let score01 = policy.weights.cadastro * cad.value
    + policy.weights.medicao * med.value
    + policy.weights.inadimplencia * ina.value;

  score01 = applyPenalty(score01, row, policy);

  const score100 = Math.max(0, Math.min(100, score01 * 100));
  const nivel = classifyScore(score100, policy, cad.value, med.value, ina.value);

  const anyMissing = cad.missing || med.missing || ina.missing;
  const templateKey = pickTemplateKey(cad.value, med.value, ina.value, anyMissing);

  const motivo = policy.templates.motivo[templateKey] || "";
  const acao = policy.templates.acao_sugerida[templateKey] || "";
  const justificativa = policy.templates.justificativa_curta[templateKey] || "";

  return {
    imovel_id: row.imovel_id,
    periodo: row.periodo,
    potencial_score: round2(score100),
    potencial_nivel: nivel,
    potencial_cadastro: round2(cad.value),
    potencial_medicao: round2(med.value),
    potencial_inadimplencia: round2(ina.value),
    motivo,
    acao_sugerida: acao,
    justificativa_curta: justificativa,
    erro: null,
  };
}

// -----------------------------
// Persistência (com validação e auditoria)
// -----------------------------

async function salvarPotenciais(items: PotencialOutput[]): Promise<void> {
  if (!items?.length) return;

  const valid: PotencialOutput[] = [];
  const invalid: PotencialOutput[] = [];

  for (const it of items) {
    const errs: string[] = [];
    if (!isValidUUID(it.imovel_id)) errs.push(`UUID inválido: ${it.imovel_id}`);
    if (!isValidPeriod(it.periodo)) errs.push(`Período inválido: ${it.periodo}`);
    if (errs.length) {
      invalid.push({
        ...it,
        potencial_score: null,
        potencial_nivel: null,
        potencial_cadastro: null,
        potencial_medicao: null,
        potencial_inadimplencia: null,
        motivo: "",
        acao_sugerida: "",
        justificativa_curta: "",
        erro: criarAuditoriaErro("VALIDACAO_FALHOU", it, new Error(errs.join("; ")), { imovel_id: it.imovel_id, periodo: it.periodo }),
      });
    } else {
      valid.push(it);
    }
  }

  const dedup = new Map<string, PotencialOutput>();
  for (const v of valid) {
    const k = `${v.imovel_id}-${v.periodo}`;
    if (!dedup.has(k)) dedup.set(k, v);
  }
  const toUpsert = Array.from(dedup.values());

  // Upsert em lote
  if (toUpsert.length) {
    const { error } = await supabase
      .from("potencial_receita_imovel")
      .upsert(toUpsert, { onConflict: "imovel_id,periodo", ignoreDuplicates: false });

    if (error) {
      // fallback por registro para identificar erro
      for (const v of toUpsert) {
        const { error: e } = await supabase
          .from("potencial_receita_imovel")
          .upsert([v], { onConflict: "imovel_id,periodo", ignoreDuplicates: false });
        if (e) {
          const auditoria = criarAuditoriaErro("UPSERT_INDIVIDUAL_FALHOU", v, e, { imovel_id: v.imovel_id, periodo: v.periodo });
          await supabase
            .from("potencial_receita_imovel")
            .upsert([{ ...v, erro: auditoria }], { onConflict: "imovel_id,periodo", ignoreDuplicates: false });
        }
      }
    }
  }

  // Persiste inválidos (para rastreabilidade)
  if (invalid.length) {
    await supabase
      .from("potencial_receita_imovel")
      .upsert(invalid, { onConflict: "imovel_id,periodo", ignoreDuplicates: false });
  }
}

// -----------------------------
// Rotas
// -----------------------------

app.get("/healthz", (_req: Request, res: Response) => res.json({ ok: true }));

// Consulta erros gravados
app.get("/erros", async (req: Request, res: Response) => {
  try {
    const { limit = "50", offset = "0", tipo_erro } = req.query as Record<string, string>;
    const lim = Math.max(1, Math.min(500, Number(limit)));
    const off = Math.max(0, Number(offset));

    let query = supabase
      .from("potencial_receita_imovel")
      .select("*")
      .not("erro", "is", null)
      .order("created_at", { ascending: false })
      .range(off, off + lim - 1);

    const { data, error } = await query;
    if (error) return res.status(500).json({ erro: error.message });

    const dadosFiltrados = tipo_erro
      ? (data || []).filter((r: any) => {
          try {
            const o = JSON.parse(r.erro);
            return o.tipo_erro === tipo_erro;
          } catch {
            return false;
          }
        })
      : (data || []);

    res.json({ total: dadosFiltrados.length, limit: lim, offset: off, dados: dadosFiltrados });
  } catch (err: any) {
    res.status(500).json({ erro: err.message });
  }
});

// Gera filtros (como no seu webhook)
app.post("/webhook", (req: Request, res: Response) => {
  try {
    const { ano, mes, setores } = req.body || {};
    if (!ano || !mes || !setores) return res.status(400).json({ erro: "Faltam parâmetros: ano, mes ou setores" });

    const periodo = `${ano}-${String(mes).padStart(2, "0")}-01`;
    const filtros = (setores as string[]).map((setor) => ({ periodo, setor }));
    res.json({ filtros });
  } catch (err: any) {
    res.status(500).json({ erro: err.message });
  }
});

// Rodar cálculo por período/setor usando RANGES + POLICY
app.get("/rodar/:ano/:mes/:setor", async (req: Request, res: Response) => {
  try {
    const { ano, mes, setor } = req.params;
    const periodo = `${ano}-${String(mes).padStart(2, "0")}-01`;

    // 1) Buscar imóveis
    const imoveis = await buscarImoveis(periodo, setor);
    if (!imoveis.length) return res.status(404).json({ erro: "Nenhum imóvel encontrado" });

    // 2) Construir payload agregado (ranges/histogramas)
    const aggregated = buildAggregatedPayload(periodo, imoveis);

    // 3) Obter policy do assistant (cache em memória)
    const policy = await obterPolicyPorRanges(aggregated);

    // 4) Calcular localmente por imóvel (determinístico)
    const outputs: PotencialOutput[] = imoveis.map((row) => {
      try {
        return calcularPotenciais(row, policy);
      } catch (err: any) {
        return {
          imovel_id: row.imovel_id,
          periodo: row.periodo,
          potencial_score: null,
          potencial_nivel: null,
          potencial_cadastro: null,
          potencial_medicao: null,
          potencial_inadimplencia: null,
          motivo: "",
          acao_sugerida: "",
          justificativa_curta: "",
          erro: criarAuditoriaErro("CALCULO_FALHOU", row, err),
        };
      }
    });

    // 5) Persistir resultados (com validação/erros)
    await salvarPotenciais(outputs);

    res.json({
      periodo,
      setor,
      total_imoveis: imoveis.length,
      policy_id: policy.policy_id,
      processados: outputs.length,
    });
  } catch (err: any) {
    res.status(500).json({ erro: err.message });
  }
});

// -----------------------------
// Start
// -----------------------------
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
