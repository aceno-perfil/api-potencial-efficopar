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
  // Remove sufixos: "101__w_indice::2025-10::6m" -> "101__w_indice"
  const cleanName = name.split("::")[0];
  const ix = cleanName.indexOf(SETOR_KEY_JOIN);
  if (ix === -1) return { setor: null, key: cleanName };
  return { 
    setor: cleanName.slice(0, ix), 
    key: cleanName.slice(ix + SETOR_KEY_JOIN.length) 
  };
}

function extractParamMetadata(name: string) {
  // "101__w_indice::2025-10::6m" -> { periodo: "2025-10", janela_meses: 6 }
  const parts = name.split("::");
  return {
    periodo: parts[1] || null,
    janela_meses: parts[2] ? parseInt(parts[2]) : null
  };
}

function groupByCategory(items: Array<{key: string, val: any}>) {
  const out: any = { inadimplencia: {}, medicao: {}, cadastro: {}, potencial: {} };
  for (const { key, val } of items) {
    if (INAD_KEYS.has(key)) {
      out.inadimplencia[key] = val;
    } else if (MEDI_KEYS.has(key)) {
      out.medicao[key] = val;
    } else if (CAD_KEYS.has(key)) {
      out.cadastro[key] = val;
    } else if (POT_KEYS.has(key)) {
      out.potencial[key] = val;
    }
  }
  return out;
}

function toGroupedNoPrefix(rows: any[], isSetor: boolean, setorId?: string) {
  // Agrupa por periodo::janela
  const byPeriodJanela = new Map<string, any[]>();
  
  for (const r of rows) {
    const raw = String(r.nome);
    const parts = raw.split("::");
    const baseName = parts[0]; // "w_anomalias" ou "101__w_anomalias"
    const periodo = parts[1] || null; // "2021-10"
    const janelaStr = parts[2] || null; // "10m"
    const janelaMeses = janelaStr ? parseInt(janelaStr) : null; // 10
    
    // Remove prefixo do setor se necessário
    const key = isSetor ? splitSetorKey(baseName).key : baseName;
    const val = r.valor_num ?? (r.valor_texto ? Number(r.valor_texto) : null);
    
    const groupKey = periodo && janelaStr ? `${periodo}::${janelaStr}` : '__no_period__';
    if (!byPeriodJanela.has(groupKey)) {
      byPeriodJanela.set(groupKey, []);
    }
    byPeriodJanela.get(groupKey)!.push({ key, val });
  }
  
  // Converte para array de objetos
  const result: any[] = [];
  for (const [groupKey, items] of byPeriodJanela.entries()) {
    let periodo: string | null = null;
    let janelaMeses: number | null = null;
    
    if (groupKey !== '__no_period__') {
      const [p, j] = groupKey.split('::');
      periodo = p;
      janelaMeses = parseInt(j);
    }
    
    result.push({
      periodo,
      janela_meses: janelaMeses,
      ...groupByCategory(items)
    });
  }
  
  return result;
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
    const periodo = req.query.periodo ? String(req.query.periodo).substring(0, 7) : null;
    const janelaMeses = req.query.janela_meses ? Number(req.query.janela_meses) : null;

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
          let query = supabase
            .from("parametros_risco_grupo")
            .select("grupo_id,id,nome,valor_num,valor_texto,ativo,updated_at")
            .eq("grupo_id", id);
          
          // Filtra por período e janela se fornecidos
          if (periodo && janelaMeses) {
            query = query.like("nome", `%::${periodo}::${janelaMeses}m`);
          } else if (periodo) {
            query = query.like("nome", `%::${periodo}::%`);
          }
          
          query = query.order("nome", { ascending: true });
          const { data, error } = await query;

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
          let query = supabase
            .from("parametros_risco")
            .select("id,nome,valor_num,valor_texto,ativo,updated_at")
            .like("nome", `${id}${SETOR_KEY_JOIN}%`);
          
          // Filtra por período e janela se fornecidos
          if (periodo && janelaMeses) {
            query = query.like("nome", `%::${periodo}::${janelaMeses}m`);
          } else if (periodo) {
            query = query.like("nome", `%::${periodo}::%`);
          }
          
          query = query.order("nome", { ascending: true });
          const { data, error} = await query;

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
    let g_query = supabase
      .from("parametros_risco_grupo")
      .select("grupo_id,id,nome,valor_num,valor_texto,ativo,updated_at", { count: "exact" });
    
    // Filtra por período e janela se fornecidos
    if (periodo && janelaMeses) {
      g_query = g_query.like("nome", `%::${periodo}::${janelaMeses}m`);
    } else if (periodo) {
      g_query = g_query.like("nome", `%::${periodo}::%`);
    }
    
    g_query = g_query
      .order("grupo_id", { ascending: true })
      .order("nome", { ascending: true })
      .range(g_offset, g_offset + g_limit - 1);
    
    const { data: g_rows, error: g_err, count: g_count } = await g_query;
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
    let s_query = supabase
      .from("parametros_risco")
      .select("id,nome,valor_num,valor_texto,ativo,updated_at", { count: "exact" })
      .like("nome", `%${SETOR_KEY_JOIN}%`); // pega todos que seguem o padrão "<SETOR>__<key>"
    
    // Filtra por período e janela se fornecidos
    if (periodo && janelaMeses) {
      s_query = s_query.like("nome", `%::${periodo}::${janelaMeses}m`);
    } else if (periodo) {
      s_query = s_query.like("nome", `%::${periodo}::%`);
    }
    
    s_query = s_query
      .order("nome", { ascending: true })
      .range(s_offset, s_offset + s_limit - 1);
    
    const { data: s_rows, error: s_err, count: s_count } = await s_query;
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
