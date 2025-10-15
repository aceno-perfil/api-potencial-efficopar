// routes/params-list.ts
import express from "express";
import { supabase } from "../database/supabase";
import { isUUIDv4 } from "../helpers";

export const paramsListRouter = express.Router();

const SETOR_KEY_JOIN = "__";

// chaves conhecidas (sem namespaces)
const INAD_KEYS = new Set(["w_atraso", "w_indice", "w_valor_aberto"]);
const MEDI_KEYS = new Set(["w_idade", "w_anomalias", "w_desvio"]);
const CAD_KEYS  = new Set(["z_warn", "z_risk"]);
const POT_KEYS  = new Set(["pot_min", "pot_max"]);

function splitSetorKey(name: string) {
  // "101__w_indice" -> { setor: "101", key: "w_indice" }
  const ix = name.indexOf(SETOR_KEY_JOIN);
  if (ix === -1) return { setor: null, key: name };
  return { setor: name.slice(0, ix), key: name.slice(ix + SETOR_KEY_JOIN.length) };
}

function toGroupedNoPrefix(rows: any[], isSetor: boolean, setorId?: string) {
  const out: any = { inadimplencia: {}, medicao: {}, cadastro: {}, potencial: {} };
  for (const r of rows) {
    const raw = String(r.nome);
    const key = isSetor ? splitSetorKey(raw).key : raw;
    const val = r.valor_num ?? (r.valor_texto ? Number(r.valor_texto) : null);

    if (INAD_KEYS.has(key)) {
      out.inadimplencia[key] = val;
    } else if (MEDI_KEYS.has(key)) {
      out.medicao[key] = val;
    } else if (CAD_KEYS.has(key)) {
      out.cadastro[key] = val;
    } else if (POT_KEYS.has(key)) {
      out.potencial[key] = val;
    } else {
      // opcional: out.outros = { ...(out.outros||{}), [key]: val }
    }
  }
  return out;
}

/**
 * GET /params-list
 *
 * Query:
 * - ids= (opcional) lista CSV de IDs mistos (UUID = grupo, texto = setor)
 * - activeOnly=true|false (default true)
 * - format=grouped|flat (default grouped)
 * - g_limit / g_offset (default 50 / 0) -> paginação de grupos QUANDO ids NÃO for passado
 * - s_limit / s_offset (default 50 / 0) -> paginação de setores QUANDO ids NÃO for passado
 *
 * Com ids -> retorna `items` (mistos).
 * Sem ids -> retorna `groups` e `setores` paginados em blocos separados.
 */
