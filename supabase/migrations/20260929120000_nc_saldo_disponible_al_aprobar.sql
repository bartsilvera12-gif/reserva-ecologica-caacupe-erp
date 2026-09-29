-- Fix: las notas de crédito aprobadas DESPUÉS del backfill del 2026-09-01
-- (migración 20260901180000) nacían con saldo_disponible = 0 y por eso NO
-- aparecían en el "Cobro múltiple" (que lista NC con estado_erp='aprobada' AND
-- saldo_disponible > 0). El backfill solo arregló las NC que ya existían; el
-- flujo de aprobación nunca setea saldo_disponible.
--
-- Detectado con MACISA (cliente ALMA GONZALEZ): 8 NC aprobadas, solo 4 visibles
-- en el cobro (las creadas antes del 01-09). Alcance real: ~55 NC en ~15 clientes.
--
-- Esta migración:
--   1) BACKFILL idempotente: saldo_disponible = monto para NC aprobadas, con
--      monto > 0, saldo_disponible = 0 y SIN aplicaciones activas (no toca NC ya
--      consumidas en cobros).
--   2) TRIGGER: al pasar una NC a 'aprobada' inicializa saldo_disponible = monto
--      automáticamente. Robusto ante cualquier vía de aprobación (RPC, etc.), así
--      no vuelve a ocurrir. No refilla NC ya consumidas (guard por aplicaciones).
--
-- Solo schema reservacaacupe. Idempotente. No toca SIFEN ni cuentas_por_cobrar.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'reservacaacupe') THEN
    RETURN;
  END IF;

  -- 1) BACKFILL de las NC ya aprobadas que quedaron invisibles.
  UPDATE reservacaacupe.nota_credito nc
     SET saldo_disponible = nc.monto,
         updated_at = now()
   WHERE nc.estado_erp = 'aprobada'
     AND COALESCE(nc.monto, 0) > 0
     AND COALESCE(nc.saldo_disponible, 0) <= 0.001
     AND NOT EXISTS (
           SELECT 1 FROM reservacaacupe.nota_credito_aplicaciones a
            WHERE a.nota_credito_id = nc.id AND a.anulado = false);
END $$;

-- 2) TRIGGER que inicializa saldo_disponible al aprobar.
CREATE OR REPLACE FUNCTION reservacaacupe.nc_set_saldo_disponible_on_aprobar()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.estado_erp = 'aprobada'
     AND (TG_OP = 'INSERT' OR OLD.estado_erp IS DISTINCT FROM 'aprobada')
     AND COALESCE(NEW.saldo_disponible, 0) <= 0.001
     AND COALESCE(NEW.monto, 0) > 0
     AND NOT EXISTS (
           SELECT 1 FROM reservacaacupe.nota_credito_aplicaciones a
            WHERE a.nota_credito_id = NEW.id AND a.anulado = false)
  THEN
    NEW.saldo_disponible := NEW.monto;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_nc_saldo_disponible_al_aprobar ON reservacaacupe.nota_credito;
CREATE TRIGGER trg_nc_saldo_disponible_al_aprobar
  BEFORE INSERT OR UPDATE OF estado_erp ON reservacaacupe.nota_credito
  FOR EACH ROW
  EXECUTE FUNCTION reservacaacupe.nc_set_saldo_disponible_on_aprobar();
