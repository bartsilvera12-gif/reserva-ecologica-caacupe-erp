-- ============================================================================
-- Notas de crédito de PROVEEDOR (lado compra) — documental + devolución de stock
-- ============================================================================
--
-- Aditivo. No toca ventas, facturas de venta, SIFEN, notas de crédito de venta,
-- ni el (inexistente) libro de cuentas por pagar. Solo agrega tablas nuevas, un
-- valor al CHECK de origen de movimientos_inventario, y un módulo nuevo.
--
-- QUÉ ES: el proveedor te emite una NC (vos solo la REGISTRÁS, no se emite a
-- SIFEN). Documenta una devolución de mercadería o un descuento/bonificación.
--   * tipo = 'devolucion' -> descuenta stock de los productos devueltos y deja
--     un movimiento SALIDA (origen='nota_credito_compra') auditable.
--   * tipo = 'descuento'  -> puramente documental/fiscal: NO toca stock.
-- Siempre se vincula a una compra ya registrada (compras.numero_control).
--
-- QUÉ NO HACE (fuera de alcance, decidido con el cliente):
--   * No mantiene saldo de deuda al proveedor (no hay cuentas_por_pagar).
--   * No revierte costo_promedio ni precio_venta (igual criterio que anular compra).
--
-- Genérico para N sucursales/empresas: no hardcodea IDs, códigos ni nombres.
-- Todo en una transacción: si algo no cuadra, aborta y no queda a medias.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Ampliar el CHECK de origen de movimientos_inventario
-- ---------------------------------------------------------------------------
-- Preserva los 9 valores existentes (compra, venta, ajuste_manual,
-- inventario_inicial, anulacion_venta, anulacion_compra, produccion,
-- transferencia_salida, transferencia_entrada) y agrega 'nota_credito_compra'.
ALTER TABLE reservacaacupe.movimientos_inventario
  DROP CONSTRAINT IF EXISTS movimientos_inventario_origen_check;
ALTER TABLE reservacaacupe.movimientos_inventario
  ADD CONSTRAINT movimientos_inventario_origen_check CHECK (
    origen = ANY (ARRAY[
      'compra','venta','ajuste_manual','inventario_inicial',
      'anulacion_venta','anulacion_compra','produccion',
      'transferencia_salida','transferencia_entrada',
      'nota_credito_compra'
    ])
  );

