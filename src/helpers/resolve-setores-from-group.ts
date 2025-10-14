import { supabase } from "../database/supabase";

export async function resolveSetoresFromGroup(groupId: string) {
    const { data, error } = await supabase
      .from("setor_grupo")
      .select("setor")
      .eq("grupo_id", groupId);
    if (error) throw error;
    return (data ?? []).map((r) => String(r.setor));
  }