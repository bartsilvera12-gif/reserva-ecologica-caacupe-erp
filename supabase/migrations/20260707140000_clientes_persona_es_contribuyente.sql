-- Marca si una persona física está inscripta como contribuyente en la SET
-- (RUC de persona = CI + DV). Cuando `tipo_cliente='persona'` y este flag
-- está en true + hay `ruc` cargado, SIFEN emite el DE como B2B (iTiOpe=1)
-- en vez de B2C (iTiOpe=2), evitando el rechazo 0301 [1264] "RUC del emisor
-- no habilitado para B2C" cuando el emisor no tiene habilitación B2C.
--
-- Para empresas el flag no aplica (siempre son contribuyentes por definición
-- si tienen RUC). Solo aplica al schema `reservacaacupe`. Idempotente.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'clientes'
      AND c.relkind = 'r'
      AND n.nspname = 'reservacaacupe'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.clientes ADD COLUMN IF NOT EXISTS es_contribuyente boolean NOT NULL DEFAULT false',
      r.sch
    );
    EXECUTE format(
      'COMMENT ON COLUMN %I.clientes.es_contribuyente IS ''Persona física inscripta como contribuyente en la SET. Cuando es true y hay RUC cargado, la factura electrónica sale como B2B (iTiOpe=1) en vez de B2C (iTiOpe=2). No aplica a empresas.''',
      r.sch
    );
  END LOOP;
END $$;
