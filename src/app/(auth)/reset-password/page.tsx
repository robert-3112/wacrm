"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { KeyRound, CheckCircle, ArrowLeft } from "lucide-react";

/**
 * Define a senha nova depois do link do e-mail.
 *
 * Chega aqui pelo `/auth/callback`, que já trocou o `code` por uma sessão — por
 * isso a página só precisa chamar `updateUser`. Se alguém abrir a URL direto,
 * sem sessão, o aviso explica em vez de deixar o formulário falhar no envio.
 *
 * Em português porque quem usa é o time da SUNT. As outras telas de auth vieram
 * do fork em inglês; a inconsistência é conhecida e menos ruim que uma tela de
 * recuperação de senha que o usuário não lê.
 */

const MIN_SENHA = 10; // espelha o mínimo configurado no Supabase Auth

export default function ResetPasswordPage() {
  const router = useRouter();
  const supabase = createClient();

  const [senha, setSenha] = useState("");
  const [confirma, setConfirma] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [salvando, setSalvando] = useState(false);
  const [pronto, setPronto] = useState(false);
  const [temSessao, setTemSessao] = useState<boolean | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setTemSessao(Boolean(data.session)));
  }, [supabase]);

  const salvar = async (e: React.FormEvent) => {
    e.preventDefault();
    setErro(null);

    if (senha.length < MIN_SENHA) {
      setErro(`A senha precisa ter pelo menos ${MIN_SENHA} caracteres.`);
      return;
    }
    if (senha !== confirma) {
      setErro("As duas senhas não são iguais.");
      return;
    }

    setSalvando(true);
    const { error } = await supabase.auth.updateUser({ password: senha });

    if (error) {
      setErro(error.message);
      setSalvando(false);
      return;
    }

    setPronto(true);
    setSalvando(false);
    setTimeout(() => router.push("/dashboard"), 1800);
  };

  if (pronto) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md border-border bg-card">
          <CardHeader className="items-center text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
              <CheckCircle className="h-6 w-6 text-primary" />
            </div>
            <CardTitle className="text-xl text-foreground">Senha alterada</CardTitle>
            <CardDescription className="text-muted-foreground">
              Levando você para o sistema...
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <KeyRound className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-foreground">Criar uma senha nova</CardTitle>
          <CardDescription className="text-muted-foreground">
            Escolha uma senha com pelo menos {MIN_SENHA} caracteres.
          </CardDescription>
        </CardHeader>

        <CardContent>
          {temSessao === false ? (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                Este link não é mais válido — ele expira depois de um tempo e só pode ser
                usado uma vez. Peça um novo e-mail de redefinição.
              </p>
              <Button className="w-full" onClick={() => router.push("/forgot-password")}>
                Pedir um link novo
              </Button>
            </div>
          ) : (
            <form onSubmit={salvar} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="senha">Senha nova</Label>
                <Input
                  id="senha"
                  type="password"
                  autoComplete="new-password"
                  value={senha}
                  onChange={(e) => setSenha(e.target.value)}
                  required
                />
              </div>

              <div className="flex flex-col gap-2">
                <Label htmlFor="confirma">Repita a senha</Label>
                <Input
                  id="confirma"
                  type="password"
                  autoComplete="new-password"
                  value={confirma}
                  onChange={(e) => setConfirma(e.target.value)}
                  required
                />
              </div>

              {erro && <p className="text-sm text-destructive">{erro}</p>}

              <Button type="submit" className="w-full" disabled={salvando || temSessao === null}>
                {salvando ? "Salvando..." : "Salvar senha"}
              </Button>

              <Link
                href="/login"
                className="flex items-center justify-center gap-1 text-sm text-muted-foreground hover:text-foreground"
              >
                <ArrowLeft className="h-3 w-3" />
                Voltar para o login
              </Link>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
