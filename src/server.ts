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
import express from "express";
import { createCalculationRoutes, createErrorRoutes, healthRoutes, webhookRoutes } from './routes';
import { CalculationService, DataService, PolicyService } from './services';

// -----------------------------
// Setup
// -----------------------------

const app = express();
app.use(express.json());
const PORT = Number(process.env.PORT || 3000);

// Inicializa serviços
const dataService = new DataService(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_KEY!
);

const policyService = new PolicyService(
    process.env.OPENAI_API_KEY!,
    process.env.ASSISTANT_ID!
);

const calculationService = new CalculationService();

// -----------------------------
// Rotas
// -----------------------------

// Health check
app.get("/healthz", healthRoutes.healthz);

// Erros
const errorRoutes = createErrorRoutes(dataService);
app.get("/erros", errorRoutes.getErrors);

// Webhook
app.post("/webhook", webhookRoutes.webhook);

// Cálculo
const calculationRoutes = createCalculationRoutes(dataService, policyService, calculationService);
app.get("/rodar/:ano/:mes/:setor", calculationRoutes.runCalculation);

// -----------------------------
// Start
// -----------------------------
app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
