import { NextRequest, NextResponse } from "next/server";
import { getTenantSupabaseFromAuth } from "@/lib/supabase/tenant-api";
import { successResponse, errorResponse } from "@/lib/api/response";
import { API_ERRORS } from "@/lib/api/errors";
import type { Venta, LineaVenta, TipoIvaVenta, TipoPrecioVenta } from "@/lib/ventas/types";
import { exigirSucursal, respuestaSucursalNoAsignada } from "@/lib/sucursales/filtro";

interface VentaRow {
  id: string;
  empresa_id: string;
  numero_control: string;
  moneda: string;
  tipo_cambio: number | string;
  subtotal: number | string;
  monto_iva: number | string;
  total: number | string;
  tipo_venta: string;
  plazo_dias: number | null;
  fecha: string;
}

interface VentaItemRow {
  venta_id: string;
  producto_id: string;
  producto_nombre: string;
  sku: string;
  cantidad: number | string;
  precio_venta_original: number | string;
  precio_venta: number | string;
  tipo_iva: string;
  tipo_precio?: string;
  subtotal: number | string;
  monto_iva: number | string;
  total_linea: number | string;
}

function num(v: number | string): number {
  return typeof v === "number" ? v : Number(v);
}

function mapItems(rows: VentaItemRow[]): LineaVenta[] {
  return rows.map((r) => ({
    producto_id: r.producto_id,
    producto_nombre: r.producto_nombre,
    sku: r.sku,
    cantidad: num(r.cantidad),
    precio_venta_original: num(r.precio_venta_original),
    precio_venta: num(r.precio_venta),
    tipo_iva: r.tipo_iva as TipoIvaVenta,
    tipo_precio: (r.tipo_precio === "mayorista" || r.tipo_precio === "distribuidor" || r.tipo_precio === "costo" ? r.tipo_precio : "minorista") as TipoPrecioVenta,
    subtotal: num(r.subtotal),
    monto_iva: num(r.monto_iva),
    total_linea: num(r.total_linea),
  }));
}

