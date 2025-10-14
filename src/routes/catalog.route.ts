// routes/catalog.js
import express from "express";
import { supabase } from '../database/supabase';

export const catalogRouter = express.Router();

// GET /catalog
// Retorna:
// - grupos (com setores e contagem)
// - setores (com metadados de grupo quando existir)
// - setores_sem_grupo (vistos no IHA mas não mapeados)
catalogRouter.get("/catalog", async (req, res) => {
  try {
    // setores distintos do agregado (fonte mais abrangente)
    const { data: setoresIHA, error: errIHA } = await supabase
      .from("imovel_historico_agregado")
      .select("setor")
      .not("setor", "is", null);
    if (errIHA) throw errIHA;

    const allSetoresSet = new Set((setoresIHA ?? []).map(r => String(r.setor)));

    // grupos
    const { data: grupos, error: errGr } = await supabase
      .from("grupo_setores")
      .select("id, nome, ativo")
      .order("nome", { ascending: true });
    if (errGr) throw errGr;

    const byId = new Map((grupos ?? []).map(g => [g.id, g]));

    // mapeamento setor->grupo
    const { data: map, error: errMap } = await supabase
      .from("setor_grupo")
      .select("setor, grupo_id");
    if (errMap) throw errMap;

    const gruposOutMap = new Map(); // grupo_id -> { grupo_id, nome, ativo, setores: [] }
    (map ?? []).forEach(r => {
      const gid = r.grupo_id;
      const s = String(r.setor);
      allSetoresSet.delete(s);
      if (!gruposOutMap.has(gid)) {
        const meta = byId.get(gid);
        gruposOutMap.set(gid, {
          grupo_id: gid,
          nome: meta?.nome ?? null,
          ativo: meta?.ativo ?? null,
          setores: []
        });
      }
      gruposOutMap.get(gid).setores.push(s);
    });

    const gruposOut = Array.from(gruposOutMap.values()).map(g => ({
      ...g,
      setores: g.setores.sort(),
      qtd_setores: g.setores.length
    })).sort((a,b) => (a.nome || "").localeCompare(b.nome || ""));

    // setores “achatado”: lista completa com metadados de grupo (se houver)
    const mapBySetor = new Map((map ?? []).map(r => [String(r.setor), r.grupo_id]));
    const setoresOut = Array.from(new Set([
      ...Array.from(mapBySetor.keys()),
      ...Array.from(allSetoresSet)
    ])).sort().map(s => {
      const gid = mapBySetor.get(s);
      const meta = gid ? byId.get(gid) : null;
      return {
        setor: s,
        grupo_id: gid ?? null,
        grupo_nome: meta?.nome ?? null,
        grupo_ativo: meta?.ativo ?? null
      };
    });

    const setoresSemGrupo = Array.from(allSetoresSet).sort();

    return res.json({
      grupos: gruposOut,
      setores: setoresOut,
      setores_sem_grupo: setoresSemGrupo,
      total_grupos: gruposOut.length,
      total_setores: setoresOut.length,
      total_setores_sem_grupo: setoresSemGrupo.length
    });
  } catch (e) {
    console.error("[GET /catalog] err", e);
    res.status(500).json({ error: String(e?.message ?? e) });
  }
});
