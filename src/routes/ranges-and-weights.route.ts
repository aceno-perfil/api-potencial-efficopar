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

/**
 * POST /ranges-and-weights
 * Calcula ranges e pesos para setores ou grupos
 */
router.post("/ranges-and-weights", async (req, res) => {
  try {
    const { escopo, identificadores, periodo, janela_meses, forward = true } = req.body ?? {};
    
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

    const vMes = monthStart(periodo);

    const results: any[] = [];
    if (escopo === "setor") {
      for (const setor of identificadores.map(s => String(s).trim())) {
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

    // se não for para encaminhar ao agente, apenas retorna os ranges
    if (!forward) {
      return res.json({ periodo: vMes, janela_meses, escopo, total_entidades: results.length, results });
    }

    // precisa do OPENAI_API_KEY para prosseguir
    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: "OPENAI_API_KEY env is required when forward=true" });
    }

    // Chama a OpenAI para gerar os pesos
    const agentOutput = await callAgent(results);

    // Valida e persiste cada item
    const persisted: string[] = [];
    const errors: { setor_id: string, error: string }[] = [];
    for (const item of agentOutput || []) {
      try {
        await persistAgentItem(item);
        persisted.push(item?.setor_id);
      } catch (e) {
        errors.push({ setor_id: item?.setor_id, error: String(e?.message ?? e) });
      }
    }

    return res.json({
      periodo: vMes,
      janela_meses,
      escopo,
      total_entidades: results.length,
      results, // ranges enviados ao agente
      agent_persisted: persisted.length,
      agent_errors: errors
    });

  } catch (err) {
    console.error("[/ranges-and-weights] error", err);
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;

