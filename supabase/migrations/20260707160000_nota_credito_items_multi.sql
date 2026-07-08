-- =============================================================================
-- NC Fase B — parcial por ítems + múltiples NC por factura
-- =============================================================================
-- Cambios sobre el modelo de notas de crédito de Fase 1/2:
--
-- 1) NC PARCIAL POR ÍTEMS: nueva tabla `nota_credito_items` con líneas
--    seleccionadas de la factura origen (o ajustes libres). Cada línea
--    guarda cantidad + precio_unitario + tipo_iva + subtotal + monto_iva
--    + total_linea, más el modo ('unidades' | 'monto') que eligió el
--    operador para trazabilidad.
--
-- 2) MÚLTIPLES NC POR FACTURA: se remueve el índice único parcial que
--    permitía una sola NC "activa" por factura. La validación pasa al
--    backend (create-nota-credito) sumando aprobadas + pendientes vs
--    saldo actual.
--
-- 3) NUEVA COLUMNA `nota_credito.tipo_nc` con check ('total' | 'parcial')
--    y default 'total' para retro-compatibilidad.
--
-- Idempotente. Aplica SOLO al schema `reservacaacupe`: es el único tenant
-- activo para este proyecto. Otros tenants (luciastudios, etc.) viven en la
-- misma instancia pero NO deben tocarse desde este repo.
-- =============================================================================

DO $$
DECLARE
  r RECORD;
  empresas_schema text;
  empresas_fk text;
