"use client";

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { MessageCircle, LogOut } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

/** Minimal header for the standalone official-channel inbox shell — just
 *  branding + sign out. Intentionally not the full WACRM `<Header>` /
 *  `<Sidebar>` (account switcher, notifications bell, Settings link, etc.)
 *  — none of that applies to this account-less, single-purpose surface. */
export function OficialInboxHeader({ userEmail }: { userEmail: string | null }) {
  const router = useRouter();

  const handleSignOut = useCallback(async () => {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push("/login");
  }, [router]);

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
      <div className="flex items-center gap-2">
        <MessageCircle className="h-5 w-5 text-primary" />
        <span className="text-sm font-semibold">SUNT WhatsApp Hub</span>
        <span className="text-xs text-muted-foreground">Canal oficial</span>
      </div>
      <div className="flex items-center gap-3">
        {userEmail && (
          <span className="hidden text-xs text-muted-foreground sm:inline">{userEmail}</span>
        )}
        <Button variant="ghost" size="sm" onClick={handleSignOut}>
          <LogOut data-icon="inline-start" />
          Sair
        </Button>
      </div>
    </header>
  );
}
