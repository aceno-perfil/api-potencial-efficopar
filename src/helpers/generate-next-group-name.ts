import { supabase } from "../database/supabase";

/**
 * Gera o próximo nome automático de grupo no formato "Grupo N"
 */
export async function generateNextGroupName(): Promise<string> {
  const { data, error } = await supabase
    .from("grupo_setores")
    .select("nome")
    .ilike("nome", "Grupo %");

  if (error) throw error;

  // Extrai os números dos nomes no formato "Grupo N"
  const indices = (data ?? [])
    .map((row) => {
      const match = row.nome.match(/^Grupo\s+(\d+)$/i);
      return match ? parseInt(match[1], 10) : 0;
    })
    .filter((n) => n > 0);

  const nextIndex = indices.length > 0 ? Math.max(...indices) + 1 : 1;
  return `Grupo ${nextIndex}`;
}

