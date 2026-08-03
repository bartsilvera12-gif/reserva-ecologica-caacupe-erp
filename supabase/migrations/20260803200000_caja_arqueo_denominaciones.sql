-- ============================================================================
-- Arqueo de caja por denominaciones (conteo físico de monedas y billetes)
-- ============================================================================
--
-- Guarda el DETALLE del conteo (no solo el total) en apertura y en cierre, para
-- auditoría. monto_apertura y efectivo_contado siguen siendo las columnas del
-- total (se calculan desde el detalle cuando el cajero usa el arqueo, pero no se
-- eliminan ni renombran: el flujo manual —tipear el total— sigue funcionando).
--
-- Aditiva, nullable, no destructiva. Portada de Ferretería República.
-- supabase_admin.
-- ============================================================================

BEGIN;

ALTER TABLE reservacaacupe.cajas
  ADD COLUMN IF NOT EXISTS arqueo_apertura_json jsonb,
  ADD COLUMN IF NOT EXISTS arqueo_cierre_json   jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='reservacaacupe' AND table_name='cajas' AND column_name='arqueo_cierre_json'
  ) THEN
    RAISE EXCEPTION 'ABORT: no se creó arqueo_cierre_json';
  END IF;
  RAISE NOTICE 'Caja arqueo por denominaciones OK: columnas JSON creadas';
END $$;

COMMIT;
