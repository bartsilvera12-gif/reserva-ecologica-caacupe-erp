-- Nombre para facturación: campo opcional independiente de la Razón Social.
-- Cuando está seteado, sobrescribe el nombre del receptor en tickets/notas de remisión
-- (útil cuando el cliente pide facturar a nombre de su cónyuge, hijo/a, etc.).
-- Idempotente. No toca datos existentes.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'clientes'
      AND c.relkind = 'r'
      AND n.nspname = 'reservacaacupe'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.clientes ADD COLUMN IF NOT EXISTS nombre_facturacion text',
      r.sch
    );
    EXECUTE format(
      'COMMENT ON COLUMN %I.clientes.nombre_facturacion IS ''Nombre para facturar cuando difiere de la Razón Social (ej: pareja, hijo/a). NULL = usar empresa/nombre_contacto.''',
      r.sch
    );
  END LOOP;
END $$;
