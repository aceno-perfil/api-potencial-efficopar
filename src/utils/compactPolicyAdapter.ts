// utils/compactPolicyAdapter.ts
// -------------------------------------------------------
// Adapter para converter compact_policy_parametros em linhas para parametros_risco
// -------------------------------------------------------

import { CompactPolicyParametros, ParametroRow } from '../types';

// Defaults de segurança conforme especificação
const DEFAULT_VALUES = {
    familias: {
        cadastro: 0.3,
        medicao: 0.5,
        inadimplencia: 0.2
    },
    inadimplencia: {
        w_days: 0.34,
        w_open_count: 0.33,
        w_amount_ratio: 0.33,
        trigger_ratio: 0.6,
        penalty_max: 0.1,
        curve: "linear" as const
    },
    medicao: {
        w_idade: 0.4,
        w_anomalias: 0.3,
        w_desvio: 0.3
    },
    cadastro: {
        z_warn: 0.10,
        z_risk: 0.30
    },
    potencial: {
        pot_min: 0.0,
        pot_max: 1.0
    },
    classificacao: {
        baixo: 40,
        medio: 70,
        alto: 100,
        nenhum_if_all_potentials_below: 0.05
    }
};

/**
 * Normaliza pesos para somar 1.0
 */
function normalizeWeights(weights: { [key: string]: number }): { [key: string]: number } {
    const sum = Object.values(weights).reduce((acc, val) => acc + val, 0);
    if (sum === 0) return weights;

    const normalized: { [key: string]: number } = {};
    for (const [key, value] of Object.entries(weights)) {
        normalized[key] = value / sum;
    }
    return normalized;
}

/**
 * Converte compact_policy_parametros em linhas para parametros_risco
 * @param compact - Estrutura compact retornada pelo modelo
 * @param periodo - Período da política
 * @param setor - Setor da política
 * @returns Array de linhas para inserir na tabela parametros_risco
 */
export function compactToParametrosRows(
    compact: CompactPolicyParametros,
    periodo: string,
    setor: string
): ParametroRow[] {
    console.log(`[COMPACT_ADAPTER] Convertendo política ${compact.policy_id} para linhas de parâmetros`);

    const rows: ParametroRow[] = [];

    // Aplicar defaults de segurança e normalizar pesos
    const familias = normalizeWeights({
        cadastro: compact.familias?.cadastro ?? DEFAULT_VALUES.familias.cadastro,
        medicao: compact.familias?.medicao ?? DEFAULT_VALUES.familias.medicao,
        inadimplencia: compact.familias?.inadimplencia ?? DEFAULT_VALUES.familias.inadimplencia
    });

    const inadimplencia = {
        w_days: compact.inadimplencia?.w_days ?? DEFAULT_VALUES.inadimplencia.w_days,
        w_open_count: compact.inadimplencia?.w_open_count ?? DEFAULT_VALUES.inadimplencia.w_open_count,
        w_amount_ratio: compact.inadimplencia?.w_amount_ratio ?? DEFAULT_VALUES.inadimplencia.w_amount_ratio,
        trigger_ratio: compact.inadimplencia?.trigger_ratio ?? DEFAULT_VALUES.inadimplencia.trigger_ratio,
        penalty_max: compact.inadimplencia?.penalty_max ?? DEFAULT_VALUES.inadimplencia.penalty_max,
        curve: compact.inadimplencia?.curve ?? DEFAULT_VALUES.inadimplencia.curve
    };

    const medicao = normalizeWeights({
        w_idade: compact.medicao?.w_idade ?? DEFAULT_VALUES.medicao.w_idade,
        w_anomalias: compact.medicao?.w_anomalias ?? DEFAULT_VALUES.medicao.w_anomalias,
        w_desvio: compact.medicao?.w_desvio ?? DEFAULT_VALUES.medicao.w_desvio
    });

    const cadastro = {
        z_warn: compact.cadastro?.z_warn ?? DEFAULT_VALUES.cadastro.z_warn,
        z_risk: compact.cadastro?.z_risk ?? DEFAULT_VALUES.cadastro.z_risk
    };

    const potencial = {
        pot_min: compact.potencial?.pot_min ?? DEFAULT_VALUES.potencial.pot_min,
        pot_max: compact.potencial?.pot_max ?? DEFAULT_VALUES.potencial.pot_max
    };

    const classificacao = {
        baixo: compact.classificacao?.baixo ?? DEFAULT_VALUES.classificacao.baixo,
        medio: compact.classificacao?.medio ?? DEFAULT_VALUES.classificacao.medio,
        alto: compact.classificacao?.alto ?? DEFAULT_VALUES.classificacao.alto,
        nenhum_if_all_potentials_below: compact.classificacao?.nenhum_if_all_potentials_below ?? DEFAULT_VALUES.classificacao.nenhum_if_all_potentials_below
    };

    // Mapeamento conforme especificação
    const mappings = [
        // Inadimplência
        { nome: 'w_inad_atraso', valor_num: inadimplencia.w_days },
        { nome: 'w_inad_indice', valor_num: inadimplencia.w_open_count },
        { nome: 'w_inad_valor_aberto', valor_num: inadimplencia.w_amount_ratio },
        { nome: 'pen_trigger_ratio', valor_num: inadimplencia.trigger_ratio },
        { nome: 'pen_max', valor_num: inadimplencia.penalty_max },
        { nome: 'pen_curve', valor_texto: inadimplencia.curve },

        // Medição
        { nome: 'w_med_idade', valor_num: medicao.w_idade },
        { nome: 'w_med_anomalias', valor_num: medicao.w_anomalias },
        { nome: 'w_med_desvio', valor_num: medicao.w_desvio },

        // Cadastro
        { nome: 'z_warn_cad', valor_num: cadastro.z_warn },
        { nome: 'z_risk_cad', valor_num: cadastro.z_risk },

        // Potencial
        { nome: 'pot_min', valor_num: potencial.pot_min },
        { nome: 'pot_max', valor_num: potencial.pot_max },

        // Famílias (para uso futuro)
        { nome: 'w_fam_cadastro', valor_num: familias.cadastro },
        { nome: 'w_fam_medicao', valor_num: familias.medicao },
        { nome: 'w_fam_inad', valor_num: familias.inadimplencia },

        // Classificação
        { nome: 'thr_baixo', valor_num: classificacao.baixo },
        { nome: 'thr_medio', valor_num: classificacao.medio },
        { nome: 'thr_alto', valor_num: classificacao.alto },
        { nome: 'none_cut', valor_num: classificacao.nenhum_if_all_potentials_below }
    ];

    // Converter para ParametroRow
    for (const mapping of mappings) {
        rows.push({
            nome: mapping.nome,
            valor_num: mapping.valor_num ?? null,
            valor_texto: mapping.valor_texto ?? null
        });
    }

    console.log(`[COMPACT_ADAPTER] Geradas ${rows.length} linhas de parâmetros`);
    console.log(`[COMPACT_ADAPTER] Amostra dos parâmetros:`, rows.slice(0, 5).map(r => ({
        nome: r.nome,
        valor_num: r.valor_num,
        valor_texto: r.valor_texto
    })));

    return rows;
}

/**
 * Valida se a estrutura compact tem os campos necessários
 * @param compact - Estrutura a ser validada
 * @returns true se válida, false caso contrário
 */
export function validateCompactPolicy(compact: any): compact is CompactPolicyParametros {
    if (!compact || typeof compact !== 'object') return false;

    // Campos obrigatórios
    const requiredFields = ['policy_id'];
    for (const field of requiredFields) {
        if (!compact[field]) return false;
    }

    return true;
}
