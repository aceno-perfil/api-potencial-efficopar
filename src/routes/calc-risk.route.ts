import { Router } from "express";
import { supabase } from "../database/supabase";
import { calculateRisk } from "../services";

export const calcRiskRouter = Router();

/**
 * POST /calc-risk
 * Body:
 * {
 *   "escopo": "setor" | "grupo" | "all",
 *   "identificadores": ["101","102"] | ["<uuid-grupo>"], // opcional se escopo=all
 *   "periodo": "YYYY-MM-01",
 *   "janela_meses": 6,
 *   "reprocess": false
 * }
 */
calcRiskRouter.post("/calc-risk", async (req, res) => {
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

    // Calcular período ISO
    const vMes = new Date(periodo);
    const vMonthStr = `${vMes.getUTCFullYear()}-${String(
      vMes.getUTCMonth() + 1
    ).padStart(2, "0")}`;
    const vMesISO = `${vMonthStr}-01`;

    console.log({
      escopo,
      identificadores,
      periodo,
      janela_meses,
      reprocess,
    });
    console.log("Calculando risco para o período", vMesISO);

    // Executar cálculo de risco usando o service
    const { rowsToUpsert, imovelIds, setoresFiltro, grupoId } =
      await calculateRisk({
        escopo: String(escopo),
        identificadores,
        periodo,
        janela_meses: Number(janela_meses),
      });

    console.log("Rows to upsert", rowsToUpsert);
    console.log("Imóveis ids", imovelIds);
    console.log("Setores filtro", setoresFiltro);
    console.log("Grupo id", grupoId);

    // Verificar se há dados para processar
    if (rowsToUpsert.length === 0) {
      let detail = "sem imóveis no escopo";
      if (escopo === "grupo" && setoresFiltro?.length === 0) {
        detail = "grupo sem setores";
      }
      return res.json({
        periodo: vMesISO,
        janela_meses,
        escopo,
        result: { processed: 0, detail },
      });
    }

    // Reprocess: apaga mês-alvo antes de inserir
    if (reprocess && imovelIds.length > 0) {
      const { error: delErr } = await supabase
        .from("risco_imovel_mensal")
        .delete()
        .eq("periodo", vMesISO)
        .in("imovel_id", imovelIds);
      if (delErr) throw delErr;
    }

    // Upsert em lotes
    const BATCH = 500;
    let inserted = 0;
    for (let i = 0; i < rowsToUpsert.length; i += BATCH) {
      const batch = rowsToUpsert.slice(i, i + BATCH);
      
      console.log("Salvando lote", i, "de", rowsToUpsert.length);

      const { error: upErr, count } = await supabase
        .from("risco_imovel_mensal")
        .upsert(batch, {
          onConflict: "imovel_id,periodo",
          ignoreDuplicates: false,
          count: "exact",
        });
      if (upErr) throw upErr;
      inserted += count ?? batch.length;
    }

    return res.json({
      periodo: vMesISO,
      janela_meses,
      escopo,
      filtros: { setores: setoresFiltro, grupo_id: grupoId },
      result: { processed: rowsToUpsert.length, upserted: inserted },
    });
  } catch (e: any) {
    console.error("[POST /calc-risk] error", e);
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
});
