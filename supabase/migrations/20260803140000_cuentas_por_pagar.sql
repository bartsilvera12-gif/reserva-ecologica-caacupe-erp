-- ============================================================================
-- Cuentas por pagar a proveedores + pagos a proveedor (aditivo)
-- ============================================================================
--
-- No toca ventas, facturas de venta, SIFEN, cuentas_por_cobrar, ni el alta de
-- compras (el enganche desde compras es best-effort vía SAVEPOINT en el backend,
-- nunca aborta una compra). Solo agrega tablas nuevas, un módulo y RLS.
--
-- Modelo:
--  * 1 cuenta_por_pagar por compra (numero_control). saldo = monto_original
--    - nc_aplicado - pagado, nunca negativo. estado guardado en
--    {pendiente,parcial,pagada,anulada}; 'vencida' se deriva en lectura
--    (saldo>0 y fecha_vencimiento < hoy Asunción) para no depender de un cron.
--  * pagos_proveedor: N pagos por cuenta.
--
-- Genérico para N sucursales/empresas. Ejecutar como supabase_admin.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) cuentas_por_pagar
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservacaacupe.cuentas_por_pagar (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id               uuid NOT NULL REFERENCES reservacaacupe.empresas(id) ON DELETE CASCADE,
  sucursal_id              uuid NOT NULL REFERENCES reservacaacupe.sucursales(id) ON DELETE RESTRICT,
  compra_numero_control    text NOT NULL,
  proveedor_id             uuid,
  proveedor_nombre         text NOT NULL DEFAULT '',
  numero_factura_proveedor text,
  fecha_factura            date,
  fecha_vencimiento        date,
  moneda                   text NOT NULL DEFAULT 'PYG',
  monto_original           numeric NOT NULL DEFAULT 0,
  nc_aplicado              numeric NOT NULL DEFAULT 0,
  pagado                   numeric NOT NULL DEFAULT 0,
  saldo                    numeric NOT NULL DEFAULT 0,
  estado                   text NOT NULL DEFAULT 'pendiente',
  observaciones            text,
  created_by               uuid REFERENCES reservacaacupe.usuarios(id) ON DELETE SET NULL,
  usuario_nombre           text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cxp_compra_uq UNIQUE (empresa_id, compra_numero_control),
  CONSTRAINT cxp_estado_check CHECK (estado = ANY (ARRAY['pendiente','parcial','pagada','anulada'])),
  CONSTRAINT cxp_montos_nonneg CHECK (monto_original >= 0 AND nc_aplicado >= 0 AND pagado >= 0 AND saldo >= 0)
);

CREATE INDEX IF NOT EXISTS idx_cxp_empresa      ON reservacaacupe.cuentas_por_pagar (empresa_id);
CREATE INDEX IF NOT EXISTS idx_cxp_sucursal     ON reservacaacupe.cuentas_por_pagar (sucursal_id);
CREATE INDEX IF NOT EXISTS idx_cxp_proveedor    ON reservacaacupe.cuentas_por_pagar (proveedor_id);
CREATE INDEX IF NOT EXISTS idx_cxp_estado       ON reservacaacupe.cuentas_por_pagar (empresa_id, sucursal_id, estado);
CREATE INDEX IF NOT EXISTS idx_cxp_vencimiento  ON reservacaacupe.cuentas_por_pagar (empresa_id, sucursal_id, fecha_vencimiento)
  WHERE estado <> 'anulada';

DROP TRIGGER IF EXISTS cuentas_por_pagar_updated_at ON reservacaacupe.cuentas_por_pagar;
CREATE TRIGGER cuentas_por_pagar_updated_at
  BEFORE UPDATE ON reservacaacupe.cuentas_por_pagar
  FOR EACH ROW EXECUTE FUNCTION reservacaacupe.set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) pagos_proveedor
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservacaacupe.pagos_proveedor (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id            uuid NOT NULL REFERENCES reservacaacupe.empresas(id) ON DELETE CASCADE,
  sucursal_id           uuid NOT NULL REFERENCES reservacaacupe.sucursales(id) ON DELETE RESTRICT,
  cuenta_por_pagar_id   uuid NOT NULL REFERENCES reservacaacupe.cuentas_por_pagar(id) ON DELETE CASCADE,
  fecha                 date NOT NULL DEFAULT (now() AT TIME ZONE 'America/Asuncion')::date,
  monto                 numeric NOT NULL,
  metodo_pago           text NOT NULL DEFAULT 'efectivo',
  referencia            text,
  comprobante_storage_path text,
  comprobante_nombre       text,
  comprobante_mime_type    text,
  anulado               boolean NOT NULL DEFAULT false,
  created_by            uuid REFERENCES reservacaacupe.usuarios(id) ON DELETE SET NULL,
  usuario_nombre        text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pgp_monto_pos CHECK (monto > 0)
);

CREATE INDEX IF NOT EXISTS idx_pgp_cuenta   ON reservacaacupe.pagos_proveedor (cuenta_por_pagar_id);
CREATE INDEX IF NOT EXISTS idx_pgp_empresa  ON reservacaacupe.pagos_proveedor (empresa_id, sucursal_id);

-- ---------------------------------------------------------------------------
-- 3) RLS por empresa
-- ---------------------------------------------------------------------------
ALTER TABLE reservacaacupe.cuentas_por_pagar ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservacaacupe.pagos_proveedor   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cxp_empresa_isolation ON reservacaacupe.cuentas_por_pagar;
CREATE POLICY cxp_empresa_isolation ON reservacaacupe.cuentas_por_pagar
  USING (empresa_id = reservacaacupe.empresa_id_actual())
  WITH CHECK (empresa_id = reservacaacupe.empresa_id_actual());

DROP POLICY IF EXISTS pgp_empresa_isolation ON reservacaacupe.pagos_proveedor;
CREATE POLICY pgp_empresa_isolation ON reservacaacupe.pagos_proveedor
  USING (empresa_id = reservacaacupe.empresa_id_actual())
  WITH CHECK (empresa_id = reservacaacupe.empresa_id_actual());

-- ---------------------------------------------------------------------------
-- 4) Módulo
-- ---------------------------------------------------------------------------
INSERT INTO reservacaacupe.modulos (slug, nombre)
SELECT 'cuentas_por_pagar', 'Cuentas por pagar'
WHERE NOT EXISTS (SELECT 1 FROM reservacaacupe.modulos WHERE slug = 'cuentas_por_pagar');

INSERT INTO reservacaacupe.empresa_modulos (empresa_id, modulo_id, activo)
SELECT e.id, m.id, true
  FROM reservacaacupe.empresas e
 CROSS JOIN reservacaacupe.modulos m
 WHERE m.slug = 'cuentas_por_pagar'
   AND NOT EXISTS (
     SELECT 1 FROM reservacaacupe.empresa_modulos em
      WHERE em.empresa_id = e.id AND em.modulo_id = m.id
   );

-- ---------------------------------------------------------------------------
-- 5) Verificación
-- ---------------------------------------------------------------------------
DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM information_schema.tables
   WHERE table_schema='reservacaacupe' AND table_name IN ('cuentas_por_pagar','pagos_proveedor');
  IF v <> 2 THEN RAISE EXCEPTION 'ABORT: faltan tablas de cuentas por pagar'; END IF;
  RAISE NOTICE 'Cuentas por pagar OK: tablas + módulo creados';
END $$;

COMMIT;
