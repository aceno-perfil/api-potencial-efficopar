import {
    CompactPolicyParametros,
    FamilyPotentialResult,
    ImovelAgregado,
    PiecewiseRule,
    PotencialOutput,
    PotencialReceitaPolicy,
    TemplateKey,
} from "../types";
import { buildRangesFromBreaks, num, round2 } from "../utils";

export class CalculationService {
    constructor(private debug = false) { }

    private log(...args: any[]) {
        if (this.debug) console.log("[CALCULATION_SERVICE]", ...args);
    }

    // Avalia uma regra piecewise (0..1). Ausente/NaN => 0.
    private evalPiecewise(rule: PiecewiseRule, row: ImovelAgregado): number {
        const v = Number((row as any)[rule.feature]);
        if (!Number.isFinite(v)) return 0;

        const ranges = buildRangesFromBreaks(rule.breaks);
        // bins: (-inf,b1], (b1,b2], ..., (bN,+inf)
        let idx = -1;
        for (let i = 0; i < ranges.length; i++) {
            const [a, b] = ranges[i];
            const okLower = a === null ? true : v > a;
            const okUpper = b === null ? true : v <= b;
            if (okLower && okUpper) {
                idx = i;
                break;
            }
        }
        if (idx < 0 || idx >= rule.values.length) return 0;

        const vv = Number(rule.values[idx]);
        if (!Number.isFinite(vv)) return 0;

        return Math.max(0, Math.min(1, vv));
    }

    // Agrega múltiplas regras de uma família como média simples das presentes
    private familyPotential(
        rules: PiecewiseRule[],
        row: ImovelAgregado
    ): FamilyPotentialResult {
        if (!rules || !rules.length) {
            this.log("familyPotential: sem regras");
            return { value: 0, missing: true };
        }

        let sum = 0;
        let used = 0;
        let anyMissing = false;

        for (const r of rules) {
            const raw = (row as any)[r.feature];
            const has = Number.isFinite(Number(raw));
            const score = this.evalPiecewise(r, row);
            if (has) {
                sum += score;
                used++;
            } else {
                anyMissing = true;
            }
            this.log(`rule ${r.feature}: raw=${raw} has=${has} score=${score}`);
        }

        return used === 0
            ? { value: 0, missing: true }
            : { value: sum / used, missing: anyMissing };
    }

    // Classificação por score final (0..100) + regra de "NENHUM"
    private classifyScore(
        score: number,
        policy: PotencialReceitaPolicy,
        cad: number,
        med: number,
        inad: number
    ): "NENHUM" | "BAIXO" | "MEDIO" | "ALTO" {
        const thr = policy.classification.score_thresholds;
        const noneCut = policy.classification.nenhum_if_all_potentials_below;
        const allBelow = cad < noneCut && med < noneCut && inad < noneCut;
        if (allBelow) return "NENHUM";
        if (score < thr.baixo) return "BAIXO";
        if (score < thr.medio) return "MEDIO";
        return "ALTO";
    }

    // Seleciona template
    private pickTemplateKey(
        cad: number,
        med: number,
        inad: number,
        anyMissing: boolean
    ): TemplateKey {
        if (anyMissing) return "DADOS_INSUFICIENTES";
        if (inad < 0.3) return "INAD_ALTA";
        if (med > cad && med - cad > 0.1) return "MEDICAO_DOMINANTE";
        if (cad > med && cad - med > 0.1) return "CADASTRO_DOMINANTE";
        return "BALANCEADO";
    }

    // Penalidade escalonada (linear/log) ao exceder trigger_threshold
    private applyPenalty(
        base01: number,
        row: ImovelAgregado,
        policy: PotencialReceitaPolicy
    ): number {
        const pen = policy.penalties?.inadimplencia_score_penalty;
        if (!pen) return base01;

        const v = Number((row as any)[pen.trigger_feature]);
        if (!Number.isFinite(v) || v <= pen.trigger_threshold) return base01;

        // fator em [0,1] proporcional ao excedente
        const over = v - pen.trigger_threshold;
        const denom = pen.trigger_threshold || 1; // fallback
        let factor = Math.min(1, Math.max(0, over / denom));

        if (pen.curve === "log") {
            // curva suave: 0..1
            factor = Math.log1p(factor) / Math.log(2); // ~0..1
        }

        const delta = factor * num(pen.max_penalty, 0.1);
        return Math.max(0, base01 - delta);
    }

