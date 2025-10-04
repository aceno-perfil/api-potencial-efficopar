// utils/helpers.ts
// -------------------------------------------------------
// Utilitários diversos
// -------------------------------------------------------

// Cria auditoria de erro em string JSON
export function criarAuditoriaErro(
    tipoErro: string,
    dadosOriginais: unknown,
    erro: unknown,
    contexto: Record<string, unknown> = {}
): string {
    const e = (erro as any) || {};
    return JSON.stringify({
        timestamp: new Date().toISOString(),
        tipo_erro: tipoErro,
        erro_mensagem: e.message || String(erro),
        dados_originais: dadosOriginais,
        contexto,
        stack_trace: e.stack || null,
    });
}

// Arredonda p/ 2 casas
export const round2 = (n: number) => Math.round(n * 100) / 100;

// Pega valor numérico seguro (fallback 0)
export const num = (v: number | null | undefined, fallback = 0) => (Number.isFinite(v as number) ? Number(v) : fallback);
