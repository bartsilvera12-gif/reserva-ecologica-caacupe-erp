-- Trigger preventivo para CUENTAS POR PAGAR: mantiene cxp.saldo y cxp.estado
-- consistentes con `pagado` y `nc_aplicado`, redondeando residuos por decimales.
--
-- Causa de origen: una compra con decimales (monto_original = 1.360.303,29) y un
-- pago en guaraníes redondeado (1.360.303) dejaba saldo residual de 0,29 →
-- estado 'parcial'. La UI lo mostraba como "Vencida" cuando el cliente ya lo
-- había pagado totalmente. Mismo patrón que CxC con NC.
--
-- Invariante: saldo = max(0, monto_original - pagado - nc_aplicado).
-- Estado:
--   'anulada' no se toca.
--   saldo <= 0.5 Gs (residuo por decimales)   -> 'pagada', saldo = 0.
--   pagado + nc_aplicado > 0 pero saldo > 0   -> 'parcial'.
--   caso contrario                            -> 'pendiente'.
--
-- Solo schema reservacaacupe. Idempotente.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'reservacaacupe') THEN
    RETURN;
  END IF;

  CREATE OR REPLACE FUNCTION reservacaacupe.fn_recalc_cxp_saldo()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
  DECLARE
    v_saldo numeric;
    v_estado text;
  BEGIN
    IF NEW.estado = 'anulada' THEN
      RETURN NEW;
    END IF;

    v_saldo := COALESCE(NEW.monto_original, 0)
             - COALESCE(NEW.pagado, 0)
             - COALESCE(NEW.nc_aplicado, 0);
    IF v_saldo < 0.5 THEN
      v_saldo := 0;
    END IF;

    IF v_saldo <= 0.5 THEN
      v_estado := 'pagada';
      v_saldo := 0;
    ELSIF COALESCE(NEW.pagado, 0) + COALESCE(NEW.nc_aplicado, 0) > 0 THEN
      v_estado := 'parcial';
    ELSE
      v_estado := 'pendiente';
    END IF;

    NEW.saldo := v_saldo;
    NEW.estado := v_estado;
    RETURN NEW;
  END;
  $fn$;

  DROP TRIGGER IF EXISTS trg_cxp_recalc_saldo ON reservacaacupe.cuentas_por_pagar;
  CREATE TRIGGER trg_cxp_recalc_saldo
    BEFORE INSERT OR UPDATE OF monto_original, pagado, nc_aplicado
    ON reservacaacupe.cuentas_por_pagar
    FOR EACH ROW EXECUTE FUNCTION reservacaacupe.fn_recalc_cxp_saldo();

  -- Corrección retroactiva de los saldos residuales existentes. El trigger
  -- se dispara por el UPDATE pues toca las columnas que lo despiertan.
  UPDATE reservacaacupe.cuentas_por_pagar
     SET pagado = pagado
   WHERE estado <> 'anulada'
     AND ABS(COALESCE(monto_original,0) - COALESCE(pagado,0) - COALESCE(nc_aplicado,0)) < 0.5
     AND (saldo <> 0 OR estado <> 'pagada');

END $$;
