import {
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

    // Cálculo completo para 1 imóvel
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
