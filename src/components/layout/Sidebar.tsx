"use client";

import Link from "next/link";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  LayoutDashboard,
  ShoppingCart,
  Package,
  Users,
  FileText,
  Settings,
  UserCog,
  Building2,
  ChevronDown,
  ChevronRight,
  Star,
  Sparkles,
  PanelLeftClose,
  PanelLeft,
  Receipt,
  Banknote,
  Megaphone,
  Ticket,
  MessageCircle,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { getMisModulos, getTodosModulos } from "@/lib/empresas/actions";
import type { ModuloEmpresa } from "@/lib/empresas/actions";
import { getFavoritos, toggleFavorito } from "@/lib/favorites";

type MenuItem = {
  slug: string;
  label: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  children?: { label: string; href: string; exactMatch?: boolean }[];
  showWhen?: string;
};

/** Inbox solo coincide con la ruta exacta (no operación ni historial). */
function menuChildPathActive(path: string, childHref: string, exactMatch?: boolean): boolean {
  if (path === childHref) return true;
  if (exactMatch || childHref === "/dashboard/conversaciones") return false;
  return path.startsWith(`${childHref}/`);
}

const MENU_STRUCTURE: MenuItem[] = [
  { slug: "dashboard", label: "Dashboard", href: "/", icon: LayoutDashboard },
  {
    slug: "conversaciones",
    label: "Conversaciones",
    href: "/dashboard/conversaciones",
    icon: MessageCircle,
    children: [
      { label: "Inbox", href: "/dashboard/conversaciones", exactMatch: true },
      { label: "Historial omnicanal", href: "/dashboard/conversaciones/historial" },
      { label: "Colas y agentes", href: "/dashboard/conversaciones/operacion" },
    ],
  },
  { slug: "ventas", label: "Ventas", href: "/ventas", icon: ShoppingCart },
  { slug: "inventario", label: "Inventario", href: "/inventario", icon: Package, children: [
    { label: "Productos", href: "/inventario" },
    { label: "Movimientos", href: "/inventario/movimientos" },
  ]},
  { slug: "clientes", label: "Clientes", href: "/clientes", icon: Users },
  { slug: "compras", label: "Compras", href: "/compras", icon: Package },
  { slug: "gastos", label: "Gastos", href: "/gastos", icon: Receipt },
  { slug: "pagos", label: "Pagos", href: "/pagos", icon: Banknote },
  { slug: "usuarios", label: "Usuarios", href: "/usuarios", icon: UserCog },
  { slug: "configuracion", label: "Configuración", href: "/configuracion", icon: Settings },
  { slug: "planes", label: "Planes", href: "/planes", icon: FileText },
  { slug: "gestion-clientes", label: "Gestión Clientes", href: "/gestion-clientes", icon: Users },
  { slug: "crm", label: "CRM Funnel", href: "/crm", icon: Sparkles },
  { slug: "marketing", label: "Marketing Ops", href: "/marketing", icon: Megaphone },
  { slug: "sorteos", label: "Sorteos", href: "/sorteos", icon: Ticket },
];

