import { describe, expect, it } from "vitest";
import { mesclarLeadsCsv, publicoAnuncioValido, serializarPeriodoCriacao } from "./campanha-nova-dialog";

describe("período de criação da campanha", () => {
  it("converte o dia local inteiro em limites UTC inclusivos", () => {
    expect(serializarPeriodoCriacao("2026-09-01", "2026-09-28")).toEqual({
      criadoDe: new Date(2026, 8, 1, 0, 0, 0, 0).toISOString(),
      criadoAte: new Date(2026, 8, 28, 23, 59, 59, 999).toISOString().replace(/\.999Z$/, ".999999Z"),
    });
  });

  it("aceita limites independentes e o mesmo dia em ambas as pontas", () => {
    expect(serializarPeriodoCriacao("", "")).toEqual({ criadoDe: undefined, criadoAte: undefined });
    expect(serializarPeriodoCriacao("2026-09-01", "").criadoAte).toBeUndefined();
    expect(serializarPeriodoCriacao("2026-09-01", "2026-09-01").criadoAte)
      .toBe(new Date(2026, 8, 1, 23, 59, 59, 999).toISOString().replace(/\.999Z$/, ".999999Z"));
  });

  it("recusa intervalo invertido e datas inexistentes", () => {
    expect(() => serializarPeriodoCriacao("2026-09-29", "2026-09-28")).toThrow("anterior");
    expect(() => serializarPeriodoCriacao("2026-02-30", "")).toThrow("válida");
    expect(() => serializarPeriodoCriacao("", "2026-13-01")).toThrow("válida");
  });
});

describe("seleção de contatos resolvidos do CSV", () => {
  it("preserva a seleção manual e inclui cada lead do CRM uma vez", () => {
    const manual = { id: "a", nome: "Ana", telefone: "5511999999999" };
    const novo = { id: "b", nome: "Bia", telefone: "5511888888888" };
    const resultado = mesclarLeadsCsv([manual], [manual, novo, novo]);
    expect(resultado.selecionados).toEqual([manual, novo]);
    expect(resultado.adicionados).toBe(1);
    expect(resultado.jaSelecionados).toBe(1);
    expect(resultado.semEspaco).toBe(0);
  });

  it("respeita o limite combinado de 500 contatos", () => {
    const atuais = Array.from({ length: 499 }, (_, index) => ({
      id: `manual-${index}`, nome: "Manual", telefone: null,
    }));
    const resolvidos = [
      { id: "csv-1", nome: "CSV 1", telefone: "5511999999999" },
      { id: "csv-2", nome: "CSV 2", telefone: "5511888888888" },
    ];
    const resultado = mesclarLeadsCsv(atuais, resolvidos);
    expect(resultado.selecionados).toHaveLength(500);
    expect(resultado.selecionados.at(-1)?.id).toBe("csv-1");
    expect(resultado.adicionados).toBe(1);
    expect(resultado.semEspaco).toBe(1);
  });
});

describe("resposta de contatos por anúncio", () => {
  it("aceita leads do CRM e recusa uma resposta que exceda o limite", () => {
    const lead = { id: "lead-1", nome: "Ana", telefone: "5511999999999" };
    expect(publicoAnuncioValido({ leads: [lead], total: 1 })).toBe(true);
    expect(publicoAnuncioValido({ leads: [lead], total: 501 })).toBe(false);
    expect(publicoAnuncioValido({ leads: [{ ...lead, id: "" }], total: 1 })).toBe(false);
  });
});
