-- ============================================================================
-- Módulo Reposición y Transferencias entre sucursales
-- ============================================================================
--
-- Aditivo. No toca ventas, compras, facturas, SIFEN, CxC ni contabilidad.
-- Solo agrega tablas nuevas, dos valores al CHECK de origen de
-- movimientos_inventario, y un módulo nuevo.
--
-- DECISIONES (auditoría):
--  * inventario_stock_ubicacion está VACÍA (0 filas): el sistema no mantiene
--    stock por ubicación. La transferencia opera solo sobre productos.stock_actual,
--    igual que Compras. No se toca esa tabla → no se crea estado contradictorio.
--  * Los movimientos se enlazan a la transferencia por `referencia = TRF-XXXXXX`.
--  * Idempotencia por máquina de estados + FOR UPDATE en el backend, no acá.
--
-- Genérico para N sucursales: no hardcodea IDs, códigos ni nombres.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Ampliar el CHECK de origen de movimientos_inventario
-- ---------------------------------------------------------------------------
-- Se recrea preservando los 7 valores existentes (verificados contra los datos:
-- compra, venta, ajuste_manual, inventario_inicial, anulacion_venta,
-- anulacion_compra, produccion) y se agregan los dos de transferencia.
ALTER TABLE reservacaacupe.movimientos_inventario
  DROP CONSTRAINT IF EXISTS movimientos_inventario_origen_check;
ALTER TABLE reservacaacupe.movimientos_inventario
  ADD CONSTRAINT movimientos_inventario_origen_check CHECK (
    origen = ANY (ARRAY[
      'compra','venta','ajuste_manual','inventario_inicial',
      'anulacion_venta','anulacion_compra','produccion',
      'transferencia_salida','transferencia_entrada'
    ])
  );

-- ---------------------------------------------------------------------------
-- 2) transferencias_inventario (cabecera)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservacaacupe.transferencias_inventario (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id            uuid NOT NULL REFERENCES reservacaacupe.empresas(id) ON DELETE CASCADE,
  numero                text NOT NULL,
  sucursal_origen_id    uuid NOT NULL REFERENCES reservacaacupe.sucursales(id) ON DELETE RESTRICT,
  sucursal_destino_id   uuid NOT NULL REFERENCES reservacaacupe.sucursales(id) ON DELETE RESTRICT,
  estado                text NOT NULL DEFAULT 'pendiente',
  observacion_solicitud text,
  motivo_rechazo        text,
  solicitada_por        uuid REFERENCES reservacaacupe.usuarios(id) ON DELETE SET NULL,
  aprobada_por          uuid REFERENCES reservacaacupe.usuarios(id) ON DELETE SET NULL,
  despachada_por        uuid REFERENCES reservacaacupe.usuarios(id) ON DELETE SET NULL,
  recibida_por          uuid REFERENCES reservacaacupe.usuarios(id) ON DELETE SET NULL,
  solicitada_at         timestamptz NOT NULL DEFAULT now(),
  aprobada_at           timestamptz,
  rechazada_at          timestamptz,
  despachada_at         timestamptz,
  recibida_at           timestamptz,
  cancelada_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transferencias_numero_empresa_uq UNIQUE (empresa_id, numero),
  CONSTRAINT transferencias_estado_check CHECK (
    estado = ANY (ARRAY['pendiente','aprobada','rechazada','despachada','recibida','cancelada'])
  ),
  -- Origen y destino no pueden ser la misma sucursal.
  CONSTRAINT transferencias_origen_distinto_destino CHECK (sucursal_origen_id <> sucursal_destino_id)
);

CREATE INDEX IF NOT EXISTS idx_transf_empresa        ON reservacaacupe.transferencias_inventario (empresa_id);
CREATE INDEX IF NOT EXISTS idx_transf_origen         ON reservacaacupe.transferencias_inventario (sucursal_origen_id);
CREATE INDEX IF NOT EXISTS idx_transf_destino        ON reservacaacupe.transferencias_inventario (sucursal_destino_id);
CREATE INDEX IF NOT EXISTS idx_transf_estado         ON reservacaacupe.transferencias_inventario (empresa_id, estado);

DROP TRIGGER IF EXISTS transferencias_inventario_updated_at ON reservacaacupe.transferencias_inventario;
CREATE TRIGGER transferencias_inventario_updated_at
  BEFORE UPDATE ON reservacaacupe.transferencias_inventario
  FOR EACH ROW EXECUTE FUNCTION reservacaacupe.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3) transferencias_inventario_items (líneas)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservacaacupe.transferencias_inventario_items (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transferencia_id            uuid NOT NULL REFERENCES reservacaacupe.transferencias_inventario(id) ON DELETE CASCADE,
  empresa_id                  uuid NOT NULL REFERENCES reservacaacupe.empresas(id) ON DELETE CASCADE,
  -- La solicitud nace con el producto de la sucursal DESTINO (la que pide).
  producto_destino_id         uuid NOT NULL REFERENCES reservacaacupe.productos(id) ON DELETE RESTRICT,
  -- Equivalente en la sucursal ORIGEN (mismo SKU). Nullable hasta resolverse.
  producto_origen_id          uuid REFERENCES reservacaacupe.productos(id) ON DELETE RESTRICT,
  sku_snapshot                text,
  nombre_snapshot             text,
  unidad_snapshot             text,
  cantidad_solicitada         numeric NOT NULL,
  cantidad_aprobada           numeric NOT NULL DEFAULT 0,
  cantidad_despachada         numeric NOT NULL DEFAULT 0,
  cantidad_recibida           numeric NOT NULL DEFAULT 0,
  costo_unitario_transferencia numeric NOT NULL DEFAULT 0,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT transf_item_cant_solicitada_pos  CHECK (cantidad_solicitada > 0),
  CONSTRAINT transf_item_cant_aprobada_nonneg CHECK (cantidad_aprobada >= 0),
  CONSTRAINT transf_item_cant_despachada_nonneg CHECK (cantidad_despachada >= 0),
  CONSTRAINT transf_item_cant_recibida_nonneg CHECK (cantidad_recibida >= 0),
  CONSTRAINT transf_item_costo_nonneg         CHECK (costo_unitario_transferencia >= 0),
  -- La aprobada nunca supera la solicitada.
  CONSTRAINT transf_item_aprobada_le_solicitada CHECK (cantidad_aprobada <= cantidad_solicitada),
  -- Un producto destino no se repite en la misma transferencia.
  CONSTRAINT transf_item_producto_uq UNIQUE (transferencia_id, producto_destino_id)
);

