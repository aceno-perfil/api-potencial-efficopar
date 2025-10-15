/**
 * Service responsável por buscar todos os dados necessários para o cálculo de risco
 */

import { supabase } from "../database/supabase";

interface FetchRiskDataParams {
  imovelIds: string[];
  vMesISO: string;
  vIni: Date;
  vFim: Date;
  setoresFiltro: string[] | null;
}

export interface RiskDataResult {
  // Imóveis
  imoveis: any[];
  setorByImovel: Map<string, string>;
  municipioByImovel: Map<string, string>;
  catByImovel: Map<string, string>;
  ecoByImovel: Map<string, number>;
  sitAguaByImovel: Map<string, string>;

  // Consumo do mês
  consumoPorImovel: Map<string, number>;

  // Score cadastro grupo
  scgMap: Map<string, { media: number; std: number }>;

  // Inadimplência
  faturaImovel: Map<string, string>;
  payByFat: Map<string, { valor_pago: number; data_pagamento: string | null }>;
  faturas: any[];

  // Medição histórica
  consHistByImovel: Map<string, number[]>;
  anomCountByImovel: Map<string, number>;
  obsCountByImovel: Map<string, number>;

  // Hidrômetro
  lastInstByImovel: Map<string, string | null>;
}

/**
 * Busca todos os dados necessários do banco para cálculo de risco
 * @param params Parâmetros com IDs e período
 * @returns Objeto estruturado com todos os dados
 */
