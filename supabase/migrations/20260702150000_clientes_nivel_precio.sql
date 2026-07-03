-- Nivel de precio por cliente: minorista | mayorista | distribuidor.
-- Al agregar productos en Presupuestos, Pedidos o Ventas, el precio unitario se
-- precarga con el nivel del cliente (en lugar de que el operador lo elija manual).
-- Aplica solo en el schema `reservacaacupe`. Idempotente.

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
      'ALTER TABLE %I.clientes ADD COLUMN IF NOT EXISTS nivel_precio text DEFAULT ''minorista''',
      r.sch
    );
    EXECUTE format(
      'UPDATE %I.clientes SET nivel_precio = ''minorista'' WHERE nivel_precio IS NULL',
      r.sch
    );
    EXECUTE format(
      'ALTER TABLE %I.clientes ALTER COLUMN nivel_precio SET NOT NULL',
      r.sch
    );
    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = format('%I.clientes', r.sch)::regclass
        AND conname = 'clientes_nivel_precio_check'
    ) THEN
      EXECUTE format(
        'ALTER TABLE %I.clientes ADD CONSTRAINT clientes_nivel_precio_check CHECK (nivel_precio IN (''minorista'', ''mayorista'', ''distribuidor''))',
        r.sch
      );
    END IF;
    EXECUTE format(
      'COMMENT ON COLUMN %I.clientes.nivel_precio IS ''Nivel de precio comercial: minorista | mayorista | distribuidor. Se usa como default al agregar productos a presupuestos, pedidos y ventas.''',
      r.sch
    );
  END LOOP;
END $$;
