import { supabase } from "../database/supabase";

/**
 * Associa setores a um grupo (upsert)
 * Se o setor já estiver em outro grupo, atualiza para o novo grupo
 */
export async function associateSetoresToGroup(
  setores: string[],
  groupId: string
): Promise<void> {
  if (setores.length === 0) return;

  // Normaliza os setores (trim)
  const normalizedSetores = setores.map((s) => String(s).trim()).filter((s) => s);

  // Upsert: insere ou atualiza se já existir
  const rows = normalizedSetores.map((setor) => ({
    setor,
    grupo_id: groupId
  }));

  const { error } = await supabase
    .from("setor_grupo")
    .upsert(rows, { onConflict: "setor" });

  if (error) throw error;
}

