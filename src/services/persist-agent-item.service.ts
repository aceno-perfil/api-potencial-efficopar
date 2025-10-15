import { supabase } from "../database/supabase";
import { isUUIDv4, validateWeights } from "../helpers";

// ---- Persistência dos pesos ----
function getParamNames(includePotencial: boolean = false): string[] {
  const baseParams = [
    "w_atraso",
    "w_indice",
    "w_valor_aberto",
    "w_idade",
    "w_anomalias",
    "w_desvio",
    "z_warn",
    "z_risk"
  ];
  
  if (includePotencial) {
    return [...baseParams, "pot_min", "pot_max"];
  }
  
  return baseParams;
}

function formatParamName(baseName: string, periodo?: string, janelaMeses?: number): string {
  if (!periodo) return baseName;
  // Extrai YYYY-MM do periodo (ex: "2025-10-01" -> "2025-10")
  const month = periodo.substring(0, 7);
  const janela = janelaMeses ? `::${janelaMeses}m` : '';
  return `${baseName}::${month}${janela}`;
}

export async function persistAgentItem(item, periodo?: string, janelaMeses?: number, savePotencial: boolean = false) {
    // Decide setor (texto) x grupo (UUID)
    const id = String(item?.setor_id ?? "");
    if (!id) throw new Error("missing setor_id in agent item");
  
    // valida antes de salvar
    validateWeights(item);
    const now = new Date().toISOString();
  
    if (isUUIDv4(id)) {
      // ---- Grupo → parametros_risco_grupo ----
      // busca parâmetros antigos do mesmo período/janela
      let query = supabase
        .from("parametros_risco_grupo")
        .select("id,nome")
        .eq("grupo_id", id);
      
      // Filtra por período e janela se fornecidos
      if (periodo && janelaMeses) {
        const month = periodo.substring(0, 7);
        query = query.like("nome", `%::${month}::${janelaMeses}m`);
      }
      
      const { data: oldRows, error: selErr } = await query;
      if (selErr) throw selErr;
  
      // Extrai nomes base dos parâmetros esperados
      const expectedNames = new Set(
        getParamNames(savePotencial).map(key => formatParamName(key, periodo, janelaMeses))
      );
      const toDelIds = (oldRows ?? [])
        .filter(r => expectedNames.has(String(r.nome)))
        .map(r => r.id);
  
      if (toDelIds.length) {
        const { error: delErr } = await supabase
          .from("parametros_risco_grupo")
          .delete()
          .in("id", toDelIds);
        if (delErr) throw delErr;
      }
  
      // insere novos
      const rows = extractParamsToRows(item, periodo, janelaMeses, savePotencial).map(r => ({
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
      const names = toSetorParamNames(id, periodo, janelaMeses, savePotencial);
      // apaga antigos por nome prefixado (considera período e janela se fornecidos)
      let query = supabase
        .from("parametros_risco")
        .select("id,nome")
        .like("nome", `${id}\_\_%`);
      
      // Filtra por período e janela se fornecidos
      if (periodo && janelaMeses) {
        const month = periodo.substring(0, 7);
        query = query.like("nome", `%::${month}::${janelaMeses}m`);
      }
      
      const { data: oldRows, error: selErr } = await query;
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
  
      const rows = extractParamsToRows(item, periodo, janelaMeses, savePotencial).map(r => ({
        nome: `${id}__${r.name}`,
        valor_num: r.value,
        valor_texto: null,
        ativo: true,
        updated_at: now
      }));
      const { error: insErr } = await supabase.from("parametros_risco").insert(rows);
      if (insErr) throw insErr;
    }
  }

  function toSetorParamNames(setor: string, periodo?: string, janelaMeses?: number, savePotencial: boolean = false) {
    return getParamNames(savePotencial).map(key => 
      formatParamName(`${setor}__${key}`, periodo, janelaMeses)
    );
  }
  
  function extractParamsToRows(item: any, periodo?: string, janelaMeses?: number, savePotencial: boolean = false) {
    // retorna um array { name, value } para 8 ou 10 parâmetros (dependendo de savePotencial)
    const rows: { name: string, value: any }[] = [];
    const addRow = (name: string, value: any) => {
      rows.push({ name: formatParamName(name, periodo, janelaMeses), value });
    };
    
    addRow("w_atraso", item?.inadimplencia?.w_atraso);
    addRow("w_indice", item?.inadimplencia?.w_indice);
    addRow("w_valor_aberto", item?.inadimplencia?.w_valor_aberto);
    addRow("w_idade", item?.medicao?.w_idade);
    addRow("w_anomalias", item?.medicao?.w_anomalias);
    addRow("w_desvio", item?.medicao?.w_desvio);
    addRow("z_warn", item?.cadastro?.z_warn);
    addRow("z_risk", item?.cadastro?.z_risk);
    
    // Adiciona pot_min e pot_max apenas se savePotencial = true
    if (savePotencial) {
      addRow("pot_min", item?.potencial?.pot_min);
      addRow("pot_max", item?.potencial?.pot_max);
    }
    
    return rows;
  }