BEGIN
  -- Resolver dónde vive la tabla `empresas` en esta instancia. Distintos
  -- despliegues Supabase tienen la tabla o bien en `zentra_erp` (multi-tenant
  -- original) o bien en `public` (deploy standalone). Si no está en ninguno
  -- de los dos, dejamos empresa_id sin FK — la app valida el empresa_id via
  -- getTenantSupabaseFromAuth antes de insertar.
  SELECT n.nspname
    INTO empresas_schema
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'empresas'
      AND c.relkind = 'r'
      AND n.nspname IN ('zentra_erp', 'public')
    ORDER BY (n.nspname = 'zentra_erp') DESC
    LIMIT 1;

  IF empresas_schema IS NOT NULL THEN
    empresas_fk := format(' REFERENCES %I.empresas(id) ON DELETE CASCADE', empresas_schema);
  ELSE
    empresas_fk := '';
    RAISE NOTICE 'Tabla empresas no encontrada en zentra_erp ni public; se crea nota_credito_items sin FK a empresas.';
  END IF;

  FOR r IN
    SELECT n.nspname AS sch
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'nota_credito'
      AND c.relkind = 'r'
      AND n.nspname = 'reservacaacupe'
  LOOP
    -- (1) tipo_nc en nota_credito
    EXECUTE format(
      'ALTER TABLE %I.nota_credito ADD COLUMN IF NOT EXISTS tipo_nc text NOT NULL DEFAULT ''total''',
      r.sch
    );
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.nota_credito ADD CONSTRAINT nota_credito_tipo_nc_check CHECK (tipo_nc IN (''total'', ''parcial''))',
        r.sch
      );
    EXCEPTION WHEN duplicate_object THEN
      NULL;
    END;
    EXECUTE format(
      'COMMENT ON COLUMN %I.nota_credito.tipo_nc IS ''Alcance de la NC: total (acredita saldo entero, sin ítems) o parcial (líneas en nota_credito_items). Default total (compat retro).''',
      r.sch
    );

    -- (2) Habilitar múltiples NC por factura: drop del UQ activo.
    -- La validación acumulada pasa al backend (sum aprobadas + pendientes <= saldo).
    EXECUTE format('DROP INDEX IF EXISTS %I.%I', r.sch, 'uq_nota_credito_factura_estado_activo');

    -- (3) Tabla de ítems. La FK a empresas se resuelve dinámicamente arriba
    -- para tolerar deploys donde la tabla vive en public o en zentra_erp.
    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS %1$s.nota_credito_items (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        empresa_id uuid NOT NULL%2$s,
        nota_credito_id uuid NOT NULL REFERENCES %1$s.nota_credito(id) ON DELETE CASCADE,
        -- Trazabilidad al item origen (nullable: puede ser un ajuste libre no
        -- ligado a una línea concreta de la factura).
        factura_item_id uuid NULL,
        producto_id uuid NULL,
        producto_nombre_snapshot text NOT NULL,
        sku_snapshot text NULL,
        cantidad numeric(14,4) NOT NULL CHECK (cantidad > 0),
        precio_unitario numeric(14,4) NOT NULL CHECK (precio_unitario >= 0),
        tipo_iva text NOT NULL CHECK (tipo_iva IN ('EXENTA', '5%%', '10%%')),
        subtotal numeric(14,2) NOT NULL,
        monto_iva numeric(14,2) NOT NULL,
        total_linea numeric(14,2) NOT NULL,
        -- Modo elegido por el operador al armar la línea. Útil para auditoría.
        --   unidades: precio_unitario fijo, cantidad libre → sistema calcula totales.
        --   monto: cantidad=1 en general, total_linea libre → sistema deriva IVA.
        modo text NOT NULL DEFAULT 'unidades' CHECK (modo IN ('unidades', 'monto')),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    $ddl$, r.sch, empresas_fk);

    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_nota_credito_items_nc ON %I.nota_credito_items (empresa_id, nota_credito_id)',
      r.sch
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_nota_credito_items_producto ON %I.nota_credito_items (empresa_id, producto_id)',
      r.sch
    );

    -- Trigger updated_at (reutiliza public.set_updated_at igual que el resto).
    EXECUTE format('DROP TRIGGER IF EXISTS nota_credito_items_updated_at ON %I.nota_credito_items', r.sch);
    EXECUTE format(
      'CREATE TRIGGER nota_credito_items_updated_at BEFORE UPDATE ON %I.nota_credito_items FOR EACH ROW EXECUTE FUNCTION public.set_updated_at()',
      r.sch
    );

    -- RLS: mismo criterio que nota_credito (puede_acceder_empresa).
    EXECUTE format('ALTER TABLE %I.nota_credito_items ENABLE ROW LEVEL SECURITY', r.sch);
    EXECUTE format(
      'DROP POLICY IF EXISTS "nota_credito_items_select" ON %I.nota_credito_items',
      r.sch
    );
    EXECUTE format(
      'CREATE POLICY "nota_credito_items_select" ON %I.nota_credito_items FOR SELECT USING (public.puede_acceder_empresa(empresa_id))',
      r.sch
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS "nota_credito_items_insert" ON %I.nota_credito_items',
      r.sch
    );
    EXECUTE format(
      'CREATE POLICY "nota_credito_items_insert" ON %I.nota_credito_items FOR INSERT WITH CHECK (public.puede_acceder_empresa(empresa_id))',
      r.sch
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS "nota_credito_items_update" ON %I.nota_credito_items',
      r.sch
    );
    EXECUTE format(
      'CREATE POLICY "nota_credito_items_update" ON %I.nota_credito_items FOR UPDATE USING (public.puede_acceder_empresa(empresa_id)) WITH CHECK (public.puede_acceder_empresa(empresa_id))',
      r.sch
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS "nota_credito_items_delete" ON %I.nota_credito_items',
      r.sch
    );
    EXECUTE format(
      'CREATE POLICY "nota_credito_items_delete" ON %I.nota_credito_items FOR DELETE USING (public.puede_acceder_empresa(empresa_id))',
      r.sch
    );

    EXECUTE format(
      'COMMENT ON TABLE %I.nota_credito_items IS ''Líneas de una NC parcial. La suma de total_linea debe coincidir con nota_credito.monto. Modo unidades = cantidad libre / precio fijo; modo monto = total_linea libre.''',
      r.sch
    );
  END LOOP;
END $$;
