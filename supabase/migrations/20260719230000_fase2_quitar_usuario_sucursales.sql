-- ============================================================================
-- FASE 2 — Eliminar usuario_sucursales
-- ============================================================================
--
-- La tabla se creó en la Fase 1 para soportar un usuario con acceso a VARIAS
-- sucursales (con un selector para cambiar entre ellas).
--
-- El cliente definió después un modelo distinto: cada usuario pertenece a UNA
-- sola sucursal y ve únicamente lo de esa sucursal, admin incluido. Reserva
-- Market tiene su propio admin, que no ve nada de Casa Matriz.
--
-- Con ese modelo `usuarios.sucursal_predeterminada_id` alcanza y sobra.
-- Mantener además la N:M dejaría DOS fuentes de verdad sobre el mismo hecho,
-- que pueden desincronizarse y dar respuestas distintas segun quien pregunte.
--
-- Ningún código la usa: se creó y se llenó por backfill, nada más.
-- ============================================================================

BEGIN;

-- Guarda: no borrar si alguien empezó a usarla para accesos múltiples, porque
-- eso significaría que el modelo cambió otra vez y hay que revisar antes.
DO $$
DECLARE n_multi int;
BEGIN
  SELECT count(*) INTO n_multi FROM (
    SELECT usuario_id FROM reservacaacupe.usuario_sucursales
     GROUP BY usuario_id HAVING count(*) > 1
  ) t;
  IF n_multi > 0 THEN
    RAISE EXCEPTION 'ABORT: % usuarios tienen mas de una sucursal. Revisar antes de borrar.', n_multi;
  END IF;
END $$;

-- Guarda: todos deben tener su sucursal en usuarios antes de perder la N:M.
DO $$
DECLARE n_sin int;
BEGIN
  SELECT count(*) INTO n_sin FROM reservacaacupe.usuarios
   WHERE sucursal_predeterminada_id IS NULL;
  IF n_sin > 0 THEN
    RAISE EXCEPTION 'ABORT: % usuarios sin sucursal_predeterminada_id.', n_sin;
  END IF;
END $$;

DROP TABLE reservacaacupe.usuario_sucursales;

COMMIT;
