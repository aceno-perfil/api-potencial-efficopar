export const POLICY_JSON_SCHEMA = {
    name: "potencial_receita_policy",
    strict: true,
    schema: {
      type: "object",
      properties: {
        policy_id: { type: "string" },
        periodo: { type: "string" },
        weights: {
          type: "object",
          properties: {
            cadastro: { type: "number" },
            medicao: { type: "number" },
            inadimplencia: { type: "number" }
          },
          required: ["cadastro", "medicao", "inadimplencia"],
          additionalProperties: false
        },
        mappings: {
          type: "object",
          properties: {
            cadastro: { type: "array", items: { $ref: "#/$defs/piecewise_rule" } },
            medicao: { type: "array", items: { $ref: "#/$defs/piecewise_rule" } },
            inadimplencia: { type: "array", items: { $ref: "#/$defs/piecewise_rule" } }
          },
          required: ["cadastro", "medicao", "inadimplencia"],
          additionalProperties: false
        },
        penalties: {
          type: "object",
          properties: {
            inadimplencia_score_penalty: {
              type: "object",
              properties: {
                trigger_feature: { type: "string" },
                trigger_threshold: { type: "number" },
                curve: { type: "string", enum: ["linear", "log"] },
                max_penalty: { type: "number" }
              },
              required: ["trigger_feature", "trigger_threshold", "curve", "max_penalty"],
              additionalProperties: false
            }
          },
          required: ["inadimplencia_score_penalty"],
          additionalProperties: false
        },
        classification: {
          type: "object",
          properties: {
            score_thresholds: {
              type: "object",
              properties: {
                baixo: { type: "number" },
                medio: { type: "number" },
                alto: { type: "number" }
              },
              required: ["baixo", "medio", "alto"],
              additionalProperties: false
            },
            nenhum_if_all_potentials_below: { type: "number" }
          },
          required: ["score_thresholds", "nenhum_if_all_potentials_below"],
          additionalProperties: false
        },
        templates: {
          type: "object",
          properties: {
            motivo: {
              type: "object",
              properties: {
                MEDICAO_DOMINANTE: { type: "string" },
                CADASTRO_DOMINANTE: { type: "string" },
                INAD_ALTA: { type: "string" },
                DADOS_INSUFICIENTES: { type: "string" },
                BALANCEADO: { type: "string" }
              },
              required: ["MEDICAO_DOMINANTE","CADASTRO_DOMINANTE","INAD_ALTA","DADOS_INSUFICIENTES","BALANCEADO"],
              additionalProperties: false
            },
            acao_sugerida: {
              type: "object",
              properties: {
                MEDICAO_DOMINANTE: { type: "string" },
                CADASTRO_DOMINANTE: { type: "string" },
                INAD_ALTA: { type: "string" },
                DADOS_INSUFICIENTES: { type: "string" },
                BALANCEADO: { type: "string" }
              },
              required: ["MEDICAO_DOMINANTE","CADASTRO_DOMINANTE","INAD_ALTA","DADOS_INSUFICIENTES","BALANCEADO"],
              additionalProperties: false
            },
            justificativa_curta: {
              type: "object",
              properties: {
                MEDICAO_DOMINANTE: { type: "string" },
                CADASTRO_DOMINANTE: { type: "string" },
                INAD_ALTA: { type: "string" },
                DADOS_INSUFICIENTES: { type: "string" },
                BALANCEADO: { type: "string" }
              },
              required: ["MEDICAO_DOMINANTE","CADASTRO_DOMINANTE","INAD_ALTA","DADOS_INSUFICIENTES","BALANCEADO"],
              additionalProperties: false
            }
          },
          required: ["motivo","acao_sugerida","justificativa_curta"],
          additionalProperties: false
        },
        meta: {
          type: "object",
          properties: {
            validity_days: { type: "number" },
            notes: { type: "string" }
          },
          required: ["validity_days"],
          additionalProperties: false
        }
      },
      required: ["policy_id","periodo","weights","mappings","penalties","classification","templates","meta"],
      additionalProperties: false,
      $defs: {
        piecewise_rule: {
          type: "object",
          properties: {
            feature: { type: "string" },
            breaks: { type: "array", items: { type: "number" }, minItems: 1 },
            values: { type: "array", items: { type: "number" } },
            higher_is_risk: { type: "boolean" }
          },
          required: ["feature","breaks","values","higher_is_risk"],
          additionalProperties: false
        }
      }
    }
  } as const;
  