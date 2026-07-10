"use client";

import { useEffect, useState } from "react";

/**
 * Hook simple para leer el rol ERP del usuario actual (desde /api/me/rol).
 * Devuelve `rol=null` mientras carga o si falla la lectura — usar `loaded`
 * para diferenciar. Se comparte cache HTTP con useIsAdmin (mismo endpoint
 * sin cache-control especial; ambos hooks piden por separado, pero como es
 * `cache: no-store` no hay riesgo de stale entre pestañas).
 */
export function useRolErp(): { rol: string | null; loaded: boolean } {
  const [rol, setRol] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let cancel = false;
    fetch("/api/me/rol", { credentials: "include", cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (cancel) return;
        if (j?.success && j.data && typeof j.data.rol !== "undefined") {
          setRol(j.data.rol == null ? null : String(j.data.rol));
        }
        setLoaded(true);
      })
      .catch(() => {
        if (!cancel) setLoaded(true);
      });
    return () => {
      cancel = true;
    };
  }, []);
  return { rol, loaded };
}
