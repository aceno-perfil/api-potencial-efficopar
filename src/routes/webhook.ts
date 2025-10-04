// routes/webhook.ts
// -------------------------------------------------------
// Rotas de webhook
// -------------------------------------------------------

import { Request, Response } from "express";

export const webhookRoutes = {
    // Gera filtros (como no seu webhook)
    webhook: (req: Request, res: Response) => {
        try {
            const { ano, mes, setores } = req.body || {};
            if (!ano || !mes || !setores) return res.status(400).json({ erro: "Faltam parâmetros: ano, mes ou setores" });

            const periodo = `${ano}-${String(mes).padStart(2, "0")}-01`;
            const filtros = (setores as string[]).map((setor) => ({ periodo, setor }));
            res.json({ filtros });
        } catch (err: any) {
            res.status(500).json({ erro: err.message });
        }
    },
};
