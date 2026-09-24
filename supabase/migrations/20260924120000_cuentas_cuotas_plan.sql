-- Plan de cuotas para cuentas por cobrar (ventas) y por pagar (compras).
--
-- Contexto: el ERP ya soporta abonos parciales (cobros_clientes / pagos_proveedor
-- reducen el saldo global de la cuenta). Lo que faltaba es programar ese saldo en
-- CUOTAS con montos y vencimientos distintos ("cuota 1 = Gs X el D1, cuota 2 = Gs
-- Y el D2"). Esta tabla guarda ESE cronograma.
--
-- Diseño deliberado — el plan es informativo/derivado, NO un segundo libro de
-- saldos:
--   - `cuentas_cuotas` solo guarda el cronograma (numero_cuota, monto, vencimiento).
--   - El estado de cada cuota (pendiente/parcial/pagada) se DERIVA en lectura
--     imputando lo ya cobrado/pagado de la más antigua a la más nueva. Así la
--     única fuente de verdad del dinero sigue siendo el saldo de la cuenta y sus
--     abonos (no se duplica ni se desincroniza).
--   - La suma de las cuotas debe igualar el saldo de la cuenta al programarse
--     (se valida en la capa de aplicación).
--
-- Solo schema reservacaacupe. Idempotente. No toca SIFEN.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'reservacaacupe') THEN
    RETURN;
  END IF;

  CREATE TABLE IF NOT EXISTS reservacaacupe.cuentas_cuotas (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    empresa_id         uuid NOT NULL,
    sucursal_id        uuid,
    -- 'cobrar' → cuenta_id referencia cuentas_por_cobrar.id
    -- 'pagar'  → cuenta_id referencia cuentas_por_pagar.id
    -- Polimórfico a propósito: son dos tablas distintas; no ponemos FK dura.
    tipo               text NOT NULL CHECK (tipo IN ('cobrar', 'pagar')),
    cuenta_id          uuid NOT NULL,
    numero_cuota       integer NOT NULL CHECK (numero_cuota >= 1),
    monto              numeric NOT NULL CHECK (monto > 0),
    fecha_vencimiento  date NOT NULL,
    observaciones      text,
    created_by         uuid,
    usuario_nombre     text,
    created_at         timestamptz NOT NULL DEFAULT now(),
    updated_at         timestamptz NOT NULL DEFAULT now(),
    -- Una sola cuota por número dentro de la misma cuenta.
    CONSTRAINT cuentas_cuotas_uniq UNIQUE (empresa_id, tipo, cuenta_id, numero_cuota)
  );

  CREATE INDEX IF NOT EXISTS idx_cuentas_cuotas_cuenta
    ON reservacaacupe.cuentas_cuotas (empresa_id, tipo, cuenta_id, numero_cuota);
  CREATE INDEX IF NOT EXISTS idx_cuentas_cuotas_venc
    ON reservacaacupe.cuentas_cuotas (empresa_id, fecha_vencimiento);

  -- RLS: aislar por empresa como el resto de tablas del tenant.
  ALTER TABLE reservacaacupe.cuentas_cuotas ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS cuentas_cuotas_empresa_isolation ON reservacaacupe.cuentas_cuotas;
  CREATE POLICY cuentas_cuotas_empresa_isolation
    ON reservacaacupe.cuentas_cuotas
    USING (empresa_id = current_setting('app.empresa_id', true)::uuid);
END $$;
