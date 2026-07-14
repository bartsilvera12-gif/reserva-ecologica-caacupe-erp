-- NC sobre facturas CONTADO (y, en general, sobre facturas ya cobradas).
--
-- Problema
-- --------
-- El modelo trataba la NC como algo que descuenta del SALDO PENDIENTE:
--   * `nota_credito_aplicar_aprobacion_set` rechazaba si `p_monto > saldo`.
--   * Una factura CONTADO nace con saldo 0 (y sin filas en `pagos`), así que
--     CUALQUIER NC era rechazada -> imposible acreditar una venta contado
--     (devolución, descuento comercial, bonificación).
--
-- Regla nueva
-- -----------
-- El tope de la NC pasa a ser el IMPORTE ACREDITABLE de la factura:
--     acreditable = monto_factura - SUM(NC ya aprobadas)
-- Es el límite fiscalmente correcto (no se puede acreditar más de lo facturado)
-- y no depende del saldo, por lo que habilita contado. Sobre una factura ya
-- cobrada la NC representa un reembolso/descuento al cliente; el saldo se
-- mantiene en 0 (GREATEST) porque no hay cuenta por cobrar que reducir.
--
-- Efecto sobre crédito: una factura a crédito parcialmente pagada ahora puede
-- acreditarse por completo (antes el tope era el saldo). La diferencia entre lo
-- acreditado y lo adeudado queda como reembolso al cliente, gestionado fuera del
-- sistema (el ERP no lleva "saldo a favor").
--
-- Estado de la factura
-- --------------------
--   * 'Corregida NC' cuando el acumulado de NC aprobadas alcanza el monto
--     facturado (aplica a contado y a crédito).
--   * Compat crédito: si la factura tenía saldo > 0 y esta NC lo lleva a 0,
--     queda 'Corregida NC' (comportamiento previo, preservado).
--   * Contado con NC parcial: sigue 'Pagado' (el dinero se cobró). Con la regla
--     vieja habría pasado a 'Corregida NC' ante cualquier NC, porque el saldo ya
--     estaba en 0.
--
-- ALCANCE
-- -------
-- Estas funciones son POR TENANT: cada schema tiene su propia copia, y el wrapper
-- `nota_credito_tras_aprobacion_set_transaccional` invoca la del tenant con el
-- schema hardcodeado. En runtime la app solo usa la copia de `reservacaacupe`.
--
-- Por eso se actualiza ÚNICAMENTE `reservacaacupe` y NO la plantilla `zentra_erp`:
-- permitir NC sobre facturas cobradas es una decisión de negocio de este cliente,
-- no el default de la plataforma. Los demás tenants (actuales y futuros) conservan
-- la regla anterior (tope por saldo).
--
-- Propietario: estas funciones pertenecen a `supabase_admin`. Aplicar con un rol
-- que sea dueño (con `postgres` falla: "must be owner of function").

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

  -- NC ya aprobadas de esta factura (excluye la que estamos aprobando ahora).
  EXECUTE format(
    'SELECT COALESCE(SUM(monto), 0) FROM %s.nota_credito
      WHERE factura_id = $1 AND empresa_id = $2
        AND estado_erp = ''aprobada'' AND id <> $3',
    fq
  ) INTO nc_aprobadas USING p_factura_id, p_empresa_id, p_nota_credito_id;

  -- Tope por MONTO facturado (no por saldo): es lo que habilita contado/pagadas.
  acreditable := GREATEST(0::numeric, COALESCE(monto_fact, 0) - COALESCE(nc_aprobadas, 0));
  IF p_monto > acreditable + 0.02 THEN
    RAISE EXCEPTION
      'El monto de la NC (%) supera el importe acreditable de la factura (%)',
      p_monto, acreditable;
  END IF;

  total_nc := COALESCE(nc_aprobadas, 0) + p_monto;

  EXECUTE format(
    'UPDATE %s.facturas SET
       saldo = GREATEST(0::numeric, saldo - $1),
       estado = CASE
         WHEN estado = ''Anulado'' THEN ''Anulado''
         -- Acreditada por completo (contado o crédito).
         WHEN $4 >= $5 - 0.02 THEN ''Corregida NC''
         -- Compat crédito: tenía saldo pendiente y esta NC lo deja en 0.
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
  'Aplica NC aprobada. Tope = monto facturado - NC aprobadas (habilita contado/pagadas). Saldo baja con piso 0; estado Corregida NC al acreditar el total.';

NOTIFY pgrst, 'reload schema';
