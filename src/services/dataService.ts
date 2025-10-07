// services/dataService.ts
// -------------------------------------------------------
// Serviço para operações de dados no Supabase
// -------------------------------------------------------
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { ImovelAgregado, ImovelHistoricoAgregadoRaw, ParametroRow, PotencialOutput } from '../types';
import { criarAuditoriaErro, isValidPeriod, isValidUUID, toCanonical } from '../utils';

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

        const rawRecords = data || [] as ImovelHistoricoAgregadoRaw[];
        console.log(`[DATA_SERVICE] Busca concluída em ${queryTime}ms: ${rawRecords.length} imóveis encontrados`);

        if (rawRecords.length === 0) {
            return [];
        }

        // Normalizar registros para nomes canônicos
        console.log(`[DATA_SERVICE] Normalizando registros para nomes canônicos...`);
        return rawRecords.map(record => toCanonical(record));
    }

    // Busca TODOS os imóveis agregados por período (sem filtro de setor)
    async buscarTodosImoveisPeriodo(periodo: string): Promise<ImovelAgregado[]> {
        console.log(`[DATA_SERVICE] Buscando TODOS os imóveis do período: período=${periodo}`);
        const startTime = Date.now();

        const { data, error } = await this.supabase
            .from("imovel_historico_agregado")
            .select("*")
            .eq("periodo", periodo);

        const queryTime = Date.now() - startTime;

        if (error) {
            console.error(`[DATA_SERVICE] Erro na busca de todos os imóveis após ${queryTime}ms:`, error.message);
            throw error;
        }

        const rawRecords = data || [] as ImovelHistoricoAgregadoRaw[];
        console.log(`[DATA_SERVICE] Busca de todos os imóveis concluída em ${queryTime}ms: ${rawRecords.length} imóveis encontrados`);

        if (rawRecords.length === 0) {
            return [];
        }

        // Normalizar registros para nomes canônicos
        console.log(`[DATA_SERVICE] Normalizando registros para nomes canônicos...`);
        return rawRecords.map(record => toCanonical(record));
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
            /*             console.log(`[DATA_SERVICE] Executando upsert em lote de ${toUpsert.length} registros`);
            
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
                        }); */

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

    // ========================================
    // FUNÇÕES PARA PERSISTÊNCIA DE PARÂMETROS
    // ========================================

    /**
     * Salva parâmetros de política na tabela parametros_risco
     * Só cria novos parâmetros se não existirem no banco
     * @param parametros - Array de linhas de parâmetros para inserir
     */
    async salvarParametros(parametros: ParametroRow[]): Promise<void> {
        if (!parametros?.length) return;

        console.log(`[DATA_SERVICE] Verificando ${parametros.length} parâmetros na tabela parametros_risco`);
        const startTime = Date.now();

        // 1. Buscar parâmetros existentes
        const nomesParametros = parametros.map(p => p.nome);
        const { data: existingParams, error: fetchError } = await this.supabase
            .from("parametros_risco")
            .select("nome, valor_num, valor_texto")
            .in("nome", nomesParametros)
            .eq("ativo", true);

        if (fetchError) {
            console.error(`[DATA_SERVICE] Erro ao buscar parâmetros existentes:`, fetchError.message);
            throw fetchError;
        }

        const existingNames = new Set((existingParams || []).map(p => p.nome));
        console.log(`[DATA_SERVICE] Encontrados ${existingNames.size} parâmetros existentes de ${nomesParametros.length} solicitados`);

        // 2. Filtrar apenas parâmetros que não existem
        const novosParametros = parametros.filter(p => !existingNames.has(p.nome));

        if (novosParametros.length === 0) {
            console.log(`[DATA_SERVICE] Todos os parâmetros já existem no banco. Nenhuma inserção necessária.`);
            return;
        }

        console.log(`[DATA_SERVICE] Criando ${novosParametros.length} novos parâmetros`);

        // 3. Preparar dados para inserção (apenas novos)
        const insertData = novosParametros.map(param => ({
            nome: param.nome,
            valor_num: param.valor_num,
            valor_texto: param.valor_texto,
            ativo: true
        }));

        // Log detalhado dos novos parâmetros
        console.log(`[DATA_SERVICE] Novos parâmetros sendo inseridos:`);
        insertData.forEach((param, index) => {
            console.log(`[DATA_SERVICE] Parâmetro ${index + 1}:`, {
                nome: param.nome,
                valor_num: param.valor_num,
                valor_texto: param.valor_texto
            });
        });

        const insertStartTime = Date.now();

        // 4. Inserir apenas novos parâmetros
        const { error } = await this.supabase
            .from("parametros_risco")
            .insert(insertData);

        const insertTime = Date.now() - insertStartTime;

        if (error) {
            console.error(`[DATA_SERVICE] Erro na inserção de novos parâmetros após ${insertTime}ms:`, error.message);
            console.log(`[DATA_SERVICE] Tentando inserção individual para ${insertData.length} parâmetros`);

            // Fallback por registro para identificar erro
            for (const param of insertData) {
                const { error: e } = await this.supabase
                    .from("parametros_risco")
                    .insert([param]);
                if (e) {
                    console.error(`[DATA_SERVICE] Erro na inserção individual para parâmetro ${param.nome}:`, e.message);
                }
            }
        } else {
            console.log(`[DATA_SERVICE] Inserção de novos parâmetros concluída com sucesso em ${insertTime}ms`);
        }

        const totalTime = Date.now() - startTime;
        console.log(`[DATA_SERVICE] Processo de parâmetros finalizado em ${totalTime}ms`);
        console.log(`[DATA_SERVICE] Resumo: ${existingNames.size} existentes, ${novosParametros.length} novos inseridos`);
    }

    /**
     * Verifica se os parâmetros essenciais existem no banco
     * @returns true se todos os parâmetros essenciais existem, false caso contrário
     */
    async verificarParametrosEssenciais(): Promise<boolean> {
        const parametrosEssenciais = [
            'w_med_idade', 'w_med_anomalias', 'w_med_desvio',
            'w_inad_atraso', 'w_inad_indice', 'w_inad_valor_aberto',
            'z_warn_cad', 'z_risk_cad',
            'thr_baixo', 'thr_medio', 'thr_alto', 'none_cut',
            'pen_trigger_ratio', 'pen_max', 'pen_curve'
        ];

        console.log(`[DATA_SERVICE] Verificando ${parametrosEssenciais.length} parâmetros essenciais`);

        const { data, error } = await this.supabase
            .from("parametros_risco")
            .select("nome")
            .in("nome", parametrosEssenciais)
            .eq("ativo", true);

        if (error) {
            console.error(`[DATA_SERVICE] Erro ao verificar parâmetros essenciais:`, error.message);
            return false;
        }

        const parametrosExistentes = (data || []).map(p => p.nome);
        const todosExistem = parametrosEssenciais.every(param => parametrosExistentes.includes(param));

        console.log(`[DATA_SERVICE] Parâmetros essenciais: ${parametrosExistentes.length}/${parametrosEssenciais.length} encontrados`);

        if (todosExistem) {
            console.log(`[DATA_SERVICE] ✅ Todos os parâmetros essenciais existem no banco`);
        } else {
            const faltando = parametrosEssenciais.filter(param => !parametrosExistentes.includes(param));
            console.log(`[DATA_SERVICE] ❌ Parâmetros faltando: ${faltando.join(', ')}`);
        }

        return todosExistem;
    }
}


const coverageLog = (coverage: any) => {
    console.log(`[DATA_SERVICE] Cobertura por campo:`);
    for (const [field, rate] of Object.entries(coverage.fields)) {
        console.log(`[DATA_SERVICE]   ${field}: ${(rate as number * 100).toFixed(1)}%`);
    }

    console.log(`[DATA_SERVICE] Cobertura por família:`);
    console.log(`[DATA_SERVICE]   cadastro: ${(coverage.families.cadastro * 100).toFixed(1)}%`);
    console.log(`[DATA_SERVICE]   medicao: ${(coverage.families.medicao * 100).toFixed(1)}%`);
    console.log(`[DATA_SERVICE]   inadimplencia: ${(coverage.families.inadimplencia * 100).toFixed(1)}%`);
}