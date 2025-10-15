// routes/params.js
import express from "express";
import { supabase } from '../database/supabase';
import { isUUIDv4 } from "../helpers";

export const paramsRouter = express.Router();

const SETOR_KEY_JOIN = "__";

function splitSetorKey(name: string) {
  // "101__w_indice" -> { setor: "101", key: "w_indice" }
  const ix = name.indexOf(SETOR_KEY_JOIN);
  if (ix === -1) return { setor: null, key: name };
  return { setor: name.slice(0, ix), key: name.slice(ix + SETOR_KEY_JOIN.length) };
}

// GET /params
// Query params:
// - id= (obrigatório) UUID (grupo) ou código do setor (texto)
// - escopo= group | setor | auto (default: auto → detecta UUID como grupo)
// - month= (opcional) ex.: "2025-09" se você versionar nomes com ::YYYY-MM
// - activeOnly= true|false (default: true)
// - format= grouped|flat (default: grouped)
paramsRouter.get("/params", async (req, res) => {
  try {
    const id = String(req.query.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "id is required (grupo UUID or setor code)" });

    const escopo = isUUIDv4(id) ? "group" : "setor";
    const activeOnly = String(req.query.activeOnly ?? "true") === "true";
    const format = (req.query.format === "flat" ? "flat" : "grouped");

    let rows: any[] = [];

    if (escopo === "group") {
      // Grupo: nomes são só a chave final ("w_indice", "z_warn", ...)
      const { data, error } = await supabase
        .from("parametros_risco_grupo")
        .select("id, nome, valor_num, valor_texto, ativo, updated_at")
        .eq("grupo_id", id)
        .order("nome", { ascending: true });
      if (error) throw error;
      rows = data ?? [];
    } else {
      // Setor: nomes são "<SETOR>__<key>"
      const { data, error } = await supabase
        .from("parametros_risco")
        .select("id, nome, valor_num, valor_texto, ativo, updated_at")
        .like("nome", `${id}${SETOR_KEY_JOIN}%`)
        .order("nome", { ascending: true });
      if (error) throw error;
      rows = data ?? [];
    }

    if (activeOnly) rows = rows.filter(r => r.ativo !== false);
    if (format === "flat") return res.json({ escopo, id, count: rows.length, params: rows });

    // monta objeto agrupado por blocos (sem families; agrupamos por nomes conhecidos)
    const grouped: any = { inadimplencia: {}, medicao: {}, cadastro: {}, potencial: {} };

    for (const r of rows) {
      const rawName = String(r.nome);
      const val = r.valor_num ?? (r.valor_texto ? Number(r.valor_texto) : null);

      // chave final
      const key = escopo === "group" ? rawName : splitSetorKey(rawName).key;

      // decide bloco pelo conjunto de chaves conhecidas (sem namespaces)
      if (key === "w_atraso" || key === "w_indice" || key === "w_valor_aberto") {
        grouped.inadimplencia[key] = val;
      } else if (key === "w_idade" || key === "w_anomalias" || key === "w_desvio") {
        grouped.medicao[key] = val;
      } else if (key === "z_warn" || key === "z_risk") {
        grouped.cadastro[key] = val;
      } else if (key === "pot_min" || key === "pot_max") {
        grouped.potencial[key] = val;
      } else {
        // chave desconhecida: você pode ignorar ou colocar num bloco "outros"
        // ex.: grouped.outros = grouped.outros || {}; grouped.outros[key] = val;
      }
    }

    return res.json({ escopo, id, count: rows.length, params: grouped, raw: rows });
  } catch (e) {
    console.error("[GET /params] err", e);
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
});
