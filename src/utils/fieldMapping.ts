// utils/fieldMapping.ts
// -------------------------------------------------------
// Mapeamento e normalização de campos do banco de dados
// -------------------------------------------------------
// 
// Mapeamento de features para nomes canônicos:
// meter_age_years = idade_hidrometro_meses / 12.0
// anomaly_rate = taxa_anomalias
// consumption_cv = se coef_var_consumo não nulo usar coef_var_consumo; senão, se std_consumo_m3 e media_consumo_m3 > 0 usar std_consumo_m3 / media_consumo_m3; caso contrário null
// inconsistencias_rate = null por enquanto (deixar ponto de extensão para join futuro)
// delinquency_days = media_tempo_atraso
// open_invoices_count = qtd_contas_abertas
// open_amount_ratio = se indice_inadimplencia não nulo usar indice_inadimplencia; senão normalizar valor_total_aberto pelo P95 do período e setor (open_amount_ratio = LEAST(valor_total_aberto / p95, 1.0)), bound 0..1

import { ImovelAgregado, ImovelHistoricoAgregadoRaw } from '../types';

// Mapeamento de campos canônicos para possíveis nomes no banco
export const FIELD_MAPPING: Record<string, string[]> = {
    // Medição
    meter_age_years: [
        'meter_age_years',
        'hidrometro_idade_anos',
        'idade_hidrometro',
        'meter_age',
        'hidrometro_age'
    ],
    anomaly_rate: [
        'anomaly_rate',
        'anomalias_12m',
        'anomalias_rate',
        'anomaly_ratio',
        'taxa_anomalias'
    ],
    consumption_cv: [
        'consumption_cv',
        'desvio_padrao_consumo',
        'cv_consumo',
        'consumption_variance',
        'coeficiente_variacao'
    ],

    // Cadastro
    inconsistencias_rate: [
        'inconsistencias_rate',
        'inconsistencias_total',
        'taxa_inconsistencias',
        'inconsistency_rate',
        'regras_aplicadas'
    ],

    // Inadimplência
    delinquency_days: [
        'delinquency_days',
        'dias_atraso_medio',
        'days_delinquency',
        'atraso_dias',
        'dias_atraso'
    ],
    open_invoices_count: [
        'open_invoices_count',
        'faturas_abertas',
        'invoices_open',
        'faturas_em_aberto',
        'open_invoices'
    ],
    open_amount_ratio: [
        'open_amount_ratio',
        'valor_aberto_12m',
        'amount_open_ratio',
        'ratio_valor_aberto',
        'valor_aberto_ratio'
    ]
};

// Campos obrigatórios para cada família
export const FAMILY_FIELDS = {
    cadastro: ['inconsistencias_rate'],
    medicao: ['meter_age_years', 'anomaly_rate', 'consumption_cv'],
    inadimplencia: ['delinquency_days', 'open_invoices_count', 'open_amount_ratio']
};

// Função para encontrar o nome real do campo no banco
export function findFieldName(canonicalName: string, availableFields: string[]): string | null {
    const possibleNames = FIELD_MAPPING[canonicalName] || [canonicalName];

    for (const possibleName of possibleNames) {
        if (availableFields.includes(possibleName)) {
            return possibleName;
        }
    }

    return null;
}

// Função para normalizar um registro do banco para os nomes canônicos
export function normalizeRecord(record: any): ImovelAgregado {
    const normalized: any = {
        imovel_id: record.imovel_id,
        periodo: record.periodo,
        setor: record.setor
    };

    // Mapear cada campo canônico
    for (const [canonicalName, possibleNames] of Object.entries(FIELD_MAPPING)) {
        let value = null;

        // Procurar o valor em qualquer um dos nomes possíveis
        for (const possibleName of possibleNames) {
            if (record[possibleName] !== undefined && record[possibleName] !== null) {
                value = record[possibleName];
                break;
            }
        }

        normalized[canonicalName] = value;
    }

    return normalized as ImovelAgregado;
}

// Função para calcular cobertura de campos
export function calculateFieldCoverage(records: any[]): Record<string, { coverage: number; count: number; total: number }> {
    const coverage: Record<string, { coverage: number; count: number; total: number }> = {};
    const totalRecords = records.length;

    if (totalRecords === 0) return coverage;

    // Calcular cobertura para cada campo canônico
    for (const canonicalName of Object.keys(FIELD_MAPPING)) {
        let nonNullCount = 0;

        for (const record of records) {
            const fieldName = findFieldName(canonicalName, Object.keys(record));
            if (fieldName && record[fieldName] !== null && record[fieldName] !== undefined) {
                nonNullCount++;
            }
        }

        coverage[canonicalName] = {
            coverage: (nonNullCount / totalRecords) * 100,
            count: nonNullCount,
            total: totalRecords
        };
    }

    return coverage;
}

