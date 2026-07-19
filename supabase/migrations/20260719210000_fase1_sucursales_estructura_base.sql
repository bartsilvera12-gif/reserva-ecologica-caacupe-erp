-- ============================================================================
-- FASE 1 — Estructura base multi-sucursal (Casa Matriz / Reserva Market)
-- ============================================================================
--
-- PURAMENTE ADITIVA: no cambia el comportamiento del sistema. Todas las columnas
-- `sucursal_id` nacen NULLABLE y se backfillean a Casa Matriz. Ninguna API filtra
-- todavía por sucursal (eso es Fase 2/3), así que las pantallas siguen mostrando
-- exactamente lo mismo que hoy.
--
-- DECISIONES DEL CLIENTE aplicadas acá:
--   * Catálogo SEPARADO por sucursal  -> productos / categorías / recetas llevan sucursal_id
--   * Precios distintos por sucursal  -> queda cubierto: cada sucursal tiene su fila de producto
--   * Clientes y proveedores COMPARTIDOS -> NO llevan sucursal_id
--   * Prefijo FAC- en ambas sucursales -> se cambia el único de numero_factura a
--     (empresa_id, sucursal_id, numero_factura). Fiscalmente es válido porque el
--     punto de expedición difiere (001-001 vs 001-002) y a SET solo le llegan los
--     dígitos (normalizarNumeroDocumentoSifen borra el prefijo).
--   * "Caja" es el módulo de ventas: no existen tablas de caja que separar.
--
-- NO SE TOCA EN ESTA FASE: empresa_sifen_config, XML, CDC, numeración fiscal,
-- worker SIFEN, KUDE ni el diseño de factura.
--
-- Backup previo: /root/backup_reservacaacupe_2026-07-19_2028.sql (5.2 MB,
-- 122 tablas, 122 bloques COPY, cierra con "dump complete").
--
-- Ejecutar como supabase_admin (dueño de las tablas). Todo en una transacción:
-- si algo no cuadra, aborta y no queda nada a medias.
-- ============================================================================

BEGIN;

-- Guarda: este script asume UNA sola empresa. Si hubiera más, abortar y revisar.
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM reservacaacupe.empresas;
  IF n <> 1 THEN
    RAISE EXCEPTION 'ABORT: se esperaba 1 empresa, hay %. Revisar antes de continuar.', n;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 1) Catálogo de sucursales
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reservacaacupe.sucursales (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa_id    uuid NOT NULL REFERENCES reservacaacupe.empresas(id) ON DELETE CASCADE,
  codigo        text NOT NULL,
  nombre        text NOT NULL,
  es_principal  boolean NOT NULL DEFAULT false,
  activa        boolean NOT NULL DEFAULT true,
  -- Punto de expedición SIFEN. Informativo en Fase 1: la emisión sigue leyendo
  -- empresa_sifen_config (001-001). Se usará recién en Fase 4.
  establecimiento    text,
  punto_expedicion   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sucursales_codigo_uq UNIQUE (empresa_id, codigo)
);

-- Una sola sucursal principal por empresa.
CREATE UNIQUE INDEX IF NOT EXISTS sucursales_una_principal_uq
  ON reservacaacupe.sucursales (empresa_id) WHERE es_principal;

COMMENT ON TABLE reservacaacupe.sucursales IS
  'Sucursales operativas. El punto de expedición es informativo hasta la Fase 4 (SIFEN).';

-- Filas iniciales. Casa Matriz conserva el punto actual 001-001.
INSERT INTO reservacaacupe.sucursales
  (empresa_id, codigo, nombre, es_principal, activa, establecimiento, punto_expedicion)
SELECT e.id, v.codigo, v.nombre, v.es_principal, v.activa, v.est, v.punto
  FROM reservacaacupe.empresas e
 CROSS JOIN (VALUES
    ('CASA_MATRIZ',    'Casa Matriz',     true,  true, '001', '001'),
    ('RESERVA_MARKET', 'Reserva Market',  false, true, '001', '002')
 ) AS v(codigo, nombre, es_principal, activa, est, punto)
