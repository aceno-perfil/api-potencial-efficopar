import { supabase } from "../database/supabase";

/**
 * Cria ou busca um grupo existente pelo nome
 * @returns ID do grupo
 */
export async function upsertGroup(groupName: string): Promise<string> {
  // Tenta criar o grupo
  const { data: insertData, error: insertError } = await supabase
    .from("grupo_setores")
    .insert({ nome: groupName })
    .select("id")
    .single();

  // Se inseriu com sucesso, retorna o ID
  if (!insertError && insertData) {
    return insertData.id;
  }

  // Se falhou por conflito (grupo já existe), busca o ID
  if (insertError?.code === "23505") {
    const { data: selectData, error: selectError } = await supabase
      .from("grupo_setores")
      .select("id")
      .eq("nome", groupName)
      .single();

    if (selectError) throw selectError;
    if (!selectData) throw new Error(`Group ${groupName} not found after conflict`);

    return selectData.id;
  }

  // Outro tipo de erro
  throw insertError;
}