function NavItem({
  item,
  itemId,
  isActive,
  isFavorito,
  onToggleFavorito,
  hasAccess,
  collapsed,
  expanded,
  onToggleExpand,
}: {
  item: MenuItem;
  itemId: string;
  isActive: boolean;
  isFavorito: boolean;
  onToggleFavorito: (id: string) => void;
  hasAccess: boolean;
  collapsed: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
}) {
  const Icon = item.icon;
  const p = usePathname() ?? "";

  if (!hasAccess && item.slug !== "dashboard") return null;

  const childActive = item.children?.some((c) => menuChildPathActive(p, c.href, c.exactMatch));

  if (item.children) {
    const rowTone =
      isActive || childActive
        ? "bg-[#0EA5E9] text-white"
        : "text-slate-700 hover:bg-[#E2E8F0]";
    return (
      <div className="space-y-0.5">
        <div className={`flex items-center gap-0.5 rounded-lg text-sm font-medium transition-colors ${rowTone}`}>
          <Link
            href={item.href}
            className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5"
            title={item.label}
          >
            <Icon className={`h-5 w-5 shrink-0 ${isActive || childActive ? "text-white" : "text-slate-500"}`} />
            {!collapsed && <span className="flex-1 truncate">{item.label}</span>}
          </Link>
          {!collapsed && (
            <>
              <button
                type="button"
                onClick={() => onToggleFavorito(itemId)}
                className={`shrink-0 rounded p-0.5 ${isFavorito ? "text-amber-400" : "text-slate-400 hover:text-amber-400"}`}
                aria-label="Favorito"
              >
                <Star className={`h-4 w-4 ${isFavorito ? "fill-current" : ""}`} />
              </button>
              <button
                type="button"
                onClick={() => onToggleExpand()}
                className="shrink-0 rounded p-1 text-current hover:opacity-90"
                aria-expanded={expanded}
                aria-label={expanded ? "Contraer submenú" : "Expandir submenú"}
              >
                {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
              </button>
            </>
          )}
        </div>
        <AnimatePresence>
          {expanded && !collapsed && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden pl-4 space-y-0.5"
            >
              {item.children.map((c) => (
                <Link
                  key={c.href}
                  href={c.href}
                  className={`block rounded-lg px-3 py-2 text-sm transition-all ${
                    menuChildPathActive(p, c.href, c.exactMatch)
                      ? "bg-[#0EA5E9] text-white font-medium"
                      : "text-slate-600 hover:bg-[#E2E8F0]"
                  }`}
                >
                  {c.label}
                </Link>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    );
  }

  return (
    <Link
      href={item.href}
      className={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all ${
        isActive
          ? "bg-[#0EA5E9] text-white"
          : "text-slate-700 hover:bg-[#E2E8F0]"
      }`}
    >
      <Icon className={`h-5 w-5 shrink-0 ${isActive ? "text-white" : "text-slate-500"}`} />
      {!collapsed && (
        <>
          <span className="flex-1 truncate">{item.label}</span>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); onToggleFavorito(itemId); }}
            className={`rounded p-0.5 opacity-0 transition-opacity group-hover:opacity-100 ${
              isFavorito ? "opacity-100 text-amber-500" : "text-slate-500 hover:text-amber-500"
            }`}
          >
            <Star className={`h-4 w-4 ${isFavorito ? "fill-current" : ""}`} />
          </button>
        </>
      )}
    </Link>
  );
}

export default function Sidebar() {
  const pathname = usePathname();
  const [modulos, setModulos] = useState<ModuloEmpresa[]>([]);
  const [favoritos, setFavoritos] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({
    conversaciones: true,
    inventario: true,
    sorteos: true,
  });
  const [cargando, setCargando] = useState(true);
  const [esSuperAdmin, setEsSuperAdmin] = useState(false);

  useEffect(() => {
    setFavoritos(getFavoritos());
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function cargarMenu() {
      try {
        setCargando(true);
        const { data: { session } } = await supabase.auth.getSession();
        const user = session?.user;
        if (cancelled || !user?.email) {
          setModulos([]);
          return;
        }
        const { data: usuario } = await supabase.from("usuarios").select("rol").eq("email", user.email).single();
        const rol = usuario?.rol;
        if (!cancelled) setEsSuperAdmin(rol === "super_admin");
        const data = rol === "super_admin" ? await getTodosModulos() : await getMisModulos();
        if (cancelled) return;
        setModulos(data);
      } catch {
        if (!cancelled) setModulos([]);
      } finally {
        if (!cancelled) setCargando(false);
      }
    }
    cargarMenu();
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session?.user) cargarMenu();
      else setModulos([]);
    });
    return () => { cancelled = true; subscription.unsubscribe(); };
  }, []);

  const handleToggleFavorito = (id: string) => {
    setFavoritos(toggleFavorito(id));
  };

  const modulosSlugs = new Set(modulos.map((m) => m.slug));
  const hasAccess = (slug: string) =>
    esSuperAdmin || slug === "dashboard" || modulosSlugs.has(slug);

  const isActive = (slug: string, href: string) => {
    const p = pathname ?? "";
    if (slug === "dashboard") return p === "/";
    return p === href || p.startsWith(href + "/");
  };

  const toggleExpand = (slug: string) => {
    setExpandedItems((prev) => ({ ...prev, [slug]: !prev[slug] }));
  };

  const slugToId = (slug: string) => modulos.find((m) => m.slug === slug)?.id ?? slug;

  return (
    <motion.aside
      id="neura-sidebar"
      initial={false}
      animate={{ width: collapsed ? 80 : 260 }}
      transition={{ duration: 0.2 }}
      className="flex shrink-0 flex-col border-r border-slate-200 bg-[#F1F5F9]"
    >
      {/* Logo — casi del tamaño de la sección lateral, sin texto duplicado */}
      <div className="flex h-36 items-center justify-between gap-2 border-b border-slate-200 px-3 py-3">
        <Link href="/" className={`flex items-center justify-center min-w-0 flex-1 overflow-hidden`}>
          <div className={`relative flex items-center justify-center ${collapsed ? "h-14 w-14" : "h-28 w-full max-w-[240px]"}`}>
            <Image
              src="/neura-logo.svg"
              alt="Neura"
              width={240}
              height={120}
              className="h-full w-full object-contain object-center brightness-0"
              priority
            />
          </div>
        </Link>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="rounded-lg p-2 text-slate-500 transition-colors hover:bg-[#E2E8F0] hover:text-slate-700"
          aria-label={collapsed ? "Expandir sidebar" : "Colapsar sidebar"}
        >
          {collapsed ? <PanelLeft className="h-5 w-5" /> : <PanelLeftClose className="h-5 w-5" />}
        </button>
      </div>

      <nav className="flex-1 overflow-y-auto p-3">
        {/* Favoritos */}
        {favoritos.length > 0 && !collapsed && (
          <div className="mb-4">
            <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-[#475569]">★ Favoritos</p>
            <div className="space-y-0.5">
              {MENU_STRUCTURE.filter((item) => favoritos.includes(slugToId(item.slug))).map((item) => (
                <NavItem
                  key={item.slug}
                  item={item}
                  itemId={slugToId(item.slug)}
                  isActive={isActive(item.slug, item.href)}
                  isFavorito={true}
                  onToggleFavorito={handleToggleFavorito}
                  hasAccess={hasAccess(item.slug)}
                  collapsed={collapsed}
                  expanded={expandedItems[item.slug] ?? false}
                  onToggleExpand={() => toggleExpand(item.slug)}
                />
              ))}
            </div>
          </div>
        )}

        {/* Menú principal */}
        <div className="space-y-0.5">
          {!collapsed && (
            <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-slate-500">General</p>
          )}
          {cargando ? (
            <div className="px-3 py-2 text-sm text-[#475569] animate-pulse">Cargando…</div>
          ) : (
            MENU_STRUCTURE.filter((item) => !favoritos.includes(slugToId(item.slug))).map((item) => (
              <NavItem
                key={item.slug}
                item={item}
                itemId={slugToId(item.slug)}
                isActive={isActive(item.slug, item.href)}
                isFavorito={favoritos.includes(slugToId(item.slug))}
                onToggleFavorito={handleToggleFavorito}
                hasAccess={hasAccess(item.slug)}
                collapsed={collapsed}
                expanded={expandedItems[item.slug] ?? false}
                onToggleExpand={() => toggleExpand(item.slug)}
              />
            ))
          )}
        </div>

        {/* Admin */}
        {esSuperAdmin && (
          <div className="mt-6 pt-4 border-t border-slate-200">
            {!collapsed && (
              <p className="mb-2 px-3 text-xs font-semibold uppercase tracking-wider text-[#475569]">Admin</p>
            )}
            <Link
              href="/admin/empresas"
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-all ${
                (pathname ?? "").startsWith("/admin/empresas")
                  ? "bg-[#0EA5E9] text-white"
                  : "text-amber-600 hover:bg-[#E2E8F0]"
              }`}
            >
              <Building2 className="h-5 w-5 shrink-0" />
              {!collapsed && <span className="truncate">Admin Empresas</span>}
            </Link>
          </div>
        )}
      </nav>
    </motion.aside>
  );
}
