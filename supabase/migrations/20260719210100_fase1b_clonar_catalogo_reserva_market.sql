-- ============================================================================
-- FASE 1b — Clonar el catálogo de Casa Matriz a Reserva Market
-- ============================================================================
--
-- ⚠️ NO EJECUTAR TODAVÍA. Requiere que la Fase 2 (filtrado por sucursal en las
-- APIs) esté desplegada primero.
--
-- Se intentó correr el 2026-07-19 justo después de la Fase 1 y hubo que
-- revertirlo: como ninguna API filtra por `sucursal_id` aún, `/api/productos`
-- solo filtra por `empresa_id` + `activo`, así que devolvía las 998 filas y la
-- pantalla mostraba cada producto DUPLICADO. La Fase 1 (estructura) es inocua;
-- este clon NO lo es hasta que las consultas filtren por sucursal.
--
-- Orden correcto: Fase 1 (hecha) -> Fase 2 (filtrado + deploy verificado) -> este script.
--
-- Se ejecuta DESPUÉS de 20260719210000_fase1_sucursales_estructura_base.sql.
--
-- Copia las 10 categorías y los 499 productos a Reserva Market con IDs NUEVOS,
-- de modo que cada sucursal maneje su propio stock y sus propios precios sin
-- interferir con la otra.
--
-- QUÉ SE CLONA
--   * categorias_productos (10)  -> mismos nombres, IDs nuevos
--   * productos (499)            -> IDs nuevos, precios iguales, STOCK EN 0
--   * producto_categorias (443)  -> el puente, repuntado a los clones
--
-- QUÉ **NO** SE CLONA, y por qué
--   * recetas / receta_items  -> son de producción, no de un market. Además sus
--     insumos apuntan a productos de Casa Matriz y habría que remapear la
--     explosión de insumos entera. Si el cliente después quiere producir en
--     Market, se clonan aparte con el mapa de IDs reconstruido.
--   * inventario_stock_ubicacion / ubicacion_principal_id -> las ubicaciones son
--     físicas de Casa Matriz. Los clones nacen con ubicación NULL; Market carga
--     las suyas cuando se le definan depósitos.
--   * proveedor_productos -> el vínculo se puede rearmar; proveedor_principal_id
--     SÍ se copia porque los proveedores son COMPARTIDOS entre sucursales.
--   * movimientos_inventario, ventas_items, compras -> son histórico de Casa
--     Matriz. Jamás se clonan.
--
-- REVERSIBLE: si el cliente no lo quiere, se borra con
--   DELETE FROM reservacaacupe.productos
--    WHERE sucursal_id = (SELECT id FROM reservacaacupe.sucursales WHERE codigo='RESERVA_MARKET');
-- (el puente cae solo por ON DELETE CASCADE). Seguro mientras Market no haya
-- operado todavía: si ya tiene ventas, el FK ON DELETE RESTRICT lo va a frenar.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_emp uuid; v_cm uuid; v_mk uuid;
  n_cat int; n_prod int; n_puente int; n_ya int;