    // Métodos auxiliares para CompactPolicyParametros

    // Calcula potencial de cadastro usando pesos diretos
    private calculateCadastroPotential(
        row: ImovelAgregado,
        compactPolicy: CompactPolicyParametros
    ): FamilyPotentialResult {
        // Para cadastro, usamos os pesos z_warn e z_risk
        // Como não temos regras piecewise no formato compact, vamos usar uma abordagem simplificada
        // baseada nos valores disponíveis nos dados do imóvel

        const zWarn = compactPolicy.cadastro.z_warn;
        const zRisk = compactPolicy.cadastro.z_risk;

        // Por enquanto, retornamos um valor baseado nos pesos (pode ser refinado)
        // TODO: Implementar lógica específica baseada nos dados do imóvel
        const value = (zWarn + zRisk) / 2;

        return { value, missing: false };
    }

    // Calcula potencial de medição usando pesos diretos
    private calculateMedicaoPotential(
        row: ImovelAgregado,
        compactPolicy: CompactPolicyParametros
    ): FamilyPotentialResult {
        const wIdade = compactPolicy.medicao.w_idade;
        const wAnomalias = compactPolicy.medicao.w_anomalias;
        const wDesvio = compactPolicy.medicao.w_desvio;

        // Calcular baseado nos dados do imóvel
        let sum = 0;
        let count = 0;
        let anyMissing = false;

        // Idade do hidrômetro
        if (row.meter_age_years !== null && Number.isFinite(row.meter_age_years)) {
            // Normalizar idade (assumindo que > 10 anos é problemático)
            const normalizedAge = Math.min(1, row.meter_age_years / 10);
            sum += wIdade * (1 - normalizedAge); // Inverter: menor idade = maior potencial
            count++;
        } else {
            anyMissing = true;
        }

        // Taxa de anomalias
        if (row.anomaly_rate !== null && Number.isFinite(row.anomaly_rate)) {
            sum += wAnomalias * (1 - row.anomaly_rate); // Inverter: menor anomalia = maior potencial
            count++;
        } else {
            anyMissing = true;
        }

        // Coeficiente de variação do consumo
        if (row.consumption_cv !== null && Number.isFinite(row.consumption_cv)) {
            // Normalizar CV (assumindo que > 0.5 é problemático)
            const normalizedCV = Math.min(1, row.consumption_cv / 0.5);
            sum += wDesvio * (1 - normalizedCV); // Inverter: menor variação = maior potencial
            count++;
        } else {
            anyMissing = true;
        }

        return count === 0
            ? { value: 0, missing: true }
            : { value: sum / count, missing: anyMissing };
    }

    // Calcula potencial de inadimplência usando pesos diretos
    private calculateInadimplenciaPotential(
        row: ImovelAgregado,
        compactPolicy: CompactPolicyParametros
    ): FamilyPotentialResult {
        const wDays = compactPolicy.inadimplencia.w_days;
        const wOpenCount = compactPolicy.inadimplencia.w_open_count;
        const wAmountRatio = compactPolicy.inadimplencia.w_amount_ratio;

        let sum = 0;
        let count = 0;
        let anyMissing = false;

        // Dias de atraso
        if (row.delinquency_days !== null && Number.isFinite(row.delinquency_days)) {
            // Normalizar dias (assumindo que > 90 dias é problemático)
            const normalizedDays = Math.min(1, row.delinquency_days / 90);
            sum += wDays * (1 - normalizedDays); // Inverter: menor atraso = maior potencial
            count++;
        } else {
            anyMissing = true;
        }

        // Quantidade de contas em aberto
        if (row.open_invoices_count !== null && Number.isFinite(row.open_invoices_count)) {
            // Normalizar contas (assumindo que > 3 contas é problemático)
            const normalizedCount = Math.min(1, row.open_invoices_count / 3);
            sum += wOpenCount * (1 - normalizedCount); // Inverter: menos contas = maior potencial
            count++;
        } else {
            anyMissing = true;
        }

        // Razão de valor em aberto
        if (row.open_amount_ratio !== null && Number.isFinite(row.open_amount_ratio)) {
            sum += wAmountRatio * (1 - row.open_amount_ratio); // Inverter: menor valor = maior potencial
            count++;
        } else {
            anyMissing = true;
        }

        return count === 0
            ? { value: 0, missing: true }
            : { value: sum / count, missing: anyMissing };
    }

