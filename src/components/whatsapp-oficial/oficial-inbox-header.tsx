'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Bot,
  FileText,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  MessageSquareText,
  Settings,
  Smartphone,
  Users,
  UsersRound,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

// SUNT destinations only: legacy WACRM routes use a different account model.
const NAV = [
  { href: '/whatsapp-oficial', label: 'Visão geral', icon: LayoutDashboard },
  {
    href: '/whatsapp-oficial/inbox',
    label: 'Atendimento',
    icon: MessageSquareText,
  },
  { href: '/whatsapp-oficial/contatos', label: 'Contatos', icon: UsersRound },
  { href: '/whatsapp-oficial/campanhas', label: 'Campanhas', icon: Megaphone },
  { href: '/whatsapp-oficial/templates', label: 'Templates', icon: FileText },
  { href: '/whatsapp-oficial/numeros', label: 'Números', icon: Smartphone },
  { href: '/whatsapp-oficial/sophia', label: 'Sophia', icon: Bot },
  { href: '/whatsapp-oficial/equipe', label: 'Equipe', icon: Users },
  {
    href: '/whatsapp-oficial/configuracoes',
    label: 'Configurações',
    icon: Settings,
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
  const [menuPath, setMenuPath] = useState<string | null>(null);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)');
    const closeMenu = () => setMenuPath(null);
    const closeOnDesktop = (event: MediaQueryListEvent) => {
      if (event.matches) closeMenu();
    };
    // The Sheet portal is outside the hidden mobile header. Close it on resize;
    // clear its path on history traversal so returning cannot reopen an old menu.
    desktop.addEventListener('change', closeOnDesktop);
    window.addEventListener('popstate', closeMenu);
    return () => {
      desktop.removeEventListener('change', closeOnDesktop);
      window.removeEventListener('popstate', closeMenu);
    };
  }, []);

  const handleSignOut = useCallback(async () => {
    setSaindo(true);
    try {
      const supabase = createClient();
      const { error } = await supabase.auth.signOut();
      if (error) throw error;
      router.push('/login');
      router.refresh();
    } catch {
      toast.error('Não foi possível sair da conta. Tente novamente.');
      setSaindo(false);
    }
  }, [router]);

  const navigation = (close?: () => void) => (
    <nav
      aria-label="Seções do WhatsHub"
      className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3"
    >
      {NAV.map(({ href, label, icon: Icon }) => (
        <Link
          key={href}
          href={href}
          onClick={close}
          aria-current={isRotaAtiva(pathname, href) ? 'page' : undefined}
          className={cn(
            'focus-visible:ring-ring flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm font-medium focus-visible:ring-2 focus-visible:outline-none',
            isRotaAtiva(pathname, href)
              ? 'bg-primary-soft text-foreground'
              : 'text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground'
          )}
        >
          <Icon aria-hidden="true" className="size-4 shrink-0" />
          {label}
        </Link>
      ))}
    </nav>
  );
  const brand = (
    <Link
      href="/whatsapp-oficial"
      aria-label="WhatsHub SUNT, abrir visão geral"
      className="focus-visible:ring-ring inline-flex min-h-11 min-w-0 items-center gap-2 rounded px-1 font-semibold focus-visible:ring-2 focus-visible:outline-none"
    >
      <MessageSquareText
        aria-hidden="true"
        className="text-primary size-5 shrink-0"
      />
      <span className="truncate">SUNT · WhatsHub</span>
    </Link>
  );
  const account = (
    <div className="border-sidebar-border shrink-0 space-y-2 border-t p-3">
      {userEmail && (
        <p className="text-muted-foreground truncate text-xs" title={userEmail}>
          {userEmail}
        </p>
      )}
      <Button
        variant="ghost"
        onClick={handleSignOut}
        aria-label="Sair da conta"
        aria-busy={saindo}
        disabled={saindo}
        className="min-h-11 w-full justify-start"
      >
        <LogOut aria-hidden="true" className="size-4" />
        {saindo ? 'Saindo…' : 'Sair da conta'}
      </Button>
    </div>
  );

  return (
    <>
      <aside className="border-sidebar-border bg-sidebar text-sidebar-foreground hidden h-full w-56 shrink-0 flex-col border-r lg:flex">
        <div className="border-sidebar-border shrink-0 border-b p-3">
          {brand}
        </div>
        {navigation()}
        {account}
      </aside>
      <header className="bg-sidebar text-sidebar-foreground flex h-14 shrink-0 items-center justify-between gap-2 border-b px-3 lg:hidden">
        {brand}
        <Sheet
          open={menuPath === pathname}
          onOpenChange={(open) => setMenuPath(open ? pathname : null)}
        >
          <SheetTrigger
            render={
              <Button
                variant="ghost"
                className="min-h-11 shrink-0"
                aria-label="Abrir menu de navegação"
              />
            }
          >
            <Menu aria-hidden="true" className="size-5" />
            <span>Menu</span>
          </SheetTrigger>
          <SheetContent
            side="left"
            showCloseButton={false}
            className="bg-sidebar text-sidebar-foreground gap-0"
            finalFocus={() =>
              window.matchMedia('(min-width: 1024px)').matches
                ? document.getElementById('conteudo-whathub')
                : true
            }
          >
            <SheetHeader className="border-sidebar-border shrink-0 border-b pr-14">
              <SheetTitle>WhatsHub · SUNT</SheetTitle>
              <SheetDescription>Seções e acesso à conta</SheetDescription>
            </SheetHeader>
            <SheetClose
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-2 right-2 size-11"
                  aria-label="Fechar menu de navegação"
                />
              }
            >
              <X aria-hidden="true" className="size-5" />
            </SheetClose>
            {navigation(() => setMenuPath(null))}
            {account}
          </SheetContent>
        </Sheet>
      </header>
    </>
  );
}
