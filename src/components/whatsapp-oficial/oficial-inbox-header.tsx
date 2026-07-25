"use client";

import { useCallback } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MessageCircle, LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Minimal header for the standalone official-channel shell — branding, the
 *  surface switcher and sign out. Intentionally not the full WACRM
 *  `<Header>` / `<Sidebar>` (account switcher, notifications bell, Settings
 *  link, etc.) — none of that applies to this account-less surface. */

/** As três telas do Hub. Ordem = fluxo de trabalho: primeiro se conversa,
 *  depois se cataloga o que dá para mandar, depois se dispara em massa. */
const NAV = [
  { href: "/whatsapp-oficial/inbox", label: "Inbox" },
  { href: "/whatsapp-oficial/templates", label: "Templates" },
  { href: "/whatsapp-oficial/campanhas", label: "Campanhas" },
] as const;

/** Ativo por PREFIXO, não por igualdade: `/campanhas/<uuid>` (o detalhe) tem
 *  de manter "Campanhas" marcado, senão o operador que abre uma campanha vê a
 *  navegação inteira apagada e perde a referência de onde está. */
function isRotaAtiva(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function OficialInboxHeader({ userEmail }: { userEmail: string | null }) {
  const router = useRouter();
  const pathname = usePathname();

  const handleSignOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }, [router]);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
      <div className="flex min-w-0 items-center gap-4">
        <div className="flex shrink-0 items-center gap-2">
          <MessageCircle className="h-5 w-5 text-primary" />
          <span className="hidden text-sm font-semibold sm:inline">SUNT WhatsApp Hub</span>
        </div>

        <nav aria-label="Seções do Hub" className="flex items-center gap-1">
          {NAV.map((item) => {
            const ativa = isRotaAtiva(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                // `aria-current` é o que um leitor de tela usa para anunciar
                // "página atual" — a cor sozinha não diz nada para ele.
                aria-current={ativa ? "page" : undefined}
                className={cn(
                  "rounded-md px-2.5 py-1.5 text-sm transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none",
                  ativa
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        {userEmail && (
          <span className="hidden text-xs text-muted-foreground lg:inline">{userEmail}</span>
        )}
        <Button variant="ghost" size="sm" onClick={handleSignOut}>
          <LogOut data-icon="inline-start" />
          Sair
        </Button>
      </div>
    </header>
  );
}