export async function fetchRiskData(
  params: FetchRiskDataParams
): Promise<RiskDataResult> {
  const { imovelIds, vMesISO, vIni, vFim, setoresFiltro } = params;
  console.log("Fetching risk data params", params);
  try {
    // 1) Buscar imóveis do escopo
    let qImv = supabase
      .from("imovel")
      .select(
        "id, qtd_economias, categoria, sit_ligacao_agua, endereco: endereco!inner(municipio, setor)"
      )
      .order("id", { ascending: true });

    const { data: imoveisRaw, error: imvErr } = await qImv;
    if (imvErr) throw imvErr;

    // Filtra por setor (se houver filtro)
    const imoveis = (imoveisRaw ?? []).filter(
      (r: any) =>
        !setoresFiltro || setoresFiltro.includes(String(r?.endereco?.setor ?? ""))
    );

    console.log("Total de imóveis", imoveis.length);

    const setorByImovel = new Map<string, string>(
      imoveis.map((r: any) => [r.id, String(r?.endereco?.setor ?? "")])
    );
    const municipioByImovel = new Map<string, string>(
      imoveis.map((r: any) => [r.id, String(r?.endereco?.municipio ?? "")])
    );
    const catByImovel = new Map<string, string>(
      imoveis.map((r: any) => [r.id, String(r?.categoria ?? "")])
    );
    const ecoByImovel = new Map<string, number>(
      imoveis.map((r: any) => [r.id, Number(r?.qtd_economias ?? 0)])
    );
    const sitAguaByImovel = new Map<string, string>(
      imoveis.map((r: any) => [
        r.id,
        String(r?.sit_ligacao_agua ?? "").toLowerCase(),
      ])
    );

    // 2) Consumo do mês (cadastro)
    const { data: mmMes, error: mmErr } = await supabase
      .from("medicao_mensal")
      .select("imovel_id, vol_medido_agua, vol_medido_poco")
      .eq("competencia", vMesISO)
      .in("imovel_id", imovelIds);
    if (mmErr) throw mmErr;
    const consumoPorImovel = new Map<string, number>();
    (mmMes ?? []).forEach((r) => {
      consumoPorImovel.set(
        r.imovel_id,
        Number(r.vol_medido_agua ?? 0) + Number(r.vol_medido_poco ?? 0)
      );
    });

    console.log("Total de consumo por imóvel", consumoPorImovel.size);

    // 3) Score cadastro grupo
    const muniSet = new Set<string>(
      imoveis.map((r: any) => String(r?.endereco?.municipio ?? ""))
    );
    const catSet = new Set<string>(
      imoveis.map((r: any) => String(r?.categoria ?? ""))
    );
    const { data: scg, error: scgErr } = await supabase
      .from("score_cadastro_grupo")
      .select("municipio, categoria, periodo, media_grupo, std_grupo")
      .eq("periodo", vMesISO)
      .in("municipio", Array.from(muniSet))
      .in("categoria", Array.from(catSet));
    if (scgErr) throw scgErr;
    const scgMap = new Map<string, { media: number; std: number }>();
    (scg ?? []).forEach((r) => {
      scgMap.set(`${r.municipio}|||${r.categoria}`, {
        media: Number(r.media_grupo ?? 0),
        std: Number(r.std_grupo ?? 0),
      });
    });

    console.log("Total de score cadastro grupo", scgMap.size);

    // 4) Inadimplência - faturas
    const { data: fts, error: fErr, count: fCount } = await supabase
      .from("fatura")
      .select(
        "id, competencia, vencimento_atual, vencimento_original, valor_agua, valor_esgoto, valor_debitos, valor_creditos, valor_impostos, valor_total, medicao_id"
      )
      .lte("competencia", vMesISO);
    if (fErr) throw fErr;

    console.log("Total de faturas", fts?.length ?? 0);

    // Map fatura -> imovel
    const { data: mmAll, error: mmAllErr } = await supabase
      .from("medicao_mensal")
      .select("id, imovel_id")
      .in(
        "id",
        (fts ?? []).map((f) => f.medicao_id)
      );
    
      console.error("Error fetching medicao mensal", mmAllErr);

    if (mmAllErr) throw mmAllErr;
    const faturaImovel = new Map<string, string>();
    (mmAll ?? []).forEach((r) => faturaImovel.set(r.id, r.imovel_id));

    console.log("Total de faturas por imóvel", faturaImovel.size);

    // Pagamentos
    const { data: pays, error: pErr } = await supabase
      .from("pagamento")
      .select("fatura_id, valor_pago, data_pagamento")
      .in(
        "fatura_id",
        (fts ?? []).map((f) => f.id)
      );
    if (pErr) throw pErr;
    const payByFat = new Map<
      string,
      { valor_pago: number; data_pagamento: string | null }
    >();
    (pays ?? []).forEach((p) =>
      payByFat.set(p.fatura_id, {
        valor_pago: Number(p.valor_pago ?? 0),
        data_pagamento: p.data_pagamento || null,
      })
    );

    console.log("Total de pagamentos por fatura", payByFat.size);

    // 5) Medição histórica (janela)
    const { data: mmJan, error: mmJanErr } = await supabase
      .from("medicao_mensal")
      .select(
        "imovel_id, competencia, vol_medido_agua, vol_medido_poco, anomalia_leitura, anomalia_consumo"
      )
      .gte("competencia", vIni.toISOString().slice(0, 10))
      .lt("competencia", vFim.toISOString().slice(0, 10))
      .in("imovel_id", imovelIds);
    if (mmJanErr) throw mmJanErr;

    console.log("Total de medições mensais", mmJan?.length ?? 0);

    const consHistByImovel = new Map<string, number[]>();
    const anomCountByImovel = new Map<string, number>();
    const obsCountByImovel = new Map<string, number>();
    for (const r of mmJan ?? []) {
      const id = r.imovel_id;
      const cons =
        Number(r.vol_medido_agua ?? 0) + Number(r.vol_medido_poco ?? 0);
      if (!consHistByImovel.has(id)) consHistByImovel.set(id, []);
      consHistByImovel.get(id)!.push(cons);
      const anom = r.anomalia_leitura != null || r.anomalia_consumo != null;
      anomCountByImovel.set(id, (anomCountByImovel.get(id) ?? 0) + (anom ? 1 : 0));
      obsCountByImovel.set(id, (obsCountByImovel.get(id) ?? 0) + 1);
    }

    // 6) Hidrômetro
    const { data: hRows, error: hErr } = await supabase
      .from("hidrometro")
      .select("imovel_id, data_instalacao");
    if (hErr) throw hErr;
    const lastInstByImovel = new Map<string, string | null>();
    (hRows ?? []).forEach((r) => {
      const id = r.imovel_id;
      const di = r.data_instalacao ? new Date(r.data_instalacao) : null;
      const cur = lastInstByImovel.get(id);
      if (!cur || (di && new Date(cur) < di))
        lastInstByImovel.set(id, r.data_instalacao ?? null);
    });

    console.log("Total de hidrômetros", lastInstByImovel.size);

    return {
      imoveis,
      setorByImovel,
      municipioByImovel,
      catByImovel,
      ecoByImovel,
      sitAguaByImovel,
      consumoPorImovel,
      scgMap,
      faturaImovel,
      payByFat,
      faturas: fts ?? [],
      consHistByImovel,
      anomCountByImovel,
      obsCountByImovel,
      lastInstByImovel,
    };
  } catch (error) {
    console.error("Error fetching risk data", error);
    throw error;
  }
}

