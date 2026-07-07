-- =============================================================================
-- SIFEN Jobs — Fase 3.1a: límite de re-encolados por SET-en-proceso
-- =============================================================================
--
-- Cuando SET responde "en proceso" indefinidamente, el orquestador re-encola
-- el Job cada 30s. Sin límite, un Job atascado consumía un slot del worker
-- para siempre. Esta migración:
--   1) Agrega `veces_re_encolado_consulta` — contador que el orquestador
--      incrementa cada vez que re-encola por SET-en-proceso (no cuenta como
--      intento fallido: SET no rechazó nada).
--   2) Extiende `tipo_error` para incluir 'set_timeout' — se usa al cerrar
--      el Job en 'error' cuando `veces_re_encolado_consulta` alcanza el
--      límite (10). El operador ve el mensaje explicativo y puede consultar
--      manualmente o reintentar.
--
-- Idempotente. Aplica en cualquier schema tenant que tenga `sifen_jobs`.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'sifen_jobs'
      AND c.relkind = 'r'
  LOOP
    -- 1) Nueva columna contador.
    EXECUTE format(
      'ALTER TABLE %I.sifen_jobs
         ADD COLUMN IF NOT EXISTS veces_re_encolado_consulta int NOT NULL DEFAULT 0',
      r.sch
    );

    -- 2) Reemplazar el CHECK de tipo_error para incluir 'set_timeout'.
    --    Buscar el constraint por nombre y recrear.
    DECLARE
      cname text;
    BEGIN
      SELECT conname INTO cname
      FROM pg_constraint
      WHERE conrelid = format('%I.sifen_jobs', r.sch)::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) ILIKE '%tipo_error%';
      IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE %I.sifen_jobs DROP CONSTRAINT %I', r.sch, cname);
      END IF;
      EXECUTE format(
        $c$ALTER TABLE %I.sifen_jobs
             ADD CONSTRAINT sifen_jobs_tipo_error_check
             CHECK (tipo_error IS NULL OR tipo_error IN (
               'set_rechazo','fiscal','firma','config',
               'red','http_5xx','storage','inesperado','set_timeout'
             ))$c$,
        r.sch
      );
    END;

    RAISE NOTICE 'sifen_jobs actualizado en schema % (Fase 3.1a)', r.sch;
  END LOOP;
END $$;
