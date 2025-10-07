import OpenAI from "openai";
import { CompactPolicyParametros, ImovelAgregado, PotencialReceitaPolicy } from "../types";
import {
    COMPACT_POLICY_JSON_SCHEMA,
    DEFAULT_BREAKS,
    histogram,
    POLICY_JSON_SCHEMA,
    validatePolicyData,
} from "../utils";

export class PolicyService {
    private openai: OpenAI;
    private assistantId: string;
    private policyCache = new Map<
        string,
        { policy: PotencialReceitaPolicy; cachedAt: number }
    >();

    constructor(apiKey: string, assistantId: string) {
        this.openai = new OpenAI({ apiKey });
        this.assistantId = assistantId;
    }

    // Monta payload agregado (ranges) a partir dos campos canônicos
    private buildAggregatedPayload(
        periodo: string,
        rowsCanon: ImovelAgregado[]
    ): {
        periodo: string;
        features: Record<
            string,
            Array<{ range: [number | null, number | null]; count: number }>
        >;
        stats: { pop_total: number };
        presence: Record<string, number>;
    } {
        const features: Record<string, any[]> = {};
        const presence: Record<string, number> = {};
        const featureNames = Object.keys(DEFAULT_BREAKS);

        for (const fname of featureNames) {
            const breaks = DEFAULT_BREAKS[fname];
            const rawVals = rowsCanon.map((r) => (r as any)[fname]);
            const present = rawVals.filter((v) => Number.isFinite(Number(v))).length;
            presence[fname] = rowsCanon.length
                ? present / rowsCanon.length
                : 0;

            const values = rawVals
                .map((v) => Number(v))
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
            stats: { pop_total: rowsCanon.length },
            presence,
        };
    }

    // Obtém a policy via assistant (1 chamada por período:setor) com cache e TTL por validity_days
    async obterPolicyPorRanges(
        periodo: string,
        imoveis: ImovelAgregado[],
        setor?: string
    ): Promise<PotencialReceitaPolicy> {
        const startTime = Date.now();
        const cacheKey = `${periodo}:${setor || "default"}`;
        const cached = this.policyCache.get(cacheKey);

        if (cached) {
            const ttlMs =
                ((cached.policy.meta?.validity_days ?? 1) as number) * 24 * 60 * 60 * 1000;
            if (Date.now() - cached.cachedAt < ttlMs) {
                console.log(
                    `[POLICY_SERVICE] Cache hit para ${cacheKey} (TTL ${ttlMs}ms)`
                );
                return cached.policy;
            }
            this.policyCache.delete(cacheKey);
            console.log(`[POLICY_SERVICE] Cache expirado para ${cacheKey}`);
        }

        console.log(
            `[POLICY_SERVICE] Gerando payload agregado para período=${periodo}, setor=${setor} (${imoveis.length} imóveis)`
        );
        const aggregatedPayload = this.buildAggregatedPayload(periodo, imoveis);

        // Thread
        const thread = await this.openai.beta.threads.create();
        await this.openai.beta.threads.messages.create(thread.id, {
            role: "user",
            content: JSON.stringify(aggregatedPayload),
        });

        // Run com response_format estrito
        let run = await this.openai.beta.threads.runs.create(thread.id, {
            assistant_id: this.assistantId,
            response_format: {
                type: "json_schema",
                json_schema: POLICY_JSON_SCHEMA,
            },
        });

        // Polling simples
        let attempts = 0;
        const maxAttempts = 60;
        while (
            run.status !== "completed" &&
            run.status !== "failed" &&
            run.status !== "cancelled" &&
            run.status !== "expired" &&
            attempts < maxAttempts
        ) {
            attempts++;
            await new Promise((r) => setTimeout(r, 1000));
            run = await this.openai.beta.threads.runs.retrieve(thread.id, run.id);
            console.log(
                `[POLICY_SERVICE] Esperando assistant (tentativa ${attempts}/${maxAttempts}) status=${run.status}`
            );
        }

        if (run.status !== "completed") {
            throw new Error(`Assistant ${run.status} após ${attempts} tentativas`);
        }

        // Pega a última mensagem do assistant (mais recente)
        const messages = await this.openai.beta.threads.messages.list(thread.id);
        const lastAssistant = messages.data
            .filter((m) => m.role === "assistant")
            .sort(
                (a: any, b: any) =>
                    (a.created_at ?? 0) - (b.created_at ?? 0)
            )
            .at(-1);

        const raw: string | undefined = lastAssistant?.content
            ?.map((c: any) => c?.text?.value)
            .find((v: any) => typeof v === "string");

        if (!raw) throw new Error("Empty assistant response");

        // Parse
        let parsed: any;
        try {
            parsed = JSON.parse(raw);
        } catch (e: any) {
            throw new Error(`Policy JSON parse error: ${e.message}`);
        }

        // Validação Zod (inclua normalizações mínimas antes, se preciso)
        let validatedPolicy: PotencialReceitaPolicy;
        try {
            validatedPolicy = validatePolicyData(parsed);
        } catch (validationError: any) {
            console.error(
                `[POLICY_SERVICE] Policy inválida`,
                validationError?.errors || validationError?.message
            );
            console.error(`[POLICY_SERVICE] Conteúdo recebido:`, parsed);
            throw new Error(`Policy validation failed`);
        }

        // Cache com timestamp
        this.policyCache.set(cacheKey, {
            policy: validatedPolicy,
            cachedAt: Date.now(),
        });

        const totalTime = Date.now() - startTime;
        console.log(
            `[POLICY_SERVICE] Policy obtida para ${cacheKey} em ${totalTime}ms`
        );
        return validatedPolicy;
    }

