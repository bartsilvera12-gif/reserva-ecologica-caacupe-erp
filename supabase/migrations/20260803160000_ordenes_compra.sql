-- ============================================================================
-- Órdenes de compra (OC) — aditivo. Entidad distinta de una compra recibida.
-- ============================================================================
--
-- Crear/emitir una OC NO mueve stock, NO cambia costo, NO crea cuenta por pagar,
-- NO crea movimiento de inventario. Eso ocurre recién en la RECEPCIÓN, que
-- reutiliza la lógica transaccional de compras (compras-pg) en el backend.
--
-- No toca ventas, compras, SIFEN, CxC ni el alta actual de compras. Solo agrega
-- tablas nuevas, un módulo y RLS. Genérico para N sucursales. supabase_admin.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS reservacaacupe.ordenes_compra (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id         uuid NOT NULL REFERENCES reservacaacupe.empresas(id) ON DELETE CASCADE,
  sucursal_id        uuid NOT NULL REFERENCES reservacaacupe.sucursales(id) ON DELETE RESTRICT,
  numero             text NOT NULL,
  proveedor_id       uuid,
  proveedor_nombre   text NOT NULL DEFAULT '',
  moneda             text NOT NULL DEFAULT 'PYG',
  tipo_cambio        numeric NOT NULL DEFAULT 1,
  fecha              timestamptz NOT NULL DEFAULT now(),
  llegada_estimada   date,
  tipo_pago          text NOT NULL DEFAULT 'contado',
  plazo_dias         integer,
  observaciones      text,
  estado             text NOT NULL DEFAULT 'borrador',
  created_by         uuid REFERENCES reservacaacupe.usuarios(id) ON DELETE SET NULL,
  usuario_nombre     text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oc_numero_empresa_uq UNIQUE (empresa_id, numero),
  CONSTRAINT oc_estado_check CHECK (estado = ANY (ARRAY[
    'borrador','emitida','aprobada','parcialmente_recibida','recibida','cancelada'])),
  CONSTRAINT oc_tipo_pago_check CHECK (tipo_pago = ANY (ARRAY['contado','credito']))
);

CREATE INDEX IF NOT EXISTS idx_oc_empresa   ON reservacaacupe.ordenes_compra (empresa_id, sucursal_id);
CREATE INDEX IF NOT EXISTS idx_oc_estado    ON reservacaacupe.ordenes_compra (empresa_id, sucursal_id, estado);
CREATE INDEX IF NOT EXISTS idx_oc_proveedor ON reservacaacupe.ordenes_compra (proveedor_id);

DROP TRIGGER IF EXISTS ordenes_compra_updated_at ON reservacaacupe.ordenes_compra;
CREATE TRIGGER ordenes_compra_updated_at
  BEFORE UPDATE ON reservacaacupe.ordenes_compra
  FOR EACH ROW EXECUTE FUNCTION reservacaacupe.set_updated_at();

CREATE TABLE IF NOT EXISTS reservacaacupe.ordenes_compra_items (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  orden_compra_id     uuid NOT NULL REFERENCES reservacaacupe.ordenes_compra(id) ON DELETE CASCADE,
  empresa_id          uuid NOT NULL REFERENCES reservacaacupe.empresas(id) ON DELETE CASCADE,
  producto_id         uuid REFERENCES reservacaacupe.productos(id) ON DELETE RESTRICT,
  producto_nombre     text NOT NULL DEFAULT '',
  sku_snapshot        text,
  descripcion         text,
  cantidad_solicitada numeric NOT NULL,
  cantidad_recibida   numeric NOT NULL DEFAULT 0,
  costo_estimado      numeric NOT NULL DEFAULT 0,
  iva_tipo            text NOT NULL DEFAULT '10',
  subtotal            numeric NOT NULL DEFAULT 0,
  total               numeric NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT oci_cant_solicitada_pos CHECK (cantidad_solicitada > 0),
  CONSTRAINT oci_cant_recibida_nonneg CHECK (cantidad_recibida >= 0),
  CONSTRAINT oci_producto_uq UNIQUE (orden_compra_id, producto_id)
);

CREATE INDEX IF NOT EXISTS idx_oci_orden ON reservacaacupe.ordenes_compra_items (orden_compra_id);
CREATE INDEX IF NOT EXISTS idx_oci_prod  ON reservacaacupe.ordenes_compra_items (producto_id);

DROP TRIGGER IF EXISTS ordenes_compra_items_updated_at ON reservacaacupe.ordenes_compra_items;
CREATE TRIGGER ordenes_compra_items_updated_at
  BEFORE UPDATE ON reservacaacupe.ordenes_compra_items
  FOR EACH ROW EXECUTE FUNCTION reservacaacupe.set_updated_at();

ALTER TABLE reservacaacupe.ordenes_compra       ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservacaacupe.ordenes_compra_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS oc_empresa_isolation ON reservacaacupe.ordenes_compra;
CREATE POLICY oc_empresa_isolation ON reservacaacupe.ordenes_compra
  USING (empresa_id = reservacaacupe.empresa_id_actual())
  WITH CHECK (empresa_id = reservacaacupe.empresa_id_actual());

DROP POLICY IF EXISTS oci_empresa_isolation ON reservacaacupe.ordenes_compra_items;
CREATE POLICY oci_empresa_isolation ON reservacaacupe.ordenes_compra_items
  USING (empresa_id = reservacaacupe.empresa_id_actual())
  WITH CHECK (empresa_id = reservacaacupe.empresa_id_actual());

INSERT INTO reservacaacupe.modulos (slug, nombre)
SELECT 'ordenes_compra', 'Órdenes de compra'
WHERE NOT EXISTS (SELECT 1 FROM reservacaacupe.modulos WHERE slug = 'ordenes_compra');

INSERT INTO reservacaacupe.empresa_modulos (empresa_id, modulo_id, activo)
SELECT e.id, m.id, true
  FROM reservacaacupe.empresas e
 CROSS JOIN reservacaacupe.modulos m
 WHERE m.slug = 'ordenes_compra'
   AND NOT EXISTS (SELECT 1 FROM reservacaacupe.empresa_modulos em WHERE em.empresa_id = e.id AND em.modulo_id = m.id);

DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM information_schema.tables
   WHERE table_schema='reservacaacupe' AND table_name IN ('ordenes_compra','ordenes_compra_items');
  IF v <> 2 THEN RAISE EXCEPTION 'ABORT: faltan tablas de órdenes de compra'; END IF;
  RAISE NOTICE 'Órdenes de compra OK: tablas + módulo creados';
END $$;

COMMIT;
