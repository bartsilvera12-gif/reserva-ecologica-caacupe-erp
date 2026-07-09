-- Compras: agregar fecha_factura y metodo_pago (pedido del cliente).
--
-- fecha_factura: fecha del comprobante fiscal del proveedor (la factura que
-- nos emitieron). Es distinta a `fecha` (que es cuando se registro la compra
-- en el sistema) porque a veces el comprobante llega dias o semanas despues
-- y se carga a posteriori. Nullable por retro-compat.
--
-- metodo_pago: como se pago (efectivo/transferencia/tarjeta). Es distinto al
-- `tipo_pago` existente (contado/credito), que define si se paga al momento
-- o a plazos. Ambos coexisten: se puede tener tipo_pago='contado' +
-- metodo_pago='transferencia', o tipo_pago='credito' + metodo_pago='efectivo'
-- (cuando llegue el vencimiento).
--
-- Solo aplica al schema reservacaacupe. Idempotente.

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
    EXECUTE format(
      'ALTER TABLE %I.compras ADD COLUMN IF NOT EXISTS fecha_factura date',
      r.sch
    );
    EXECUTE format(
      'ALTER TABLE %I.compras ADD COLUMN IF NOT EXISTS metodo_pago text',
      r.sch
    );

    -- CHECK opcional para metodo_pago (NULL permitido para retro-compat).
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.compras ADD CONSTRAINT compras_metodo_pago_check CHECK (metodo_pago IS NULL OR metodo_pago IN (''efectivo'', ''transferencia'', ''tarjeta''))',
        r.sch
      );
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;

    EXECUTE format(
      'COMMENT ON COLUMN %I.compras.fecha_factura IS ''Fecha del comprobante fiscal del proveedor (la factura que nos emitieron). Distinta a `fecha`, que es la fecha de registro en el sistema. Nullable.''',
      r.sch
    );
    EXECUTE format(
      'COMMENT ON COLUMN %I.compras.metodo_pago IS ''Como se pago: efectivo / transferencia / tarjeta. Distinto al tipo_pago (contado/credito) que define plazo. NULL si no se registro (compras historicas).''',
      r.sch
    );
  END LOOP;
END $$;
