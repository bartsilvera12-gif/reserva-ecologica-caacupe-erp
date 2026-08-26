-- Anulación de recibos de dinero (documento INTERNO NO FISCAL).
-- Solo schema reservacaacupe. Idempotente. No toca SIFEN.
--
-- Al anular un recibo:
--   1. Se marcan los cobros_clientes que ese recibo agrupa como anulado=true.
--   2. Se restaura el saldo de las cuentas_por_cobrar afectadas (el UPDATE
--      transaccional vive en lib/recibos/server/anular-recibo-pg.ts).
--   3. Se marca recibos_dinero.anulado=true con motivo/usuario/timestamp.
--
-- Solo agrega columnas de auditoria — la lógica queda en la app.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'reservacaacupe') THEN

    -- recibos_dinero: metadata de anulación
    ALTER TABLE reservacaacupe.recibos_dinero
      ADD COLUMN IF NOT EXISTS anulado_at         timestamptz,
      ADD COLUMN IF NOT EXISTS anulado_by_user_id uuid,
      ADD COLUMN IF NOT EXISTS anulado_by_nombre  text,
      ADD COLUMN IF NOT EXISTS anulado_motivo     text;

    -- cobros_clientes: flag y metadata equivalentes. Cuando el cobro fue
    -- registrado por un recibo agrupado, al anular el recibo se anula
    -- también este movimiento.
    ALTER TABLE reservacaacupe.cobros_clientes
      ADD COLUMN IF NOT EXISTS anulado           boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS anulado_at        timestamptz,
      ADD COLUMN IF NOT EXISTS anulado_by_user_id uuid,
      ADD COLUMN IF NOT EXISTS anulado_motivo    text,
      ADD COLUMN IF NOT EXISTS recibo_id         uuid REFERENCES reservacaacupe.recibos_dinero(id) ON DELETE SET NULL;

    -- Índice parcial: consultas típicas filtran los NO anulados.
    CREATE INDEX IF NOT EXISTS idx_cobros_no_anulados
      ON reservacaacupe.cobros_clientes (empresa_id, fecha_pago DESC)
      WHERE anulado = false;

    -- Índice para poder traer los cobros de un recibo rápidamente
    -- (necesario en el flujo de anulación transaccional).
    CREATE INDEX IF NOT EXISTS idx_cobros_recibo
      ON reservacaacupe.cobros_clientes (recibo_id)
      WHERE recibo_id IS NOT NULL;

  END IF;
END $$;
