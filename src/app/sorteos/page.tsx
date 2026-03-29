import SorteosListClient from "./SorteosListClient";
import { getSorteosVentasKpis } from "@/lib/sorteos/ventas-kpis";

export default async function SorteosPage() {
  let ventasKpis = {
    boletosHoy: 0,
    boletosMes: 0,
    montoHoy: 0,
    montoMes: 0,
  };
  try {
    ventasKpis = await getSorteosVentasKpis();
  } catch {
    /* sin sesión o error de red: KPIs en cero */
  }
  return <SorteosListClient ventasKpis={ventasKpis} />;
}