    // Obtém a policy no formato compact via assistant (nova implementação)
    async obterCompactPolicyPorRanges(
        periodo: string,
        imoveis: ImovelAgregado[],
        setor?: string
    ): Promise<CompactPolicyParametros> {
        const startTime = Date.now();
        const cacheKey = `compact_global`; // Cache global, não por período
        const cached = this.policyCache.get(cacheKey);

        if (cached) {
            const ttlMs = 24 * 60 * 60 * 1000; // 1 dia de cache para compact
            if (Date.now() - cached.cachedAt < ttlMs) {
                console.log(
                    `[POLICY_SERVICE] Cache hit para compact policy global (TTL ${ttlMs}ms)`
                );
                return cached.policy as unknown as CompactPolicyParametros;
            }
            this.policyCache.delete(cacheKey);
            console.log(`[POLICY_SERVICE] Cache expirado para compact policy global`);
        }

        console.log(
            `[POLICY_SERVICE] Gerando payload agregado para compact policy global (${imoveis.length} imóveis)`
        );
        const aggregatedPayload = this.buildAggregatedPayload(periodo, imoveis);

        // Thread
        const thread = await this.openai.beta.threads.create();
        await this.openai.beta.threads.messages.create(thread.id, {
            role: "user",
            content: JSON.stringify(aggregatedPayload),
        });

        // Run com response_format compact
        let run = await this.openai.beta.threads.runs.create(thread.id, {
            assistant_id: this.assistantId,
            response_format: {
                type: "json_schema",
                json_schema: COMPACT_POLICY_JSON_SCHEMA,
            },
        });

        // Polling simples
        let attempts = 0;
        const maxAttempts = 60;
        while (
            run.status !== "completed" &&
            run.status !== "failed" &&
            run.status !== "cancelled" &&
            run.status !== "expired" &&
            attempts < maxAttempts
        ) {
            attempts++;
            await new Promise((r) => setTimeout(r, 1000));
            run = await this.openai.beta.threads.runs.retrieve(thread.id, run.id);
            console.log(
                `[POLICY_SERVICE] Esperando assistant compact (tentativa ${attempts}/${maxAttempts}) status=${run.status}`
            );
        }

        if (run.status !== "completed") {
            throw new Error(`Assistant compact ${run.status} após ${attempts} tentativas`);
        }

        // Pega a última mensagem do assistant
        const messages = await this.openai.beta.threads.messages.list(thread.id);
        const lastAssistant = messages.data
            .filter((m) => m.role === "assistant")
            .sort(
                (a: any, b: any) =>
                    (a.created_at ?? 0) - (b.created_at ?? 0)
            )
            .at(-1);

        const raw: string | undefined = lastAssistant?.content
            ?.map((c: any) => c?.text?.value)
            .find((v: any) => typeof v === "string");

        if (!raw) throw new Error("Empty assistant compact response");

        // Parse
        let parsed: any;
        try {
            parsed = JSON.parse(raw);
        } catch (e: any) {
            throw new Error(`Compact policy JSON parse error: ${e.message}`);
        }

        // Validação básica
        if (!parsed.policy_id) {
            throw new Error("Compact policy missing policy_id");
        }

        const compactPolicy = parsed as CompactPolicyParametros;

        // Cache com timestamp
        this.policyCache.set(cacheKey, {
            policy: compactPolicy as any,
            cachedAt: Date.now(),
        });

        const totalTime = Date.now() - startTime;
        console.log(
            `[POLICY_SERVICE] Compact policy global obtida em ${totalTime}ms`
        );
        return compactPolicy;
    }
}
