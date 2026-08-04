-- ============================================================================
-- Membrete por sucursal (logo, teléfono, dirección) — aditivo
-- ============================================================================
--
-- Reserva Market tiene su propia identidad visual (logo/teléfono/dirección) en
-- los documentos imprimibles (ticket, remisión, PDFs). La Casa Matriz NO cambia:
-- sus columnas quedan NULL y los documentos caen al membrete por defecto
-- (EMPRESA_DOC). El NOMBRE legal y el RUC son los mismos (Market es sucursal).
--
-- Solo presentación: no toca datos fiscales ni de negocio. supabase_admin.
-- ============================================================================

BEGIN;

ALTER TABLE reservacaacupe.sucursales
  ADD COLUMN IF NOT EXISTS doc_logo_path text,
  ADD COLUMN IF NOT EXISTS doc_telefono  text,
  ADD COLUMN IF NOT EXISTS doc_direccion text;  -- líneas separadas por saltos de línea

-- Reserva Market (sucursal no principal): branding propio en documentos.
UPDATE reservacaacupe.sucursales
   SET doc_logo_path = '/brand/reservamarket-doc-logo.jpg',
       doc_telefono  = '0984652178',
       doc_direccion = '8 de diciembre esq. Tte Aquino' || chr(10) || 'Caacupé - Cordillera - Paraguay'
 WHERE es_principal = false;

COMMIT;
