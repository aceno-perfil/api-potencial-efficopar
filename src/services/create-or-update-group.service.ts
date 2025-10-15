import {
  generateNextGroupName,
  upsertGroup,
  associateSetoresToGroup
} from "../helpers";

interface CreateOrUpdateGroupParams {
  groupName?: string;
  setores: string[];
}

/**
 * Cria ou atualiza um grupo de setores
 * - Se groupName não for informado, gera automaticamente "Grupo N"
 * - Cria o grupo se não existir (ou usa o existente)
 * - Associa os setores ao grupo (upsert)
 * @returns ID do grupo criado/atualizado
 */
export async function createOrUpdateGroup(
  params: CreateOrUpdateGroupParams
): Promise<string> {
  const { groupName, setores } = params;

  // Valida setores
  if (!Array.isArray(setores) || setores.length === 0) {
    throw new Error("setores must be a non-empty array");
  }

  // Define o nome do grupo
  let finalGroupName: string;
  if (!groupName || groupName.trim() === "") {
    finalGroupName = await generateNextGroupName();
  } else {
    finalGroupName = groupName.trim();
  }

  // Cria ou busca o grupo
  const groupId = await upsertGroup(finalGroupName);

  // Associa os setores ao grupo
  await associateSetoresToGroup(setores, groupId);

  return groupId;
}

