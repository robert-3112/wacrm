'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  FileText,
  LayoutDashboard,
  LogOut,
  Megaphone,
  MessageSquareText,
  Smartphone,
  UsersRound,
} from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

// Only pages served by the SUNT schema belong here. Legacy WACRM routes use
// a different account model and must not appear as destinations in this shell.
const NAV = [
  {
    href: '/whatsapp-oficial',
    label: 'Visão geral',
    icon: LayoutDashboard,
  },
  {
    href: '/whatsapp-oficial/inbox',
    label: 'Atendimento',
    icon: MessageSquareText,
  },
  {
    href: '/whatsapp-oficial/contatos',
    label: 'Contatos',
    icon: UsersRound,
  },
  {
    href: '/whatsapp-oficial/campanhas',
    label: 'Campanhas',
    icon: Megaphone,
  },
  {
    href: '/whatsapp-oficial/templates',
    label: 'Templates',
    icon: FileText,
  },
  {
    href: '/whatsapp-oficial/numeros',
    label: 'Números',
    icon: Smartphone,
  },
] as const;

function isRotaAtiva(pathname: string, href: string): boolean {
  if (href === '/whatsapp-oficial') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function OficialInboxHeader({
  userEmail,
}: {
  userEmail: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [saindo, setSaindo] = useState(false);

  const handleSignOut = useCallback(async () => {
    setSaindo(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      router.push('/login');
    } catch {
      toast.error('Não foi possível sair da conta. Tente novamente.');
      setSaindo(false);
    }
  }, [router]);

  return (
    <header className="border-border bg-sidebar text-sidebar-foreground z-10 shrink-0 border-b">
      <div className="flex h-14 items-center justify-between gap-3 px-3 sm:px-5 xl:h-17 xl:px-6">
        <Link
          href="/whatsapp-oficial"
          aria-label="WhatsHub SUNT, abrir visão geral"
          className="focus-visible:ring-ring focus-visible:ring-offset-sidebar flex min-w-0 items-center gap-2.5 rounded-md focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
        >
          <span className="bg-primary text-primary-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
            <MessageSquareText className="size-5" aria-hidden="true" />
          </span>
          <span className="flex min-w-0 flex-col leading-tight">
            <span className="text-muted-foreground text-[10px] font-semibold tracking-[0.12em]">
              SUNT
            </span>
            <span className="truncate text-base font-semibold tracking-tight">
              WhatsHub
            </span>
          </span>
        </Link>

        <nav
          aria-label="Seções do WhatsHub"
          className="hidden h-full items-stretch xl:flex"
        >
          {NAV.map((item) => {
            const ativa = isRotaAtiva(pathname, item.href);
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={ativa ? 'page' : undefined}
                className={cn(
                  'focus-visible:ring-ring flex items-center gap-2 border-b-[3px] px-3 pt-[3px] text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset',
                  ativa
                    ? 'border-primary bg-primary-soft text-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground border-transparent'
                )}
              >
                <Icon className="size-4" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex min-w-0 items-center gap-2">
          {userEmail && (
            <span
              className="text-muted-foreground hidden max-w-32 truncate text-xs xl:inline"
              title={userEmail}
            >
              {userEmail}
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleSignOut}
            aria-label="Sair da conta"
            aria-busy={saindo}
            disabled={saindo}
            className="text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground shrink-0"
          >
            <LogOut className="size-4" aria-hidden="true" />
            <span className="hidden sm:inline">Sair</span>
          </Button>
        </div>
      </div>

      <nav
        aria-label="Seções do WhatsHub"
        className="border-sidebar-border grid h-[88px] grid-cols-3 grid-rows-2 border-t sm:h-14 sm:grid-cols-6 sm:grid-rows-1 xl:hidden"
      >
        {NAV.map((item) => {
          const ativa = isRotaAtiva(pathname, item.href);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={ativa ? 'page' : undefined}
              className={cn(
                'focus-visible:ring-ring flex min-w-0 flex-col items-center justify-center gap-0.5 border-b-[3px] pt-[3px] text-[11px] font-medium focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset sm:text-xs',
                ativa
                  ? 'border-primary bg-primary-soft text-foreground'
                  : 'text-muted-foreground hover:bg-sidebar-accent hover:text-foreground border-transparent'
              )}
            >
              <Icon className="size-4" aria-hidden="true" />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
