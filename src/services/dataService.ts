// services/dataService.ts
// -------------------------------------------------------
// Serviço para operações de dados no Supabase
// -------------------------------------------------------

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { ImovelAgregado, PotencialOutput } from '../types';
import { criarAuditoriaErro, isValidPeriod, isValidUUID } from '../utils';

export class DataService {
    private supabase: SupabaseClient;

    constructor(supabaseUrl: string, supabaseKey: string) {
        this.supabase = createClient(supabaseUrl, supabaseKey);
    }

    // Busca imóveis agregados por período e setor
    async buscarImoveis(periodo: string, setor: string): Promise<ImovelAgregado[]> {
        console.log(`[DATA_SERVICE] Buscando imóveis: período=${periodo}, setor=${setor}`);
        const startTime = Date.now();

        const { data, error } = await this.supabase
            .from("imovel_historico_agregado")
            .select("*")
            .eq("periodo", periodo)
            .eq("setor", setor);

        const queryTime = Date.now() - startTime;

        if (error) {
            console.error(`[DATA_SERVICE] Erro na busca de imóveis após ${queryTime}ms:`, error.message);
            throw error;
        }

        console.log(`[DATA_SERVICE] Busca concluída em ${queryTime}ms: ${(data || []).length} imóveis encontrados`);
        return (data || []) as ImovelAgregado[];
    }

    // Salva potenciais calculados com validação e auditoria
    async salvarPotenciais(items: PotencialOutput[]): Promise<void> {
        if (!items?.length) return;

        console.log(`[DATA_SERVICE] Iniciando persistência de ${items.length} potenciais`);
        const startTime = Date.now();

        const valid: PotencialOutput[] = [];
        const invalid: PotencialOutput[] = [];

        for (const it of items) {
            const errs: string[] = [];
            if (!isValidUUID(it.imovel_id)) errs.push(`UUID inválido: ${it.imovel_id}`);
            if (!isValidPeriod(it.periodo)) errs.push(`Período inválido: ${it.periodo}`);
            if (errs.length) {
                invalid.push({
                    ...it,
                    potencial_score: null,
                    potencial_nivel: null,
                    potencial_cadastro: null,
                    potencial_medicao: null,
                    potencial_inadimplencia: null,
                    motivo: "",
                    acao_sugerida: "",
                    justificativa_curta: "",
                    erro: criarAuditoriaErro("VALIDACAO_FALHOU", it, new Error(errs.join("; ")), { imovel_id: it.imovel_id, periodo: it.periodo }),
                });
            } else {
                valid.push(it);
            }
        }

        console.log(`[DATA_SERVICE] Validação concluída: ${valid.length} válidos, ${invalid.length} inválidos`);

        const dedup = new Map<string, PotencialOutput>();
        for (const v of valid) {
            const k = `${v.imovel_id}-${v.periodo}`;
            if (!dedup.has(k)) dedup.set(k, v);
        }
        const toUpsert = Array.from(dedup.values());

        console.log(`[DATA_SERVICE] Após deduplicação: ${toUpsert.length} registros para upsert`);

        // Upsert em lote
        if (toUpsert.length) {
            console.log(`[DATA_SERVICE] Executando upsert em lote de ${toUpsert.length} registros`);

            // Log detalhado dos primeiros 3 registros para debug
            console.log(`[DATA_SERVICE] Amostra dos dados sendo persistidos:`);
            toUpsert.slice(0, 3).forEach((item, index) => {
                console.log(`[DATA_SERVICE] Registro ${index + 1}:`, {
                    imovel_id: item.imovel_id,
                    periodo: item.periodo,
                    potencial_score: item.potencial_score,
                    potencial_nivel: item.potencial_nivel,
                    potencial_cadastro: item.potencial_cadastro,
                    potencial_medicao: item.potencial_medicao,
                    potencial_inadimplencia: item.potencial_inadimplencia,
                    motivo: item.motivo,
                    acao_sugerida: item.acao_sugerida,
                    justificativa_curta: item.justificativa_curta,
                    erro: item.erro
                });
            });

            const upsertStartTime = Date.now();

            const { error } = await this.supabase
                .from("potencial_receita_imovel")
                .upsert(toUpsert, { onConflict: "imovel_id,periodo", ignoreDuplicates: false });

            const upsertTime = Date.now() - upsertStartTime;

            if (error) {
                console.error(`[DATA_SERVICE] Erro no upsert em lote após ${upsertTime}ms:`, error.message);
                console.log(`[DATA_SERVICE] Tentando upsert individual para ${toUpsert.length} registros`);

                // fallback por registro para identificar erro
                for (const v of toUpsert) {
                    const { error: e } = await this.supabase
                        .from("potencial_receita_imovel")
                        .upsert([v], { onConflict: "imovel_id,periodo", ignoreDuplicates: false });
                    if (e) {
                        console.error(`[DATA_SERVICE] Erro no upsert individual para imóvel ${v.imovel_id}:`, e.message);
                        const auditoria = criarAuditoriaErro("UPSERT_INDIVIDUAL_FALHOU", v, e, { imovel_id: v.imovel_id, periodo: v.periodo });
                        await this.supabase
                            .from("potencial_receita_imovel")
                            .upsert([{ ...v, erro: auditoria }], { onConflict: "imovel_id,periodo", ignoreDuplicates: false });
                    }
                }
            } else {
                console.log(`[DATA_SERVICE] Upsert em lote concluído com sucesso em ${upsertTime}ms`);
            }
        }

        // Persiste inválidos (para rastreabilidade)
        if (invalid.length) {
            console.log(`[DATA_SERVICE] Persistindo ${invalid.length} registros inválidos para auditoria`);
            await this.supabase
                .from("potencial_receita_imovel")
                .upsert(invalid, { onConflict: "imovel_id,periodo", ignoreDuplicates: false });
        }

        const totalTime = Date.now() - startTime;
        console.log(`[DATA_SERVICE] Persistência completa finalizada em ${totalTime}ms`);
    }

    // Busca erros gravados
    async buscarErros(limit: number = 50, offset: number = 0, tipoErro?: string) {
        const lim = Math.max(1, Math.min(500, limit));
        const off = Math.max(0, offset);

        let query = this.supabase
            .from("potencial_receita_imovel")
            .select("*")
            .not("erro", "is", null)
            .order("created_at", { ascending: false })
            .range(off, off + lim - 1);

        const { data, error } = await query;
        if (error) throw error;

        const dadosFiltrados = tipoErro
            ? (data || []).filter((r: any) => {
                try {
                    const o = JSON.parse(r.erro);
                    return o.tipo_erro === tipoErro;
                } catch {
                    return false;
                }
            })
            : (data || []);

        return { total: dadosFiltrados.length, limit: lim, offset: off, dados: dadosFiltrados };
    }
}
