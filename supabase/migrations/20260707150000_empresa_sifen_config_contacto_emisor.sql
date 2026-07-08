-- Datos de contacto del emisor para el XML SIFEN (dTelEmi + dEmailE) y para el
-- KUDE (encabezado con Tel/Email). Antes estaban hardcodeados como
-- 021000000 / facturacion@configurar-empresa.com.py en handle-sifen-xml-post.ts
-- y como constantes NEURA_KUDE_TEL / NEURA_KUDE_EMAIL en kude-pdf.ts, lo cual
-- resultaba en facturas con datos de contacto que NO son del emisor real.
--
-- Idempotente. Aplica en cualquier schema donde exista empresa_sifen_config.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'empresa_sifen_config'
      AND c.relkind = 'r'
      AND n.nspname IN ('public', 'reservacaacupe')
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.empresa_sifen_config ADD COLUMN IF NOT EXISTS emisor_telefono text',
      r.sch
    );
    EXECUTE format(
      'ALTER TABLE %I.empresa_sifen_config ADD COLUMN IF NOT EXISTS emisor_email text',
      r.sch
    );
    EXECUTE format(
      'COMMENT ON COLUMN %I.empresa_sifen_config.emisor_telefono IS ''Teléfono del emisor mostrado en el KUDE (encabezado) y usado en el XML como dTelEmi. Solo dígitos (8–15). Si es null se usa un fallback histórico por retrocompatibilidad.''',
      r.sch
    );
    EXECUTE format(
      'COMMENT ON COLUMN %I.empresa_sifen_config.emisor_email IS ''Email del emisor mostrado en el KUDE (encabezado) y usado en el XML como dEmailE. Si es null se usa un fallback histórico.''',
      r.sch
    );
  END LOOP;
END $$;
