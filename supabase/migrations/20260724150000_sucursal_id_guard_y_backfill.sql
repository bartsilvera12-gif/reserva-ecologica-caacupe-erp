-- ============================================================================
-- Guard de sucursal_id + backfill de filas huérfanas
-- ============================================================================
--
-- PROBLEMA
-- Al implementar multi-sucursal se agregó el filtro por `sucursal_id` a las
-- LECTURAS, pero varias rutas de ESCRITURA nunca lo estamparon. Resultado:
-- filas creadas con sucursal_id NULL que ninguna pantalla filtrada muestra.
-- El síntoma que lo destapó: registrar un cobro funcionaba (la deuda quedaba
-- pagada) pero "Cobrado" seguía marcando 0.
--
-- Huérfanas detectadas: factura_electronica 56, movimientos_inventario 340,
-- producciones 108, sifen_jobs 54, cobros_clientes 2.
--
-- SOLUCIÓN
-- En vez de perseguir cada INSERT a mano (donde ya se escapó tres veces), se
-- pone el guard en la base: un trigger BEFORE INSERT que, si sucursal_id viene
-- NULL, lo DERIVA del registro padre. Cubre las rutas actuales, las futuras y
-- los jobs de fondo por igual.
--
-- No cambia comportamiento: si la fila ya trae sucursal_id, el trigger no toca
-- nada. Solo rellena lo que hoy quedaría huérfano.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1) Función genérica: deriva sucursal_id del padre según la tabla
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reservacaacupe.fn_heredar_sucursal_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_suc uuid;
BEGIN
  -- Si ya viene informada, respetarla tal cual.
  IF NEW.sucursal_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF TG_TABLE_NAME = 'factura_electronica' THEN
    SELECT f.sucursal_id INTO v_suc FROM reservacaacupe.facturas f WHERE f.id = NEW.factura_id;

  ELSIF TG_TABLE_NAME = 'sifen_jobs' THEN
    SELECT f.sucursal_id INTO v_suc FROM reservacaacupe.facturas f WHERE f.id = NEW.factura_id;

  ELSIF TG_TABLE_NAME = 'movimientos_inventario' THEN
    SELECT p.sucursal_id INTO v_suc FROM reservacaacupe.productos p WHERE p.id = NEW.producto_id;

  ELSIF TG_TABLE_NAME = 'producciones' THEN
    SELECT p.sucursal_id INTO v_suc FROM reservacaacupe.productos p WHERE p.id = NEW.producto_id;

  ELSIF TG_TABLE_NAME = 'cobros_clientes' THEN
    SELECT c.sucursal_id INTO v_suc FROM reservacaacupe.cuentas_por_cobrar c
     WHERE c.id = NEW.cuenta_por_cobrar_id;

  ELSIF TG_TABLE_NAME = 'recibos_dinero' THEN
    SELECT c.sucursal_id INTO v_suc FROM reservacaacupe.cobros_clientes c
     WHERE c.id = NEW.cobro_cliente_id;
    IF v_suc IS NULL AND NEW.venta_id IS NOT NULL THEN
      SELECT v.sucursal_id INTO v_suc FROM reservacaacupe.ventas v WHERE v.id = NEW.venta_id;
    END IF;
  END IF;

  -- Último recurso: si no hay padre resoluble, la sucursal principal de la
  -- empresa. Preferible a dejarla huérfana e invisible.
  IF v_suc IS NULL THEN
    SELECT s.id INTO v_suc FROM reservacaacupe.sucursales s
     WHERE s.empresa_id = NEW.empresa_id AND s.es_principal LIMIT 1;
  END IF;

  NEW.sucursal_id := v_suc;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2) Aplicar el trigger a las tablas afectadas
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'factura_electronica','sifen_jobs','movimientos_inventario',
    'producciones','cobros_clientes','recibos_dinero'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_heredar_sucursal ON reservacaacupe.%I', t);
    EXECUTE format(
      'CREATE TRIGGER trg_heredar_sucursal BEFORE INSERT ON reservacaacupe.%I
         FOR EACH ROW EXECUTE FUNCTION reservacaacupe.fn_heredar_sucursal_id()', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Backfill de las filas ya huérfanas
-- ---------------------------------------------------------------------------
UPDATE reservacaacupe.factura_electronica fe
   SET sucursal_id = f.sucursal_id
  FROM reservacaacupe.facturas f
 WHERE fe.factura_id = f.id AND fe.sucursal_id IS NULL AND f.sucursal_id IS NOT NULL;

UPDATE reservacaacupe.sifen_jobs sj
   SET sucursal_id = f.sucursal_id
  FROM reservacaacupe.facturas f
 WHERE sj.factura_id = f.id AND sj.sucursal_id IS NULL AND f.sucursal_id IS NOT NULL;

UPDATE reservacaacupe.movimientos_inventario m
   SET sucursal_id = p.sucursal_id
  FROM reservacaacupe.productos p
 WHERE m.producto_id = p.id AND m.sucursal_id IS NULL AND p.sucursal_id IS NOT NULL;

UPDATE reservacaacupe.producciones pr
   SET sucursal_id = p.sucursal_id
  FROM reservacaacupe.productos p
 WHERE pr.producto_id = p.id AND pr.sucursal_id IS NULL AND p.sucursal_id IS NOT NULL;

UPDATE reservacaacupe.cobros_clientes co
   SET sucursal_id = c.sucursal_id
  FROM reservacaacupe.cuentas_por_cobrar c
 WHERE co.cuenta_por_cobrar_id = c.id AND co.sucursal_id IS NULL AND c.sucursal_id IS NOT NULL;

-- Resto sin padre resoluble -> sucursal principal.
DO $$
DECLARE t text; v_suc uuid;
BEGIN
  SELECT s.id INTO v_suc FROM reservacaacupe.sucursales s WHERE s.es_principal LIMIT 1;
  FOREACH t IN ARRAY ARRAY[
    'factura_electronica','sifen_jobs','movimientos_inventario',
    'producciones','cobros_clientes','recibos_dinero'
  ] LOOP
    EXECUTE format('UPDATE reservacaacupe.%I SET sucursal_id = $1 WHERE sucursal_id IS NULL', t)
      USING v_suc;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4) Verificación: cero huérfanas en todas las tablas con sucursal_id
-- ---------------------------------------------------------------------------
DO $$
DECLARE t text; n bigint; total bigint := 0;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'ventas','facturas','factura_electronica','nota_credito','compras','gastos',
    'presupuestos','movimientos_inventario','producciones','proyectos',
    'cuentas_por_cobrar','pagos','cobros_clientes','recibos_dinero','recetas',
    'productos','categorias_productos','producto_categorias','sifen_jobs'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM reservacaacupe.%I WHERE sucursal_id IS NULL', t) INTO n;
    total := total + n;
    IF n > 0 THEN RAISE EXCEPTION 'ABORT: % quedó con % filas sin sucursal_id', t, n; END IF;
  END LOOP;
  RAISE NOTICE 'Guard OK: triggers activos y 0 filas huérfanas (%)', total;
END $$;

COMMIT;
