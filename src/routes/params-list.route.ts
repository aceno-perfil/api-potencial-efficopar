import express from "express";
import { supabase } from "../database/supabase";
import { isUUIDv4 } from "../helpers";

export const paramsListRouter = express.Router();

function toGrouped(rows, { month, isSetor, setorId }) {
  const out = { inadimplencia: {}, medicao: {}, cadastro: {}, potencial: {} };
  for (const r of rows) {
    const nome = String(r.nome);
    const val = r.valor_num ?? (r.valor_texto ? Number(r.valor_texto) : null);

    let clean = nome;
    if (month) clean = clean.replace(`::${month}`, "");
    if (isSetor) clean = clean.replace(`::setor::${setorId}::`, "::");

    if (clean.startsWith("weights::inadimplencia::")) {
      out.inadimplencia[clean.split("weights::inadimplencia::")[1]] = val;
    } else if (clean.startsWith("weights::medicao::")) {
      out.medicao[clean.split("weights::medicao::")[1]] = val;
    } else if (clean.startsWith("cadastro::")) {
      out.cadastro[clean.split("cadastro::")[1]] = val;
    } else if (clean.startsWith("potencial::")) {
      out.potencial[clean.split("potencial::")[1]] = val;
    }
  }
  return out;
}

/**
 * GET /params/list
 *
 * Query:
 * - ids= (opcional) lista CSV de IDs mistos (UUID = grupo, texto = setor)
 * - prefix= (opcional) ex.: weights::medicao | cadastro:: | potencial::
 * - month=YYYY-MM (opcional) se você versionar no nome
 * - activeOnly=true|false (default true)
 * - format=grouped|flat (default grouped)
 * - g_limit / g_offset (default 50 / 0) -> paginação de grupos QUANDO ids NÃO for passado
 * - s_limit / s_offset (default 50 / 0) -> paginação de setores QUANDO ids NÃO for passado
 *
 * Com ids -> retorna `items` (mistos).
 * Sem ids -> retorna `groups` e `setores` em blocos separados com suas paginações.
 */