    // Aplica penalidade usando configuração compact
    private applyPenaltyCompact(
        base01: number,
        row: ImovelAgregado,
        compactPolicy: CompactPolicyParametros
    ): number {
        const pen = compactPolicy.inadimplencia;
        if (!pen) return base01;

        // Usar trigger_ratio como threshold
        const triggerThreshold = pen.trigger_ratio;
        const maxPenalty = pen.penalty_max;
        const curve = pen.curve;

        // Assumir que usamos delinquency_days como trigger feature
        const v = Number(row.delinquency_days);
        if (!Number.isFinite(v) || v <= triggerThreshold) return base01;

        // Calcular fator de penalidade
        const over = v - triggerThreshold;
        const denom = triggerThreshold || 1;
        let factor = Math.min(1, Math.max(0, over / denom));

        if (curve === "log") {
            factor = Math.log1p(factor) / Math.log(2);
        }

        const delta = factor * maxPenalty;
        return Math.max(0, base01 - delta);
    }

    // Classifica score usando configuração compact
    private classifyScoreCompact(
        score: number,
        compactPolicy: CompactPolicyParametros,
        cad: number,
        med: number,
        inad: number
    ): "NENHUM" | "BAIXO" | "MEDIO" | "ALTO" {
        const thr = compactPolicy.classificacao;
        const noneCut = thr.nenhum_if_all_potentials_below;

        const allBelow = cad < noneCut && med < noneCut && inad < noneCut;
        if (allBelow) return "NENHUM";
        if (score < thr.baixo) return "BAIXO";
        if (score < thr.medio) return "MEDIO";
        return "ALTO";
    }

    // Obtém texto do template (simplificado para formato compact)
    private getTemplateText(templateKey: TemplateKey, type: 'motivo' | 'acao_sugerida' | 'justificativa_curta'): string {
        const templates = {
            motivo: {
                MEDICAO_DOMINANTE: "Potencial dominado por questões de medição",
                CADASTRO_DOMINANTE: "Potencial dominado por questões de cadastro",
                INAD_ALTA: "Potencial limitado por alta inadimplência",
                DADOS_INSUFICIENTES: "Dados insuficientes para análise",
                BALANCEADO: "Potencial balanceado entre diferentes fatores"
            },
            acao_sugerida: {
                MEDICAO_DOMINANTE: "Investigar problemas de medição",
                CADASTRO_DOMINANTE: "Revisar dados cadastrais",
                INAD_ALTA: "Implementar ações de cobrança",
                DADOS_INSUFICIENTES: "Coletar mais dados históricos",
                BALANCEADO: "Manter monitoramento regular"
            },
            justificativa_curta: {
                MEDICAO_DOMINANTE: "Anomalias de medição identificadas",
                CADASTRO_DOMINANTE: "Inconsistências cadastrais detectadas",
                INAD_ALTA: "Alto índice de inadimplência",
                DADOS_INSUFICIENTES: "Histórico insuficiente",
                BALANCEADO: "Análise equilibrada"
            }
        };

        return templates[type][templateKey] || "";
    }

