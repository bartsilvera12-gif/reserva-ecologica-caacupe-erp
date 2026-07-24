-- ============================================================================
-- Recibo de dinero con detalle de facturas cobradas
-- ============================================================================
--
-- Aditivo. El recibo es un documento INTERNO NO FISCAL: no toca SIFEN, ni la
-- numeración fiscal, ni las facturas. Solo deja constancia del dinero recibido.
--
-- Cambios:
--  1. `recibos_dinero_items`: una fila por factura/cuenta cobrada, para que un
--     mismo pago pueda cubrir VARIAS facturas (caso real del cliente).
--  2. La serie REC-XXXXXX pasa a ser POR SUCURSAL, igual que los otros
--     correlativos del sistema (VTA, NR, FAC, PRE, COMP, NC y el de
--     suscripciones). Sin esto las dos sucursales compartirían numeración.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Ítems del recibo
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservacaacupe.recibos_dinero_items (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  recibo_id             uuid NOT NULL REFERENCES reservacaacupe.recibos_dinero(id) ON DELETE CASCADE,
  empresa_id            uuid NOT NULL REFERENCES reservacaacupe.empresas(id) ON DELETE CASCADE,
  cuenta_por_cobrar_id  uuid REFERENCES reservacaacupe.cuentas_por_cobrar(id) ON DELETE RESTRICT,
  -- Cobro concreto que generó esta línea. Único: impide emitir dos recibos por
  -- el mismo cobro (equivalente al uq_recibos_cobro del modelo de una factura).
  cobro_cliente_id      uuid REFERENCES reservacaacupe.cobros_clientes(id) ON DELETE RESTRICT,
  factura_id            uuid REFERENCES reservacaacupe.facturas(id) ON DELETE SET NULL,
  -- Snapshots para que el PDF no dependa de joins ni cambie si el origen cambia.
  numero_documento      text,
  fecha_vencimiento     date,
  importe_aplicado      numeric NOT NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT recibo_item_importe_pos CHECK (importe_aplicado > 0)
);

CREATE INDEX IF NOT EXISTS idx_recibo_item_recibo ON reservacaacupe.recibos_dinero_items (recibo_id);
CREATE INDEX IF NOT EXISTS idx_recibo_item_cxc    ON reservacaacupe.recibos_dinero_items (cuenta_por_cobrar_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_recibo_item_cobro
  ON reservacaacupe.recibos_dinero_items (cobro_cliente_id) WHERE cobro_cliente_id IS NOT NULL;

ALTER TABLE reservacaacupe.recibos_dinero_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS recibo_items_empresa_isolation ON reservacaacupe.recibos_dinero_items;
CREATE POLICY recibo_items_empresa_isolation ON reservacaacupe.recibos_dinero_items
  USING (empresa_id = reservacaacupe.empresa_id_actual())
  WITH CHECK (empresa_id = reservacaacupe.empresa_id_actual());

-- ---------------------------------------------------------------------------
-- 2) Serie REC-XXXXXX por sucursal
-- ---------------------------------------------------------------------------
-- Igual que se hizo con los demás correlativos: el único pasa a incluir la
-- sucursal, así cada una arranca su propia serie en REC-000001.
-- Es seguro: la tabla está vacía (0 recibos emitidos hasta hoy).
DROP INDEX IF EXISTS reservacaacupe.uq_recibos_empresa_numero;
CREATE UNIQUE INDEX uq_recibos_empresa_sucursal_numero
  ON reservacaacupe.recibos_dinero (empresa_id, sucursal_id, numero_recibo);

-- ---------------------------------------------------------------------------
-- 3) Verificación
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_tab int; v_idx int;
BEGIN
  SELECT count(*) INTO v_tab FROM information_schema.tables
   WHERE table_schema='reservacaacupe' AND table_name='recibos_dinero_items';
  IF v_tab <> 1 THEN RAISE EXCEPTION 'ABORT: no se creó recibos_dinero_items'; END IF;

  SELECT count(*) INTO v_idx FROM pg_indexes
   WHERE schemaname='reservacaacupe' AND indexname='uq_recibos_empresa_sucursal_numero';
  IF v_idx <> 1 THEN RAISE EXCEPTION 'ABORT: no se creó el único por sucursal'; END IF;

  RAISE NOTICE 'Recibos OK: items creados, serie REC por sucursal';
END $$;

COMMIT;
