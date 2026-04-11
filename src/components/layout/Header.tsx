"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Bell, User, ChevronDown, LogOut } from "lucide-react";
import { signOut } from "@/lib/auth";

export default function Header() {
  const router = useRouter();
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
    <header className="z-40 flex h-16 shrink-0 items-center justify-end gap-3 border-b border-slate-200/90 bg-white/95 px-4 sm:px-6 shadow-[inset_0_-1px_0_0_rgba(10,37,64,0.05)] backdrop-blur-sm">
      <div className="flex items-center gap-2">
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
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[color:var(--zentra-sidebar)] text-white ring-1 ring-sky-400/35">
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
