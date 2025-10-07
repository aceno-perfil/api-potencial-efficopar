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
            required: ["MEDICAO_DOMINANTE", "CADASTRO_DOMINANTE", "INAD_ALTA", "DADOS_INSUFICIENTES", "BALANCEADO"],
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
            required: ["MEDICAO_DOMINANTE", "CADASTRO_DOMINANTE", "INAD_ALTA", "DADOS_INSUFICIENTES", "BALANCEADO"],
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
            required: ["MEDICAO_DOMINANTE", "CADASTRO_DOMINANTE", "INAD_ALTA", "DADOS_INSUFICIENTES", "BALANCEADO"],
            additionalProperties: false
          }
        },
        required: ["motivo", "acao_sugerida", "justificativa_curta"],
        additionalProperties: false
      },
      meta: {
        type: "object",
        properties: {
          validity_days: { type: "number" }
        },
        required: ["validity_days"],
        additionalProperties: false
      }
    },
    required: ["policy_id", "periodo", "weights", "mappings", "penalties", "classification", "templates", "meta"],
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
        required: ["feature", "breaks", "values", "higher_is_risk"],
        additionalProperties: false
      }
    }
  }
} as const;

// Schema para o novo formato compact_policy_parametros
export const COMPACT_POLICY_JSON_SCHEMA = {
  name: "compact_policy_parametros",
  strict: true,
  schema: {
    type: "object",
    properties: {
      policy_id: { type: "string" },
      familias: {
        type: "object",
        properties: {
          cadastro: { type: "number", minimum: 0, maximum: 1 },
          medicao: { type: "number", minimum: 0, maximum: 1 },
          inadimplencia: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["cadastro", "medicao", "inadimplencia"],
        additionalProperties: false
      },
      inadimplencia: {
        type: "object",
        properties: {
          w_days: { type: "number", minimum: 0, maximum: 1 },
          w_open_count: { type: "number", minimum: 0, maximum: 1 },
          w_amount_ratio: { type: "number", minimum: 0, maximum: 1 },
          trigger_ratio: { type: "number", minimum: 0, maximum: 1 },
          penalty_max: { type: "number", minimum: 0, maximum: 1 },
          curve: { type: "string", enum: ["linear", "log"] }
        },
        required: ["w_days", "w_open_count", "w_amount_ratio", "trigger_ratio", "penalty_max", "curve"],
        additionalProperties: false
      },
      medicao: {
        type: "object",
        properties: {
          w_idade: { type: "number", minimum: 0, maximum: 1 },
          w_anomalias: { type: "number", minimum: 0, maximum: 1 },
          w_desvio: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["w_idade", "w_anomalias", "w_desvio"],
        additionalProperties: false
      },
      cadastro: {
        type: "object",
        properties: {
          z_warn: { type: "number", minimum: 0, maximum: 1 },
          z_risk: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["z_warn", "z_risk"],
        additionalProperties: false
      },
      potencial: {
        type: "object",
        properties: {
          pot_min: { type: "number", minimum: 0, maximum: 1 },
          pot_max: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["pot_min", "pot_max"],
        additionalProperties: false
      },
      classificacao: {
        type: "object",
        properties: {
          baixo: { type: "number", minimum: 0, maximum: 100 },
          medio: { type: "number", minimum: 0, maximum: 100 },
          alto: { type: "number", minimum: 0, maximum: 100 },
          nenhum_if_all_potentials_below: { type: "number", minimum: 0, maximum: 1 }
        },
        required: ["baixo", "medio", "alto", "nenhum_if_all_potentials_below"],
        additionalProperties: false
      }
    },
    required: ["policy_id", "familias", "inadimplencia", "medicao", "cadastro", "potencial", "classificacao"],
    additionalProperties: false
  }
} as const;
