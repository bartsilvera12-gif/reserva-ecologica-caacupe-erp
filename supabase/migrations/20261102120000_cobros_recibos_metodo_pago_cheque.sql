-- Cobranzas / Recibos: nuevo método de pago "cheque" con número y fecha de cobro.
--   1) Agrega columnas cheque_numero (text) y cheque_fecha_cobro (date) a
--      reservacaacupe.cobros_clientes y reservacaacupe.recibos_dinero.
--   2) Son nullable: no afecta a registros existentes. No se tocan CHECK ni RLS.
--      La fecha de cobro del cheque es independiente de la fecha del recibo
--      (recibos_dinero.fecha), según pedido del cliente.
--
-- Solo schema reservacaacupe. Idempotente. No toca montos, saldos ni estados.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'reservacaacupe') THEN
    RETURN;
  END IF;

  ALTER TABLE reservacaacupe.cobros_clientes
    ADD COLUMN IF NOT EXISTS cheque_numero       text,
    ADD COLUMN IF NOT EXISTS cheque_fecha_cobro  date;

  ALTER TABLE reservacaacupe.recibos_dinero
    ADD COLUMN IF NOT EXISTS cheque_numero       text,
    ADD COLUMN IF NOT EXISTS cheque_fecha_cobro  date;
END $$;
