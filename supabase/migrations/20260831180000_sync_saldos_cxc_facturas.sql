-- Sync de saldos entre reservacaacupe.facturas y reservacaacupe.cuentas_por_cobrar.
--
-- Contexto del bug:
--   - facturas.saldo se reducia al aprobar una NC (RPC nota_credito_aplicar_aprobacion_set).
--   - cuentas_por_cobrar.saldo se reducia al registrar cobros (cobrarConRecibo).
--   - Ninguna de las dos operaciones actualizaba la contraparte.
--   -> El modal de cobro multiple lee CxC.saldo y mostraba montos SIN descontar
--      las NC aprobadas. Detectado con Herrero Group (FAC-000249 tenia NC de
--      112.400 aplicada a facturas.saldo pero CxC.saldo seguia entero).
--
-- Esta migracion:
--   1. BACKFILL: sincroniza CxC.saldo con facturas.saldo cuando divergen.
--      Se toma el MENOR de los dos para no re-cobrar montos ya acreditados
--      (facturas.saldo < CxC.saldo indica NC aprobada que no se reflejo).
--   2. Extiende el RPC nota_credito_aplicar_aprobacion_set para actualizar
--      tambien cuentas_por_cobrar.saldo cuando reduce el saldo de la factura.
--
-- El fix simetrico (cobrarConRecibo actualizando facturas.saldo) va en TS —
-- aca solo lo que necesita ser SQL/RPC.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'reservacaacupe') THEN
    RETURN;
  END IF;

  -- ============================================================================
  -- 1) BACKFILL — CxC.saldo = LEAST(CxC.saldo, facturas.saldo)
  --    cuando facturas.saldo es MENOR (NC aprobada ya reflejada en facturas).
  -- ============================================================================
  UPDATE reservacaacupe.cuentas_por_cobrar cxc
     SET saldo = f.saldo,
         estado = CASE
           WHEN f.saldo <= 0.001                                THEN 'pagado'
           WHEN f.saldo < cxc.total - 0.001                     THEN 'parcial'
           ELSE cxc.estado
         END,
         updated_at = now()
    FROM reservacaacupe.facturas f
   WHERE f.origen_venta_id = cxc.venta_id
     AND f.empresa_id = cxc.empresa_id
     AND cxc.estado <> 'anulado'
     AND f.saldo < cxc.saldo - 0.001;
END $$;

-- ==============================================================================
-- 2) RPC nota_credito_aplicar_aprobacion_set — actualiza TAMBIEN CxC.saldo
-- ==============================================================================
CREATE OR REPLACE FUNCTION reservacaacupe.nota_credito_aplicar_aprobacion_set(
  p_data_schema text,
  p_nota_credito_id uuid,
  p_factura_id uuid,
  p_empresa_id uuid,
  p_monto numeric
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_temp
AS $$
DECLARE
  s          text := btrim(p_data_schema);
  fq         text := quote_ident(btrim(p_data_schema));
  saldo_act    numeric;
  monto_fact   numeric;
  origen_v_id  uuid;
  nc_aprobadas numeric;
  acreditable  numeric;
  total_nc     numeric;
BEGIN
  IF s IS NULL OR s = '' THEN
    RAISE EXCEPTION 'nota_credito_aplicar_aprobacion_set: schema vacío';
  END IF;

  EXECUTE format(
    'SELECT saldo, monto, origen_venta_id FROM %s.facturas
      WHERE id = $1 AND empresa_id = $2 FOR UPDATE',
    fq
  ) INTO saldo_act, monto_fact, origen_v_id USING p_factura_id, p_empresa_id;

  IF saldo_act IS NULL THEN
    RAISE EXCEPTION 'Factura no encontrada';
  END IF;

  -- NC ya aprobadas de esta factura (excluye la que estamos aprobando ahora).
  EXECUTE format(
    'SELECT COALESCE(SUM(monto), 0) FROM %s.nota_credito
      WHERE factura_id = $1 AND empresa_id = $2
        AND estado_erp = ''aprobada'' AND id <> $3',
    fq
  ) INTO nc_aprobadas USING p_factura_id, p_empresa_id, p_nota_credito_id;

  -- Tope por MONTO facturado (no por saldo): habilita acreditar sobre contado/pagadas.
  acreditable := GREATEST(0::numeric, COALESCE(monto_fact, 0) - COALESCE(nc_aprobadas, 0));
  IF p_monto > acreditable + 0.02 THEN
    RAISE EXCEPTION
      'El monto de la NC (%) supera el importe acreditable de la factura (%)',
      p_monto, acreditable;
  END IF;

  total_nc := COALESCE(nc_aprobadas, 0) + p_monto;

  -- Reducir saldo/estado en `facturas` (comportamiento previo).
  EXECUTE format(
    'UPDATE %s.facturas SET
       saldo = GREATEST(0::numeric, saldo - $1),
       estado = CASE
         WHEN estado = ''Anulado'' THEN ''Anulado''
         WHEN $4 >= $5 - 0.02 THEN ''Corregida NC''
         WHEN $6 > 0.0001 AND GREATEST(0::numeric, $6 - $1) <= 0.0001 THEN ''Corregida NC''
         ELSE estado
       END,
       updated_at = now()
     WHERE id = $2 AND empresa_id = $3',
    fq
  ) USING p_monto, p_factura_id, p_empresa_id, total_nc, COALESCE(monto_fact, 0), saldo_act;

  -- NUEVO: reducir tambien el saldo de la cuenta por cobrar asociada.
  -- Multi-CxC por venta es raro pero posible: se actualizan todas las que
  -- coinciden. Si no hay CxC (factura contado sin cuenta corriente) el UPDATE
  -- no toca filas y el flujo continua.
  IF origen_v_id IS NOT NULL THEN
    EXECUTE format(
      'UPDATE %s.cuentas_por_cobrar
          SET saldo = GREATEST(0::numeric, saldo - $1),
              estado = CASE
                WHEN estado = ''anulado'' THEN estado
                WHEN GREATEST(0::numeric, saldo - $1) <= 0.001 THEN ''pagado''
                WHEN GREATEST(0::numeric, saldo - $1) < total - 0.001 THEN ''parcial''
                ELSE estado
              END,
              updated_at = now()
        WHERE venta_id = $2 AND empresa_id = $3
          AND estado <> ''anulado''',
      fq
    ) USING p_monto, origen_v_id, p_empresa_id;
  END IF;

  -- Marcar la NC como aprobada en el ERP.
  EXECUTE format(
    'UPDATE %s.nota_credito SET estado_erp = ''aprobada'', updated_at = now()
     WHERE id = $1 AND empresa_id = $2 AND estado_erp <> ''anulada_borrador''',
    fq
  ) USING p_nota_credito_id, p_empresa_id;
END;
$$;

COMMENT ON FUNCTION reservacaacupe.nota_credito_aplicar_aprobacion_set(text, uuid, uuid, uuid, numeric) IS
'Aplica una NC aprobada por SET: reduce facturas.saldo, marca ''Corregida NC'' si corresponde, y ademas sincroniza cuentas_por_cobrar.saldo para que el modal de cobro/pagos vea el saldo neto real (bugfix 2026-08-31, Herrero Group).';