paramsListRouter.get("/params-list", async (req, res) => {
  try {
    const idsRaw = String(req.query.ids ?? "").trim();
    const ids = idsRaw ? idsRaw.split(",").map(s => s.trim()).filter(Boolean) : [];

    const activeOnly = String(req.query.activeOnly ?? "true") === "true";
    const format = (req.query.format === "flat" ? "flat" : "grouped");

    // ---- Caso 1: com IDS (misto) -> um único array "items"
    if (ids.length) {
      const items: any[] = [];

      for (const id of ids) {
        const isGroup = isUUIDv4(id);

        if (isGroup) {
          // GRUPO: busca o nome do grupo
          const { data: groupData, error: groupError } = await supabase
            .from("grupo_setores")
            .select("nome")
            .eq("id", id)
            .single();

          if (groupError && groupError.code !== "PGRST116") throw groupError;
          const groupName = groupData?.nome ?? null;

          // GRUPO: nome = <key>
          const { data, error } = await supabase
            .from("parametros_risco_grupo")
            .select("grupo_id,id,nome,valor_num,valor_texto,ativo,updated_at")
            .eq("grupo_id", id)
            .order("nome", { ascending: true });

          if (error) throw error;

          let rows = data ?? [];
          if (activeOnly) rows = rows.filter(r => r.ativo !== false);

          if (format === "flat") {
            items.push({ escopo: "group", id, nome: groupName, count: rows.length, params: rows });
          } else {
            items.push({
              escopo: "group",
              id,
              nome: groupName,
              count: rows.length,
              params: toGroupedNoPrefix(rows, false),
              raw: rows
            });
          }
        } else {
          // SETOR: nome = "<SETOR>__<key>"
          const { data, error } = await supabase
            .from("parametros_risco")
            .select("id,nome,valor_num,valor_texto,ativo,updated_at")
            .like("nome", `${id}${SETOR_KEY_JOIN}%`)
            .order("nome", { ascending: true });

          if (error) throw error;

          let rows = data ?? [];
          if (activeOnly) rows = rows.filter(r => r.ativo !== false);

          if (format === "flat") {
            items.push({ escopo: "setor", id, nome: id, count: rows.length, params: rows });
          } else {
            items.push({
              escopo: "setor",
              id,
              nome: id,
              count: rows.length,
              params: toGroupedNoPrefix(rows, true, id),
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

    // GRUPOS (paginado) — nome = <key>
    const { data: g_rows, error: g_err, count: g_count } = await supabase
      .from("parametros_risco_grupo")
      .select("grupo_id,id,nome,valor_num,valor_texto,ativo,updated_at", { count: "exact" })
      .order("grupo_id", { ascending: true })
      .order("nome", { ascending: true })
      .range(g_offset, g_offset + g_limit - 1);
    if (g_err) throw g_err;

    let g_list = g_rows ?? [];
    if (activeOnly) g_list = g_list.filter(r => r.ativo !== false);

    // agrupa por grupo_id
    const g_byId = new Map<string, any[]>();
    for (const r of g_list) {
      if (!g_byId.has(r.grupo_id)) g_byId.set(r.grupo_id, []);
      g_byId.get(r.grupo_id)!.push(r);
    }

    // busca nomes dos grupos
    const uniqueGroupIds = Array.from(g_byId.keys());
    const { data: groupNames, error: groupNamesErr } = await supabase
      .from("grupo_setores")
      .select("id,nome")
      .in("id", uniqueGroupIds);
    if (groupNamesErr) throw groupNamesErr;

    const groupNameMap = new Map((groupNames ?? []).map(g => [g.id, g.nome]));

    const groups: any[] = [];
    for (const [gid, list] of g_byId.entries()) {
      const groupName = groupNameMap.get(gid) ?? null;
      if (format === "flat") {
        groups.push({ escopo: "group", id: gid, nome: groupName, count: list.length, params: list });
      } else {
        groups.push({
          escopo: "group",
          id: gid,
          nome: groupName,
          count: list.length,
          params: toGroupedNoPrefix(list, false),
          raw: list
        });
      }
    }

    // SETORES (paginado) — nome = "<SETOR>__<key>"
    const { data: s_rows, error: s_err, count: s_count } = await supabase
      .from("parametros_risco")
      .select("id,nome,valor_num,valor_texto,ativo,updated_at", { count: "exact" })
      .like("nome", `%${SETOR_KEY_JOIN}%`) // pega todos que seguem o padrão "<SETOR>__<key>"
      .order("nome", { ascending: true })
      .range(s_offset, s_offset + s_limit - 1);
    if (s_err) throw s_err;

    let s_list = s_rows ?? [];
    if (activeOnly) s_list = s_list.filter(r => r.ativo !== false);

    // agrupa por setor (extraindo antes do "__")
    const s_bySetor = new Map<string, any[]>();
    for (const r of s_list) {
      const { setor } = splitSetorKey(String(r.nome));
      // Pula registros que não seguem o padrão "SETOR__chave" (parâmetros globais)
      if (!setor) continue;
      if (!s_bySetor.has(setor)) s_bySetor.set(setor, []);
      s_bySetor.get(setor)!.push(r);
    }

    const setores: any[] = [];
    for (const [setor, list] of s_bySetor.entries()) {
      if (format === "flat") {
        setores.push({ escopo: "setor", id: setor, nome: setor, count: list.length, params: list });
      } else {
        setores.push({
          escopo: "setor",
          id: setor,
          nome: setor,
          count: list.length,
          params: toGroupedNoPrefix(list, true, setor),
          raw: list
        });
      }
    }

    return res.json({
      mode: "paged_both",
      activeOnly,
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
  } catch (e: any) {
    console.error("[GET /params-list] err", e);
    return res.status(500).json({ error: String(e?.message ?? e) });
  }
});
