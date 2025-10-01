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
  
      // Processa em lote (mais rápido)
      let total = 0;
      let sucessos = 0;
      let erros = 0;
      
      try {
        console.log(`\n🚀 [${new Date().toLocaleTimeString()}] ===== PROCESSANDO LOTE =====`);
        const resposta = await avaliarLote(imoveis);

        if (resposta.items && resposta.items.length > 0) {
          console.log(`💾 [${new Date().toLocaleTimeString()}] Salvando ${resposta.items.length} resultado(s) no Supabase...`);
          await salvarPotenciais(resposta.items);
          total += resposta.items.length;
          sucessos = resposta.items.length;
          console.log(`✅ [${new Date().toLocaleTimeString()}] Lote processado com sucesso!`);
        } else {
          console.log(`⚠️ [${new Date().toLocaleTimeString()}] Resposta sem items no lote`);
        }
      } catch (err) {
        erros = imoveis.length;
        console.error(`❌ [${new Date().toLocaleTimeString()}] Erro processando lote:`, err.message);

        // salva todos com erro
        console.log(`💾 [${new Date().toLocaleTimeString()}] Salvando registros de erro no Supabase...`);
        const registrosErro = imoveis.map(imovel => ({
          imovel_id: imovel.imovel_id,
          periodo: periodo,
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
        await salvarPotenciais(registrosErro);
      }
  
      console.log(`\n🎉 [${new Date().toLocaleTimeString()}] ===== PROCESSAMENTO CONCLUÍDO =====`);
      console.log(`📊 Total processados: ${imoveis.length}`);
      console.log(`✅ Sucessos: ${sucessos}`);
      console.log(`❌ Erros: ${erros}`);
      console.log(`💾 Total inseridos: ${total}`);
  
      res.json({ 
        setor, 
        periodo, 
        total_processados: imoveis.length,
        sucessos,
        erros,
        total_inseridos: total 
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