// Função para calcular cobertura por família
export function calculateFamilyCoverage(records: any[]): Record<string, { coverage: number; fields: Record<string, number> }> {
    const fieldCoverage = calculateFieldCoverage(records);
    const familyCoverage: Record<string, { coverage: number; fields: Record<string, number> }> = {};

    for (const [familyName, fieldNames] of Object.entries(FAMILY_FIELDS)) {
        const familyFields: Record<string, number> = {};
        let totalCoverage = 0;

        for (const fieldName of fieldNames) {
            const coverage = fieldCoverage[fieldName]?.coverage || 0;
            familyFields[fieldName] = coverage;
            totalCoverage += coverage;
        }

        familyCoverage[familyName] = {
            coverage: totalCoverage / fieldNames.length, // Média da cobertura da família
            fields: familyFields
        };
    }

    return familyCoverage;
}

// Função para verificar se a cobertura é suficiente
export function isCoverageSufficient(familyCoverage: Record<string, { coverage: number; fields: Record<string, number> }>, minCoverage: number = 20): boolean {
    for (const [familyName, familyData] of Object.entries(familyCoverage)) {
        if (familyData.coverage < minCoverage) {
            console.warn(`[FIELD_MAPPING] Cobertura insuficiente para família ${familyName}: ${familyData.coverage.toFixed(1)}% (mínimo: ${minCoverage}%)`);
            return false;
        }
    }
    return true;
}

const toNum = (v: string | number | null | undefined): number | null =>
    v == null ? null : typeof v === "number" ? v : Number(v);
const div = (a: number | null, b: number | null): number | null =>
    a != null && b != null && b !== 0 ? a / b : null;
const clamp01 = (x: number | null): number | null =>
    x == null ? null : Math.max(0, Math.min(1, x));

export function toCanonical(r: ImovelHistoricoAgregadoRaw, p95ValorAberto?: number | null): ImovelAgregado {
    const meter_age_years = div(r.idade_hidrometro_meses ?? null, 12);
    const anomaly_rate = toNum(r.taxa_anomalias);
    const consumption_cv =
        toNum(r.coef_var_consumo) ??
        div(toNum(r.std_consumo_m3), toNum(r.media_consumo_m3));
    const delinquency_days = toNum(r.media_tempo_atraso);
    const open_invoices_count = r.qtd_contas_abertas ?? null;

    let open_amount_ratio = toNum(r.indice_inadimplencia);
    if (open_amount_ratio == null) {
        const val = toNum(r.valor_total_aberto);
        if (val != null && p95ValorAberto && p95ValorAberto > 0) {
            open_amount_ratio = clamp01(val / p95ValorAberto);
        }
    }

    return {
        imovel_id: r.imovel_id,
        periodo: r.periodo,
        setor: r.setor,
        meter_age_years,
        anomaly_rate,
        consumption_cv,
        inconsistencias_rate: null,
        delinquency_days,
        open_invoices_count,
        open_amount_ratio,
    };
}


// Função para calcular cobertura após normalização
export function computeCoverage(rows: Array<ReturnType<typeof toCanonical>>): {
    total: number;
    fields: Record<string, number>;
    families: { cadastro: number; medicao: number; inadimplencia: number };
    presenceRates?: Record<string, number>;
} {
    const total = rows.length;
    if (total === 0) {
        return {
            total: 0,
            fields: {},
            families: { cadastro: 0, medicao: 0, inadimplencia: 0 }
        };
    }

    // Calcular cobertura por campo
    const fields: Record<string, number> = {};
    const canonicalFields = ['meter_age_years', 'anomaly_rate', 'consumption_cv', 'inconsistencias_rate', 'delinquency_days', 'open_invoices_count', 'open_amount_ratio'];

    for (const field of canonicalFields) {
        const nonNullCount = rows.filter(row => Number.isFinite(row[field as keyof typeof row])).length;
        fields[field] = nonNullCount / total;
    }

    // Calcular cobertura por família
    const families = {
        cadastro: fields.inconsistencias_rate || 0,
        medicao: (fields.meter_age_years + fields.anomaly_rate + fields.consumption_cv) / 3,
        inadimplencia: (fields.delinquency_days + fields.open_invoices_count + fields.open_amount_ratio) / 3
    };

    return {
        total,
        fields,
        families,
        presenceRates: fields // Para usar no payload do assistant se necessário
    };
}

// Função para criar auditoria de erro
export function criarAuditoriaErro(tipoErro: string, row: any, error: any, extra?: any): string {
    return JSON.stringify({
        tipo_erro: tipoErro,
        timestamp: new Date().toISOString(),
        imovel_id: row?.imovel_id || 'unknown',
        periodo: row?.periodo || 'unknown',
        setor: row?.setor || 'unknown',
        error_message: error?.message || String(error),
        extra: extra || null
    });
}
