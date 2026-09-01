-- Modelo de "NC aplicable" — permite que el operador use una nota de crédito
-- aprobada como línea negativa en el cobro de una o más facturas del cliente.
--
-- Contexto: "aprobada por SET" (evento fiscal) ≠ "aplicada al cobro" (decisión
-- operativa). Hasta ahora el sistema no modelaba la aplicación al cobro: las
-- NC quedaban en `nota_credito` con `estado_erp = aprobada` pero no había
-- forma de decir "usá esta NC de Gs. 112.400 para cubrir parte del pago de
-- hoy". El comprobante del cliente (Herrero Group) ya trabaja así: lista las
-- facturas positivas + NC negativas y suma el neto.
--
-- Solo schema reservacaacupe. Idempotente. No toca SIFEN.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'reservacaacupe') THEN
    RETURN;
  END IF;

  -- 1) nota_credito.saldo_disponible = cuánto queda para aplicar de esa NC.
  --    Arranca en `monto` para las aprobadas activas; 0 para las anuladas/
  --    borrador/rechazadas. Baja al aplicar en un cobro y se restaura al
  --    anular ese cobro.
  ALTER TABLE reservacaacupe.nota_credito
    ADD COLUMN IF NOT EXISTS saldo_disponible numeric NOT NULL DEFAULT 0;

  -- Backfill idempotente: las NC aprobadas arrancan con TODO su monto
  -- disponible. El operador manualmente aplicará lo que corresponda contra
  -- los saldos históricos.
  UPDATE reservacaacupe.nota_credito
     SET saldo_disponible = monto
   WHERE estado_erp = 'aprobada'
     AND saldo_disponible = 0
     AND monto > 0;

  -- 2) nota_credito_aplicaciones — registro de cada aplicación de NC contra
  --    un cobro. Permite auditar y revertir (al anular recibo).
  CREATE TABLE IF NOT EXISTS reservacaacupe.nota_credito_aplicaciones (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id              uuid NOT NULL,
    sucursal_id             uuid,
    nota_credito_id         uuid NOT NULL REFERENCES reservacaacupe.nota_credito(id) ON DELETE RESTRICT,
    -- CxC contra la que se descontó (una NC puede aplicarse a cualquier CxC
    -- del mismo cliente, no necesariamente a la factura origen).
    cuenta_por_cobrar_id    uuid NOT NULL REFERENCES reservacaacupe.cuentas_por_cobrar(id) ON DELETE RESTRICT,
    -- Vinculo al recibo/cobro donde se registró (para revertir al anular).
    recibo_id               uuid REFERENCES reservacaacupe.recibos_dinero(id) ON DELETE SET NULL,
    cobro_cliente_id        uuid REFERENCES reservacaacupe.cobros_clientes(id) ON DELETE SET NULL,
    importe_aplicado        numeric NOT NULL CHECK (importe_aplicado > 0),
    anulado                 boolean NOT NULL DEFAULT false,
    anulado_at              timestamptz,
    anulado_by_user_id      uuid,
    anulado_motivo          text,
    usuario_id              uuid,
    usuario_nombre          text,
    created_at              timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS idx_nc_aplic_empresa
    ON reservacaacupe.nota_credito_aplicaciones (empresa_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_nc_aplic_nc
    ON reservacaacupe.nota_credito_aplicaciones (nota_credito_id);
  CREATE INDEX IF NOT EXISTS idx_nc_aplic_recibo
    ON reservacaacupe.nota_credito_aplicaciones (recibo_id)
    WHERE recibo_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_nc_aplic_cxc
    ON reservacaacupe.nota_credito_aplicaciones (cuenta_por_cobrar_id);

  -- RLS: aislar por empresa como el resto de tablas del tenant.
  ALTER TABLE reservacaacupe.nota_credito_aplicaciones ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS nc_aplic_empresa_isolation ON reservacaacupe.nota_credito_aplicaciones;
  CREATE POLICY nc_aplic_empresa_isolation
    ON reservacaacupe.nota_credito_aplicaciones
    USING (empresa_id = current_setting('app.empresa_id', true)::uuid);

END $$;
