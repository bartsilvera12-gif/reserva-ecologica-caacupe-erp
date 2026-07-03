-- Presupuestos: agrega `fecha_entrega` (día de entrega definido) al presupuesto.
-- El campo `plazo_entrega` (text libre, ej. "5 días hábiles") se conserva por compatibilidad,
-- pero el flujo nuevo del cliente escribe una fecha concreta que se muestra en el PDF.
-- Idempotente. Aplica solo en `reservacaacupe`.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'presupuestos'
      AND c.relkind = 'r'
      AND n.nspname = 'reservacaacupe'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.presupuestos ADD COLUMN IF NOT EXISTS fecha_entrega date',
      r.sch
    );
    EXECUTE format(
      'COMMENT ON COLUMN %I.presupuestos.fecha_entrega IS ''Fecha de entrega comprometida. Se muestra en el PDF/impresión del presupuesto.''',
      r.sch
    );
  END LOOP;
END $$;
