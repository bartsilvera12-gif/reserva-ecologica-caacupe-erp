-- ============================================================================
-- Caja: multi-caja simultánea + estado intermedio 'en_cierre' — aditivo
-- ============================================================================
--
-- Paridad con Ferretería República:
--   * Se permite MÁS de una caja activa por sucursal (varios "registros"
--     abiertos a la vez), diferenciadas por numero_caja.
--   * Estado intermedio 'en_cierre': la caja deja de recibir ventas/movimientos
--     y queda esperando el conteo físico para cerrarse.
--
-- Cambios:
--   1. CHECK de estado ahora admite 'en_cierre'.
--   2. El índice único que reservaba el numero_caja pasa a cubrir también las
--      cajas 'en_cierre' (una caja en conteo sigue ocupando su número), pero YA
--      NO impide abrir otra caja con OTRO número en la misma sucursal.
--
-- No toca ventas, cobros, SIFEN ni facturas. supabase_admin.
-- ============================================================================

BEGIN;

-- 1) Estado admite 'en_cierre'.
ALTER TABLE reservacaacupe.cajas DROP CONSTRAINT IF EXISTS cajas_estado_check;
ALTER TABLE reservacaacupe.cajas
  ADD CONSTRAINT cajas_estado_check
  CHECK (estado = ANY (ARRAY['abierta','en_cierre','cerrada']));

-- 2) El número de caja queda reservado mientras la caja esté activa
--    (abierta O en_cierre). Distintos números pueden convivir activos en la
--    misma sucursal → multi-caja.
DROP INDEX IF EXISTS reservacaacupe.cajas_una_abierta_por_sucursal;
CREATE UNIQUE INDEX IF NOT EXISTS cajas_numero_activo_por_sucursal
  ON reservacaacupe.cajas (empresa_id, sucursal_id, numero_caja)
  WHERE estado IN ('abierta', 'en_cierre');

COMMIT;
