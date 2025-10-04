// services/calculationService.ts
// -------------------------------------------------------
// Serviço para cálculos de potencial de receita
// -------------------------------------------------------

import {
    FamilyPotentialResult,
    ImovelAgregado,
    PiecewiseRule,
    PotencialOutput,
    PotencialReceitaPolicy,
    TemplateKey
} from '../types';
import { buildRangesFromBreaks, num, round2 } from '../utils';

export class CalculationService {

    // Avalia uma peça piecewise (retorna 0..1). Se valor ausente → 0.
    private evalPiecewise(rule: PiecewiseRule, row: ImovelAgregado): number {
        const vRaw = (row as any)[rule.feature] as number | null | undefined;
        if (!Number.isFinite(vRaw as number)) return 0;
        const v = Number(vRaw);
        const ranges = buildRangesFromBreaks(rule.breaks);

        // Mesma semântica dos bins do histograma: (-inf,b1], (b1,b2], ..., (bN,+inf)
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
        if (idx < 0) return 0;

        const val = rule.values[idx];
        // values já vêm calibrados 0..1 pelo assistant; apenas garante limites
        return Math.max(0, Math.min(1, Number(val)));
    }

    // Agrega múltiplas rules de uma família (cadastro/medicao/inadimplencia) como média simples
    private familyPotential(rules: PiecewiseRule[], row: ImovelAgregado): FamilyPotentialResult {
        if (!rules || !rules.length) {
            console.log(`[CALCULATION_SERVICE] familyPotential: nenhuma rule fornecida`);
            return { value: 0, missing: true };
        }

        let sum = 0;
        let used = 0;
        let anyMissing = false;

        console.log(`[CALCULATION_SERVICE] familyPotential: processando ${rules.length} rules`);

        for (const r of rules) {
            const raw = (row as any)[r.feature];
            const has = Number.isFinite(raw as number);
            const score = this.evalPiecewise(r, row);

            console.log(`[CALCULATION_SERVICE] Rule ${r.feature}: raw=${raw}, has=${has}, score=${score}`);

            if (has) {
                sum += score;
                used++;
            } else {
                anyMissing = true;
            }
        }

        const result = !used ? { value: 0, missing: true } : { value: sum / used, missing: anyMissing };
        console.log(`[CALCULATION_SERVICE] familyPotential resultado:`, result);

        return result;
    }

    // Classifica score em nível
    private classifyScore(
        score: number,
        policy: PotencialReceitaPolicy,
        cad: number,
        med: number,
        inad: number
    ): "NENHUM" | "BAIXO" | "MEDIO" | "ALTO" {
        const thr = policy.classification.score_thresholds;
        const allBelow = cad < policy.classification.nenhum_if_all_potentials_below
            && med < policy.classification.nenhum_if_all_potentials_below
            && inad < policy.classification.nenhum_if_all_potentials_below;
        if (allBelow) return "NENHUM";
        if (score < thr.baixo) return "BAIXO";
        if (score < thr.medio) return "MEDIO";
        return "ALTO";
    }

    // Escolhe chave do template baseado nos valores
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

    // Aplica penalidade ao score base
    private applyPenalty(baseScore01: number, row: ImovelAgregado, policy: PotencialReceitaPolicy): number {
        const pen = policy.penalties?.inadimplencia_score_penalty;
        if (!pen) return baseScore01;

        const vRaw = (row as any)[pen.trigger_feature] as number | null | undefined;
        if (!Number.isFinite(vRaw as number)) return baseScore01;

        const v = Number(vRaw);
        if (v <= pen.trigger_threshold) return baseScore01;

        // Implementação simples: penalidade fixa ao cruzar o limiar (mantendo no intervalo 0..1)
        // TODO: se necessário, evoluir para curva linear/log com escala definida.
        const penalized = Math.max(0, baseScore01 - num(pen.max_penalty, 0.1));
        return penalized;
    }

    // Converte uma policy + linha em PotencialOutput
    calcularPotenciais(row: ImovelAgregado, policy: PotencialReceitaPolicy): PotencialOutput {
        try {
            const cad = this.familyPotential(policy.mappings.cadastro, row);
            const med = this.familyPotential(policy.mappings.medicao, row);
            const ina = this.familyPotential(policy.mappings.inadimplencia, row);

            // Log detalhado dos valores calculados para debug
            console.log(`[CALCULATION_SERVICE] Valores calculados para imóvel ${row.imovel_id}:`, {
                cadastro: { value: cad.value, missing: cad.missing },
                medicao: { value: med.value, missing: med.missing },
                inadimplencia: { value: ina.value, missing: ina.missing },
                weights: policy.weights
            });

            let score01 = policy.weights.cadastro * cad.value
                + policy.weights.medicao * med.value
                + policy.weights.inadimplencia * ina.value;

            score01 = this.applyPenalty(score01, row, policy);

            const score100 = Math.max(0, Math.min(100, score01 * 100));
            const nivel = this.classifyScore(score100, policy, cad.value, med.value, ina.value);

            const anyMissing = cad.missing || med.missing || ina.missing;
            const templateKey = this.pickTemplateKey(cad.value, med.value, ina.value, anyMissing);

            const motivo = policy.templates.motivo[templateKey] || "";
            const acao = policy.templates.acao_sugerida[templateKey] || "";
            const justificativa = policy.templates.justificativa_curta[templateKey] || "";

            const result = {
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

            // Log detalhado do resultado final
            console.log(`[CALCULATION_SERVICE] Resultado final para imóvel ${row.imovel_id}:`, {
                potencial_score: result.potencial_score,
                potencial_nivel: result.potencial_nivel,
                potencial_cadastro: result.potencial_cadastro,
                potencial_medicao: result.potencial_medicao,
                potencial_inadimplencia: result.potencial_inadimplencia,
                motivo: result.motivo,
                acao_sugerida: result.acao_sugerida,
                justificativa_curta: result.justificativa_curta,
                template_key: templateKey
            });

            return result;
        } catch (error: any) {
            console.error(`[CALCULATION_SERVICE] Erro ao calcular imóvel ${row.imovel_id}:`, error.message);
            throw error;
        }
    }
}
