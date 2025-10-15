import { Router } from "express";
import { persistAgentItem } from "../services";
import { isUUIDv4, validateWeights } from "../helpers";

const router = Router();

/**
 * POST /params/save
 * Salva parâmetros manualmente (sem agente AI)
 * Body: { escopo, id, periodo, janela_meses, inadimplencia, medicao, cadastro, potencial }
 */
router.post("/params/save", async (req, res) => {
  try {
    const { escopo, id, periodo, janela_meses, inadimplencia, medicao, cadastro, potencial } = req.body ?? {};

    // Validações de entrada
    if (!escopo || !["setor", "grupo"].includes(escopo)) {
      return res.status(400).json({ error: "escopo must be 'setor' or 'grupo'" });
    }
    
    if (!id || typeof id !== "string") {
      return res.status(400).json({ error: "id is required and must be a string" });
    }
    
    if (!periodo || !/^\d{4}-\d{2}/.test(periodo)) {
      return res.status(400).json({ error: "periodo is required (format: YYYY-MM)" });
    }
    
    if (!janela_meses || typeof janela_meses !== "number" || janela_meses <= 0) {
      return res.status(400).json({ error: "janela_meses must be a positive number" });
    }

    // Validar se escopo bate com tipo de ID
    const isGroup = isUUIDv4(id);
    if (escopo === "grupo" && !isGroup) {
      return res.status(400).json({ error: "grupo escopo requires a valid UUID id" });
    }
    if (escopo === "setor" && isGroup) {
      return res.status(400).json({ error: "setor escopo requires a non-UUID id" });
    }

    // Monta item no formato esperado por persistAgentItem
    const item = {
      setor_id: id,
      inadimplencia,
      medicao,
      cadastro,
      potencial  // será salvo na rota manual
    };

    // Validar pesos e thresholds (usa a mesma validação do ranges-and-weights)
    validateWeights(item);

    // Validar z_warn < z_risk
    const zWarn = Number(cadastro?.z_warn);
    const zRisk = Number(cadastro?.z_risk);
    if (!Number.isFinite(zWarn) || !Number.isFinite(zRisk) || !(zWarn < zRisk)) {
      return res.status(400).json({ error: "cadastro.z_warn must be < cadastro.z_risk" });
    }

    // Normalizar período para YYYY-MM-01
    const periodoNormalized = periodo.substring(0, 7) + "-01";

    // Persistir (pot_min e pot_max SERÃO salvos na rota manual)
    await persistAgentItem(item, periodoNormalized, janela_meses, true);

    return res.json({
      success: true,
      message: "Parameters saved successfully",
      escopo,
      id,
      periodo: periodo.substring(0, 7),
      janela_meses
    });

  } catch (err: any) {
    console.error("[POST /params/save] error", err);
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;