CREATE INDEX IF NOT EXISTS idx_transf_item_transf   ON reservacaacupe.transferencias_inventario_items (transferencia_id);
CREATE INDEX IF NOT EXISTS idx_transf_item_prod_dst ON reservacaacupe.transferencias_inventario_items (producto_destino_id);
CREATE INDEX IF NOT EXISTS idx_transf_item_prod_org ON reservacaacupe.transferencias_inventario_items (producto_origen_id);

DROP TRIGGER IF EXISTS transferencias_items_updated_at ON reservacaacupe.transferencias_inventario_items;
CREATE TRIGGER transferencias_items_updated_at
  BEFORE UPDATE ON reservacaacupe.transferencias_inventario_items
  FOR EACH ROW EXECUTE FUNCTION reservacaacupe.set_updated_at();

-- ---------------------------------------------------------------------------
-- 4) RLS por empresa (defensa en profundidad; el service role la saltea igual)
-- ---------------------------------------------------------------------------
ALTER TABLE reservacaacupe.transferencias_inventario       ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservacaacupe.transferencias_inventario_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS transf_empresa_isolation ON reservacaacupe.transferencias_inventario;
CREATE POLICY transf_empresa_isolation ON reservacaacupe.transferencias_inventario
  USING (empresa_id = reservacaacupe.empresa_id_actual())
  WITH CHECK (empresa_id = reservacaacupe.empresa_id_actual());

DROP POLICY IF EXISTS transf_items_empresa_isolation ON reservacaacupe.transferencias_inventario_items;
CREATE POLICY transf_items_empresa_isolation ON reservacaacupe.transferencias_inventario_items
  USING (empresa_id = reservacaacupe.empresa_id_actual())
  WITH CHECK (empresa_id = reservacaacupe.empresa_id_actual());

-- ---------------------------------------------------------------------------
-- 5) Módulo nuevo: acceso acotado sin dar el Inventario completo
-- ---------------------------------------------------------------------------
INSERT INTO reservacaacupe.modulos (slug, nombre)
SELECT 'reposicion', 'Reposición entre sucursales'
WHERE NOT EXISTS (SELECT 1 FROM reservacaacupe.modulos WHERE slug = 'reposicion');

-- Activar el módulo para todas las empresas del schema.
INSERT INTO reservacaacupe.empresa_modulos (empresa_id, modulo_id, activo)
SELECT e.id, m.id, true
  FROM reservacaacupe.empresas e
 CROSS JOIN reservacaacupe.modulos m
 WHERE m.slug = 'reposicion'
   AND NOT EXISTS (
     SELECT 1 FROM reservacaacupe.empresa_modulos em
      WHERE em.empresa_id = e.id AND em.modulo_id = m.id
   );

-- Darlo al rol `usuario` (que trabaja por usuario_modulos). Admin/administrador
-- lo ven solo → todos los módulos activos de la empresa. Supervisor y usuario
-- van por usuario_modulos, así que se les asigna explícitamente.
INSERT INTO reservacaacupe.usuario_modulos (usuario_id, modulo_id)
SELECT u.id, m.id
  FROM reservacaacupe.usuarios u
 CROSS JOIN reservacaacupe.modulos m
 WHERE m.slug = 'reposicion'
   AND lower(coalesce(u.rol,'')) IN ('usuario','supervisor')
   AND NOT EXISTS (
     SELECT 1 FROM reservacaacupe.usuario_modulos um
      WHERE um.usuario_id = u.id AND um.modulo_id = m.id
   );

-- ---------------------------------------------------------------------------
-- 6) Verificación
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_chk text; v_mod int;
BEGIN
  SELECT pg_get_constraintdef(con.oid) INTO v_chk
    FROM pg_constraint con JOIN pg_class t ON t.oid=con.conrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace
   WHERE n.nspname='reservacaacupe' AND t.relname='movimientos_inventario'
     AND con.conname='movimientos_inventario_origen_check';
  IF v_chk NOT LIKE '%transferencia_salida%' OR v_chk NOT LIKE '%produccion%' THEN
    RAISE EXCEPTION 'ABORT: el CHECK de origen no quedó con todos los valores: %', v_chk;
  END IF;

  SELECT count(*) INTO v_mod FROM reservacaacupe.modulos WHERE slug='reposicion';
  IF v_mod <> 1 THEN RAISE EXCEPTION 'ABORT: módulo reposicion no quedó creado'; END IF;

  RAISE NOTICE 'Transferencias OK: CHECK ampliado, tablas creadas, módulo reposicion activo';
END $$;

COMMIT;
