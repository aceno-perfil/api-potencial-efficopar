/**
 * Service responsável por chamar a OpenAI para gerar pesos baseados nos ranges
 */

import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Chama a OpenAI para gerar pesos estruturados para cada setor
 * @param rangesArray Array de objetos com ranges por setor
 * @returns Array de objetos com setor_id e pesos calculados
 * @throws {Error} Se a chamada falhar ou OPENAI_API_KEY não estiver configurada
 */
export async function callAgent(rangesArray: any[]): Promise<any[]> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY environment variable is required");
  }

  // JSON Schema do output (objeto contendo array de setores com pesos)
  // A OpenAI exige que o schema raiz seja do tipo "object" e que todos os objetos tenham additionalProperties: false
  const schema = {
    "type": "object",
    "required": ["setores"],
    "properties": {
      "setores": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["setor_id","inadimplencia","medicao","cadastro","potencial"],
          "properties": {
            "setor_id": { "type": "string" },
            "inadimplencia": {
              "type": "object",
              "required": ["w_atraso","w_indice","w_valor_aberto"],
              "properties": {
                "w_atraso": { "type": "number", "minimum": 0, "maximum": 1 },
                "w_indice": { "type": "number", "minimum": 0, "maximum": 1 },
                "w_valor_aberto": { "type": "number", "minimum": 0, "maximum": 1 }
              },
              "additionalProperties": false
            },
            "medicao": {
              "type": "object",
              "required": ["w_idade","w_anomalias","w_desvio"],
              "properties": {
                "w_idade": { "type": "number", "minimum": 0, "maximum": 1 },
                "w_anomalias": { "type": "number", "minimum": 0, "maximum": 1 },
                "w_desvio": { "type": "number", "minimum": 0, "maximum": 1 }
              },
              "additionalProperties": false
            },
            "cadastro": {
              "type": "object",
              "required": ["z_warn","z_risk"],
              "properties": {
                "z_warn": { "type": "number" },
                "z_risk": { "type": "number" }
              },
              "additionalProperties": false
            },
            "potencial": {
              "type": "object",
              "required": ["pot_min","pot_max"],
              "properties": {
                "pot_min": { "type": "number", "minimum": 0, "maximum": 100 },
                "pot_max": { "type": "number", "minimum": 0, "maximum": 100 }
              },
              "additionalProperties": false
            }
          },
          "additionalProperties": false
        }
      }
    },
    "additionalProperties": false
  };

  const system = `Papel e objetivo
Você recebe, por setor (ou grupo), intervalos estatísticos {min_value, max_value, quantidade} de métricas de cadastro, inadimplência e medição.
Sua tarefa é calibrar pesos e limiares para compor o score do projeto de perdas comerciais, maximizando a utilidade operacional (priorizar onde a troca de hidrômetro/ações geram maior retorno).
Devolva APENAS JSON válido conforme o JSON Schema informado, sem comentários nem texto extra.

Entradas (por setor_id)

cadastro.consumo_por_economia: quanto maior, menor suspeita de submedição; quanto menor, pode indicar subdeclaração de economias ou erro cadastral.

inadimplencia: tempo_medio_atraso, valor_em_aberto, indice_inadimplencia — maiores valores indicam maior risco de inadimplência.

medicao:

idade_hidrometro_dias: maior idade ⇒ maior probabilidade de erro/metrologia fora;

taxa_anomalias: maior ⇒ mais eventos anômalos;

desvio_consumo (CV): maior ⇒ consumo instável, sinal de intermitência ou erro de medição.

Regras obrigatórias de saída

inadimplencia.w_atraso + w_indice + w_valor_aberto = 1 (tolerância 1e-3).

medicao.w_idade + w_anomalias + w_desvio = 1 (tolerância 1e-3).

cadastro.z_warn < cadastro.z_risk.

potencial.pot_min ≤ potencial.pot_max.

Mantenha ordem dos itens e mesmos setor_id recebidos.

Heurística de calibração (default, ajustável)
A. Robustez por amostra

Defina um fator de confiança por métrica:
conf = clamp( log10(max(quantidade,1)+1) / 3 , 0.2, 1.0 ).
(Ex.: 10 itens ⇒ ~0.7; 100 ⇒ ~0.9; <5 ⇒ ~0.4)

Se max_value ≈ min_value (faixa muito estreita: (max-min)/max < 1%), reduza conf para 0.3.

B. Intensidade do risco (por métrica)

Medição: calcule “intensidades” normalizadas:
i_idade = sigmoid(max_value / 3650) (10 anos ≈ 1.0 de referência)
i_anom = max_value (já em 0–1)
i_cv = min(max_value, 2.0) / 2.0 (cap em 2)
Peso bruto = intensidade × conf.
Normalize os 3 pesos brutos para somarem 1.

Inadimplência (quanto maior pior):
i_atraso = min(max_value, 90) / 90
i_ind = min(max_value, 1.0)
i_aberto = min(max_value, P95_referência) (se referência não informada, use max_value apenas para ranking relativo)
Peso bruto = intensidade × conf; normalize para somar 1.

Cadastro:
z_warn e z_risk baseados em quão baixo pode estar consumo_por_economia:

Se min_value muito baixo vs. contexto (não fornecido), use defaults: z_warn = 0.6, z_risk = 0.8.

Estreite/afrouxe os limiares conforme conf:
z_warn = clamp(0.6 + (0.2 - 0.2*conf), 0.3, 0.8)
z_risk = clamp(0.8 + (0.2 - 0.2*conf), 0.5, 1.2)
Garanta z_warn < z_risk.

C. Potencial esperado

Escala 0–100.

Use a média dos maiores dois pesos (entre todos os 6 pesos de inadimplência+medição) como “força”:
force = 100 * mean(top2(pesos)).

Defina:
pot_min = round( max(5, 0.5 * force) )
pot_max = round( min(100, 1.2 * force) )
Garanta pot_min ≤ pot_max.

Critérios de desempate & limites

Em empate de intensidade, priorize medição.desvio_consumo > medição.idade > medição.taxa_anomalias.

Para inadimplência, priorize índice_inadimplencia > valor_em_aberto > tempo_medio_atraso.

Nunca retorne NaN/Infinity. Use 0 em caso extremo.

Valide internamente (antes de devolver):

Somas de pesos = 1 (com ajuste proporcional se necessário).

Intervalos respeitados e campos presentes.

Formato de resposta
JSON estrito no schema fornecido. Não inclua chaves extras.`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-2024-08-06", // modelo com suporte a structured outputs
    messages: [
      { role: "system", content: system },
      { role: "user", content: JSON.stringify(rangesArray) }
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "WeightsPerSetor", schema, strict: true }
    }
  });

  // Extrai o conteúdo da resposta estruturada
  const content = completion.choices[0]?.message?.content;
  if (!content) {
    throw new Error("No content returned from OpenAI");
  }

  const parsed = JSON.parse(content);
  return parsed.setores;
}

