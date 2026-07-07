-- =============================================================================
-- SIFEN — cola persistente de trabajos (Fase 2 del rediseño async)
-- =============================================================================
--
-- Cada Job representa "encolar la emisión SIFEN de un DE" para que un worker
-- interno la ejecute en background sin bloquear la caja del vendedor.
--
-- El Worker (Fase 3) llamará DIRECTAMENTE las funciones ya extraídas:
--   handleSifenXmlPost, handleSifenFirmarPost, handleSifenEnviarPost,
--   handleSifenConsultaLotePost. No usa loopback HTTP ni fetch interno; por eso
--   basta con guardar empresa_id + data_schema + factura_id/fe_id en el Job.
--
-- Estados: pendiente → procesando → aprobado | rechazado | error.
--   'rechazado'    → SET respondió con código != 0300 en recibe-lote o marcó
--                    filas como rechazadas en consulta-lote.
--   'error'        → problema técnico definitivo tras los reintentos automáticos
--                    (máx. 2 con backoff 5s/20s) o clasificado como no-reintentable
--                    (fiscal/config/firma).
-- Etapas: xml | firmar | enviar | consulta_lote (donde se detuvo el Job).
--
-- Unicidad: un solo Job "vivo" (pendiente|procesando) por factura_electronica.
-- Ver `uq_sifen_jobs_fe_activo` (unique parcial). Cuando el operador presiona
-- "Reintentar" tras un rechazo/error, se inserta un Job nuevo (histórico completo).
--
-- Aplica solo en el schema del tenant que ya tiene `factura_electronica`.
-- Idempotente.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'factura_electronica'
      AND c.relkind = 'r'
  LOOP
    EXECUTE format($f$
      CREATE TABLE IF NOT EXISTS %I.sifen_jobs (
        id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        empresa_id                uuid NOT NULL,
        data_schema               text NOT NULL,
        factura_id                uuid NOT NULL,
        factura_electronica_id    uuid NOT NULL REFERENCES %I.factura_electronica(id) ON DELETE CASCADE,

        estado                    text NOT NULL DEFAULT 'pendiente'
          CHECK (estado IN ('pendiente','procesando','aprobado','rechazado','error')),
        etapa                     text
          CHECK (etapa IS NULL OR etapa IN ('xml','firmar','enviar','consulta_lote')),

        intentos                  int  NOT NULL DEFAULT 0,
        max_intentos_auto         int  NOT NULL DEFAULT 2,
        intentos_log              jsonb NOT NULL DEFAULT '[]'::jsonb,

        codigo_error_set          text,
        codigo_sub_error_set      text,
        mensaje_set               text,
        ultimo_error              text,
        tipo_error                text
          CHECK (tipo_error IS NULL OR tipo_error IN (
            'set_rechazo','fiscal','firma','config','red','http_5xx','storage','inesperado'
          )),

        respuesta_recibe_lote     jsonb,
        respuesta_consulta_lote   jsonb,

        cdc                       text,
        protocolo_lote            text,

        tiempo_xml_ms             int,
        tiempo_firmar_ms          int,
        tiempo_enviar_ms          int,
        tiempo_consulta_ms        int,
        tiempo_total_ms           int,

        origen                    text NOT NULL DEFAULT 'auto_venta'
          CHECK (origen IN ('auto_venta','reintento_manual','manual_admin')),

        created_at                timestamptz NOT NULL DEFAULT now(),
        started_at                timestamptz,
        finished_at               timestamptz,
        procesando_desde          timestamptz,
        lock_owner                text,
        proximo_reintento_at      timestamptz
      )$f$, r.sch, r.sch);

    -- Cola FIFO: worker toma el más viejo pendiente cuyo tiempo de reintento haya vencido.
    EXECUTE format($f$
      CREATE INDEX IF NOT EXISTS idx_sifen_jobs_pendientes
        ON %I.sifen_jobs (proximo_reintento_at NULLS FIRST, created_at)
        WHERE estado = 'pendiente'
    $f$, r.sch);

    -- Reclaim de jobs zombie: procesando sin cerrar durante más de N minutos.
    EXECUTE format($f$
      CREATE INDEX IF NOT EXISTS idx_sifen_jobs_procesando
        ON %I.sifen_jobs (procesando_desde)
        WHERE estado = 'procesando'
    $f$, r.sch);

    -- Un solo job vivo por DE (pendiente o procesando). "Reintentar" tras
    -- rechazo/error inserta un job nuevo — la unicidad parcial no lo bloquea.
    EXECUTE format($f$
      CREATE UNIQUE INDEX IF NOT EXISTS uq_sifen_jobs_fe_activo
        ON %I.sifen_jobs (factura_electronica_id)
        WHERE estado IN ('pendiente','procesando')
    $f$, r.sch);

    -- Listado por empresa (UI y monitoreo).
    EXECUTE format($f$
      CREATE INDEX IF NOT EXISTS idx_sifen_jobs_empresa_created
        ON %I.sifen_jobs (empresa_id, created_at DESC)
    $f$, r.sch);

    -- Lookup del último job por DE (para /sifen/resumen).
    EXECUTE format($f$
      CREATE INDEX IF NOT EXISTS idx_sifen_jobs_fe_created
        ON %I.sifen_jobs (factura_electronica_id, created_at DESC)
    $f$, r.sch);

    -- RLS: replicamos el mismo modelo de factura_electronica (puede_acceder_empresa).
    -- El service role la ignora igual que hoy con las otras tablas SIFEN.
    BEGIN
      EXECUTE format('ALTER TABLE %I.sifen_jobs ENABLE ROW LEVEL SECURITY', r.sch);

      EXECUTE format('DROP POLICY IF EXISTS "sifen_jobs_select" ON %I.sifen_jobs', r.sch);
      EXECUTE format('DROP POLICY IF EXISTS "sifen_jobs_insert" ON %I.sifen_jobs', r.sch);
      EXECUTE format('DROP POLICY IF EXISTS "sifen_jobs_update" ON %I.sifen_jobs', r.sch);
      EXECUTE format('DROP POLICY IF EXISTS "sifen_jobs_delete" ON %I.sifen_jobs', r.sch);

      EXECUTE format(
        'CREATE POLICY "sifen_jobs_select" ON %I.sifen_jobs FOR SELECT
           USING (public.puede_acceder_empresa(empresa_id))',
        r.sch
      );
      EXECUTE format(
        'CREATE POLICY "sifen_jobs_insert" ON %I.sifen_jobs FOR INSERT
           WITH CHECK (public.puede_acceder_empresa(empresa_id))',
        r.sch
      );
      EXECUTE format(
        'CREATE POLICY "sifen_jobs_update" ON %I.sifen_jobs FOR UPDATE
           USING (public.puede_acceder_empresa(empresa_id))
           WITH CHECK (public.puede_acceder_empresa(empresa_id))',
        r.sch
      );
      EXECUTE format(
        'CREATE POLICY "sifen_jobs_delete" ON %I.sifen_jobs FOR DELETE
           USING (public.puede_acceder_empresa(empresa_id))',
        r.sch
      );
    EXCEPTION WHEN undefined_function THEN
      -- Si el tenant no tiene puede_acceder_empresa (schemas legacy), dejamos
      -- la tabla sin RLS explícita. El service role igual puede leer/escribir.
      NULL;
    END;

    RAISE NOTICE 'sifen_jobs listo en schema %', r.sch;
  END LOOP;
END $$;
