-- Gastos: agregar campos beneficiario y metodo_pago (pedido del cliente).
--
-- beneficiario: nombre de la empresa/comercio a quien se hizo el pago (proveedor,
-- servicio publico, comercio, etc). Texto libre porque no siempre corresponde a
-- un proveedor registrado en la tabla proveedores (ej. peaje, farmacia ocasional).
--
-- metodo_pago: como se realizo el pago (efectivo/transferencia/tarjeta). Mismo
-- enum que se usa en ventas.metodo_pago (create-venta-pg.ts).
--
-- Ambos NULL por retro-compatibilidad: gastos ya cargados sin estos datos siguen
-- siendo validos. Solo aplica al schema `reservacaacupe`. Idempotente.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'gastos'
      AND c.relkind = 'r'
      AND n.nspname = 'reservacaacupe'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.gastos ADD COLUMN IF NOT EXISTS beneficiario text',
      r.sch
    );
    EXECUTE format(
      'ALTER TABLE %I.gastos ADD COLUMN IF NOT EXISTS metodo_pago text',
      r.sch
    );

    -- CHECK opcional: si metodo_pago tiene valor, tiene que ser uno de los 3
    -- validos. NULL sigue permitido para retro-compat.
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.gastos ADD CONSTRAINT gastos_metodo_pago_check CHECK (metodo_pago IS NULL OR metodo_pago IN (''efectivo'', ''transferencia'', ''tarjeta''))',
        r.sch
      );
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;

    EXECUTE format(
      'COMMENT ON COLUMN %I.gastos.beneficiario IS ''Nombre de la empresa o comercio al que se efectuo el pago (texto libre; no siempre corresponde a un proveedor registrado).''',
      r.sch
    );
    EXECUTE format(
      'COMMENT ON COLUMN %I.gastos.metodo_pago IS ''Metodo de pago: efectivo | transferencia | tarjeta. NULL si no se registro (gastos historicos).''',
      r.sch
    );
  END LOOP;
END $$;
