-- Trigger preventivo: mantiene cuentas_por_cobrar.saldo consistente con
-- los cobros_clientes y las nota_credito_aplicaciones activas.
--
-- Causa de origen: hubo un período en que la aplicación de NC en el cobro
-- múltiple registraba la aplicación en nota_credito_aplicaciones pero no
-- descontaba el saldo de la CxC destino, dejando saldos inflados (p. ej. REC
-- 62/63 de HERRERO CENTRAL, Oct-2026). El código actual ya descuenta, pero
-- cualquier flujo nuevo o alternativo que inserte en cobros_clientes o en
-- nota_credito_aplicaciones podría volver a desincronizar. El trigger blinda
-- el invariante en la BD, sin importar quién escribe.
--
-- Invariante: saldo = total - SUM(cobros activos) - SUM(NC aplicadas activas)
-- Estado: 'pagado' si saldo <= 0.01, 'pendiente' si saldo >= total - 0.01,
--         'parcial' en el medio. No tocamos 'anulado'.
--
-- Solo schema reservacaacupe. Idempotente.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'reservacaacupe') THEN
    RETURN;
  END IF;

  -- Función que recalcula el saldo/estado de una CxC dado su id.
  CREATE OR REPLACE FUNCTION reservacaacupe.fn_recalc_cxc_saldo(p_cxc_id uuid)
    RETURNS void
    LANGUAGE plpgsql
    AS $fn$
  DECLARE
    v_total    numeric;
    v_estado   text;
    v_cob      numeric;
    v_nc       numeric;
    v_saldo    numeric;
    v_nuevo_est text;
  BEGIN
    SELECT total, estado INTO v_total, v_estado
      FROM reservacaacupe.cuentas_por_cobrar
     WHERE id = p_cxc_id;
    IF NOT FOUND THEN RETURN; END IF;
    -- Las anuladas se dejan como están.
    IF v_estado = 'anulado' THEN RETURN; END IF;

    SELECT COALESCE(SUM(monto), 0) INTO v_cob
      FROM reservacaacupe.cobros_clientes
     WHERE cuenta_por_cobrar_id = p_cxc_id AND anulado = false;

    SELECT COALESCE(SUM(importe_aplicado), 0) INTO v_nc
      FROM reservacaacupe.nota_credito_aplicaciones
     WHERE cuenta_por_cobrar_id = p_cxc_id AND anulado = false;

    v_saldo := v_total - v_cob - v_nc;
    IF v_saldo < 0 THEN v_saldo := 0; END IF;

    IF v_saldo <= 0.01 THEN
      v_nuevo_est := 'pagado';
    ELSIF v_saldo >= v_total - 0.01 THEN
      v_nuevo_est := 'pendiente';
    ELSE
      v_nuevo_est := 'parcial';
    END IF;

    UPDATE reservacaacupe.cuentas_por_cobrar
       SET saldo = v_saldo,
           estado = v_nuevo_est,
           updated_at = now()
     WHERE id = p_cxc_id
       AND (saldo <> v_saldo OR estado <> v_nuevo_est);
  END;
  $fn$;

  -- Trigger genérico AFTER para cobros_clientes y nota_credito_aplicaciones.
  CREATE OR REPLACE FUNCTION reservacaacupe.fn_trg_cxc_recalc()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      PERFORM reservacaacupe.fn_recalc_cxc_saldo(OLD.cuenta_por_cobrar_id);
      RETURN OLD;
    END IF;
    PERFORM reservacaacupe.fn_recalc_cxc_saldo(NEW.cuenta_por_cobrar_id);
    IF TG_OP = 'UPDATE' AND OLD.cuenta_por_cobrar_id IS DISTINCT FROM NEW.cuenta_por_cobrar_id THEN
      PERFORM reservacaacupe.fn_recalc_cxc_saldo(OLD.cuenta_por_cobrar_id);
    END IF;
    RETURN NEW;
  END;
  $fn$;

  -- Instalar en cobros_clientes
  DROP TRIGGER IF EXISTS trg_cxc_recalc_desde_cobros ON reservacaacupe.cobros_clientes;
  CREATE TRIGGER trg_cxc_recalc_desde_cobros
    AFTER INSERT OR UPDATE OF monto, anulado, cuenta_por_cobrar_id OR DELETE
    ON reservacaacupe.cobros_clientes
    FOR EACH ROW EXECUTE FUNCTION reservacaacupe.fn_trg_cxc_recalc();

  -- Instalar en nota_credito_aplicaciones
  DROP TRIGGER IF EXISTS trg_cxc_recalc_desde_nc ON reservacaacupe.nota_credito_aplicaciones;
  CREATE TRIGGER trg_cxc_recalc_desde_nc
    AFTER INSERT OR UPDATE OF importe_aplicado, anulado, cuenta_por_cobrar_id OR DELETE
    ON reservacaacupe.nota_credito_aplicaciones
    FOR EACH ROW EXECUTE FUNCTION reservacaacupe.fn_trg_cxc_recalc();
END $$;
