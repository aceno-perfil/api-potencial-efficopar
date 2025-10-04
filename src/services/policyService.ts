// services/policyService.ts
// -------------------------------------------------------
// Serviço para gerenciamento de policies do OpenAI Assistant
// -------------------------------------------------------

import OpenAI from "openai";
import { ImovelAgregado, PotencialReceitaPolicy } from '../types';
import { DEFAULT_BREAKS, histogram, validatePolicyData } from '../utils';

export class PolicyService {
    private openai: OpenAI;
    private assistantId: string;
    private policyCache = new Map<string, { policy: PotencialReceitaPolicy; cachedAt: number }>();

    constructor(apiKey: string, assistantId: string) {
        this.openai = new OpenAI({ apiKey });
        this.assistantId = assistantId;
    }

    // Constrói payload agregado compacto para o assistant
    private buildAggregatedPayload(periodo: string, imoveis: ImovelAgregado[]) {
        const features: Record<string, any[]> = {};
        const featureNames = Object.keys(DEFAULT_BREAKS);

        for (const fname of featureNames) {
            const breaks = DEFAULT_BREAKS[fname];
            const values = imoveis
                .map((r) => {
                    const val = (r as any)[fname];
                    return Number.isFinite(val) ? Number(val) : NaN;
                })
                .filter((v) => Number.isFinite(v));
            const bins = histogram(values, breaks);
            features[fname] = bins.map((b) => ({
                range: b.range,
                count: b.count,
            }));
        }

        return {
            periodo,
            features,
            stats: {
                pop_total: imoveis.length,
            },
        };
    }

    // Obtém policy do assistant usando ranges/histogramas
    async obterPolicyPorRanges(periodo: string, imoveis: ImovelAgregado[]): Promise<PotencialReceitaPolicy> {
        console.log(`[POLICY_SERVICE] Obtendo policy para período=${periodo} com ${imoveis.length} imóveis`);
        const startTime = Date.now();

        // Cache por período (você pode incluir setor no cache key se desejar políticas por setor)
        const cacheKey = periodo;
        const cached = this.policyCache.get(cacheKey);
        if (cached) {
            console.log(`[POLICY_SERVICE] Policy encontrada no cache para período=${periodo}`);
            // Mantém simples: ignora validade; ou valide via meta.validity_days
            return cached.policy;
        }

        console.log(`[POLICY_SERVICE] Policy não encontrada no cache, construindo payload agregado`);
        const aggregatedPayload = this.buildAggregatedPayload(periodo, imoveis);
        console.log(`[POLICY_SERVICE] Payload construído com ${Object.keys(aggregatedPayload.features).length} features`);

        console.log(`[POLICY_SERVICE] Criando thread no OpenAI Assistant`);
        const thread = await this.openai.beta.threads.create();
        await this.openai.beta.threads.messages.create(thread.id, {
            role: "user",
            content: JSON.stringify(aggregatedPayload),
        });

        console.log(`[POLICY_SERVICE] Iniciando run do assistant (ID: ${this.assistantId})`);
        let run = await this.openai.beta.threads.runs.create(thread.id, {
            assistant_id: this.assistantId,
        });

        let attempts = 0;
        const maxAttempts = 60; // 60 segundos máximo
        while (run.status !== "completed" && run.status !== "failed" && attempts < maxAttempts) {
            attempts++;
            console.log(`[POLICY_SERVICE] Aguardando completion do assistant (tentativa ${attempts}/${maxAttempts}, status: ${run.status})`);
            await new Promise((r) => setTimeout(r, 1000));
            run = await this.openai.beta.threads.runs.retrieve(thread.id, run.id);
        }

        if (run.status === "failed") {
            console.error(`[POLICY_SERVICE] Assistant falhou após ${attempts} tentativas`);
            throw new Error("Assistant failed to create policy from ranges");
        }

        if (attempts >= maxAttempts) {
            console.error(`[POLICY_SERVICE] Timeout após ${maxAttempts} tentativas`);
            throw new Error("Assistant timeout");
        }

        console.log(`[POLICY_SERVICE] Assistant completou em ${attempts} tentativas, obtendo resposta`);
        const messages = await this.openai.beta.threads.messages.list(thread.id);
        const last = messages.data.find((m) => m.role === "assistant");
        const raw = last?.content?.[0] && (last.content[0] as any).text?.value;
        if (!raw) {
            console.error(`[POLICY_SERVICE] Resposta vazia do assistant`);
            throw new Error("Empty assistant response");
        }

        console.log(`[POLICY_SERVICE] Parseando JSON da resposta (${raw.length} caracteres)`);
        let parsed: any;
        try {
            parsed = JSON.parse(raw);
        } catch (e: any) {
            console.error(`[POLICY_SERVICE] Erro no parse do JSON:`, e.message);
            throw new Error(`Policy JSON parse error: ${e.message}`);
        }

        // Validar e transformar os dados com Zod
        console.log(`[POLICY_SERVICE] Validando estrutura da policy com Zod`);
        let validatedPolicy: PotencialReceitaPolicy;
        try {
            validatedPolicy = validatePolicyData(parsed);
            console.log(`[POLICY_SERVICE] Policy validada com sucesso`);
        } catch (validationError: any) {
            console.error(`[POLICY_SERVICE] Erro na validação da policy:`, validationError.message);
            console.error(`[POLICY_SERVICE] Dados recebidos do assistant:`, JSON.stringify(parsed));
            throw new Error(`Policy validation failed: ${validationError.message}`);
        }

        // Aqui assumimos que o assistant respeita o schema estrito
        console.log(`[POLICY_SERVICE] Policy parseada com sucesso, salvando no cache`);
        this.policyCache.set(cacheKey, { policy: validatedPolicy, cachedAt: Date.now() });

        const totalTime = Date.now() - startTime;
        console.log(`[POLICY_SERVICE] Policy obtida com sucesso em ${totalTime}ms`);
        console.log(`[POLICY_SERVICE] Policy:`, JSON.stringify(validatedPolicy));
        return validatedPolicy;
    }
}
