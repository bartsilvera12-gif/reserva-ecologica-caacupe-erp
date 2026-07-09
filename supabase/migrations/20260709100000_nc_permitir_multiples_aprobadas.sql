-- Fix QA: nota_credito_aplicar_aprobacion_set bloqueaba la política de
-- "múltiples NC parciales hasta agotar el saldo" implementada en
-- 20260707160000_nota_credito_items_multi.sql.
--
-- Esa migración quitó el índice único que limitaba a una NC "activa" por
-- factura y actualizó toda la capa de aplicación (create-nota-credito.ts,
-- evaluate-creation-gate.ts) para permitir varias NC acumuladas. Pero este
-- RPC —que es el que efectivamente descuenta el saldo al aprobar en SET—
-- seguía teniendo un guard viejo: rechazaba la aprobación de una NC si ya
-- existía OTRA NC aprobada para la misma factura. Con eso, la segunda NC
-- parcial de una serie nunca podía aprobarse aunque el saldo alcanzara.
--
-- El guard es innecesario: el chequeo `p_monto > saldo_act + 0.02` (con
-- `SELECT ... FOR UPDATE` sobre facturas, ya presente) es suficiente para
-- impedir que el acumulado de NC aprobadas supere el saldo real, sea la
-- primera o la enésima NC. Se elimina el bloqueo de "otra aprobada".

CREATE OR REPLACE FUNCTION zentra_erp.nota_credito_aplicar_aprobacion_set(
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
  s text := btrim(p_data_schema);
  fq text := quote_ident(btrim(p_data_schema));
  saldo_act numeric;
BEGIN
  IF s IS NULL OR s = '' THEN
    RAISE EXCEPTION 'nota_credito_aplicar_aprobacion_set: schema vacío';
  END IF;

  -- Ya NO se bloquea por "otra NC aprobada existente": el negocio permite
  -- múltiples NC parciales por factura. El FOR UPDATE + chequeo de saldo
  -- de abajo son la única protección necesaria contra sobregiro.
  EXECUTE format(
    'SELECT saldo FROM %s.facturas WHERE id = $1 AND empresa_id = $2 FOR UPDATE',
    fq
  ) INTO saldo_act USING p_factura_id, p_empresa_id;

  IF saldo_act IS NULL THEN
    RAISE EXCEPTION 'Factura no encontrada';
  END IF;
  IF p_monto > saldo_act + 0.02 THEN
    RAISE EXCEPTION 'El monto de la NC (%) supera el saldo pendiente (%)', p_monto, saldo_act;
  END IF;

  EXECUTE format(
    'UPDATE %s.facturas SET
       saldo = GREATEST(0::numeric, saldo - $1),
       estado = CASE
         WHEN estado = ''Anulado'' THEN ''Anulado''
         WHEN GREATEST(0::numeric, saldo - $1) <= 0.0001 THEN ''Corregida NC''
         ELSE estado
       END,
       updated_at = now()
     WHERE id = $2 AND empresa_id = $3',
    fq
  ) USING p_monto, p_factura_id, p_empresa_id;

  EXECUTE format(
    'UPDATE %s.nota_credito SET estado_erp = ''aprobada'', updated_at = now()
     WHERE id = $1 AND empresa_id = $2 AND estado_erp <> ''anulada_borrador''',
    fq
  ) USING p_nota_credito_id, p_empresa_id;
END;
$$;

COMMENT ON FUNCTION zentra_erp.nota_credito_aplicar_aprobacion_set(text, uuid, uuid, uuid, numeric) IS
  'Resta NC del saldo (permite múltiples NC aprobadas por factura, hasta agotar saldo); si queda en ~0 (salvo Anulado), estado Corregida NC.';

NOTIFY pgrst, 'reload schema';
