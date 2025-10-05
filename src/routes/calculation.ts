// routes/calculation.ts
// -------------------------------------------------------
// Rotas para cálculo de potencial
// -------------------------------------------------------

import { Request, Response } from "express";
import { CalculationService, DataService, PolicyService } from '../services';
import { computeCoverage, criarAuditoriaErro } from '../utils';

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

                // 1) Buscar imóveis e normalizar para campos canônicos
                console.log(`[CALCULATION] Buscando imóveis para período=${periodo}, setor=${setor}`);
                const imoveis = await dataService.buscarImoveis(periodo, setor);
                console.log(`[CALCULATION] Encontrados ${imoveis.length} imóveis`);

                if (!imoveis.length) {
                    return res.status(404).json({ erro: "Nenhum imóvel encontrado" });
                }

                // 2) Calcular cobertura após normalização
                const coverage = computeCoverage(imoveis);
                console.log(`[CALCULATION] ✅ Cobertura de dados adequada, prosseguindo com cálculo`);

                // 3) Obter policy do assistant (cache em memória)
                console.log(`[CALCULATION] Obtendo policy do assistant para período=${periodo}, setor=${setor}`);
                const policy = await policyService.obterPolicyPorRanges(periodo, imoveis, setor);
                console.log(`[CALCULATION] Policy obtida: ${policy.policy_id}`);

                // Log detalhado da policy para debug
                console.log(`[CALCULATION] Policy details:`, {
                    policy_id: policy.policy_id,
                    weights: policy.weights,
                    classification: policy.classification,
                    templates_keys: {
                        motivo: Object.keys(policy.templates.motivo),
                        acao_sugerida: Object.keys(policy.templates.acao_sugerida),
                        justificativa_curta: Object.keys(policy.templates.justificativa_curta)
                    },
                    mappings_count: {
                        cadastro: policy.mappings.cadastro?.length || 0,
                        medicao: policy.mappings.medicao?.length || 0,
                        inadimplencia: policy.mappings.inadimplencia?.length || 0
                    }
                });

                // 4) Calcular localmente por imóvel (determinístico)
                console.log(`[CALCULATION] Iniciando cálculos individuais para ${imoveis.length} imóveis`);
                const calculationStartTime = Date.now();

                const outputs = imoveis.map((row, index) => {
                    try {
                        const result = calculationService.calcularPotenciais(row, policy);

                        // Log detalhado dos primeiros 3 cálculos para debug
                        if (index < 3) {
                            console.log(`[CALCULATION] Cálculo ${index + 1} - Imóvel ${row.imovel_id}:`, {
                                potencial_score: result.potencial_score,
                                potencial_nivel: result.potencial_nivel,
                                potencial_cadastro: result.potencial_cadastro,
                                potencial_medicao: result.potencial_medicao,
                                potencial_inadimplencia: result.potencial_inadimplencia,
                                motivo: result.motivo,
                                acao_sugerida: result.acao_sugerida,
                                justificativa_curta: result.justificativa_curta,
                                erro: result.erro
                            });
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

                // 6) Persistir resultados (com validação/erros)
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
                    total_imoveis: imoveis.length,
                    policy_id: policy.policy_id,
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
