-- IVA por producto: agrega `tipo_iva` a `productos` con default '10%' y CHECK.
-- Aplica en todos los schemas de tenant que tengan la tabla. Idempotente.
-- Los productos existentes quedan como '10%' (default) — el cliente puede ajustar
-- individualmente los que tienen IVA 5% desde el detalle del producto.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'productos'
      AND c.relkind = 'r'
      AND n.nspname = 'reservacaacupe'
  LOOP
    -- Agregar la columna sin NOT NULL primero para permitir backfill idempotente.
    EXECUTE format(
      'ALTER TABLE %I.productos ADD COLUMN IF NOT EXISTS tipo_iva text DEFAULT ''10%%''',
      r.sch
    );
    -- Backfill defensivo: si existen filas con NULL (bases pre-existentes), poner '10%'.
    EXECUTE format(
      'UPDATE %I.productos SET tipo_iva = ''10%%'' WHERE tipo_iva IS NULL',
      r.sch
    );
    -- Forzar NOT NULL.
    EXECUTE format(
      'ALTER TABLE %I.productos ALTER COLUMN tipo_iva SET NOT NULL',
      r.sch
    );
    -- CHECK igual al de ventas_items para mantener consistencia.
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = format('%I.productos', r.sch)::regclass
        AND conname = 'productos_tipo_iva_check'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.productos ADD CONSTRAINT productos_tipo_iva_check CHECK (tipo_iva IN (''EXENTA'', ''5%%'', ''10%%''))',
        r.sch
      );
    END IF;
  END LOOP;
END $$;
