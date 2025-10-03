// 1. Carregar variáveis de ambiente
require("dotenv").config();

// 2. Imports
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 3. Configuração do servidor
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// 4. Conexão Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// 5. Funções auxiliares
async function buscarImoveis(periodo, setor) {
  const { data, error } = await supabase
    .from("imovel_historico_agregado")
    .select("*")
    .eq("periodo", periodo)
    .eq("setor", setor);

  if (error) throw error;
  return data;
}

async function avaliarLote(imoveis) {
  console.log(`🏠 [${new Date().toLocaleTimeString()}] Iniciando avaliação de lote com ${imoveis.length} imóveis`);

  const payload = JSON.stringify(imoveis);

  // Cria thread
  console.log(`📝 [${new Date().toLocaleTimeString()}] Criando thread...`);
  const thread = await openai.beta.threads.create();
  console.log(`✅ [${new Date().toLocaleTimeString()}] Thread criado: ${thread.id}`);

  // Adiciona mensagem com o array de imóveis
  console.log(`💬 [${new Date().toLocaleTimeString()}] Adicionando ${imoveis.length} imóveis ao thread...`);
  await openai.beta.threads.messages.create(thread.id, {
    role: "user",
    content: payload,
  });

  // Roda o assistant
  console.log(`🤖 [${new Date().toLocaleTimeString()}] Iniciando execução do assistant para o lote...`);
  let run = await openai.beta.threads.runs.create(thread.id, {
    assistant_id: "asst_xtxEvFNTsyZyfnNNlcMiYU67",
  });
  console.log(`🚀 [${new Date().toLocaleTimeString()}] Run criado: ${run.id} - Status: ${run.status}`);

  // Espera concluir
  let tentativas = 0;
  while (run.status !== "completed" && run.status !== "failed") {
    tentativas++;
    await new Promise((r) => setTimeout(r, 1000));
    run = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    console.log(`⏳ [${new Date().toLocaleTimeString()}] Aguardando lote... Status: ${run.status} (tentativa ${tentativas})`);
  }

  if (run.status === "failed") {
    console.log(`❌ [${new Date().toLocaleTimeString()}] Assistant falhou ao processar o lote`);

    // Cria auditoria do erro do Assistant
    const auditoriaAssistant = criarAuditoriaErro(
      'ASSISTANT_FALHOU',
      imoveis,
      new Error("Assistant falhou ao processar o lote"),
      {
        thread_id: thread.id,
        run_id: run.id,
        status: run.status,
        tentativas: tentativas,
        operacao: 'avaliar_lote'
      }
    );

    console.log(`📋 [${new Date().toLocaleTimeString()}] Auditoria de erro do Assistant criada`);
    console.log(auditoriaAssistant);

    throw new Error("O Assistant falhou ao processar o lote");
  }

  console.log(`✅ [${new Date().toLocaleTimeString()}] Assistant completou o lote de ${imoveis.length} imóveis`);

  // Pega a resposta final
  console.log(`📨 [${new Date().toLocaleTimeString()}] Buscando resposta do assistant...`);
  const messages = await openai.beta.threads.messages.list(thread.id);
  const ultima = messages.data.find((m) => m.role === "assistant");
  const texto = ultima?.content[0]?.text?.value || "{}";

  let parsed;
  try {
    parsed = JSON.parse(texto);
    console.log(`✅ [${new Date().toLocaleTimeString()}] Resposta parseada com sucesso para lote de ${imoveis.length} imóveis`);
  } catch (e) {
    console.log(`⚠️ [${new Date().toLocaleTimeString()}] Erro ao parsear JSON do lote: ${e.message}`);

    // Cria auditoria do erro de parsing
    const auditoriaParse = criarAuditoriaErro(
      'JSON_PARSE_FALHOU',
      { texto_resposta: texto, imoveis_originais: imoveis },
      e,
      {
        thread_id: thread.id,
        run_id: run.id,
        tamanho_texto: texto.length,
        operacao: 'parsear_resposta_assistant'
      }
    );

    console.log(`📋 [${new Date().toLocaleTimeString()}] Auditoria de erro de parsing criada`);
    console.log(auditoriaParse);
    
    parsed = { raw: texto, erro_parse: e.message };
  }

  return parsed;
}

