// routes/calculation.ts
// -------------------------------------------------------
// Rotas para cálculo de potencial
// -------------------------------------------------------

import { Request, Response } from "express";
import { CalculationService, DataService, PolicyService } from '../services';
import { compactToParametrosRows, computeCoverage, criarAuditoriaErro, validateCompactPolicy } from '../utils';

export function createCalculationRoutes(
    dataService: DataService,
    policyService: PolicyService,
    calculationService: CalculationService
) {
    return {
        // Rodar cálculo por período/setor usando RANGES + POLICY
        runCalculation: async (req: Request, res: Response) => {
            const startTime = Date.now();
            try {
                const { ano, mes, setor } = req.params;
                const periodo = `${ano}-${String(mes).padStart(2, "0")}-01`;

                // 1) Buscar TODOS os imóveis do período para gerar a política (não apenas do setor)
                console.log(`[CALCULATION] Buscando TODOS os imóveis do período=${periodo} para gerar política`);
                const todosImoveis = await dataService.buscarTodosImoveisPeriodo(periodo);
                console.log(`[CALCULATION] Encontrados ${todosImoveis.length} imóveis no período`);

                if (!todosImoveis.length) {
                    return res.status(404).json({ erro: "Nenhum imóvel encontrado no período" });
                }

                // 2) Buscar imóveis específicos do setor para cálculo
                console.log(`[CALCULATION] Buscando imóveis específicos do setor=${setor}`);
                const imoveis = await dataService.buscarImoveis(periodo, setor);
                console.log(`[CALCULATION] Encontrados ${imoveis.length} imóveis no setor`);

                if (!imoveis.length) {
                    return res.status(404).json({ erro: "Nenhum imóvel encontrado no setor" });
                }

                // 3) Calcular cobertura após normalização
                const coverage = computeCoverage(imoveis);
                console.log(`[CALCULATION] ✅ Cobertura de dados adequada, prosseguindo com cálculo`);

                // 4) Verificar se parâmetros essenciais existem no banco
                console.log(`[CALCULATION] Verificando se parâmetros essenciais existem no banco`);
                const parametrosExistem = await dataService.verificarParametrosEssenciais();

                let compactPolicy: any;

                if (!parametrosExistem) {
                    // 5) Obter compact policy do assistant apenas se necessário
                    console.log(`[CALCULATION] Parâmetros não existem. Obtendo compact policy do assistant (usando ${todosImoveis.length} imóveis)`);
                    compactPolicy = await policyService.obterCompactPolicyPorRanges(periodo, todosImoveis, setor);
                    console.log(`[CALCULATION] Compact policy obtida: ${compactPolicy.policy_id}`);

                    // Validar estrutura compact
                    if (!validateCompactPolicy(compactPolicy)) {
                        throw new Error("Compact policy inválida recebida do assistant");
                    }

                    // Log detalhado da compact policy para debug
                    console.log(`[CALCULATION] Compact policy details:`, {
                        policy_id: compactPolicy.policy_id,
                        familias: compactPolicy.familias,
                        inadimplencia: compactPolicy.inadimplencia,
                        medicao: compactPolicy.medicao,
                        cadastro: compactPolicy.cadastro,
                        potencial: compactPolicy.potencial,
                        classificacao: compactPolicy.classificacao
                    });

                    // 6) Converter compact policy para linhas de parâmetros e salvar apenas novos
                    console.log(`[CALCULATION] Convertendo compact policy para linhas de parâmetros`);
                    const parametrosRows = compactToParametrosRows(compactPolicy, periodo, setor);

                    console.log(`[CALCULATION] Salvando apenas novos parâmetros na tabela parametros_risco`);
                    console.log(`[CALCULATION] Parâmetros:`, JSON.stringify(parametrosRows));
                    await dataService.salvarParametros(parametrosRows);
                    console.log(`[CALCULATION] Processo de parâmetros concluído`);
                } else {
                    console.log(`[CALCULATION] ✅ Todos os parâmetros essenciais já existem no banco. Pulando geração de política.`);
                    // Criar uma política vazia para compatibilidade (não será usada)
                    compactPolicy = {
                        policy_id: "EXISTING_PARAMS",
                        familias: { cadastro: 0.3, medicao: 0.5, inadimplencia: 0.2 },
                        inadimplencia: { w_days: 0.34, w_open_count: 0.33, w_amount_ratio: 0.33, trigger_ratio: 0.6, penalty_max: 0.1, curve: "linear" },
                        medicao: { w_idade: 0.4, w_anomalias: 0.3, w_desvio: 0.3 },
                        cadastro: { z_warn: 0.10, z_risk: 0.30 },
                        potencial: { pot_min: 0.0, pot_max: 1.0 },
                        classificacao: { baixo: 40, medio: 70, alto: 100, nenhum_if_all_potentials_below: 0.05 }
                    };
                }

                // 7) Calcular localmente por imóvel usando CompactPolicyParametros
                console.log(`[CALCULATION] Iniciando cálculos individuais para ${imoveis.length} imóveis`);
                const calculationStartTime = Date.now();

                const outputs = imoveis.map((row, index) => {
                    try {
                        const result = calculationService.calcularPotenciaisCompact(row, compactPolicy);

                        // Log detalhado dos primeiros 3 cálculos para debug
                        if (index < 3) {
                            /*                             console.log(`[CALCULATION] Cálculo ${index + 1} - Imóvel ${row.imovel_id}:`, {
                                                            potencial_score: result.potencial_score,
                                                            potencial_nivel: result.potencial_nivel,
                                                            potencial_cadastro: result.potencial_cadastro,
                                                            potencial_medicao: result.potencial_medicao,
                                                            potencial_inadimplencia: result.potencial_inadimplencia,
                                                            motivo: result.motivo,
                                                            acao_sugerida: result.acao_sugerida,
                                                            justificativa_curta: result.justificativa_curta,
                                                            erro: result.erro
                                                        }); */
                        }

                        if (index % 100 === 0) { // Log a cada 100 imóveis processados
                            console.log(`[CALCULATION] Processados ${index + 1}/${imoveis.length} imóveis`);
                        }
                        return result;
                    } catch (err: any) {
                        console.error(`[CALCULATION] Erro ao calcular imóvel ${row.imovel_id}:`, err.message);
                        return {
                            imovel_id: row.imovel_id,
                            periodo: row.periodo,
                            potencial_score: null,
                            potencial_nivel: null,
                            potencial_cadastro: null,
                            potencial_medicao: null,
                            potencial_inadimplencia: null,
                            motivo: "",
                            acao_sugerida: "",
                            justificativa_curta: "",
                            erro: criarAuditoriaErro("CALCULO_FALHOU", row, err),
                        };
                    }
                });

                const calculationTime = Date.now() - calculationStartTime;
                console.log(`[CALCULATION] Cálculos individuais concluídos em ${calculationTime}ms`);

                // 8) Persistir resultados (com validação/erros)
                console.log(`[CALCULATION] Persistindo ${outputs.length} resultados`);
                const persistStartTime = Date.now();
                await dataService.salvarPotenciais(outputs);
                const persistTime = Date.now() - persistStartTime;
                console.log(`[CALCULATION] Persistência concluída em ${persistTime}ms`);

                const totalTime = Date.now() - startTime;
                console.log(`[CALCULATION] Processo completo finalizado em ${totalTime}ms`);

                // Calcular métricas de dados insuficientes
                const insufficientDataCount = outputs.filter(o =>
                    o.potencial_nivel === 'NENHUM' && o.motivo.includes('DADOS_INSUFICIENTES')
                ).length;

                const insufficientDataPercentage = (insufficientDataCount / outputs.length) * 100;

                console.log(`[CALCULATION] Métricas de dados insuficientes:`, {
                    total_insufficient: insufficientDataCount,
                    percentage: `${insufficientDataPercentage.toFixed(1)}%`,
                    sufficient_data: outputs.length - insufficientDataCount
                });

                res.json({
                    periodo,
                    setor,
                    total_imoveis_periodo: todosImoveis.length,
                    total_imoveis_setor: imoveis.length,
                    policy_id: compactPolicy.policy_id,
                    policy_source: parametrosExistem ? "EXISTING_PARAMS" : "AI_GENERATED",
                    parametros_existentes: parametrosExistem,
                    processados: outputs.length,
                    metrics: {
                        insufficient_data_count: insufficientDataCount,
                        insufficient_data_percentage: insufficientDataPercentage,
                        sufficient_data_count: outputs.length - insufficientDataCount,
                        coverage_status: 'adequate',
                        coverage_details: coverage
                    }
                });
            } catch (err: any) {
                const totalTime = Date.now() - startTime;
                console.error(`[CALCULATION] Erro após ${totalTime}ms:`, err.message);
                res.status(500).json({ erro: err.message });
            }
        },
    };
}