/** GET /api/ventas — listado vía PostgREST (compatible Hostinger sin pool). */
export async function GET(request: NextRequest) {
  try {
    const ctx = await getTenantSupabaseFromAuth(request);
    if (!ctx) return NextResponse.json(errorResponse(API_ERRORS.UNAUTHORIZED), { status: 401 });
    const empresaId = ctx.auth.empresa_id;

    const ventasQ = await ctx.supabase
      .from("ventas")
      .select(
        "id, empresa_id, numero_control, moneda, tipo_cambio, subtotal, monto_iva, total, tipo_venta, plazo_dias, metodo_pago, fecha, genera_nota_remision, nota_remision_numero, estado, anulada_at, anulacion_motivo, factura_id, cliente_id"
      )
      .eq("empresa_id", empresaId)
      .eq("sucursal_id", exigirSucursal(ctx.auth.sucursal_id))
      .order("fecha", { ascending: false })
      .limit(500);
    if (ventasQ.error) throw new Error(ventasQ.error.message);

    // Cargar nombre del cliente para las ventas asociadas a un cliente.
    // Batch por eficiencia; si el join falla se degrada silenciosamente
    // (el UI muestra "Consumidor final" cuando no hay cliente).
    const clienteIds = [
      ...new Set(
        ((ventasQ.data ?? []) as Array<{ cliente_id?: string | null }>)
          .map((v) => v.cliente_id)
          .filter((v): v is string => !!v)
      ),
    ];
    const clienteNombreByIdMap = new Map<string, string>();
    if (clienteIds.length > 0) {
      type ClienteNombreRow = {
        id: string;
        empresa?: string | null;
        nombre_contacto?: string | null;
        nombre?: string | null;
        nombre_facturacion?: string | null;
      };
      // Mismo criterio que facturas/ítems: NO se usa .in("id", clienteIds) — con
      // cientos de UUIDs la URL de PostgREST se dispara y el gateway la rechaza.
      // El error ademas se descartaba en silencio, asi que TODO el listado se
      // mostraba como "Consumidor final". Se pagina y se filtra en memoria.
      const idsCliente = new Set(clienteIds);
      const PAGE_CLI = 1000;
      // Un tenant `erp_*` puede no tener todavía las columnas más nuevas (p. ej.
      // `nombre_facturacion`): PostgREST responde 42703. En ese caso se reintenta
      // con el set mínimo que existe desde el schema inicial de clientes.
      let colsCliente = "id, empresa, nombre_contacto, nombre, nombre_facturacion";

      for (let desde = 0; ; desde += PAGE_CLI) {
        const pageQ = await ctx.supabase
          .from("clientes")
          .select(colsCliente)
          .eq("empresa_id", empresaId)
          .order("id", { ascending: true })
          .range(desde, desde + PAGE_CLI - 1);
        if (pageQ.error) {
          console.error("[/api/ventas GET] clientes:", pageQ.error.message);
          if (colsCliente !== "id, empresa, nombre_contacto") {
            colsCliente = "id, empresa, nombre_contacto";
            desde -= PAGE_CLI; // reintentar esta misma página con menos columnas
            continue;
          }
          break; // no fatal: el UI degrada al snapshot de la factura
        }
        const rows = (pageQ.data ?? []) as unknown as ClienteNombreRow[];
        for (const row of rows) {
          if (!idsCliente.has(row.id)) continue;
          const disp =
            (row.nombre_facturacion?.trim() || "") ||
            (row.empresa?.trim() || "") ||
            (row.nombre_contacto?.trim() || "") ||
            (row.nombre?.trim() || "");
          if (disp) clienteNombreByIdMap.set(row.id, disp);
        }
        if (rows.length < PAGE_CLI) break;
      }
    }

    // Cargar numero_factura para las ventas que ya tienen factura ERP. Un batch
    // por eficiencia; si el join falla, degradamos a solo id (la UI muestra "Facturada").
    const facturaIds = [
      ...new Set(
        ((ventasQ.data ?? []) as Array<{ factura_id?: string | null }>)
          .map((v) => v.factura_id)
          .filter((v): v is string => !!v)
      ),
    ];
    const facturaByIdMap = new Map<string, string>();
    const feEstadoByFacturaMap = new Map<string, string>();
    // Razón social congelada al facturar. Sirve de respaldo para la columna
    // Cliente cuando la ficha ya no se puede leer (o el cliente fue eliminado).
    const razonSocialByFacturaMap = new Map<string, string>();
    if (facturaIds.length > 0) {
      // NO se usa .in("id", facturaIds): con 155 facturas la URL de PostgREST
      // supera los 5 KB solo en ese parámetro y el gateway la rechaza. El error
      // ademas no se chequeaba, asi que fallaba EN SILENCIO — el mapa quedaba
      // vacio y toda venta facturada se mostraba como ticket. Es el mismo modo
      // de falla que ya habia roto el listado de items.
      //
      // Se pagina sobre empresa+sucursal (conjunto acotado) y se filtra en
      // memoria contra las ventas cargadas.
      const idsFactura = new Set(facturaIds);
      const PAGE_FAC = 1000;

      for (let desde = 0; ; desde += PAGE_FAC) {
        const pageQ = await ctx.supabase
          .from("facturas")
          .select("id, numero_factura, cliente_razon_social")
          .eq("empresa_id", empresaId)
          .eq("sucursal_id", exigirSucursal(ctx.auth.sucursal_id))
          .order("id", { ascending: true })
          .range(desde, desde + PAGE_FAC - 1);
        if (pageQ.error) throw new Error(pageQ.error.message);
        const rows = (pageQ.data ?? []) as Array<{
          id: string;
          numero_factura?: string | null;
          cliente_razon_social?: string | null;
        }>;
        for (const row of rows) {
          if (!idsFactura.has(row.id)) continue;
          if (row.numero_factura) facturaByIdMap.set(row.id, row.numero_factura);
          const rs = row.cliente_razon_social?.trim();
          if (rs) razonSocialByFacturaMap.set(row.id, rs);
        }
        if (rows.length < PAGE_FAC) break;
      }

      // Estado SIFEN por factura — el UI usa este dato para decidir si mostrar
      // el botón "Anular" cuando la factura quedó en error_envio/rechazado.
      for (let desde = 0; ; desde += PAGE_FAC) {
        const pageQ = await ctx.supabase
          .from("factura_electronica")
          .select("factura_id, estado_sifen")
          .eq("empresa_id", empresaId)
          .eq("sucursal_id", exigirSucursal(ctx.auth.sucursal_id))
          .order("factura_id", { ascending: true })
          .range(desde, desde + PAGE_FAC - 1);
        if (pageQ.error) break; // no fatal: sin estado SIFEN el UI degrada bien
        const rows = (pageQ.data ?? []) as Array<{ factura_id: string; estado_sifen?: string | null }>;
        for (const row of rows) {
          if (idsFactura.has(row.factura_id) && row.estado_sifen) {
            feEstadoByFacturaMap.set(row.factura_id, row.estado_sifen);
          }
        }
        if (rows.length < PAGE_FAC) break;
      }
    }

    const ventasRows = (ventasQ.data ?? []) as VentaRow[];

    // Ítems de la empresa, PAGINADO. Antes se traían sin límite: PostgREST corta
    // en 1000 filas por defecto, así que al superar las 1000 líneas (histórico
    // creciente) las ventas más nuevas aparecían "sin líneas cargadas" aunque sus
    // ítems existieran. El `.range()` en bucle trae todo sin depender de ese tope.
    //
    // Nota: NO se filtra con `.in("venta_id", [ids])` — con cientos de UUIDs la
    // URL de PostgREST se dispara (~7 KB con 171 ventas) y el gateway la rechaza,
    // rompiendo TODO el listado. Se filtran en memoria contra las ventas cargadas.
    const idsCargadas = new Set(ventasRows.map((v) => v.id));
    const itemsRows: VentaItemRow[] = [];
    const PAGE = 1000;
    for (let desde = 0; ; desde += PAGE) {
      const pageQ = await ctx.supabase
        .from("ventas_items")
        .select(
          "venta_id, producto_id, producto_nombre, sku, cantidad, precio_venta_original, precio_venta, tipo_iva, tipo_precio, subtotal, monto_iva, total_linea"
        )
        .eq("empresa_id", empresaId)
        .order("venta_id", { ascending: true })
        .range(desde, desde + PAGE - 1);
      if (pageQ.error) throw new Error(pageQ.error.message);
      const rows = (pageQ.data ?? []) as VentaItemRow[];
      for (const r of rows) if (idsCargadas.has(r.venta_id)) itemsRows.push(r);
      if (rows.length < PAGE) break;
    }

    const byVenta = new Map<string, VentaItemRow[]>();
    for (const row of itemsRows) {
      const list = byVenta.get(row.venta_id) ?? [];
      list.push(row);
      byVenta.set(row.venta_id, list);
    }

    const ventas: Venta[] = ventasRows.map((r) => {
      const lineRows = byVenta.get(r.id) ?? [];
      return {
        id: r.id,
        numero_control: r.numero_control,
        items: mapItems(lineRows),
        moneda: r.moneda === "USD" ? "USD" : "GS",
        tipo_cambio: num(r.tipo_cambio),
        subtotal: num(r.subtotal),
        monto_iva: num(r.monto_iva),
        total: num(r.total),
        tipo_venta: r.tipo_venta === "CREDITO" ? "CREDITO" : "CONTADO",
        plazo_dias: r.plazo_dias ?? undefined,
        metodo_pago: (r as unknown as { metodo_pago?: string }).metodo_pago === "tarjeta"
          ? "tarjeta"
          : (r as unknown as { metodo_pago?: string }).metodo_pago === "transferencia"
          ? "transferencia"
          : (r as unknown as { metodo_pago?: string }).metodo_pago === "efectivo"
          ? "efectivo"
          : undefined,
        genera_nota_remision: (r as unknown as { genera_nota_remision?: boolean }).genera_nota_remision === true,
        nota_remision_numero: (r as unknown as { nota_remision_numero?: string | null }).nota_remision_numero ?? null,
        fecha: r.fecha,
        estado: ((): "pendiente" | "completada" | "anulada" => {
          const e = (r as unknown as { estado?: string }).estado;
          return e === "anulada" || e === "pendiente" ? e : "completada";
        })(),
        anulada_at: (r as unknown as { anulada_at?: string | null }).anulada_at ?? null,
        anulacion_motivo: (r as unknown as { anulacion_motivo?: string | null }).anulacion_motivo ?? null,
        factura_id: ((r as unknown as { factura_id?: string | null }).factura_id) ?? null,
        numero_factura: (() => {
          const fid = (r as unknown as { factura_id?: string | null }).factura_id;
          return fid ? facturaByIdMap.get(fid) ?? null : null;
        })(),
        factura_estado_sifen: (() => {
          const fid = (r as unknown as { factura_id?: string | null }).factura_id;
          return fid ? feEstadoByFacturaMap.get(fid) ?? null : null;
        })(),
        cliente_id: ((r as unknown as { cliente_id?: string | null }).cliente_id) ?? null,
        cliente_nombre: (() => {
          const cid = (r as unknown as { cliente_id?: string | null }).cliente_id;
          const fid = (r as unknown as { factura_id?: string | null }).factura_id;
          const porFicha = cid ? clienteNombreByIdMap.get(cid) ?? null : null;
          const porFactura = fid ? razonSocialByFacturaMap.get(fid) ?? null : null;
          return porFicha ?? porFactura;
        })(),
      };
    });

    return NextResponse.json(successResponse({ ventas }));
  } catch (err) {
    const rSuc = respuestaSucursalNoAsignada(err);
    if (rSuc) return rSuc;
    console.error("[/api/ventas GET]", err instanceof Error ? err.message : err);
    return NextResponse.json(errorResponse("No se pudieron cargar las ventas."), { status: 500 });
  }
}
