-- ============================================================================
-- Formato de impresión del KuDE (factura electrónica) POR SUCURSAL — aditivo
-- ============================================================================
--
-- El formato de impresión era por EMPRESA (empresa_facturacion_modo), así que no
-- podía diferir entre sucursales. Reserva Market solo tiene impresora de tickets
-- y necesita el KuDE en ticket térmico; Casa Matriz sigue en A4.
--
-- Se agrega `sucursales.kude_formato` (nullable). NULL = usar el formato por
-- defecto (A4 / config de empresa). Valores: 'a4' | 'ticket_80mm' | 'ticket_58mm'.
-- Solo afecta la representación gráfica; no toca XML/firma/SET/CDC. supabase_admin.
-- ============================================================================

BEGIN;

ALTER TABLE reservacaacupe.sucursales
  ADD COLUMN IF NOT EXISTS kude_formato text;

ALTER TABLE reservacaacupe.sucursales DROP CONSTRAINT IF EXISTS sucursales_kude_formato_check;
ALTER TABLE reservacaacupe.sucursales
  ADD CONSTRAINT sucursales_kude_formato_check
  CHECK (kude_formato IS NULL OR kude_formato = ANY (ARRAY['a4','ticket_80mm','ticket_58mm']));

-- Reserva Market (sucursal no principal): factura en ticket térmico 80mm.
UPDATE reservacaacupe.sucursales SET kude_formato = 'ticket_80mm' WHERE es_principal = false;
-- Casa Matriz (principal): explícito en A4 para no depender de la config de empresa.
UPDATE reservacaacupe.sucursales SET kude_formato = 'a4' WHERE es_principal = true;

COMMIT;