    // Cálculo completo para 1 imóvel usando CompactPolicyParametros
    calcularPotenciaisCompact(
        row: ImovelAgregado,
        compactPolicy: CompactPolicyParametros
    ): PotencialOutput {
        try {
            // Calcular potenciais usando os pesos diretos do compact policy
            const cad = this.calculateCadastroPotential(row, compactPolicy);
            const med = this.calculateMedicaoPotential(row, compactPolicy);
            const ina = this.calculateInadimplenciaPotential(row, compactPolicy);

            // Usar pesos das famílias (já normalizados)
            const wc = compactPolicy.familias.cadastro;
            const wm = compactPolicy.familias.medicao;
            const wi = compactPolicy.familias.inadimplencia;

            let score01 = wc * cad.value + wm * med.value + wi * ina.value;
            score01 = this.applyPenaltyCompact(score01, row, compactPolicy);

            const score100 = Math.max(0, Math.min(100, score01 * 100));
            const nivel = this.classifyScoreCompact(
                score100,
                compactPolicy,
                cad.value,
                med.value,
                ina.value
            );

            const anyMissing = cad.missing || med.missing || ina.missing;
            const templateKey = this.pickTemplateKey(
                cad.value,
                med.value,
                ina.value,
                anyMissing
            );

            const motivo = this.getTemplateText(templateKey, 'motivo');
            const acao = this.getTemplateText(templateKey, 'acao_sugerida');
            const justificativa = this.getTemplateText(templateKey, 'justificativa_curta');

            const result: PotencialOutput = {
                imovel_id: row.imovel_id,
                periodo: row.periodo,
                potencial_score: round2(score100),
                potencial_nivel: nivel,
                potencial_cadastro: round2(cad.value),
                potencial_medicao: round2(med.value),
                potencial_inadimplencia: round2(ina.value),
                motivo,
                acao_sugerida: acao,
                justificativa_curta: justificativa,
                erro: null,
            };

            this.log(`resultado ${row.imovel_id}`, result);
            return result;
        } catch (error: any) {
            console.error(
                `[CALCULATION_SERVICE] Erro ao calcular imóvel ${row.imovel_id}:`,
                error?.message || error
            );
            throw error;
        }
    }

    // Método legacy mantido para compatibilidade
    calcularPotenciais(
        row: ImovelAgregado,
        policy: PotencialReceitaPolicy
    ): PotencialOutput {
        try {
            const cad = this.familyPotential(policy.mappings.cadastro, row);
            const med = this.familyPotential(policy.mappings.medicao, row);
            const ina = this.familyPotential(policy.mappings.inadimplencia, row);

            // Renormaliza pesos se necessário
            let wc = policy.weights.cadastro;
            let wm = policy.weights.medicao;
            let wi = policy.weights.inadimplencia;
            const sw = wc + wm + wi;
            if (sw > 0) {
                wc = wc / sw;
                wm = wm / sw;
                wi = wi / sw;
            } else {
                // fallback seguro
                wc = wm = wi = 1 / 3;
            }

            let score01 = wc * cad.value + wm * med.value + wi * ina.value;
            score01 = this.applyPenalty(score01, row, policy);

            const score100 = Math.max(0, Math.min(100, score01 * 100));
            const nivel = this.classifyScore(
                score100,
                policy,
                cad.value,
                med.value,
                ina.value
            );

            const anyMissing = cad.missing || med.missing || ina.missing;
            const templateKey = this.pickTemplateKey(
                cad.value,
                med.value,
                ina.value,
                anyMissing
            );

            const motivo = policy.templates.motivo[templateKey] || "";
            const acao = policy.templates.acao_sugerida[templateKey] || "";
            const justificativa = policy.templates.justificativa_curta[templateKey] || "";

            const result: PotencialOutput = {
                imovel_id: row.imovel_id,
                periodo: row.periodo,
                potencial_score: round2(score100),
                potencial_nivel: nivel,
                potencial_cadastro: round2(cad.value),
                potencial_medicao: round2(med.value),
                potencial_inadimplencia: round2(ina.value),
                motivo,
                acao_sugerida: acao,
                justificativa_curta: justificativa,
                erro: null,
            };

            this.log(`resultado ${row.imovel_id}`, result);
            return result;
        } catch (error: any) {
            console.error(
                `[CALCULATION_SERVICE] Erro ao calcular imóvel ${row.imovel_id}:`,
                error?.message || error
            );
            throw error;
        }
    }
}
