-- ============================================================================
-- Caja por sucursal (turno + arqueo) — aditivo
-- ============================================================================
--
-- Restricción CLAVE: una caja abierta POR SUCURSAL (no por empresa). Cada
-- sucursal abre su turno sin bloquear a la otra.
--
-- El arqueo se calcula por VENTANA DE TIEMPO (sucursal + [abierta_at, cierre]),
-- así NO hace falta tocar el alta de ventas ni de cobros (flujos críticos que
-- siguen intactos). Se agrega ventas.caja_id (nullable) para vínculo futuro, sin
-- exigirlo. Ventas históricas sin caja_id siguen funcionando.
--
-- No toca SIFEN, facturas, CxC ni el POS. supabase_admin.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS reservacaacupe.cajas (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id           uuid NOT NULL REFERENCES reservacaacupe.empresas(id) ON DELETE CASCADE,
  sucursal_id          uuid NOT NULL REFERENCES reservacaacupe.sucursales(id) ON DELETE RESTRICT,
  numero_caja          integer NOT NULL DEFAULT 1,
  estado               text NOT NULL DEFAULT 'abierta',
  monto_apertura       numeric NOT NULL DEFAULT 0,
  efectivo_esperado    numeric,
  efectivo_contado     numeric,
  diferencia           numeric,
  observacion_apertura text,
  observacion_cierre   text,
  abierta_por          uuid REFERENCES reservacaacupe.usuarios(id) ON DELETE SET NULL,
  abierta_por_nombre   text,
  cerrada_por          uuid REFERENCES reservacaacupe.usuarios(id) ON DELETE SET NULL,
  cerrada_por_nombre   text,
  abierta_at           timestamptz NOT NULL DEFAULT now(),
  cerrada_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cajas_estado_check CHECK (estado = ANY (ARRAY['abierta','cerrada'])),
  CONSTRAINT cajas_apertura_nonneg CHECK (monto_apertura >= 0)
);

-- UNA sola caja abierta por sucursal (NO por empresa).
CREATE UNIQUE INDEX IF NOT EXISTS cajas_una_abierta_por_sucursal
  ON reservacaacupe.cajas (empresa_id, sucursal_id, numero_caja)
  WHERE estado = 'abierta';

CREATE INDEX IF NOT EXISTS idx_cajas_sucursal ON reservacaacupe.cajas (empresa_id, sucursal_id, estado);
CREATE INDEX IF NOT EXISTS idx_cajas_abierta_at ON reservacaacupe.cajas (empresa_id, sucursal_id, abierta_at);

DROP TRIGGER IF EXISTS cajas_updated_at ON reservacaacupe.cajas;
CREATE TRIGGER cajas_updated_at BEFORE UPDATE ON reservacaacupe.cajas
  FOR EACH ROW EXECUTE FUNCTION reservacaacupe.set_updated_at();

CREATE TABLE IF NOT EXISTS reservacaacupe.caja_movimientos (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    uuid NOT NULL REFERENCES reservacaacupe.empresas(id) ON DELETE CASCADE,
  sucursal_id   uuid NOT NULL REFERENCES reservacaacupe.sucursales(id) ON DELETE RESTRICT,
  caja_id       uuid NOT NULL REFERENCES reservacaacupe.cajas(id) ON DELETE CASCADE,
  tipo          text NOT NULL,
  concepto      text,
  monto         numeric NOT NULL,
  metodo_pago   text NOT NULL DEFAULT 'efectivo',
  origen        text NOT NULL DEFAULT 'manual',
  referencia    text,
  created_by    uuid REFERENCES reservacaacupe.usuarios(id) ON DELETE SET NULL,
  usuario_nombre text,
  fecha         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cajamov_tipo_check CHECK (tipo = ANY (ARRAY['ingreso','egreso','retiro','ajuste'])),
  CONSTRAINT cajamov_monto_pos CHECK (monto > 0)
);

CREATE INDEX IF NOT EXISTS idx_cajamov_caja ON reservacaacupe.caja_movimientos (caja_id);
CREATE INDEX IF NOT EXISTS idx_cajamov_suc  ON reservacaacupe.caja_movimientos (empresa_id, sucursal_id);

-- Vínculo opcional venta→caja (aditivo, nullable). El arqueo NO depende de esto.
ALTER TABLE reservacaacupe.ventas
  ADD COLUMN IF NOT EXISTS caja_id uuid REFERENCES reservacaacupe.cajas(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ventas_caja ON reservacaacupe.ventas (caja_id) WHERE caja_id IS NOT NULL;

ALTER TABLE reservacaacupe.cajas            ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservacaacupe.caja_movimientos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cajas_empresa_isolation ON reservacaacupe.cajas;
CREATE POLICY cajas_empresa_isolation ON reservacaacupe.cajas
  USING (empresa_id = reservacaacupe.empresa_id_actual())
  WITH CHECK (empresa_id = reservacaacupe.empresa_id_actual());

DROP POLICY IF EXISTS cajamov_empresa_isolation ON reservacaacupe.caja_movimientos;
CREATE POLICY cajamov_empresa_isolation ON reservacaacupe.caja_movimientos
  USING (empresa_id = reservacaacupe.empresa_id_actual())
  WITH CHECK (empresa_id = reservacaacupe.empresa_id_actual());

INSERT INTO reservacaacupe.modulos (slug, nombre)
SELECT 'caja', 'Caja'
WHERE NOT EXISTS (SELECT 1 FROM reservacaacupe.modulos WHERE slug = 'caja');

INSERT INTO reservacaacupe.empresa_modulos (empresa_id, modulo_id, activo)
SELECT e.id, m.id, true
  FROM reservacaacupe.empresas e
 CROSS JOIN reservacaacupe.modulos m
 WHERE m.slug = 'caja'
   AND NOT EXISTS (SELECT 1 FROM reservacaacupe.empresa_modulos em WHERE em.empresa_id = e.id AND em.modulo_id = m.id);

DO $$
DECLARE v int;
BEGIN
  SELECT count(*) INTO v FROM information_schema.tables
   WHERE table_schema='reservacaacupe' AND table_name IN ('cajas','caja_movimientos');
  IF v <> 2 THEN RAISE EXCEPTION 'ABORT: faltan tablas de caja'; END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='reservacaacupe' AND table_name='ventas' AND column_name='caja_id') THEN
    RAISE EXCEPTION 'ABORT: no se creó ventas.caja_id';
  END IF;
  RAISE NOTICE 'Caja OK: tablas + ventas.caja_id + módulo';
END $$;

COMMIT;
