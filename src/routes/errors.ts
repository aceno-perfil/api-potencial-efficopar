// routes/errors.ts
// -------------------------------------------------------
// Rotas para consulta de erros
// -------------------------------------------------------

import { Request, Response } from "express";
import { DataService } from '../services';

export function createErrorRoutes(dataService: DataService) {
    return {
        // Consulta erros gravados
        getErrors: async (req: Request, res: Response) => {
            try {
                const { limit = "50", offset = "0", tipo_erro } = req.query as Record<string, string>;
                const lim = Math.max(1, Math.min(500, Number(limit)));
                const off = Math.max(0, Number(offset));

                const result = await dataService.buscarErros(lim, off, tipo_erro);
                res.json(result);
            } catch (err: any) {
                res.status(500).json({ erro: err.message });
            }
        },
    };
}
