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
    parsed = { raw: texto, erro_parse: e.message };
  }

  return parsed;
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
        erro: err.message
      }));

      try {
        await salvarPotenciais(registrosErro);
        console.log(`💾 [${new Date().toLocaleTimeString()}] Registros de erro salvos para lote ${i + 1}`);
      } catch (saveErr) {
        console.error(`❌ [${new Date().toLocaleTimeString()}] Erro ao salvar registros de erro do lote ${i + 1}:`, saveErr.message);
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

    const registros = items.map(item => ({
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
      erro: item.erro || null,
    }));

    console.log(`💾 [${new Date().toLocaleTimeString()}] Fazendo upsert de ${registros.length} registros...`);

    const { error } = await supabase
      .from("potencial_receita_imovel")
      .upsert(registros, { 
        onConflict: 'imovel_id,periodo',
        ignoreDuplicates: false 
      });

    if (error) {
      console.error("Erro ao fazer upsert no Supabase:", error);
      throw error;
    }

    console.log(`✅ [${new Date().toLocaleTimeString()}] Upsert realizado com sucesso!`);
  }

// 6. Rotas
// healthcheck
app.get("/healthz", (req, res) => {
  res.json({ ok: true });
});

// webhook (já testado)
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

// rota de teste supabase
app.get("/testar-supabase/:ano/:mes/:setor", async (req, res) => {
  try {
    const { ano, mes, setor } = req.params;
    const periodo = `${ano}-${String(mes).padStart(2, "0")}-01`;

    const imoveis = await buscarImoveis(periodo, setor);

    res.json({
      periodo,
      setor,
      qtd: imoveis.length,
      exemplo: imoveis[0] || null,
    });
  } catch (err) {
    res.status(500).json({ erro: err.message });
  }
});

// rota de teste gpt
app.get("/testar-gpt/:ano/:mes/:setor", async (req, res) => {
  try {
    const { ano, mes, setor } = req.params;
    const periodo = `${ano}-${String(mes).padStart(2, "0")}-01`;

    const imoveis = await buscarImoveis(periodo, setor);
    if (!imoveis.length) {
      return res.status(404).json({ erro: "Nenhum imóvel encontrado" });
    }

    const imovel = imoveis[0];
    const resposta = await avaliarLote([imovel]); // Passa como array de 1 elemento

    res.json({ enviado: imovel, resposta });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: err.message });
  }
});

// rota de teste gpt com quantidade específica
app.get("/testar-gpt/:ano/:mes/:setor/:quantidade", async (req, res) => {
  try {
    const { ano, mes, setor, quantidade } = req.params;
    const periodo = `${ano}-${String(mes).padStart(2, "0")}-01`;
    const qtd = parseInt(quantidade);

    // Validação da quantidade
    if (isNaN(qtd) || qtd < 1 || qtd > 100) {
      return res.status(400).json({ 
        erro: "Quantidade deve ser um número entre 1 e 100" 
      });
    }

    console.log(`🔍 [${new Date().toLocaleTimeString()}] Buscando ${qtd} imóveis para teste...`);
    const imoveis = await buscarImoveis(periodo, setor);

    if (!imoveis.length) {
      return res.status(404).json({ erro: "Nenhum imóvel encontrado" });
    }

    // Pega apenas a quantidade solicitada
    const imoveisParaTeste = imoveis.slice(0, qtd);

    console.log(`🚀 [${new Date().toLocaleTimeString()}] Iniciando teste com ${imoveisParaTeste.length} imóveis...`);
    const resposta = await avaliarLote(imoveisParaTeste);

    res.json({ 
      periodo,
      setor,
      quantidade_solicitada: qtd,
      quantidade_encontrada: imoveis.length,
      quantidade_processada: imoveisParaTeste.length,
      resposta 
    });
  } catch (err) {
    console.error(`❌ [${new Date().toLocaleTimeString()}] Erro no teste:`, err);
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
      const resultado = await processarLotes(imoveis, 50);

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
