import { Router } from "express";
import { createOrUpdateGroup } from "../services";

const router = Router();

/**
 * POST /grupos
 * Cria ou atualiza um grupo de setores
 */
router.post("/grupos", async (req, res) => {
  try {
    const { nome, setores } = req.body ?? {};

    if (!Array.isArray(setores) || setores.length === 0) {
      return res.status(400).json({ error: "setores must be a non-empty array" });
    }

    const groupId = await createOrUpdateGroup({
      groupName: nome,
      setores
    });

    return res.json({
      success: true,
      grupo_id: groupId,
      message: "Grupo criado/atualizado com sucesso"
    });

  } catch (err) {
    console.error("[/grupos] error", err);
    return res.status(500).json({ error: String(err?.message ?? err) });
  }
});

export default router;

