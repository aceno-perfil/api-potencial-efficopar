// routes/health.ts
// -------------------------------------------------------
// Rotas de health check
// -------------------------------------------------------

import { Request, Response } from "express";

export const healthRoutes = {
    // Health check simples
    healthz: (_req: Request, res: Response) => res.json({ ok: true }),
};