BEGIN
  SELECT id INTO v_emp FROM reservacaacupe.empresas LIMIT 1;
  SELECT id INTO v_cm FROM reservacaacupe.sucursales WHERE empresa_id=v_emp AND codigo='CASA_MATRIZ';
  SELECT id INTO v_mk FROM reservacaacupe.sucursales WHERE empresa_id=v_emp AND codigo='RESERVA_MARKET';
  IF v_cm IS NULL OR v_mk IS NULL THEN
    RAISE EXCEPTION 'ABORT: faltan sucursales. ¿Se corrió la Fase 1?';
  END IF;

  -- Idempotencia: si Market ya tiene catálogo, no duplicar.
  SELECT count(*) INTO n_ya FROM reservacaacupe.productos WHERE sucursal_id = v_mk;
  IF n_ya > 0 THEN
    RAISE EXCEPTION 'ABORT: Reserva Market ya tiene % productos. Nada que clonar.', n_ya;
  END IF;

  -- ---- 1) Categorías -------------------------------------------------------
  -- parent_id se remapea al clon correspondiente (categorías anidadas).
  CREATE TEMP TABLE map_cat (origen uuid PRIMARY KEY, clon uuid NOT NULL) ON COMMIT DROP;

  WITH nuevas AS (
    INSERT INTO reservacaacupe.categorias_productos
      (id, empresa_id, sucursal_id, nombre, codigo, descripcion, parent_id, activo)
    SELECT gen_random_uuid(), c.empresa_id, v_mk, c.nombre, c.codigo, c.descripcion, NULL, c.activo
      FROM reservacaacupe.categorias_productos c
     WHERE c.sucursal_id = v_cm
    RETURNING id, lower(btrim(nombre)) AS k
  )
  INSERT INTO map_cat (origen, clon)
  SELECT o.id, n.id
    FROM reservacaacupe.categorias_productos o
    JOIN nuevas n ON n.k = lower(btrim(o.nombre))
   WHERE o.sucursal_id = v_cm;

  UPDATE reservacaacupe.categorias_productos c
     SET parent_id = m2.clon
    FROM map_cat m1
    JOIN reservacaacupe.categorias_productos o ON o.id = m1.origen
    JOIN map_cat m2 ON m2.origen = o.parent_id
   WHERE c.id = m1.clon AND o.parent_id IS NOT NULL;

  SELECT count(*) INTO n_cat FROM map_cat;

  -- ---- 2) Productos --------------------------------------------------------
  -- Stock en 0: Market todavía no recibió mercadería. Precios y costos se
  -- copian como punto de partida; el cliente los ajusta desde la pantalla.
  CREATE TEMP TABLE map_prod (origen uuid PRIMARY KEY, clon uuid NOT NULL) ON COMMIT DROP;

  WITH nuevos AS (
    INSERT INTO reservacaacupe.productos (
      id, empresa_id, sucursal_id, nombre, sku, costo_promedio, precio_venta,
      stock_actual, stock_minimo, unidad_medida, metodo_valuacion, activo,
      imagen_url, imagen_path, codigo_barras, codigo_barras_interno,
      proveedor_principal_id, categoria_principal_id, ubicacion_principal_id,
      es_insumo, es_vendible, controla_stock, valorizado,
      unidad_compra, unidad_receta, factor_compra_receta, tiempo_prep_minutos,
      descripcion, precio_mayorista, cantidad_minima_mayorista,
      precio_distribuidor, modo_receta, tipo_iva
    )
    SELECT
      gen_random_uuid(), p.empresa_id, v_mk, p.nombre, p.sku, p.costo_promedio, p.precio_venta,
      0, p.stock_minimo, p.unidad_medida, p.metodo_valuacion, p.activo,
      p.imagen_url, p.imagen_path, p.codigo_barras, p.codigo_barras_interno,
      p.proveedor_principal_id,                    -- proveedores son compartidos
      mc.clon,                                     -- categoría clonada
      NULL,                                        -- ubicación: la define Market
      p.es_insumo, p.es_vendible, p.controla_stock, p.valorizado,
      p.unidad_compra, p.unidad_receta, p.factor_compra_receta, p.tiempo_prep_minutos,
      p.descripcion, p.precio_mayorista, p.cantidad_minima_mayorista,
      p.precio_distribuidor, p.modo_receta, p.tipo_iva
    FROM reservacaacupe.productos p
    LEFT JOIN map_cat mc ON mc.origen = p.categoria_principal_id
    WHERE p.sucursal_id = v_cm
    RETURNING id, sku
  )
  INSERT INTO map_prod (origen, clon)
  SELECT o.id, n.id
    FROM reservacaacupe.productos o
    JOIN nuevos n ON n.sku IS NOT DISTINCT FROM o.sku
   WHERE o.sucursal_id = v_cm;

  SELECT count(*) INTO n_prod FROM map_prod;
  IF n_prod <> (SELECT count(*) FROM reservacaacupe.productos WHERE sucursal_id = v_cm) THEN
    RAISE EXCEPTION 'ABORT: el mapa de productos tiene % filas y el origen tiene %. SKU duplicado o nulo rompió el join.',
      n_prod, (SELECT count(*) FROM reservacaacupe.productos WHERE sucursal_id = v_cm);
  END IF;

  -- ---- 3) Puente producto ↔ categoría --------------------------------------
  INSERT INTO reservacaacupe.producto_categorias
    (id, empresa_id, sucursal_id, producto_id, categoria_id, es_principal)
  SELECT gen_random_uuid(), pc.empresa_id, v_mk, mp.clon, mc.clon, pc.es_principal
    FROM reservacaacupe.producto_categorias pc
    JOIN map_prod mp ON mp.origen = pc.producto_id
    JOIN map_cat  mc ON mc.origen = pc.categoria_id
   WHERE pc.sucursal_id = v_cm;
  GET DIAGNOSTICS n_puente = ROW_COUNT;

  RAISE NOTICE 'FASE 1b OK -> Reserva Market: % categorías, % productos (stock 0), % vínculos de categoría',
    n_cat, n_prod, n_puente;
END $$;

-- Verificación: Casa Matriz debe quedar intacta.
DO $$
DECLARE v_cm uuid; n_cm int; n_stock numeric;
BEGIN
  SELECT id INTO v_cm FROM reservacaacupe.sucursales WHERE codigo='CASA_MATRIZ';
  SELECT count(*), coalesce(sum(stock_actual),0) INTO n_cm, n_stock
    FROM reservacaacupe.productos WHERE sucursal_id = v_cm;
  IF n_cm <> 499 THEN
    RAISE EXCEPTION 'ABORT: Casa Matriz tiene % productos, se esperaban 499', n_cm;
  END IF;
  RAISE NOTICE 'Casa Matriz intacta: % productos, stock total %', n_cm, n_stock;
END $$;

COMMIT;
