-- Fix: el CHECK de movimientos_inventario.origen se re-creó en migraciones previas
-- (20260702120000_ventas_anulacion.sql y 20260702170000_compras_anulacion.sql)
-- SIN el valor 'produccion', que sí se usa desde el flujo Fabricar de recetas
-- (`src/lib/produccion/crear-produccion-pg.ts`). Al confirmar una producción se
-- levantaba: violates check constraint "movimientos_inventario_origen_check".
--
-- Aplica solo en `reservacaacupe`. Idempotente.

DO $$
DECLARE
  r RECORD;
  cname text;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'movimientos_inventario'
      AND c.relkind = 'r'
      AND n.nspname = 'reservacaacupe'
  LOOP
    FOR cname IN
      SELECT conname
      FROM pg_constraint
      WHERE conrelid = format('%I.movimientos_inventario', r.sch)::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%origen%'
    LOOP
      EXECUTE format('ALTER TABLE %I.movimientos_inventario DROP CONSTRAINT %I', r.sch, cname);
    END LOOP;
    EXECUTE format(
      'ALTER TABLE %I.movimientos_inventario ADD CONSTRAINT movimientos_inventario_origen_check
         CHECK (origen IN (
           ''compra'', ''venta'', ''ajuste_manual'', ''inventario_inicial'',
           ''anulacion_venta'', ''anulacion_compra'', ''produccion''
         ))',
      r.sch
    );
  END LOOP;
END $$;
