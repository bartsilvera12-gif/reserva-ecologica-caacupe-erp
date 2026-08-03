-- ============================================================================
-- Compras: número REAL de la factura del proveedor (aditivo, nullable)
-- ============================================================================
--
-- `numero_control` (COMP-XXXXXX) es el correlativo INTERNO del ERP y no cambia.
-- Este campo guarda el número del comprobante fiscal REAL que emite el proveedor
-- (p. ej. 001-001-0000123). Nullable: las compras históricas no lo tienen y no
-- se exige retroactivamente. Un mismo numero_factura_proveedor puede repetirse
-- entre proveedores distintos, así que NO se le pone único.
--
-- Aditivo e idempotente. Solo toca reservacaacupe.compras. Ejecutar como
-- supabase_admin (dueño de la tabla).
-- ============================================================================

BEGIN;

ALTER TABLE reservacaacupe.compras
  ADD COLUMN IF NOT EXISTS numero_factura_proveedor text;

COMMENT ON COLUMN reservacaacupe.compras.numero_factura_proveedor IS
  'Número del comprobante fiscal real del proveedor (distinto de numero_control interno). Nullable.';

-- Índice para búsquedas por factura real, acotadas por empresa+sucursal.
CREATE INDEX IF NOT EXISTS idx_compras_numero_factura_proveedor
  ON reservacaacupe.compras (empresa_id, sucursal_id, numero_factura_proveedor)
  WHERE numero_factura_proveedor IS NOT NULL;

-- Verificación
DO $$
DECLARE v_ok boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='reservacaacupe' AND table_name='compras'
       AND column_name='numero_factura_proveedor'
  ) INTO v_ok;
  IF NOT v_ok THEN RAISE EXCEPTION 'ABORT: no se creó numero_factura_proveedor'; END IF;
  RAISE NOTICE 'OK: compras.numero_factura_proveedor creado';
END $$;

COMMIT;
