-- Anulación de ventas (ticket no fiscal).
-- Agrega columnas de auditoría a `ventas` y amplía el CHECK de `movimientos_inventario.origen`
-- para permitir el movimiento de reintegro de stock generado al anular una venta.
-- Aplica en todos los schemas de tenant que ya tengan las tablas: public, zentra_erp, er_<uuid> y erp_*.
-- No toca datos: solo DDL idempotente.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'ventas'
      AND c.relkind = 'r'
      AND n.nspname = 'reservacaacupe'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.ventas ADD COLUMN IF NOT EXISTS anulada_at timestamptz',
      r.sch
    );
    EXECUTE format(
      'ALTER TABLE %I.ventas ADD COLUMN IF NOT EXISTS anulada_por uuid',
      r.sch
    );
    EXECUTE format(
      'ALTER TABLE %I.ventas ADD COLUMN IF NOT EXISTS anulacion_motivo text',
      r.sch
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_ventas_estado_anulada ON %I.ventas(empresa_id, estado) WHERE estado = ''anulada''',
      r.sch
    );
  END LOOP;
END $$;

-- Ampliar el CHECK de origen para admitir 'anulacion_venta' (contraparte ENTRADA por anulación).
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
    -- Buscar y eliminar cualquier CHECK previo sobre `origen` (nombre no siempre estable).
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
         CHECK (origen IN (''compra'', ''venta'', ''ajuste_manual'', ''inventario_inicial'', ''anulacion_venta''))',
      r.sch
    );
  END LOOP;
END $$;
