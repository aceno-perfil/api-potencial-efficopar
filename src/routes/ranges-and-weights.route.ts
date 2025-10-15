// routes/ranges-and-weights.ts
import { Router } from "express";
import {
  buildRangeOutputForRows,
  fetchIHAForSetores,
  isUUIDv4,
  monthStart,
  resolveSetoresFromGroup
} from "../helpers";
import { persistAgentItem, callAgent } from "../services";

const router = Router();

/** -------- validação dos pesos/limiares vindos do agente -------- */
function validateAgentItem(item: any) {
  if (!item || typeof item !== "object") throw new Error("invalid agent item");
  const id = String(item.setor_id ?? "");
  if (!id) throw new Error("missing setor_id");

  // pesos inadimplência
  const wA = Number(item?.inadimplencia?.w_atraso);
  const wI = Number(item?.inadimplencia?.w_indice);
  const wV = Number(item?.inadimplencia?.w_valor_aberto);
  if (![wA, wI, wV].every((x) => Number.isFinite(x) && x >= 0 && x <= 1)) {
    throw new Error("inadimplencia weights must be in [0,1]");
  }
  const sumInad = wA + wI + wV;
  if (Math.abs(sumInad - 1) > 1e-3) throw new Error("inadimplencia weights must sum to 1");

  // pesos medição
  const wId = Number(item?.medicao?.w_idade);
  const wAn = Number(item?.medicao?.w_anomalias);
  const wDv = Number(item?.medicao?.w_desvio);
  if (![wId, wAn, wDv].every((x) => Number.isFinite(x) && x >= 0 && x <= 1)) {
    throw new Error("medicao weights must be in [0,1]");
  }
  const sumMed = wId + wAn + wDv;
  if (Math.abs(sumMed - 1) > 1e-3) throw new Error("medicao weights must sum to 1");

  // cadastro z
  const zWarn = Number(item?.cadastro?.z_warn);
  const zRisk = Number(item?.cadastro?.z_risk);
  if (!Number.isFinite(zWarn) || !Number.isFinite(zRisk) || !(zWarn < zRisk)) {
    throw new Error("cadastro.z_warn must be < cadastro.z_risk");
  }
}

/**
 * POST /ranges-and-weights
 * body: { escopo: 'setor'|'grupo', identificadores: string[], periodo: string, janela_meses: number, forward?: boolean }
 * - Gera os ranges por setor/grupo a partir de imovel_historico_agregado (helpers)
 * - (opcional) Chama o agente (OpenAI) via services.callAgent para obter pesos
 * - Valida e persiste via services.persistAgentItem
 */
router.post("/ranges-and-weights", async (req, res) => {
  try {
    const { escopo, identificadores, periodo, janela_meses, forward = true } = req.body ?? {};

    // -------- validação de entrada --------
    if (!escopo || !["setor", "grupo"].includes(escopo)) {
      return res.status(400).json({ error: "escopo must be 'setor' or 'grupo'" });
    }
    if (!Array.isArray(identificadores) || identificadores.length === 0) {
      return res.status(400).json({ error: "identificadores must be array with at least 1 item" });
    }
    if (!periodo) {
      return res.status(400).json({ error: "periodo is required" });
    }
    if (!janela_meses || janela_meses <= 0) {
      return res.status(400).json({ error: "janela_meses must be > 0" });
    }

    // truncar para o 1º dia do mês (ISO yyyy-mm-01)
    const vMes = monthStart(periodo);

    // -------- montar ranges --------
    const results: any[] = [];
    if (escopo === "setor") {
      for (const setor of identificadores.map((s: any) => String(s).trim())) {
        const rows = await fetchIHAForSetores(vMes, [setor]);
        results.push(buildRangeOutputForRows(setor, rows));
      }
    } else {
      for (const groupId of identificadores) {
        if (!isUUIDv4(groupId)) {
          return res.status(400).json({ error: `invalid group id: ${groupId}` });
        }
        const setores = await resolveSetoresFromGroup(groupId);
        if (setores.length === 0) {
          results.push(buildRangeOutputForRows(groupId, []));
          continue;
        }
        const rows = await fetchIHAForSetores(vMes, setores);
        results.push(buildRangeOutputForRows(groupId, rows));
      }
    }

    // -------- apenas retornar os ranges (sem agente) --------
    if (!forward) {
      return res.json({
        periodo: vMes,
        janela_meses,
        escopo,
        total_entidades: results.length,
        results
      });
    }

    // -------- chamar agente (via services.callAgent) --------
    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: "OPENAI_API_KEY env is required when forward=true" });
    }

    const agentOutput = await callAgent(results); // deve retornar array de objetos { setor_id, inadimplencia:{...}, medicao:{...}, cadastro:{...}, potencial:{...} }

    if (!Array.isArray(agentOutput)) {
      return res.status(502).json({ error: "agent output is not an array" });
    }

    // -------- validar e persistir --------
    const persisted: string[] = [];
    const errors: { setor_id: string; error: string }[] = [];

    for (const item of agentOutput) {
      try {
        validateAgentItem(item);
        // IMPORTANTE: o persistAgentItem deve, internamente,
        // - salvar chaves de GRUPO como "w_indice::YYYY-MM::Jm", "z_warn::YYYY-MM::Jm"
        // - salvar chaves de SETOR como "<SETOR>__<key>::YYYY-MM::Jm" (ex.: "101__w_indice::2025-10::6m")
        // - NÃO salva pot_min e pot_max (devem ser gerenciados externamente)
        await persistAgentItem(item, vMes, janela_meses);
        persisted.push(String(item?.setor_id));
      } catch (e: any) {
        errors.push({ setor_id: String(item?.setor_id ?? ""), error: String(e?.message ?? e) });
      }
    }

    return res.json({
      periodo: vMes,
      janela_meses,
      escopo,
      total_entidades: results.length,
      results,               // ranges enviados ao agente
      agent_persisted: persisted.length,
      agent_errors: errors
    });
  } catch (err: any) {
    console.error("[/ranges-and-weights] error", err);
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;
