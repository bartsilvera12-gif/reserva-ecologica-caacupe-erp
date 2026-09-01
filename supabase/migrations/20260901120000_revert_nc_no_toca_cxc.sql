-- Revertir el cambio del 2026-08-31 (20260831180000) que hacia que aprobar
-- una NC en SIFEN reduzca automaticamente cuentas_por_cobrar.saldo.
--
-- Motivo: el criterio del negocio es distinto. "NC aprobada por SET" es un
-- evento fiscal (reduce facturas.saldo). "NC aplicada a un cobro" es una
-- decision operativa del operador: puede o no usarla en ese cobro puntual,
-- puede dejarla como credito a favor del cliente, o aplicarla mas tarde a
-- otro cobro. Descontarla automaticamente del cobrable era incorrecto.
--
-- Esta migracion:
--   1. Devuelve el RPC nota_credito_aplicar_aprobacion_set a la version
--      previa (solo toca facturas.saldo, NO cuentas_por_cobrar).
--   2. NO revierte el backfill de datos — eso se hace desde el editor SQL
--      con un UPDATE inspeccionable, para no re-corromper CxC si el
--      operador ya limpio manualmente algunas filas.

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
  s  text := btrim(p_data_schema);
  fq text := quote_ident(btrim(p_data_schema));
  saldo_act    numeric;
  monto_fact   numeric;
  nc_aprobadas numeric;
  acreditable  numeric;
  total_nc     numeric;
BEGIN
  IF s IS NULL OR s = '' THEN
    RAISE EXCEPTION 'nota_credito_aplicar_aprobacion_set: schema vacío';
  END IF;

  EXECUTE format(
    'SELECT saldo, monto FROM %s.facturas WHERE id = $1 AND empresa_id = $2 FOR UPDATE',
    fq
  ) INTO saldo_act, monto_fact USING p_factura_id, p_empresa_id;

  IF saldo_act IS NULL THEN
    RAISE EXCEPTION 'Factura no encontrada';
  END IF;

  EXECUTE format(
    'SELECT COALESCE(SUM(monto), 0) FROM %s.nota_credito
      WHERE factura_id = $1 AND empresa_id = $2
        AND estado_erp = ''aprobada'' AND id <> $3',
    fq
  ) INTO nc_aprobadas USING p_factura_id, p_empresa_id, p_nota_credito_id;

  acreditable := GREATEST(0::numeric, COALESCE(monto_fact, 0) - COALESCE(nc_aprobadas, 0));
  IF p_monto > acreditable + 0.02 THEN
    RAISE EXCEPTION
      'El monto de la NC (%) supera el importe acreditable de la factura (%)',
      p_monto, acreditable;
  END IF;

  total_nc := COALESCE(nc_aprobadas, 0) + p_monto;

  -- Solo facturas.saldo. NO tocamos cuentas_por_cobrar.saldo — la aplicacion
  -- al cobrable es una decision operativa que se registra al momento del cobro
  -- (proximo cambio: NC con saldo_disponible aplicable en el modal).
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

  EXECUTE format(
    'UPDATE %s.nota_credito SET estado_erp = ''aprobada'', updated_at = now()
     WHERE id = $1 AND empresa_id = $2 AND estado_erp <> ''anulada_borrador''',
    fq
  ) USING p_nota_credito_id, p_empresa_id;
END;
$$;

COMMENT ON FUNCTION reservacaacupe.nota_credito_aplicar_aprobacion_set(text, uuid, uuid, uuid, numeric) IS
'Aplica una NC aprobada por SET: reduce SOLO facturas.saldo y marca ''Corregida NC'' si corresponde. La sincronia con cuentas_por_cobrar.saldo NO se hace automaticamente — la aplicacion al cobrable es operativa (se hace al registrar el cobro, no al aprobar la NC). Revertido de 20260831180000 el 2026-09-01.';