// Função para validar UUID
function isValidUUID(uuid) {
  if (!uuid || typeof uuid !== 'string') return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

// Função para validar período
function isValidPeriod(periodo) {
  if (!periodo || typeof periodo !== 'string') return false;
  return periodo.match(/^\d{4}-\d{2}-\d{2}$/) !== null;
}

// Função para criar objeto de auditoria para a coluna erro
function criarAuditoriaErro(tipoErro, dadosOriginais, erro, contexto = {}) {
  const auditoria = {
    timestamp: new Date().toISOString(),
    tipo_erro: tipoErro,
    erro_mensagem: erro.message || erro.toString(),
    dados_originais: dadosOriginais,
    contexto: contexto,
    stack_trace: erro.stack || null
  };

  return JSON.stringify(auditoria);
}

// Função para dividir array em lotes
function dividirEmLotes(array, tamanhoLote) {
  const lotes = [];
  for (let i = 0; i < array.length; i += tamanhoLote) {
    lotes.push(array.slice(i, i + tamanhoLote));
  }
  return lotes;
}

// Função para processar múltiplos lotes
async function processarLotes(imoveis, tamanhoLote = 50) {
  console.log(`📦 [${new Date().toLocaleTimeString()}] Dividindo ${imoveis.length} imóveis em lotes de ${tamanhoLote}...`);

  const lotes = dividirEmLotes(imoveis, tamanhoLote);
  console.log(`📊 [${new Date().toLocaleTimeString()}] Criados ${lotes.length} lote(s)`);

  const resultados = [];
  let totalProcessados = 0;
  let totalSucessos = 0;
  let totalErros = 0;

  for (let i = 0; i < lotes.length; i++) {
    const lote = lotes[i];
    console.log(`\n🚀 [${new Date().toLocaleTimeString()}] ===== PROCESSANDO LOTE ${i + 1}/${lotes.length} =====`);
    console.log(`📦 Lote ${i + 1}: ${lote.length} imóveis`);

    try {
      const resposta = await avaliarLote(lote);

      if (resposta.items && resposta.items.length > 0) {
        console.log(`💾 [${new Date().toLocaleTimeString()}] Salvando ${resposta.items.length} resultado(s) do lote ${i + 1}...`);
        await salvarPotenciais(resposta.items);
        totalProcessados += resposta.items.length;
        totalSucessos += resposta.items.length;
        resultados.push({
          lote: i + 1,
          status: 'sucesso',
          processados: resposta.items.length,
          resposta: resposta
        });
        console.log(`✅ [${new Date().toLocaleTimeString()}] Lote ${i + 1} processado com sucesso!`);
      } else {
        console.log(`⚠️ [${new Date().toLocaleTimeString()}] Lote ${i + 1} sem items na resposta`);
        resultados.push({
          lote: i + 1,
          status: 'sem_items',
          processados: 0,
          resposta: resposta
        });
      }
    } catch (err) {
      console.error(`❌ [${new Date().toLocaleTimeString()}] Erro no lote ${i + 1}:`, err.message);
      totalErros += lote.length;

      // Cria auditoria do erro do lote
      const auditoriaErroLote = criarAuditoriaErro(
        'LOTE_PROCESSAMENTO_FALHOU',
        lote,
        err,
        {
          numero_lote: i + 1,
          total_lotes: lotes.length,
          tamanho_lote: lote.length,
          operacao: 'processar_lote'
        }
      );

      // Salva registros de erro para este lote
      const registrosErro = lote.map(imovel => ({
        imovel_id: imovel.imovel_id,
        periodo: imovel.periodo || new Date().toISOString().slice(0, 7) + '-01',
        potencial_score: null,
        potencial_nivel: null,
        potencial_cadastro: null,
        potencial_medicao: null,
        potencial_inadimplencia: null,
        motivo: "",
        acao_sugerida: "",
        justificativa_curta: "",
        erro: auditoriaErroLote
      }));

      try {
        await salvarPotenciais(registrosErro);
        console.log(`💾 [${new Date().toLocaleTimeString()}] Registros de erro salvos para lote ${i + 1}`);
      } catch (saveErr) {
        console.error(`❌ [${new Date().toLocaleTimeString()}] Erro ao salvar registros de erro do lote ${i + 1}:`, saveErr.message);

        // Cria auditoria do erro ao salvar registros de erro
        const auditoriaErroSalvar = criarAuditoriaErro(
          'SALVAR_REGISTROS_ERRO_LOTE_FALHOU',
          registrosErro,
          saveErr,
          {
            numero_lote: i + 1,
            total_registros_erro: registrosErro.length,
            operacao: 'salvar_registros_erro_lote'
          }
        );

        console.log(`📋 [${new Date().toLocaleTimeString()}] Auditoria de erro ao salvar lote criada`);
        console.log(auditoriaErroSalvar);
      }

      resultados.push({
        lote: i + 1,
        status: 'erro',
        processados: 0,
        erro: err.message
      });
    }

    // Pequena pausa entre lotes para não sobrecarregar
    if (i < lotes.length - 1) {
      console.log(`⏸️ [${new Date().toLocaleTimeString()}] Pausa de 2s antes do próximo lote...`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  console.log(`\n🎉 [${new Date().toLocaleTimeString()}] ===== TODOS OS LOTES CONCLUÍDOS =====`);
  console.log(`📊 Total de lotes: ${lotes.length}`);
  console.log(`✅ Sucessos: ${totalSucessos}`);
  console.log(`❌ Erros: ${totalErros}`);
  console.log(`💾 Total processados: ${totalProcessados}`);

  return {
    total_lotes: lotes.length,
    total_imoveis: imoveis.length,
    sucessos: totalSucessos,
    erros: totalErros,
    total_processados: totalProcessados,
    resultados_por_lote: resultados
  };
}

async function salvarPotenciais(items) {
  if (!items || !items.length) return;

  console.log(`🔍 [${new Date().toLocaleTimeString()}] Validando ${items.length} registros antes do upsert...`);

  // Validação e limpeza dos dados
  const registrosValidos = [];
  const registrosInvalidos = [];

  for (const item of items) {
    const errosValidacao = [];

    // Valida UUID
    if (!item.imovel_id || !isValidUUID(item.imovel_id)) {
      errosValidacao.push(`UUID inválido: ${item.imovel_id}`);
    }

    // Valida período
    if (!item.periodo || !isValidPeriod(item.periodo)) {
      errosValidacao.push(`Período inválido: ${item.periodo}`);
    }

    if (errosValidacao.length > 0) {
      console.warn(`⚠️ [${new Date().toLocaleTimeString()}] Registro inválido: ${errosValidacao.join(', ')}`);

      // Cria auditoria para a coluna erro
      const auditoriaErro = criarAuditoriaErro(
        'VALIDACAO_FALHOU',
        item,
        new Error(errosValidacao.join('; ')),
        {
          erros: errosValidacao,
          imovel_id: item.imovel_id,
          periodo: item.periodo
        }
      );

      registrosInvalidos.push({
        ...item,
        erro: auditoriaErro
      });
      continue;
    }

    registrosValidos.push({
      imovel_id: item.imovel_id,
      periodo: item.periodo,
      potencial_score: item.potencial_score,
      potencial_nivel: item.potencial_nivel,
      potencial_cadastro: item.potencial_cadastro,
      potencial_medicao: item.potencial_medicao,
      potencial_inadimplencia: item.potencial_inadimplencia,
      motivo: item.motivo || "",
      acao_sugerida: item.acao_sugerida || "",
      justificativa_curta: item.justificativa_curta || "",
      erro: item.erro || null,
    });
  }

  console.log(`✅ [${new Date().toLocaleTimeString()}] Registros válidos: ${registrosValidos.length}, inválidos: ${registrosInvalidos.length}`);

  // Remove duplicatas baseado em imovel_id + periodo
  const registrosUnicos = [];
  const chavesVistas = new Set();

  for (const registro of registrosValidos) {
    const chave = `${registro.imovel_id}-${registro.periodo}`;
    if (!chavesVistas.has(chave)) {
      chavesVistas.add(chave);
      registrosUnicos.push(registro);
    } else {
      console.warn(`⚠️ [${new Date().toLocaleTimeString()}] Registro duplicado ignorado: ${chave}`);

      // Cria auditoria da duplicata para salvar na coluna erro
      const auditoriaDuplicata = criarAuditoriaErro(
        'REGISTRO_DUPLICADO',
        registro,
        new Error(`Registro duplicado: ${chave}`),
        { chave_duplicata: chave }
      );

      // Salva o registro duplicado com auditoria na coluna erro
      try {
        await supabase
          .from("potencial_receita_imovel")
          .upsert([{
            ...registro,
            erro: auditoriaDuplicata
          }], {
            onConflict: 'imovel_id,periodo',
            ignoreDuplicates: false
          });
        console.log(`📋 [${new Date().toLocaleTimeString()}] Registro duplicado salvo com auditoria`);
      } catch (dupErr) {
        console.error(`❌ [${new Date().toLocaleTimeString()}] Erro ao salvar duplicata:`, dupErr.message);
        console.log(auditoriaDuplicata);
      }
    }
  }

  console.log(`🔄 [${new Date().toLocaleTimeString()}] Após remoção de duplicatas: ${registrosUnicos.length} registros`);

  if (registrosUnicos.length === 0) {
    console.log(`⚠️ [${new Date().toLocaleTimeString()}] Nenhum registro válido para salvar`);
    return;
  }

  // Salva registros válidos
  try {
    console.log(`💾 [${new Date().toLocaleTimeString()}] Fazendo upsert de ${registrosUnicos.length} registros...`);

    const { error } = await supabase
      .from("potencial_receita_imovel")
      .upsert(registrosUnicos, {
        onConflict: 'imovel_id,periodo',
        ignoreDuplicates: false
      });

    if (error) {
      console.error("Erro ao fazer upsert no Supabase:", error);

      // Cria auditoria do erro de upsert em lote
      const auditoriaErroLote = criarAuditoriaErro(
        'UPSERT_LOTE_FALHOU',
        registrosUnicos,
        error,
        {
          total_registros: registrosUnicos.length,
          operacao: 'upsert_lote'
        }
      );

      console.log(`📋 [${new Date().toLocaleTimeString()}] Auditoria de erro de lote criada`);
      console.log(auditoriaErroLote);
      throw error;
    }

    console.log(`✅ [${new Date().toLocaleTimeString()}] Upsert realizado com sucesso!`);
  } catch (err) {
    console.error(`❌ [${new Date().toLocaleTimeString()}] Erro no upsert:`, err.message);

    // Se falhar, tenta salvar um por vez para identificar o problema específico
    console.log(`🔄 [${new Date().toLocaleTimeString()}] Tentando salvar registros individualmente...`);

    let sucessosIndividuais = 0;
    let errosIndividuais = 0;

    for (const registro of registrosUnicos) {
      try {
        const { error } = await supabase
          .from("potencial_receita_imovel")
          .upsert([registro], {
            onConflict: 'imovel_id,periodo',
            ignoreDuplicates: false
          });

        if (error) {
          console.error(`❌ Erro ao salvar registro ${registro.imovel_id}:`, error.message);

          // Cria auditoria do erro individual e salva na coluna erro
          const auditoriaErroIndividual = criarAuditoriaErro(
            'UPSERT_INDIVIDUAL_FALHOU',
            registro,
            error,
            {
              imovel_id: registro.imovel_id,
              periodo: registro.periodo,
              operacao: 'upsert_individual'
            }
          );

          // Tenta salvar o registro com erro na coluna erro
          try {
            await supabase
              .from("potencial_receita_imovel")
              .upsert([{
                ...registro,
                erro: auditoriaErroIndividual
              }], {
                onConflict: 'imovel_id,periodo',
                ignoreDuplicates: false
              });
            console.log(`📋 [${new Date().toLocaleTimeString()}] Registro com erro individual salvo`);
          } catch (saveErr) {
            console.error(`❌ [${new Date().toLocaleTimeString()}] Erro ao salvar registro com erro:`, saveErr.message);
            console.log(auditoriaErroIndividual);
          }

          errosIndividuais++;
        } else {
          sucessosIndividuais++;
        }
      } catch (individualErr) {
        console.error(`❌ Erro individual para ${registro.imovel_id}:`, individualErr.message);

        // Cria auditoria do erro individual e salva na coluna erro
        const auditoriaErroException = criarAuditoriaErro(
          'UPSERT_INDIVIDUAL_EXCEPTION',
          registro,
          individualErr,
          {
            imovel_id: registro.imovel_id,
            periodo: registro.periodo,
            operacao: 'upsert_individual'
          }
        );

        // Tenta salvar o registro com erro na coluna erro
        try {
          await supabase
            .from("potencial_receita_imovel")
            .upsert([{
              ...registro,
              erro: auditoriaErroException
            }], {
              onConflict: 'imovel_id,periodo',
              ignoreDuplicates: false
            });
          console.log(`📋 [${new Date().toLocaleTimeString()}] Registro com exceção individual salvo`);
        } catch (saveErr) {
          console.error(`❌ [${new Date().toLocaleTimeString()}] Erro ao salvar registro com exceção:`, saveErr.message);
          console.log(auditoriaErroException);
        }

        errosIndividuais++;
      }
    }

    console.log(`📊 [${new Date().toLocaleTimeString()}] Resultado individual: ${sucessosIndividuais} sucessos, ${errosIndividuais} erros`);
  }

  // Salva registros inválidos com erro na tabela principal
  if (registrosInvalidos.length > 0) {
    console.log(`💾 [${new Date().toLocaleTimeString()}] Salvando ${registrosInvalidos.length} registros com erro...`);

    try {
      const registrosComErro = registrosInvalidos.map(item => ({
        imovel_id: item.imovel_id || null,
        periodo: item.periodo || new Date().toISOString().slice(0, 7) + '-01',
        potencial_score: null,
        potencial_nivel: null,
        potencial_cadastro: null,
        potencial_medicao: null,
        potencial_inadimplencia: null,
        motivo: "",
        acao_sugerida: "",
        justificativa_curta: "",
        erro: item.erro || criarAuditoriaErro('DADOS_INVALIDOS', item, new Error("Dados inválidos"), {})
      }));

      const { error } = await supabase
        .from("potencial_receita_imovel")
        .upsert(registrosComErro, {
          onConflict: 'imovel_id,periodo',
          ignoreDuplicates: false
        });

      if (error) {
        console.error(`❌ [${new Date().toLocaleTimeString()}] Erro ao salvar registros com erro:`, error.message);

        // Cria auditoria do erro ao salvar registros inválidos
        const auditoriaErroInvalidos = criarAuditoriaErro(
          'SALVAR_REGISTROS_INVALIDOS_FALHOU',
          registrosComErro,
          error,
          {
            total_registros_invalidos: registrosInvalidos.length,
            operacao: 'salvar_registros_invalidos'
          }
        );

        console.log(`📋 [${new Date().toLocaleTimeString()}] Auditoria de erro ao salvar inválidos criada`);
        console.log(auditoriaErroInvalidos);
      } else {
        console.log(`✅ [${new Date().toLocaleTimeString()}] Registros com erro salvos com sucesso!`);
      }
    } catch (err) {
      console.error(`❌ [${new Date().toLocaleTimeString()}] Erro ao salvar registros com erro:`, err.message);

      // Cria auditoria do erro ao salvar registros inválidos
      const auditoriaErroException = criarAuditoriaErro(
        'SALVAR_REGISTROS_INVALIDOS_EXCEPTION',
        registrosInvalidos,
        err,
        {
          total_registros_invalidos: registrosInvalidos.length,
          operacao: 'salvar_registros_invalidos'
        }
      );

      console.log(`📋 [${new Date().toLocaleTimeString()}] Auditoria de exceção ao salvar inválidos criada`);
      console.log(auditoriaErroException);
    }
  }
}

// 6. Rotas
// healthcheck
app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

// webhook
app.post("/webhook", (req, res) => {
  try {
    const { ano, mes, setores } = req.body;

    if (!ano || !mes || !setores) {
      return res
        .status(400)
        .json({ erro: "Faltam parâmetros: ano, mes ou setores" });
    }

    const periodo = `${ano}-${String(mes).padStart(2, "0")}-01`;

    const filtros = setores.map((setor) => ({
      periodo,
      setor,
    }));

    res.json({ filtros });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: err.message });
  }
});

// rota para consultar erros da tabela principal
app.get("/erros", async (req, res) => {
  try {
    const { limit = 50, offset = 0, tipo_erro } = req.query;

    let query = supabase
      .from("potencial_receita_imovel")
      .select("*")
      .not("erro", "is", null)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    const { data, error } = await query;

    if (error) {
      console.error("Erro ao buscar registros com erro:", error);
      return res.status(500).json({ erro: error.message });
    }

    // Filtra por tipo de erro se especificado
    let dadosFiltrados = data;
    if (tipo_erro) {
      dadosFiltrados = data.filter(registro => {
        try {
          const erroObj = JSON.parse(registro.erro);
          return erroObj.tipo_erro === tipo_erro;
        } catch {
          return false;
        }
      });
    }

    res.json({
      total: dadosFiltrados.length,
      limit: parseInt(limit),
      offset: parseInt(offset),
      dados: dadosFiltrados
    });

  } catch (err) {
    console.error("Erro na consulta de erros:", err);
    res.status(500).json({ erro: err.message });
  }
});

// rota de salvar potenciais
app.get("/rodar/:ano/:mes/:setor", async (req, res) => {
  try {
    const { ano, mes, setor } = req.params;
    const periodo = `${ano}-${String(mes).padStart(2, "0")}-01`;

    console.log(`🚀 [${new Date().toLocaleTimeString()}] ===== INICIANDO PROCESSAMENTO =====`);
    console.log(`📅 Período: ${periodo} | 🏘️ Setor: ${setor}`);

    // Busca imóveis
    console.log(`🔍 [${new Date().toLocaleTimeString()}] Buscando imóveis no Supabase...`);
    const imoveis = await buscarImoveis(periodo, setor);
    if (!imoveis.length) {
      console.log(`❌ [${new Date().toLocaleTimeString()}] Nenhum imóvel encontrado`);
      return res.status(404).json({ erro: "Nenhum imóvel encontrado" });
    }

    console.log(`✅ [${new Date().toLocaleTimeString()}] Encontrados ${imoveis.length} imóveis para processar`);

    // Processa em lotes de 50 automaticamente
    const resultado = await processarLotes(imoveis, 5);

    res.json({
      setor,
      periodo,
      total_imoveis: resultado.total_imoveis,
      total_lotes: resultado.total_lotes,
      sucessos: resultado.sucessos,
      erros: resultado.erros,
      total_processados: resultado.total_processados,
      resultados_por_lote: resultado.resultados_por_lote
    });

  } catch (err) {
    console.error(`💥 [${new Date().toLocaleTimeString()}] Erro geral:`, err);
    res.status(500).json({ erro: err.message });
  }
});

// 7. Start server
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
