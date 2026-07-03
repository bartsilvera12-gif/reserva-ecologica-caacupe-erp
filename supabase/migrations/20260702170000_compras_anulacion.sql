-- Anulación de compras.
-- 1) Agrega columnas de auditoría a `compras`:
--    anulada_at, anulada_por (uuid), anulacion_motivo (text).
-- 2) Amplía el CHECK de `movimientos_inventario.origen` para admitir 'anulacion_compra'
--    (contraparte SALIDA por reintegro inverso al stock que agregó la compra).
-- El CHECK de `compras.estado` ya incluye 'anulada' desde el schema base.
-- Aplica solo en `reservacaacupe`. Idempotente. No toca datos.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'compras'
      AND c.relkind = 'r'
      AND n.nspname = 'reservacaacupe'
  LOOP
    EXECUTE format('ALTER TABLE %I.compras ADD COLUMN IF NOT EXISTS anulada_at timestamptz', r.sch);
    EXECUTE format('ALTER TABLE %I.compras ADD COLUMN IF NOT EXISTS anulada_por uuid', r.sch);
    EXECUTE format('ALTER TABLE %I.compras ADD COLUMN IF NOT EXISTS anulacion_motivo text', r.sch);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_compras_estado_anulada ON %I.compras(empresa_id, estado) WHERE estado = ''anulada''',
      r.sch
    );
  END LOOP;
END $$;

-- Ampliar el CHECK de movimientos_inventario.origen para admitir 'anulacion_compra'.
DO $$
DECLARE
  r RECORD;
  cname text;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'movimientos_inventario'
      AND c.relkind = 'r'
      AND n.nspname = 'reservacaacupe'
  LOOP
    FOR cname IN
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = format('%I.movimientos_inventario', r.sch)::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%origen%'
    LOOP
      EXECUTE format('ALTER TABLE %I.movimientos_inventario DROP CONSTRAINT %I', r.sch, cname);
    END LOOP;
    EXECUTE format(
      'ALTER TABLE %I.movimientos_inventario ADD CONSTRAINT movimientos_inventario_origen_check
         CHECK (origen IN (''compra'', ''venta'', ''ajuste_manual'', ''inventario_inicial'', ''anulacion_venta'', ''anulacion_compra''))',
      r.sch
    );
  END LOOP;
END $$;
