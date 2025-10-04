// types/index.ts
// -------------------------------------------------------
// Tipagens para API de cálculo por estratégia de RANGES + POLICY local
// -------------------------------------------------------

// Regra por pedaços para uma feature (igual ao $defs/piecewise_rule)
export type PiecewiseRule = {
    feature: string;
    breaks: number[];          // limites crescentes (N)
    values: number[];          // tamanho N+1, valores 0..1
    higher_is_risk: boolean;   // informativo; mapping já traz 0..1 calibrado
};

// Estrutura da policy retornada pelo assistant
export type PotencialReceitaPolicy = {
    policy_id: string;
    periodo: string;
    weights: {
        cadastro: number;
        medicao: number;
        inadimplencia: number;
    };
    mappings: {
        cadastro: PiecewiseRule[];
        medicao: PiecewiseRule[];
        inadimplencia: PiecewiseRule[];
    };
    penalties?: {
        inadimplencia_score_penalty?: {
            trigger_feature: string;
            trigger_threshold: number;
            curve: "linear" | "log";
            max_penalty: number;
        };
    };
    classification: {
        score_thresholds: {
            baixo: number;  // ex.: 40
            medio: number;  // ex.: 70
            alto: number;   // ex.: 100
        };
        nenhum_if_all_potentials_below: number; // ex.: 0.05
    };
    templates: {
        motivo: Record<"MEDICAO_DOMINANTE" | "CADASTRO_DOMINANTE" | "INAD_ALTA" | "DADOS_INSUFICIENTES" | "BALANCEADO", string>;
        acao_sugerida: Record<"MEDICAO_DOMINANTE" | "CADASTRO_DOMINANTE" | "INAD_ALTA" | "DADOS_INSUFICIENTES" | "BALANCEADO", string>;
        justificativa_curta: Record<"MEDICAO_DOMINANTE" | "CADASTRO_DOMINANTE" | "INAD_ALTA" | "DADOS_INSUFICIENTES" | "BALANCEADO", string>;
    };
    meta: {
        validity_days: number;
        notes?: string;
    };
};

// Registro vindo do Supabase (ajuste os nomes conforme seu schema real)
export type ImovelAgregado = {
    imovel_id: string;
    periodo: string; // YYYY-MM-DD
    setor: string;
    meter_age_years?: number | null;
    anomaly_rate?: number | null;           // 0..1
    consumption_cv?: number | null;         // 0..?
    inconsistencias_rate?: number | null;   // 0..1
    delinquency_days?: number | null;       // dias
    open_invoices_count?: number | null;
    open_amount_ratio?: number | null;      // 0..1
    // ... outros campos que não usamos no cálculo
};

// Saída a persistir
export type PotencialOutput = {
    imovel_id: string;
    periodo: string;
    potencial_score: number | null;
    potencial_nivel: "NENHUM" | "BAIXO" | "MEDIO" | "ALTO" | null;
    potencial_cadastro: number | null;
    potencial_medicao: number | null;
    potencial_inadimplencia: number | null;
    motivo: string;
    acao_sugerida: string;
    justificativa_curta: string;
    erro: string | null; // JSON string de auditoria quando houver
};

// Tipos para template keys
export type TemplateKey = "MEDICAO_DOMINANTE" | "CADASTRO_DOMINANTE" | "INAD_ALTA" | "DADOS_INSUFICIENTES" | "BALANCEADO";

// Tipo para resultado de família de potenciais
export type FamilyPotentialResult = {
    value: number;
    missing: boolean;
};
