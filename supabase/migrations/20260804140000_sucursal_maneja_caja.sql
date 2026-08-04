-- ============================================================================
-- Flag por sucursal: ¿opera caja? — aditivo
-- ============================================================================
--
-- No todas las sucursales manejan caja/turno. En Reserva Ecológica Caacupé la
-- Casa Matriz NO opera caja (solo Reserva Market). Se agrega un flag explícito
-- en vez de hardcodear nombres/UUIDs en el código: la app lo lee para mostrar u
-- ocultar el módulo de caja y para no exigir caja en la venta.
--
-- Valor inicial: la sucursal principal (es_principal = Casa Matriz) queda sin
-- caja; el resto la opera. Ajustable después con un simple UPDATE.
--
-- supabase_admin.
-- ============================================================================

BEGIN;

ALTER TABLE reservacaacupe.sucursales
  ADD COLUMN IF NOT EXISTS maneja_caja boolean NOT NULL DEFAULT true;

-- La casa matriz (sucursal principal) no opera caja.
UPDATE reservacaacupe.sucursales SET maneja_caja = false WHERE es_principal = true;

COMMIT;