ON CONFLICT (empresa_id, codigo) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2) Acceso de usuarios a sucursales (N:M) + sucursal por defecto
-- ---------------------------------------------------------------------------
-- La N:M define QUÉ sucursales puede ver el usuario (fuente de verdad del acceso).
-- `usuarios.sucursal_predeterminada_id` define con CUÁL arranca la sesión.
-- Backend valida siempre el default contra la N:M (Fase 2).
CREATE TABLE IF NOT EXISTS reservacaacupe.usuario_sucursales (
  usuario_id   uuid NOT NULL REFERENCES reservacaacupe.usuarios(id) ON DELETE CASCADE,
  sucursal_id  uuid NOT NULL REFERENCES reservacaacupe.sucursales(id) ON DELETE CASCADE,
  empresa_id   uuid NOT NULL REFERENCES reservacaacupe.empresas(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (usuario_id, sucursal_id)
);
CREATE INDEX IF NOT EXISTS idx_usuario_sucursales_sucursal
  ON reservacaacupe.usuario_sucursales (sucursal_id);

ALTER TABLE reservacaacupe.usuarios
  ADD COLUMN IF NOT EXISTS sucursal_predeterminada_id uuid
    REFERENCES reservacaacupe.sucursales(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 3) sucursal_id NULLABLE en tablas operativas y de catálogo
-- ---------------------------------------------------------------------------
-- Nullable a propósito: el backfill viene después y las APIs todavía no filtran.
-- El NOT NULL se evalúa recién al final de la Fase 3.
--
-- Las tablas de LÍNEAS (ventas_items, factura_items, presupuesto_items,
-- nota_credito_items, produccion_items, receta_items, *_evento) NO llevan
-- sucursal_id: heredan del encabezado. Ponerla permitiría que diverja.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    -- Transaccionales
    'ventas','facturas','factura_electronica','nota_credito','compras','gastos',
    'presupuestos','movimientos_inventario','producciones','proyectos',
    'cuentas_por_cobrar','sifen_jobs','pagos','cobros_clientes','recibos_dinero',
    -- Catálogo (separado por decisión del cliente)
    'productos','producto_categorias','categorias_productos','recetas'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE reservacaacupe.%I ADD COLUMN IF NOT EXISTS sucursal_id uuid
         REFERENCES reservacaacupe.sucursales(id) ON DELETE RESTRICT', t);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_%s_sucursal ON reservacaacupe.%I (sucursal_id)', t, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4) BACKFILL — todo lo existente queda en Casa Matriz
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_emp uuid;
  v_cm  uuid;
  t     text;
  n     bigint;
BEGIN
  SELECT id INTO v_emp FROM reservacaacupe.empresas LIMIT 1;
  SELECT id INTO v_cm  FROM reservacaacupe.sucursales
   WHERE empresa_id = v_emp AND codigo = 'CASA_MATRIZ';
  IF v_cm IS NULL THEN
    RAISE EXCEPTION 'ABORT: no se encontró la sucursal CASA_MATRIZ';
  END IF;

  FOREACH t IN ARRAY ARRAY[
    'ventas','facturas','factura_electronica','nota_credito','compras','gastos',
    'presupuestos','movimientos_inventario','producciones','proyectos',
    'cuentas_por_cobrar','sifen_jobs','pagos','cobros_clientes','recibos_dinero',
    'productos','producto_categorias','categorias_productos','recetas'
  ] LOOP
    EXECUTE format(
      'UPDATE reservacaacupe.%I SET sucursal_id = $1 WHERE sucursal_id IS NULL', t)
      USING v_cm;
    EXECUTE format(
      'SELECT count(*) FROM reservacaacupe.%I WHERE sucursal_id IS NULL', t) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION 'ABORT: % quedó con % filas sin sucursal_id', t, n;
    END IF;
  END LOOP;

  -- Todos los usuarios actuales operan en Casa Matriz.
  INSERT INTO reservacaacupe.usuario_sucursales (usuario_id, sucursal_id, empresa_id)
  SELECT u.id, v_cm, v_emp FROM reservacaacupe.usuarios u
  ON CONFLICT (usuario_id, sucursal_id) DO NOTHING;

  UPDATE reservacaacupe.usuarios
     SET sucursal_predeterminada_id = v_cm
   WHERE sucursal_predeterminada_id IS NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 5) Índices únicos: pasan a considerar la sucursal
