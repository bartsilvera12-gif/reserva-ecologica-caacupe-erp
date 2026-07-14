-- Cancelación de nota de crédito ante la SET (evento SIFEN siRecepEvento).
--
-- Contexto
-- --------
-- El ERP no tenía forma de cancelar una NC. Peor: la "cancelación" de facturas
-- solo marcaba estado_sifen='cancelado' en la base y NUNCA le avisaba a la SET
-- (no existe cliente SOAP de eventos), así que el documento seguía vigente en el
-- libro de ventas. Este cambio agrega la cancelación REAL para NC: recién cuando
-- la SET registra el evento se marca cancelada en el ERP y se devuelve el saldo.
--
-- Piezas
-- ------
-- 1. estado_erp: nuevo valor 'cancelada' (una NC aprobada y luego cancelada en la
--    SET no es 'anulada_borrador' — esa es para borradores que nunca se enviaron).
-- 2. nota_credito_electronica: sifen_cancelado_at + sifen_cancelacion_motivo,
--    espejo de lo que ya tiene factura_electronica.
-- 3. RPC nota_credito_aplicar_cancelacion_set: aplica la cancelación y RECALCULA
--    el saldo de la factura de forma transaccional.
--
-- Por qué el saldo se RECALCULA y no se "suma de vuelta"
-- -----------------------------------------------------
-- La aprobación hace `saldo = GREATEST(0, saldo - monto)`. Revertir con
-- `saldo + monto` sería incorrecto en dos casos:
--   * CONTADO: el saldo ya era 0 antes de la NC (la factura estaba cobrada), así
--     que la NC no descontó nada; sumarle el monto inventaría una deuda.
--   * Crédito donde la NC superaba el saldo: el GREATEST lo truncó a 0, y sumar
--     el monto devolvería de más.
-- Por eso se recalcula desde la verdad:
--     crédito -> saldo = monto - pagos - NC aprobadas restantes
--     contado -> saldo = 0 (siempre: ya fue cobrada)
--
-- OJO: tabla/función pertenecen a `supabase_admin`. Aplicar con un rol dueño.

ALTER TABLE reservacaacupe.nota_credito
  DROP CONSTRAINT IF EXISTS nota_credito_estado_erp_check;

ALTER TABLE reservacaacupe.nota_credito
  ADD CONSTRAINT nota_credito_estado_erp_check
  CHECK (estado_erp = ANY (ARRAY[
    'borrador', 'pendiente_envio_sifen', 'aprobada',
    'rechazada', 'error', 'anulada_borrador', 'cancelada'
  ]));

ALTER TABLE reservacaacupe.nota_credito_electronica
  ADD COLUMN IF NOT EXISTS sifen_cancelado_at timestamptz,
  ADD COLUMN IF NOT EXISTS sifen_cancelacion_motivo text;

CREATE OR REPLACE FUNCTION reservacaacupe.nota_credito_aplicar_cancelacion_set(
  p_data_schema text,
  p_nota_credito_id uuid,
  p_ne_id uuid,
  p_factura_id uuid,
  p_empresa_id uuid,
  p_motivo text,
  p_cancelado_at timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_temp
AS $$
DECLARE
  s  text := btrim(p_data_schema);
  fq text := quote_ident(btrim(p_data_schema));
  estado_nc     text;
  tipo_fact     text;
  monto_fact    numeric;
  estado_fact   text;
  suma_pagos    numeric;
  nc_restantes  numeric;
  saldo_nuevo   numeric;
  estado_nuevo  text;
BEGIN
  IF s IS NULL OR s = '' THEN
    RAISE EXCEPTION 'nota_credito_aplicar_cancelacion_set: schema vacío';
  END IF;

  -- Solo se cancela una NC efectivamente aprobada. Idempotente si ya está cancelada.
  EXECUTE format(
    'SELECT estado_erp FROM %s.nota_credito WHERE id = $1 AND empresa_id = $2 FOR UPDATE',
    fq
  ) INTO estado_nc USING p_nota_credito_id, p_empresa_id;

  IF estado_nc IS NULL THEN
    RAISE EXCEPTION 'Nota de crédito no encontrada';
  END IF;
  IF estado_nc = 'cancelada' THEN
    RETURN;
  END IF;
  IF estado_nc <> 'aprobada' THEN
    RAISE EXCEPTION 'Solo se puede cancelar una nota de crédito aprobada (estado actual: %)', estado_nc;
  END IF;

  EXECUTE format(
    'SELECT tipo, monto, estado FROM %s.facturas WHERE id = $1 AND empresa_id = $2 FOR UPDATE',
    fq
  ) INTO tipo_fact, monto_fact, estado_fact USING p_factura_id, p_empresa_id;

  IF monto_fact IS NULL THEN
    RAISE EXCEPTION 'Factura no encontrada';
  END IF;

  -- Marcar la NC como cancelada ANTES de recalcular, para que no se cuente.
  EXECUTE format(
    'UPDATE %s.nota_credito SET estado_erp = ''cancelada'', updated_at = now()
      WHERE id = $1 AND empresa_id = $2',
    fq
  ) USING p_nota_credito_id, p_empresa_id;

  EXECUTE format(
    'UPDATE %s.nota_credito_electronica SET
       estado_sifen = ''cancelado'',
       sifen_cancelado_at = $1,
       sifen_cancelacion_motivo = $2,
       updated_at = now()
     WHERE id = $3 AND empresa_id = $4',
    fq
  ) USING p_cancelado_at, p_motivo, p_ne_id, p_empresa_id;

  EXECUTE format(
    'SELECT COALESCE(SUM(monto), 0) FROM %s.pagos WHERE factura_id = $1 AND empresa_id = $2',
    fq
  ) INTO suma_pagos USING p_factura_id, p_empresa_id;

  EXECUTE format(
    'SELECT COALESCE(SUM(monto), 0) FROM %s.nota_credito
      WHERE factura_id = $1 AND empresa_id = $2 AND estado_erp = ''aprobada''',
    fq
  ) INTO nc_restantes USING p_factura_id, p_empresa_id;

  -- Recalcular saldo desde la verdad (ver cabecera: NO sumar el monto de vuelta).
  IF lower(COALESCE(tipo_fact, '')) = 'contado' THEN
    saldo_nuevo := 0;
  ELSE
    saldo_nuevo := GREATEST(0::numeric,
      COALESCE(monto_fact, 0) - COALESCE(suma_pagos, 0) - COALESCE(nc_restantes, 0));
  END IF;

  IF estado_fact = 'Anulado' THEN
    estado_nuevo := 'Anulado';
  ELSIF COALESCE(nc_restantes, 0) >= COALESCE(monto_fact, 0) - 0.02 THEN
    estado_nuevo := 'Corregida NC';
  ELSIF saldo_nuevo <= 0.0001 THEN
    estado_nuevo := 'Pagado';
  ELSE
    estado_nuevo := 'Pendiente';
  END IF;

  EXECUTE format(
    'UPDATE %s.facturas SET saldo = $1, estado = $2, updated_at = now()
      WHERE id = $3 AND empresa_id = $4',
    fq
  ) USING saldo_nuevo, estado_nuevo, p_factura_id, p_empresa_id;
END;
$$;

COMMENT ON FUNCTION reservacaacupe.nota_credito_aplicar_cancelacion_set(text, uuid, uuid, uuid, uuid, text, timestamptz) IS
  'Aplica la cancelación de una NC ya registrada en la SET: marca cancelada y RECALCULA el saldo/estado de la factura (crédito: monto - pagos - NC vigentes; contado: 0).';

NOTIFY pgrst, 'reload schema';
