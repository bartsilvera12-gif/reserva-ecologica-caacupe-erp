/**
 * Resuelve el override de membrete (logo/teléfono/dirección) de una sucursal a
 * partir de las columnas `doc_*` de `sucursales`. Si la sucursal no tiene
 * branding propio (todas las columnas NULL), devuelve `undefined` y el documento
 * usa el membrete por defecto (EMPRESA_DOC).
 */
import { getChatPostgresPool, quoteSchemaTable } from "@/lib/supabase/chat-pg-pool";
import { assertAllowedChatDataSchema } from "@/lib/supabase/chat-data-schema";
import type { MembreteMarca } from "@/lib/documentos/membrete";

export async function getMarcaSucursal(
  schemaRaw: string,
  empresaId: string,
  sucursalId: string | null | undefined
): Promise<MembreteMarca | undefined> {
  if (!sucursalId) return undefined;
  const pool = getChatPostgresPool();
  if (!pool) return undefined;
  const schema = assertAllowedChatDataSchema(schemaRaw);
  const tS = quoteSchemaTable(schema, "sucursales");
  const { rows } = await pool.query<{ doc_logo_path: string | null; doc_telefono: string | null; doc_direccion: string | null }>(
    `SELECT doc_logo_path, doc_telefono, doc_direccion FROM ${tS} WHERE id=$1::uuid AND empresa_id=$2::uuid`,
    [sucursalId, empresaId]
  );
  const r = rows[0];
  if (!r) return undefined;
  const logoUrl = r.doc_logo_path?.trim() || undefined;
  const telefono = r.doc_telefono?.trim() || undefined;
  const direccion = r.doc_direccion?.trim()
    ? r.doc_direccion.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    : undefined;
  if (!logoUrl && !telefono && (!direccion || direccion.length === 0)) return undefined;
  return { logoUrl, telefono, direccion };
}