-- ---------------------------------------------------------------------------
-- Sin esto, Reserva Market no podría reutilizar los mismos SKU/códigos de barra
-- del catálogo, ni emitir FAC-000001 (chocaría con Casa Matriz).
-- Se hace DESPUÉS del backfill: con sucursal_id ya cargado en todas las filas,
-- los nuevos únicos se cumplen sin conflicto (todo es Casa Matriz hoy).

-- productos: SKU único por sucursal
DROP INDEX IF EXISTS reservacaacupe.idx_productos_empresa_sku;
CREATE UNIQUE INDEX idx_productos_empresa_sucursal_sku
  ON reservacaacupe.productos (empresa_id, sucursal_id, sku);

-- productos: código de barras único por sucursal
DROP INDEX IF EXISTS reservacaacupe.uq_productos_codigo_barras;
CREATE UNIQUE INDEX uq_productos_codigo_barras
  ON reservacaacupe.productos (empresa_id, sucursal_id, codigo_barras)
  WHERE codigo_barras IS NOT NULL;

-- facturas: numero_factura único por sucursal (permite FAC- en ambas)
DROP INDEX IF EXISTS reservacaacupe.uq_facturas_empresa_numero;
CREATE UNIQUE INDEX uq_facturas_empresa_sucursal_numero
  ON reservacaacupe.facturas (empresa_id, sucursal_id, numero_factura);

-- nota_credito: correlativo único por sucursal
DROP INDEX IF EXISTS reservacaacupe.nota_credito_numero_empresa_uq;
CREATE UNIQUE INDEX nota_credito_numero_empresa_sucursal_uq
  ON reservacaacupe.nota_credito (empresa_id, sucursal_id, numero)
  WHERE numero IS NOT NULL;

-- categorias_productos: nombre único por sucursal. Sin esto, Reserva Market no
-- podría tener una categoría con el mismo nombre que Casa Matriz ("Bebidas",
-- "Almacén", etc.) y el clon del catálogo fallaría.
DROP INDEX IF EXISTS reservacaacupe.uq_categorias_productos_empresa_nombre;
CREATE UNIQUE INDEX uq_categorias_productos_empresa_sucursal_nombre
  ON reservacaacupe.categorias_productos (empresa_id, sucursal_id, lower(btrim(nombre)));

-- ---------------------------------------------------------------------------
-- 6) VERIFICACIÓN FINAL — aborta si algo no cuadra
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_suc int; v_us int; v_sin_acceso int; v_sin_default int;
BEGIN
  SELECT count(*) INTO v_suc FROM reservacaacupe.sucursales;
  IF v_suc <> 2 THEN RAISE EXCEPTION 'ABORT: se esperaban 2 sucursales, hay %', v_suc; END IF;

  SELECT count(*) INTO v_us FROM reservacaacupe.usuarios;
  SELECT count(*) INTO v_sin_acceso FROM reservacaacupe.usuarios u
   WHERE NOT EXISTS (SELECT 1 FROM reservacaacupe.usuario_sucursales us WHERE us.usuario_id = u.id);
  IF v_sin_acceso > 0 THEN
    RAISE EXCEPTION 'ABORT: % de % usuarios sin acceso a ninguna sucursal', v_sin_acceso, v_us;
  END IF;

  SELECT count(*) INTO v_sin_default FROM reservacaacupe.usuarios
   WHERE sucursal_predeterminada_id IS NULL;
  IF v_sin_default > 0 THEN
    RAISE EXCEPTION 'ABORT: % usuarios sin sucursal predeterminada', v_sin_default;
  END IF;

  RAISE NOTICE 'FASE 1 OK: % sucursales, % usuarios con acceso y default asignado', v_suc, v_us;
END $$;

COMMIT;