paramsListRouter.get("/params-list", async (req, res) => {
  try {
    const idsRaw = String(req.query.ids ?? "").trim();
    const ids = idsRaw ? idsRaw.split(",").map(s => s.trim()).filter(Boolean) : [];

    const activeOnly = String(req.query.activeOnly ?? "true") === "true";
    const prefix = req.query.prefix ? String(req.query.prefix) : "";
    const month  = req.query.month ? String(req.query.month) : "";
    const format = (req.query.format === "flat" ? "flat" : "grouped");

    const patternBase = prefix ? `${prefix}%` : `%`;
    const monthSuffix = month ? `::${month}` : "";

    // ---- Caso 1: com IDS (misto) -> um único array "items"
    if (ids.length) {
      const items: any[] = [];
      for (const id of ids) {
        const isGroup = isUUIDv4(id);

        if (isGroup) {
          const { data, error } = await supabase
            .from("parametros_risco_grupo")
            .select("grupo_id,id,nome,valor_num,valor_texto,ativo,updated_at")
            .eq("grupo_id", id)
            .like("nome", `${patternBase}${monthSuffix}`)
            .order("nome", { ascending: true });
          if (error) throw error;
          let rows = data ?? [];
          if (activeOnly) rows = rows.filter(r => r.ativo !== false);

          if (format === "flat") {
            items.push({ escopo: "group", id, count: rows.length, params: rows });
          } else {
            items.push({
              escopo: "group",
              id,
              count: rows.length,
              params: toGrouped(rows, { month, isSetor: false, setorId: null }),
              raw: rows
            });
          }
        } else {
          const pattern = `${patternBase}::setor::${id}::%${monthSuffix}`;
          const { data, error } = await supabase
            .from("parametros_risco")
            .select("id,nome,valor_num,valor_texto,ativo,updated_at")
            .like("nome", pattern)
            .order("nome", { ascending: true });
          if (error) throw error;
          let rows = data ?? [];
          if (activeOnly) rows = rows.filter(r => r.ativo !== false);

          if (format === "flat") {
            items.push({ escopo: "setor", id, count: rows.length, params: rows });
          } else {
            items.push({
              escopo: "setor",
              id,
              count: rows.length,
              params: toGrouped(rows, { month, isSetor: true, setorId: id }),
              raw: rows
            });
          }
        }
      }
      return res.json({ mode: "by_ids", total_ids: ids.length, items });
    }

    // ---- Caso 2: sem IDS -> lista geral, com paginações separadas
    const g_limit  = Math.max(1, Math.min(1000, Number(req.query.g_limit ?? 50)));
    const g_offset = Math.max(0, Number(req.query.g_offset ?? 0));
    const s_limit  = Math.max(1, Math.min(1000, Number(req.query.s_limit ?? 50)));
    const s_offset = Math.max(0, Number(req.query.s_offset ?? 0));

    // GRUPOS (paginado)
    const { data: g_rows, error: g_err, count: g_count } = await supabase
      .from("parametros_risco_grupo")
      .select("grupo_id,id,nome,valor_num,valor_texto,ativo,updated_at", { count: "exact" })
      .like("nome", `${patternBase}${monthSuffix}`)
      .order("grupo_id", { ascending: true })
      .order("nome", { ascending: true })
      .range(g_offset, g_offset + g_limit - 1);
    if (g_err) throw g_err;
    let g_list = g_rows ?? [];
    if (activeOnly) g_list = g_list.filter(r => r.ativo !== false);

    // agrupa por grupo_id
    const g_byId = new Map();
    for (const r of g_list) {
      if (!g_byId.has(r.grupo_id)) g_byId.set(r.grupo_id, []);
      g_byId.get(r.grupo_id).push(r);
    }
    const groups: any[] = [];
    for (const [gid, list] of g_byId.entries()) {
      if (format === "flat") {
        groups.push({ escopo: "group", id: gid, count: list.length, params: list });
      } else {
        groups.push({
          escopo: "group",
          id: gid,
          count: list.length,
          params: toGrouped(list, { month, isSetor: false, setorId: null }),
          raw: list
        });
      }
    }

    // SETORES (paginado)
    const { data: s_rows, error: s_err, count: s_count } = await supabase
      .from("parametros_risco")
      .select("id,nome,valor_num,valor_texto,ativo,updated_at", { count: "exact" })
      .like("nome", `%::setor::%::%${monthSuffix}`)
      .order("nome", { ascending: true })
      .range(s_offset, s_offset + s_limit - 1);
    if (s_err) throw s_err;
    let s_list = s_rows ?? [];
    if (activeOnly) s_list = s_list.filter(r => r.ativo !== false);

    // agrupa por setor (extraindo do nome)
    const s_bySetor = new Map();
    for (const r of s_list) {
      const nome = String(r.nome);
      const m = nome.match(/::setor::([^:]+)::/);
      const setor = m ? m[1] : "__DESCONHECIDO__";
      if (!s_bySetor.has(setor)) s_bySetor.set(setor, []);
      s_bySetor.get(setor).push(r);
    }
    const setores: any[] = [];
    for (const [setor, list] of s_bySetor.entries()) {
      if (format === "flat") {
        setores.push({ escopo: "setor", id: setor, count: list.length, params: list });
      } else {
        setores.push({
          escopo: "setor",
          id: setor,
          count: list.length,
          params: toGrouped(list, { month, isSetor: true, setorId: setor }),
          raw: list
        });
      }
    }

    return res.json({
      mode: "paged_both",
      prefix, month, activeOnly,
      groups: {
        total_rows: g_count ?? 0,
        limit: g_limit, offset: g_offset,
        returned: groups.length,
        items: groups
      },
      setores: {
        total_rows: s_count ?? 0,
        limit: s_limit, offset: s_offset,
        returned: setores.length,
        items: setores
      }
    });
  } catch (e) {
    console.error("[GET /params/list] err", e);
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
});