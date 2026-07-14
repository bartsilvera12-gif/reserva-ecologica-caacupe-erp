-- Numeración secuencial de notas de crédito.
--
-- Problema
-- --------
-- El número de documento SIFEN de la NC (`dNumDoc`, que va dentro del CDC) se
-- generaba con un HASH DEL UUID de la nota (`numeroDocumentoNcDesdeId` en
-- rde-nc-xml.ts):
--
--     hex = uuid.slice(0,12);  n = parseInt(hex,16);  (n % 9000000) + 1000000
--
-- O sea un número pseudo-aleatorio de 7 dígitos. Consecuencias:
--   * NO es secuencial (la SET exige numeración correlativa por
--     establecimiento / punto de expedición dentro del timbrado).
--   * Dos NC podían colisionar en el mismo número.
--   * Los CDC emitidos quedaron con números como 7012750 / 7843199 / 8458769,
--     mientras las facturas numeran bien (FAC-000025 -> dNumDoc 0000025).
--
-- Solución
-- --------
-- `nota_credito.numero`: entero secuencial por empresa, asignado al crear la NC
-- (MAX+1 con reintento ante choque, mismo patrón que facturas/ventas). El XML
-- usa ESE número como dNumDoc; si falta, se aborta en vez de inventar uno.
--
-- Legado
-- ------
-- Las NC ya emitidas conservan `numero = NULL`: su dNumDoc aleatorio ya viajó a
-- la SET dentro del CDC y no se puede cambiar. Quedan como legado (su número
-- real sigue visible dentro del CDC).
--
-- Por eso la secuencia nueva ARRANCA EN 1, sin heredar esos valores. No hay
-- riesgo de colisión en la SET: los números ya usados son >= 7.012.750, así que
-- la secuencia recién chocaría tras ~7 millones de notas de crédito.
--
-- El índice único es parcial (WHERE numero IS NOT NULL) para no exigir número a
-- las filas de legado.
--
-- OJO: la tabla pertenece a `supabase_admin`. Aplicar con un rol que sea dueño
-- (con `postgres` falla: "must be owner of relation").

ALTER TABLE reservacaacupe.nota_credito
  ADD COLUMN IF NOT EXISTS numero integer;

COMMENT ON COLUMN reservacaacupe.nota_credito.numero IS
  'Número correlativo de la NC por empresa. Es el dNumDoc del CDC SIFEN. NULL = nota de legado, emitida cuando el número se derivaba de un hash del UUID.';

CREATE UNIQUE INDEX IF NOT EXISTS nota_credito_numero_empresa_uq
  ON reservacaacupe.nota_credito (empresa_id, numero)
  WHERE numero IS NOT NULL;

NOTIFY pgrst, 'reload schema';