-- ---------------------------------------------------------------------------
-- 2) notas_credito_compra (cabecera)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservacaacupe.notas_credito_compra (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id            uuid NOT NULL REFERENCES reservacaacupe.empresas(id) ON DELETE CASCADE,
  sucursal_id           uuid NOT NULL REFERENCES reservacaacupe.sucursales(id) ON DELETE RESTRICT,
  -- Correlativo interno del ERP: NCC-000001 por (empresa, sucursal).
  numero                text NOT NULL,
  -- Compra que corrige. Se referencia por numero_control (modelo plano: N filas).
  compra_numero_control text NOT NULL,
  -- proveedor_id sin FK a proveedores (igual que compras: guarda id + nombre
  -- denormalizado). Evita acoplarse a la existencia de la tabla en el schema.
  proveedor_id          uuid,
  proveedor_nombre      text NOT NULL DEFAULT '',
  -- N° del documento fiscal que emitió el PROVEEDOR (su NC). Informativo.
  numero_documento      text,
  fecha_documento       date,
  tipo                  text NOT NULL DEFAULT 'devolucion',
  motivo                text,
  moneda                text NOT NULL DEFAULT 'PYG',
  subtotal              numeric NOT NULL DEFAULT 0,
  monto_iva             numeric NOT NULL DEFAULT 0,
  total                 numeric NOT NULL DEFAULT 0,
  -- Comprobante recibido (PDF/imagen). Reutiliza el bucket 'compras-facturas'.
  comprobante_storage_path text,
  comprobante_nombre       text,
  comprobante_mime_type    text,
  estado                text NOT NULL DEFAULT 'registrada',
  anulada_at            timestamptz,
  anulacion_motivo      text,
  anulada_por           uuid REFERENCES reservacaacupe.usuarios(id) ON DELETE SET NULL,
  created_by            uuid REFERENCES reservacaacupe.usuarios(id) ON DELETE SET NULL,
  usuario_nombre        text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ncc_numero_empresa_uq UNIQUE (empresa_id, numero),
  CONSTRAINT ncc_tipo_check   CHECK (tipo = ANY (ARRAY['devolucion','descuento'])),
  CONSTRAINT ncc_estado_check CHECK (estado = ANY (ARRAY['registrada','anulada'])),
  CONSTRAINT ncc_total_nonneg CHECK (total >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ncc_empresa   ON reservacaacupe.notas_credito_compra (empresa_id);
CREATE INDEX IF NOT EXISTS idx_ncc_sucursal  ON reservacaacupe.notas_credito_compra (sucursal_id);
CREATE INDEX IF NOT EXISTS idx_ncc_proveedor ON reservacaacupe.notas_credito_compra (proveedor_id);
CREATE INDEX IF NOT EXISTS idx_ncc_compra    ON reservacaacupe.notas_credito_compra (empresa_id, compra_numero_control);
CREATE INDEX IF NOT EXISTS idx_ncc_estado    ON reservacaacupe.notas_credito_compra (empresa_id, estado);

DROP TRIGGER IF EXISTS notas_credito_compra_updated_at ON reservacaacupe.notas_credito_compra;
CREATE TRIGGER notas_credito_compra_updated_at
  BEFORE UPDATE ON reservacaacupe.notas_credito_compra
  FOR EACH ROW EXECUTE FUNCTION reservacaacupe.set_updated_at();

-- ---------------------------------------------------------------------------
-- 3) notas_credito_compra_items (líneas)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservacaacupe.notas_credito_compra_items (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nota_credito_compra_id  uuid NOT NULL REFERENCES reservacaacupe.notas_credito_compra(id) ON DELETE CASCADE,
  empresa_id              uuid NOT NULL REFERENCES reservacaacupe.empresas(id) ON DELETE CASCADE,
  producto_id             uuid REFERENCES reservacaacupe.productos(id) ON DELETE RESTRICT,
  producto_nombre         text NOT NULL DEFAULT '',
  sku_snapshot            text,
  cantidad                numeric NOT NULL DEFAULT 0,
  costo_unitario          numeric NOT NULL DEFAULT 0,
  subtotal                numeric NOT NULL DEFAULT 0,
  created_at              timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ncc_item_cantidad_nonneg CHECK (cantidad >= 0),
  CONSTRAINT ncc_item_costo_nonneg    CHECK (costo_unitario >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ncc_item_nc   ON reservacaacupe.notas_credito_compra_items (nota_credito_compra_id);
CREATE INDEX IF NOT EXISTS idx_ncc_item_prod ON reservacaacupe.notas_credito_compra_items (producto_id);

-- ---------------------------------------------------------------------------
-- 4) RLS por empresa (defensa en profundidad; el service role la saltea igual)
-- ---------------------------------------------------------------------------
ALTER TABLE reservacaacupe.notas_credito_compra       ENABLE ROW LEVEL SECURITY;
ALTER TABLE reservacaacupe.notas_credito_compra_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ncc_empresa_isolation ON reservacaacupe.notas_credito_compra;
CREATE POLICY ncc_empresa_isolation ON reservacaacupe.notas_credito_compra
  USING (empresa_id = reservacaacupe.empresa_id_actual())
  WITH CHECK (empresa_id = reservacaacupe.empresa_id_actual());

DROP POLICY IF EXISTS ncc_items_empresa_isolation ON reservacaacupe.notas_credito_compra_items;
CREATE POLICY ncc_items_empresa_isolation ON reservacaacupe.notas_credito_compra_items
  USING (empresa_id = reservacaacupe.empresa_id_actual())
  WITH CHECK (empresa_id = reservacaacupe.empresa_id_actual());

-- ---------------------------------------------------------------------------
-- 5) Módulo nuevo — se deja OCULTO del sidebar por código (hiddenFromSidebar),
--    accesible por URL para pruebas. Acá solo se activa en empresa_modulos.
-- ---------------------------------------------------------------------------
INSERT INTO reservacaacupe.modulos (slug, nombre)
SELECT 'notas_credito_compra', 'Notas de crédito de proveedor'
WHERE NOT EXISTS (SELECT 1 FROM reservacaacupe.modulos WHERE slug = 'notas_credito_compra');

INSERT INTO reservacaacupe.empresa_modulos (empresa_id, modulo_id, activo)
SELECT e.id, m.id, true
  FROM reservacaacupe.empresas e
 CROSS JOIN reservacaacupe.modulos m
 WHERE m.slug = 'notas_credito_compra'
   AND NOT EXISTS (
     SELECT 1 FROM reservacaacupe.empresa_modulos em
      WHERE em.empresa_id = e.id AND em.modulo_id = m.id
   );

-- NO se insertan filas en usuario_modulos: los usuarios en "acceso completo"
-- (0 filas) lo tienen por defecto; los de lista explícita se agregan uno por
-- uno desde Usuarios cuando se decida publicarlo. Mismo criterio que 'reposicion'.

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
  IF v_chk NOT LIKE '%nota_credito_compra%' OR v_chk NOT LIKE '%transferencia_salida%' THEN
    RAISE EXCEPTION 'ABORT: el CHECK de origen no quedó con todos los valores: %', v_chk;
  END IF;

  SELECT count(*) INTO v_mod FROM reservacaacupe.modulos WHERE slug='notas_credito_compra';
  IF v_mod <> 1 THEN RAISE EXCEPTION 'ABORT: módulo notas_credito_compra no quedó creado'; END IF;

  RAISE NOTICE 'NC de proveedor OK: CHECK ampliado, tablas creadas, módulo activo';
END $$;

COMMIT;
