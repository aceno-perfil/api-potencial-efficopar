// routes/params.js
import express from "express";
import { supabase } from '../database/supabase';
import { isUUIDv4 } from "../helpers";

export const paramsRouter = express.Router();

// GET /params
// Query params:
// - id= (obrigatório) UUID (grupo) ou código do setor (texto)
// - escopo= group | setor | auto (default: auto → detecta UUID como grupo)
// - prefix= (opcional) ex.: "weights::medicao", "cadastro::", "potencial::"
// - month= (opcional) ex.: "2025-09" se você versionar nomes com ::YYYY-MM
// - activeOnly= true|false (default: true)
// - format= grouped|flat (default: grouped)
paramsRouter.get("/params", async (req, res) => {
  try {
    const id = String(req.query.id ?? "").trim();
    if (!id) return res.status(400).json({ error: "id is required (grupo UUID or setor code)" });

    const escopoIn = String(req.query.escopo ?? "auto");
    const escopo = escopoIn === "group" || escopoIn === "setor"
      ? escopoIn
      : (isUUIDv4(id) ? "group" : "setor");

    const activeOnly = String(req.query.activeOnly ?? "true") === "true";
    const prefix = req.query.prefix ? String(req.query.prefix) : "";
    const month = req.query.month ? String(req.query.month) : "";
    const format = (req.query.format === "flat" ? "flat" : "grouped");

    const patternBase = prefix ? `${prefix}%` : `%`;
    const monthSuffix = month ? `::${month}` : "";

    let rows: any[] = [];

    if (escopo === "group") {
      const { data, error } = await supabase
        .from("parametros_risco_grupo")
        .select("id, nome, valor_num, valor_texto, ativo, updated_at")
        .eq("grupo_id", id)
        .like("nome", `${patternBase}${monthSuffix}`)
        .order("nome", { ascending: true });
      if (error) throw error;
      rows = (data ?? []);
      if (activeOnly) rows = rows.filter(r => r.ativo !== false);
    } else {
      const pattern = `${patternBase}::setor::${id}::%${monthSuffix}`;
      const { data, error } = await supabase
        .from("parametros_risco")
        .select("id, nome, valor_num, valor_texto, ativo, updated_at")
        .like("nome", pattern)
        .order("nome", { ascending: true });
      if (error) throw error;
      rows = (data ?? []);
      if (activeOnly) rows = rows.filter(r => r.ativo !== false);
    }

    if (format === "flat") {
      return res.json({ escopo, id, count: rows.length, params: rows });
    }

    // Agrupa por blocos lógicos
    const out = { inadimplencia: {}, medicao: {}, cadastro: {}, potencial: {} };

    for (const r of rows) {
      const nome = String(r.nome);
      const val = r.valor_num ?? (r.valor_texto ? Number(r.valor_texto) : null);

      // normaliza nome removendo month e o marcador de setor
      let clean = nome;
      if (month) clean = clean.replace(`::${month}`, "");
      if (escopo === "setor") clean = clean.replace(`::setor::${id}::`, "::");

      if (clean.startsWith("weights::inadimplencia::")) {
        const key = clean.split("weights::inadimplencia::")[1];
        out.inadimplencia[key] = val;
      } else if (clean.startsWith("weights::medicao::")) {
        const key = clean.split("weights::medicao::")[1];
        out.medicao[key] = val;
      } else if (clean.startsWith("cadastro::")) {
        const key = clean.split("cadastro::")[1];
        out.cadastro[key] = val;
      } else if (clean.startsWith("potencial::")) {
        const key = clean.split("potencial::")[1];
        out.potencial[key] = val;
      }
    }

    return res.json({ escopo, id, count: rows.length, params: out, raw: rows });
  } catch (e) {
    console.error("[GET /params] err", e);
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
});
