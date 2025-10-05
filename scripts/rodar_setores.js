#!/usr/bin/env node
// Script: scripts/rodar_setores.js
// Purpose: sequentially call the /rodar/:ano/:mes/:setor route for a list of setores
// Usage:
//   BASE_URL=http://localhost:3000 node scripts/rodar_setores.js
// or make it executable:
//   chmod +x scripts/rodar_setores.js
//   BASE_URL=http://localhost:3000 ./scripts/rodar_setores.js

// Lista de setores a processar
const setores = [
  101,
  /* 102,103,104,105,106,107,108,109,110,111,113,115,
  401,402,403,404,406,407,505,506,507,508,509,511,512,513,514,515,516,
  601,602,604,607,609,610,611,612,613,616,617,618,619,620,621,622,623,624,625 */
];

const ano = 2021;
const mes = 10;
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// Lightweight fetch fallback: use global fetch if present (Node 18+), else try node-fetch
let fetchFn = global.fetch;
if (!fetchFn) {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    fetchFn = (...args) => import('node-fetch').then(({default: nf}) => nf(...args));
  } catch (e) {
    console.error('Fetch not available and node-fetch could not be imported. Install node-fetch or use Node 18+.');
    process.exit(1);
  }
}

function resumoResposta(bodyText) {
  if (!bodyText) return '';
  try {
    const obj = JSON.parse(bodyText);
    // Return a compact summary if possible
    if (obj.total_imoveis !== undefined) return `total_imoveis=${obj.total_imoveis}`;
    if (obj.sucessos !== undefined) return `sucessos=${obj.sucessos} erros=${obj.erros}`;
    return JSON.stringify(obj).slice(0, 200) + (JSON.stringify(obj).length > 200 ? '...' : '');
  } catch (_) {
    return bodyText.slice(0, 200) + (bodyText.length > 200 ? '...' : '');
  }
}

async function chamarSetor(setor) {
  const path = `/rodar/${ano}/${String(mes).padStart(2, '0')}/${setor}`;
  const url = BASE_URL.replace(/\/+$/, '') + path;
  console.log(`\n➡️  [${new Date().toISOString()}] Requisitando: ${url}`);

  const start = Date.now();
  try {
    const res = await fetchFn(url, { method: 'GET' });
    const duration = Date.now() - start;
    const text = await res.text();

    if (!res.ok) {
      console.error(`❌ [${new Date().toISOString()}] Erro HTTP ${res.status} ao processar setor ${setor} (${duration}ms)`);
      console.error('Resposta:', resumoResposta(text));
      return { setor, ok: false, status: res.status, body: text };
    }

    console.log(`✅ [${new Date().toISOString()}] Concluído setor ${setor} (${duration}ms)`);
    console.log('Resumo:', resumoResposta(text));
    return { setor, ok: true, status: res.status, body: text };
  } catch (err) {
    const duration = Date.now() - start;
    console.error(`💥 [${new Date().toISOString()}] Falha ao requisitar setor ${setor} (${duration}ms):`, err.message);
    return { setor, ok: false, error: err.message };
  }
}

async function main() {
  console.log('Iniciando sequência de requisições para /rodar/:ano/:mes/:setor');
  console.log(`BASE_URL=${BASE_URL} | ano=${ano} | mes=${mes} | total_setores=${setores.length}`);

  const resultados = [];
  for (const setor of setores) {
    // Faz a requisição e espera a resposta (sequencial)
    // Caso queira adicionar um delay entre requisições, descomente a linha abaixo
    // await new Promise(r => setTimeout(r, 1000));
    // Chama o endpoint e aguarda
    // eslint-disable-next-line no-await-in-loop
    const r = await chamarSetor(setor);
    resultados.push(r);

    // Se houver um erro crítico você pode decidir parar a sequência. Atualmente, apenas registra e continua.
  }

  console.log('\n✅ Sequência finalizada. Resumo:');
  const okCount = resultados.filter(r => r.ok).length;
  const failCount = resultados.length - okCount;
  console.log(`  sucesso: ${okCount} | falhas: ${failCount} | totais: ${resultados.length}`);

  // Opcional: escreve um pequeno relatório em arquivo
  try {
    const fs = await import('fs');
    const out = {
      base_url: BASE_URL,
      ano,
      mes,
      timestamp: new Date().toISOString(),
      resultados
    };
    fs.writeFileSync('rodar_setores_result.json', JSON.stringify(out, null, 2));
    console.log('Relatório salvo em rodar_setores_result.json');
  } catch (e) {
    console.warn('Não foi possível salvar relatório:', e.message);
  }
}

main().catch(err => {
  console.error('Erro inesperado no script:', err);
  process.exit(1);
});
