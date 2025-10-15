import { supabase } from "../database/supabase";
import { isUUIDv4 } from "./is-uuid";

interface ResolveRiskEscopoParams {
  escopo: string;
  identificadores: string[];
}

interface ResolveRiskEscopoResult {
  setoresFiltro: string[] | null;
  grupoId: string | null;
}

/**
 * Resolve o escopo de setores baseado no tipo (setor/grupo/all)
 * @param params Parâmetros com escopo e identificadores
 * @returns Objeto com setoresFiltro e grupoId
 * @throws Error se validação falhar
 */
export async function resolveRiskEscopo(
  params: ResolveRiskEscopoParams
): Promise<ResolveRiskEscopoResult> {
  const { escopo, identificadores } = params;

  let setoresFiltro: string[] | null = null;
  let grupoId: string | null = null;

  if (escopo === "setor") {
    if (!Array.isArray(identificadores) || identificadores.length === 0) {
      throw new Error("identificadores (setores) é obrigatório para escopo=setor");
    }
    setoresFiltro = identificadores.map((s: any) => String(s).trim());
  } else if (escopo === "grupo") {
    if (
      !Array.isArray(identificadores) ||
      identificadores.length === 0 ||
      !isUUIDv4(identificadores[0])
    ) {
      throw new Error(
        "identificadores deve conter 1 UUID de grupo para escopo=grupo"
      );
    }
    grupoId = String(identificadores[0]);
    const { data: sg, error: sgErr } = await supabase
      .from("setor_grupo")
      .select("setor")
      .eq("grupo_id", grupoId);
    if (sgErr) throw sgErr;
    setoresFiltro = (sg ?? []).map((r) => r.setor);
    if (setoresFiltro.length === 0) {
      // Retorna vazio mas não lança erro - será tratado na camada superior
      setoresFiltro = [];
    }
  }
  // escopo === "all" mantém setoresFiltro = null

  return { setoresFiltro, grupoId };
}

