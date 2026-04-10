import { NextResponse } from "next/server";
import { getUserAndEmpresa } from "@/lib/middleware/auth";
import { fetchDataSchemaForEmpresaId } from "@/lib/supabase/empresa-data-schema";

/**
 * GET /api/empresas/data-schema
 * Devuelve el schema PostgREST donde viven las tablas de negocio de la empresa autenticada.
 */
export async function GET() {
  const auth = await getUserAndEmpresa();
  if (!auth) {
    return NextResponse.json({ error: "No autorizado" }, { status: 401 });
  }
  const schema = await fetchDataSchemaForEmpresaId(auth.empresa_id);
  return NextResponse.json({ schema });
}
