-- Edición de presupuestos: para poder reordenar ítems de forma confiable
-- (subir/bajar), agregamos una columna `orden` a presupuesto_items. Antes el
-- listado se ordenaba por created_at, que empata cuando los ítems se insertan en
-- un solo batch (mismo now()), haciendo imposible garantizar el orden al editar.
--
-- Esta migración:
--   1) Agrega la columna `orden` (int, default 0).
--   2) BACKFILL idempotente: numera los ítems existentes por created_at dentro de
--      cada presupuesto (0,1,2,...), para no alterar el orden visible actual.
--
-- Solo schema reservacaacupe. Idempotente. No toca totales ni estados.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'reservacaacupe') THEN
    RETURN;
  END IF;

  ALTER TABLE reservacaacupe.presupuesto_items
    ADD COLUMN IF NOT EXISTS orden integer NOT NULL DEFAULT 0;

  -- Backfill: respeta el orden actual (created_at) por presupuesto.
  WITH ranked AS (
    SELECT id,
           row_number() OVER (PARTITION BY presupuesto_id ORDER BY created_at, id) - 1 AS rn
      FROM reservacaacupe.presupuesto_items
  )
  UPDATE reservacaacupe.presupuesto_items p
     SET orden = r.rn
    FROM ranked r
   WHERE p.id = r.id
     AND p.orden = 0;
END $$;
