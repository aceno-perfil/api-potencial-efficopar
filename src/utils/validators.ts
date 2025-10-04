import { z } from 'zod';

export function isValidUUID(uuid?: string | null): boolean {
    if (!uuid || typeof uuid !== "string") return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid);
}

// Valida período YYYY-MM-DD
export function isValidPeriod(periodo?: string | null): boolean {
    if (!periodo || typeof periodo !== "string") return false;
    return /^\d{4}-\d{2}-\d{2}$/.test(periodo);
}


// Schema para PiecewiseRule
const PiecewiseRuleSchema = z.object({
    feature: z.string(),
    breaks: z.array(z.number()),
    values: z.array(z.number()),
    higher_is_risk: z.boolean(),
});

// Schema para PotencialReceitaPolicy
export const PotencialReceitaPolicySchema = z.object({
    policy_id: z.string(),
    periodo: z.string(),
    weights: z.object({
        cadastro: z.number().min(0).max(1),
        medicao: z.number().min(0).max(1),
        inadimplencia: z.number().min(0).max(1),
    }),
    mappings: z.object({
        cadastro: z.array(PiecewiseRuleSchema),
        medicao: z.array(PiecewiseRuleSchema),
        inadimplencia: z.array(PiecewiseRuleSchema),
    }),
    penalties: z.object({
        inadimplencia_score_penalty: z.object({
            trigger_feature: z.string(),
            trigger_threshold: z.number(),
            curve: z.enum(['linear', 'log']),
            max_penalty: z.number().min(0).max(1),
        }),
    }).optional(),
    classification: z.object({
        score_thresholds: z.object({
            baixo: z.number().min(0).max(100),
            medio: z.number().min(0).max(100),
            alto: z.number().min(0).max(100),
        }),
        nenhum_if_all_potentials_below: z.number().min(0).max(1),
    }),
    templates: z.object({
        motivo: z.object({
            MEDICAO_DOMINANTE: z.string(),
            CADASTRO_DOMINANTE: z.string(),
            INAD_ALTA: z.string(),
            DADOS_INSUFICIENTES: z.string(),
            BALANCEADO: z.string(),
        }),
        acao_sugerida: z.object({
            MEDICAO_DOMINANTE: z.string(),
            CADASTRO_DOMINANTE: z.string(),
            INAD_ALTA: z.string(),
            DADOS_INSUFICIENTES: z.string(),
            BALANCEADO: z.string(),
        }),
        justificativa_curta: z.object({
            MEDICAO_DOMINANTE: z.string(),
            CADASTRO_DOMINANTE: z.string(),
            INAD_ALTA: z.string(),
            DADOS_INSUFICIENTES: z.string(),
            BALANCEADO: z.string(),
        }),
    }),
    meta: z.object({
        validity_days: z.number().positive(),
        notes: z.string().optional(),
    }),
});

// Função para validar e transformar dados do assistant
export function validatePolicyData(rawData: any) {
    try {
        // Primeiro, tenta validar diretamente
        return PotencialReceitaPolicySchema.parse(rawData);
    } catch (error) {
        console.error('[VALIDATOR] Erro na validação direta:', error);

        // Se falhar, tenta mapear estruturas alternativas que o assistant pode retornar
        const mappedData = mapAssistantResponse(rawData);

        try {
            return PotencialReceitaPolicySchema.parse(mappedData);
        } catch (mappedError) {
            console.error('[VALIDATOR] Erro na validação após mapeamento:', mappedError);
            throw new Error(`Policy validation failed: ${mappedError}`);
        }
    }
}

// Função para mapear respostas do assistant com estruturas diferentes
function mapAssistantResponse(data: any) {
    console.log('[VALIDATOR] Tentando mapear estrutura alternativa do assistant');

    // Estrutura alternativa 1: com "rules" em vez de "mappings"
    if (data.rules && !data.mappings) {
        console.log('[VALIDATOR] Mapeando estrutura com "rules"');
        return {
            policy_id: data.policy_id || `policy_${data.periodo || 'unknown'}`,
            periodo: data.periodo || '2021-10-01',
            weights: data.weights || { cadastro: 0.33, medicao: 0.33, inadimplencia: 0.34 },
            mappings: {
                cadastro: data.rules.cadastro || [],
                medicao: data.rules.medicao || [],
                inadimplencia: data.rules.inadimplencia || [],
            },
            penalties: data.penalidade ? {
                inadimplencia_score_penalty: {
                    trigger_feature: data.penalidade.trigger_feature,
                    trigger_threshold: data.penalidade.trigger_threshold,
                    curve: data.penalidade.curve,
                    max_penalty: data.penalidade.max_penalty,
                }
            } : undefined,
            classification: {
                score_thresholds: {
                    baixo: data.classificacao?.thresholds?.baixo || 40,
                    medio: data.classificacao?.thresholds?.medio || 70,
                    alto: data.classificacao?.thresholds?.alto || 100,
                },
                nenhum_if_all_potentials_below: data.classificacao?.nenhum_if_all_potentials_below || 0.2,
            },
            templates: {
                motivo: data.templates?.motivo || {},
                acao_sugerida: data.templates?.acao_sugerida || {},
                justificativa_curta: data.templates?.justificativa_curta || {},
            },
            meta: {
                validity_days: data.meta?.validity_days || 365,
                notes: data.meta?.notes,
            },
        };
    }

    // Estrutura alternativa 2: com "maps" em vez de "mappings"
    if (data.maps && !data.mappings) {
        console.log('[VALIDATOR] Mapeando estrutura com "maps"');
        return {
            policy_id: data.policy_id || `policy_${data.periodo || 'unknown'}`,
            periodo: data.periodo || '2021-10-01',
            weights: data.weights || { cadastro: 0.33, medicao: 0.33, inadimplencia: 0.34 },
            mappings: {
                cadastro: [], // Seria necessário mapear as features para as famílias
                medicao: [],
                inadimplencia: [],
            },
            penalties: undefined,
            classification: {
                score_thresholds: {
                    baixo: data.classification?.thresholds?.LOW?.[0] || 40,
                    medio: data.classification?.thresholds?.MEDIUM?.[0] || 70,
                    alto: data.classification?.thresholds?.HIGH?.[0] || 100,
                },
                nenhum_if_all_potentials_below: data.classification?.NONE_IF_ALL_APPROX_0 ? 0.2 : 0.1,
            },
            templates: {
                motivo: data.templates || {},
                acao_sugerida: data.templates || {},
                justificativa_curta: data.templates || {},
            },
            meta: {
                validity_days: 365,
                notes: undefined,
            },
        };
    }

    // Se não conseguir mapear, retorna os dados originais
    console.log('[VALIDATOR] Não foi possível mapear estrutura alternativa');
    return data;
}