import { supabase } from "../database/supabase";

export async function fetchIHAForSetores(periodoISO: string, setores: string[]) {
    const page = 1000;
    let from = 0, to = page - 1;
    const out: any[] = [];
  
    while (true) {
      const { data, error } = await supabase
        .from("imovel_historico_agregado")
        .select("imovel_id,setor,media_consumo_por_economia,media_tempo_atraso,valor_total_aberto,indice_inadimplencia,idade_hidrometro_meses,taxa_anomalias,coef_var_consumo,sit_ligacao_agua", { count: "exact" })
        .eq("periodo", periodoISO)
        .eq("sit_ligacao_agua", "ligado")
        .in("setor", setores)
        .range(from, to);
  
      if (error) throw error;
      out.push(...(data ?? []));
  
      if (!data || data.length < page) break;
      from += page; to += page;
    }
    return out;
  }