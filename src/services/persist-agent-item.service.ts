import { supabase } from "../database/supabase";
import { isUUIDv4, validateWeights } from "../helpers";

// ---- Persistência dos pesos ----
const GROUP_PARAM_NAMES = [
    "weights::inadimplencia::w_atraso",
    "weights::inadimplencia::w_indice",
    "weights::inadimplencia::w_valor_aberto",
    "weights::medicao::w_idade",
    "weights::medicao::w_anomalias",
    "weights::medicao::w_desvio",
    "cadastro::z_warn",
    "cadastro::z_risk",
    "potencial::pot_min",
    "potencial::pot_max"
  ];

export async function persistAgentItem(item) {
    // Decide setor (texto) x grupo (UUID)
    const id = String(item?.setor_id ?? "");
    if (!id) throw new Error("missing setor_id in agent item");
  
    // valida antes de salvar
    validateWeights(item);
    const now = new Date().toISOString();
  
    if (isUUIDv4(id)) {
      // ---- Grupo → parametros_risco_grupo ----
      const toDelete = GROUP_PARAM_NAMES;
      // apaga antigos
      const { data: oldRows, error: selErr } = await supabase
        .from("parametros_risco_grupo")
        .select("id,nome")
        .eq("grupo_id", id);
      if (selErr) throw selErr;
  
      const toDelIds = (oldRows ?? [])
        .filter(r => toDelete.includes(String(r.nome)))
        .map(r => r.id);
  
      if (toDelIds.length) {
        const { error: delErr } = await supabase
          .from("parametros_risco_grupo")
          .delete()
          .in("id", toDelIds);
        if (delErr) throw delErr;
      }
  
      // insere novos
      const rows = extractParamsToRows(item).map(r => ({
        grupo_id: id,
        nome: r.name,
        valor_num: r.value,
        valor_texto: null,
        ativo: true,
        updated_at: now
      }));
      const { error: insErr } = await supabase.from("parametros_risco_grupo").insert(rows);
      if (insErr) throw insErr;
  
    } else {
      // ---- Setor → parametros_risco (nome codifica o setor) ----
      const names = toSetorParamNames(id);
      // apaga antigos por nome prefixado
      const { data: oldRows, error: selErr } = await supabase
        .from("parametros_risco")
        .select("id,nome");
      if (selErr) throw selErr;
  
      const baseNames = new Set(names);
      const toDelIds = (oldRows ?? [])
        .filter(r => baseNames.has(String(r.nome)))
        .map(r => r.id);
  
      if (toDelIds.length) {
        const { error: delErr } = await supabase
          .from("parametros_risco")
          .delete()
          .in("id", toDelIds);
        if (delErr) throw delErr;
      }
  
      const rows = extractParamsToRows(item).map(r => ({
        nome: r.name.replace("::", `::setor::${id}::`),
        valor_num: r.value,
        valor_texto: null,
        ativo: true,
        updated_at: now
      }));
      const { error: insErr } = await supabase.from("parametros_risco").insert(rows);
      if (insErr) throw insErr;
    }
  }

  function toSetorParamNames(setor) {
    return GROUP_PARAM_NAMES.map(key => key.replace("::", `::setor::${setor}::`));
  }
  
  function extractParamsToRows(item: any) {
    // retorna um array { name, value } para os 10 parâmetros
    const rows: { name: string, value: any }[] = [];
    rows.push({ name: "weights::inadimplencia::w_atraso",    value: item?.inadimplencia?.w_atraso });
    rows.push({ name: "weights::inadimplencia::w_indice",    value: item?.inadimplencia?.w_indice });
    rows.push({ name: "weights::inadimplencia::w_valor_aberto", value: item?.inadimplencia?.w_valor_aberto });
    rows.push({ name: "weights::medicao::w_idade",           value: item?.medicao?.w_idade });
    rows.push({ name: "weights::medicao::w_anomalias",       value: item?.medicao?.w_anomalias });
    rows.push({ name: "weights::medicao::w_desvio",          value: item?.medicao?.w_desvio });
    rows.push({ name: "cadastro::z_warn",                    value: item?.cadastro?.z_warn });
    rows.push({ name: "cadastro::z_risk",                    value: item?.cadastro?.z_risk });
    rows.push({ name: "potencial::pot_min",                  value: item?.potencial?.pot_min });
    rows.push({ name: "potencial::pot_max",                  value: item?.potencial?.pot_max });
    return rows;
  }