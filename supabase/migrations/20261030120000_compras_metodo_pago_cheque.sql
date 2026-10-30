-- Compras: nuevo método de pago "cheque" + número de cheque.
--  1) Amplía el CHECK de metodo_pago para aceptar 'cheque'.
--  2) Agrega la columna cheque_numero (text, nullable) para guardar la
--     numeración del cheque cuando el método es 'cheque'.
--
-- Solo schema reservacaacupe. Idempotente. No toca montos, stock ni CxP.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'reservacaacupe') THEN
    RETURN;
  END IF;

  -- 1) Ampliar CHECK de metodo_pago (incluye 'cheque').
  ALTER TABLE reservacaacupe.compras
    DROP CONSTRAINT IF EXISTS compras_metodo_pago_check;
  ALTER TABLE reservacaacupe.compras
    ADD CONSTRAINT compras_metodo_pago_check
    CHECK (
      metodo_pago IS NULL
      OR metodo_pago = ANY (ARRAY['efectivo'::text, 'transferencia'::text, 'tarjeta'::text, 'cheque'::text])
    );

  -- 2) Columna para la numeración del cheque.
  ALTER TABLE reservacaacupe.compras
    ADD COLUMN IF NOT EXISTS cheque_numero text;
END $$;
