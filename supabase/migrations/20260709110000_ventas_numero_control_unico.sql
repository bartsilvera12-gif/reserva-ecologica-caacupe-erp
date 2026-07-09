-- Fix QA: ventas.numero_control no tenía protección de unicidad en DB.
-- El cálculo de VTA-XXXXXX es un SELECT MAX + incremento en memoria, sin
-- lock (create-venta-pg.ts). Dos requests casi simultáneos (doble click,
-- dos cajas al mismo tiempo) podían generar dos ventas con el mismo
-- numero_control, sin que nada en la DB lo rechazara — a diferencia de
-- compras y facturas, que sí tienen UNIQUE.
--
-- Este índice por sí solo no elimina la carrera (seguimos calculando el
-- próximo número sin lock), pero convierte el duplicado silencioso en un
-- error de INSERT explícito, que el código ahora reintenta (ver
-- create-venta-pg.ts). Idempotente.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'ventas'
      AND c.relkind = 'r'
      AND n.nspname = 'reservacaacupe'
  LOOP
    BEGIN
      EXECUTE format(
        'CREATE UNIQUE INDEX IF NOT EXISTS uq_ventas_empresa_numero_control ON %I.ventas (empresa_id, numero_control)',
        r.sch
      );
    EXCEPTION WHEN unique_violation THEN
      -- Ya existen duplicados de una carrera pasada (antes de este fix).
      -- No abortamos la migración entera: avisamos y seguimos. Hay que
      -- resolver los duplicados a mano (renumerar uno de los dos) antes de
      -- poder crear el índice.
      RAISE NOTICE 'No se pudo crear uq_ventas_empresa_numero_control en %: ya existen numero_control duplicados. Revisar manualmente con: SELECT empresa_id, numero_control, COUNT(*) FROM %I.ventas GROUP BY 1,2 HAVING COUNT(*) > 1;', r.sch, r.sch;
    END;
  END LOOP;
END $$;
