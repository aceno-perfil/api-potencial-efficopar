import { supabase } from "../database/supabase";

interface FetchRiskWeightsParams {
  setoresFiltro: string[] | null;
  grupoId: string | null;
  vMonthStr: string;
  janela_meses: number;
}

interface RiskWeights {
  setorWeights: Map<string, Map<string, number>>;
  groupWeights: Map<string, number>;
}

/**
 * Busca pesos versionados para setores e grupos
 * @param params Parâmetros com filtros de setor/grupo e período
 * @returns Objeto com Maps de pesos por setor e grupo
 */
export async function fetchRiskWeights(
  params: FetchRiskWeightsParams
): Promise<RiskWeights> {
  const { setoresFiltro, grupoId, vMonthStr, janela_meses } = params;

  console.log("Fetching risk weights params", params);

  const setorWeights = new Map<string, Map<string, number>>();
  const groupWeights = new Map<string, number>();

  console.log("Fetching risk weights for setores", setoresFiltro);
  console.log("Fetching risk weights for grupo", grupoId);
  console.log("Fetching risk weights for vMonthStr", vMonthStr);
  console.log("Fetching risk weights for janela_meses", janela_meses);
  try {
    // Buscar pesos de setor
    if (setoresFiltro?.length) {
      const { data: prSetor, error: prSErr } = await supabase
        .from("parametros_risco")
        .select("nome, valor_num")
        .in(
          "nome",
          setoresFiltro
            .map((s) => `${s}__w_atraso::${vMonthStr}::${janela_meses}m`)
            .concat(
              setoresFiltro.map((s) => `${s}__w_indice::${vMonthStr}::${janela_meses}m`)
            )
            .concat(
              setoresFiltro.map(
                (s) => `${s}__w_valor_aberto::${vMonthStr}::${janela_meses}m`
              )
            )
            .concat(
              setoresFiltro.map((s) => `${s}__w_idade::${vMonthStr}::${janela_meses}m`)
            )
            .concat(
              setoresFiltro.map(
                (s) => `${s}__w_anomalias::${vMonthStr}::${janela_meses}m`
              )
            )
            .concat(
              setoresFiltro.map((s) => `${s}__w_desvio::${vMonthStr}::${janela_meses}m`)
            )
        );
      if (prSErr) throw prSErr;
      (prSetor ?? []).forEach((r) => {
        const [set, rest] = String(r.nome).split("__");
        const key = rest.split("::")[0];
        if (!setorWeights.has(set)) setorWeights.set(set, new Map());
        setorWeights.get(set)!.set(key, Number(r.valor_num));
      });
    }

    // Buscar pesos de grupo
    if (grupoId) {
      const { data: prGroup, error: prGErr } = await supabase
        .from("parametros_risco_grupo")
        .select("nome, valor_num")
        .eq("grupo_id", grupoId)
        .like("nome", `%::${vMonthStr}::${janela_meses}m`);
      if (prGErr) throw prGErr;
      (prGroup ?? []).forEach((r) => {
        const key = String(r.nome).split("::")[0]; // w_atraso etc.
        groupWeights.set(key, Number(r.valor_num));
      });
    }

    return { setorWeights, groupWeights };
  } catch (error) {
    console.error("Error fetching risk weights", error);
    throw error;
  }
}

