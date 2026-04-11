"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Search, Bell, Moon, Sun, User, ChevronDown, LogOut } from "lucide-react";
import { useTheme } from "@/components/ThemeProvider";
import { signOut } from "@/lib/auth";

const PERIOD_OPTIONS = [
  { id: "hoy", label: "Hoy" },
  { id: "7d", label: "7 días" },
  { id: "30d", label: "30 días" },
  { id: "mes", label: "Mes actual" },
  { id: "anio", label: "Año" },
];

export default function Header() {
  const router = useRouter();
  const { theme, toggleTheme } = useTheme();
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState("mes");
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setUserMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <header className="z-40 flex h-16 shrink-0 items-center justify-between gap-4 border-b border-slate-200 bg-white px-6">
      {/* Buscador global */}
      <div className="flex flex-1 max-w-md">
        <div className="relative w-full">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            type="search"
            placeholder="Buscar..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-10 pr-4 text-sm text-[#0F172A] outline-none transition-colors placeholder:text-[#475569] focus:ring-2 focus:ring-[#0EA5E9] focus:border-transparent"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        {/* Selector de periodo */}
        <select
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-[#0F172A] outline-none transition-colors focus:ring-2 focus:ring-[#0EA5E9]"
        >
          {PERIOD_OPTIONS.map((opt) => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
        </select>

        {/* Toggle dark mode */}
        <button
          type="button"
          onClick={toggleTheme}
          className="flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-[#475569] transition-colors hover:bg-slate-50"
        >
          {theme === "light" ? (
            <>
              <Moon className="h-4 w-4" />
              <span className="hidden sm:inline">Oscuro</span>
            </>
          ) : (
            <>
              <Sun className="h-4 w-4" />
              <span className="hidden sm:inline">Claro</span>
            </>
          )}
        </button>

        {/* Notificaciones */}
        <button
          type="button"
          className="relative rounded-lg p-2 text-[#475569] transition-colors hover:bg-slate-50 hover:text-[#0EA5E9]"
          aria-label="Notificaciones"
        >
          <Bell className="h-5 w-5" />
          <span className="absolute -right-0.5 -top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-[#0EA5E9] text-[10px] font-bold text-white">
            0
          </span>
        </button>

        {/* Avatar + menú usuario */}
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setUserMenuOpen(!userMenuOpen)}
            className="flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 transition-colors hover:bg-slate-100"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#0EA5E9] text-white shrink-0">
              <User className="h-4 w-4" />
            </div>
            <div className="hidden text-left sm:block">
              <p className="text-sm font-medium text-[#0F172A]">Usuario</p>
              <p className="text-xs text-[#475569]">Admin</p>
            </div>
            <ChevronDown className={`h-4 w-4 text-slate-500 transition-transform ${userMenuOpen ? "rotate-180" : ""}`} />
          </button>

          <div
            className={`absolute right-0 top-full mt-1 w-48 rounded-lg border border-slate-200 bg-white py-1 shadow-lg ${
              userMenuOpen ? "block" : "hidden"
            }`}
          >
            <div className="border-b border-slate-200 px-4 py-2">
              <p className="text-sm font-medium text-[#0F172A]">Usuario</p>
              <p className="text-xs text-[#475569]">usuario@neura.com</p>
            </div>
            <button
              type="button"
              onClick={async () => {
                await signOut();
                router.push("/login");
              }}
              className="flex w-full items-center gap-2 px-4 py-2 text-sm text-[#475569] transition-colors hover:bg-slate-50 hover:text-[#0EA5E9]"
            >
              <LogOut className="h-4 w-4" />
              Cerrar sesión
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
