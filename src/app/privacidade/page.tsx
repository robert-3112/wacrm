import type { Metadata } from 'next'

/**
 * Política de privacidade pública da SUNT.
 *
 * POR QUE ESTA PÁGINA EXISTE: a Meta exige uma URL de política de privacidade
 * acessível para PUBLICAR o app (developers.facebook.com → Publicar), e app não
 * publicado só recebe webhook de teste — ou seja, mensagem real de cliente nunca
 * chegaria no CRM. O site institucional (suntinvestimentos.com.br) não tem essa
 * página: as rotas /privacidade e /politica-de-privacidade devolvem a home.
 *
 * Rota estática, sem sessão e sem banco, de propósito: a Meta busca esta URL de
 * fora, sem cookie nenhum, e ela precisa responder mesmo com o resto do app fora
 * do ar.
 *
 * `robots` é sobrescrito aqui porque o layout raiz marca o app inteiro como
 * noindex (é um painel interno). Política de privacidade é o oposto disso —
 * precisa ser encontrável.
 */

const ATUALIZADA_EM = '30 de julho de 2026'
const CONTATO = 'robert@suntinvestimentos.com.br'

export const metadata: Metadata = {
  title: 'Política de Privacidade — SUNT',
  description:
    'Como a SUNT coleta, usa e protege os dados pessoais de quem entra em contato pelo WhatsApp ou pelos nossos anúncios.',
  robots: { index: true, follow: true },
}

function Secao({ titulo, children }: { titulo: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold tracking-tight text-foreground">{titulo}</h2>
      <div className="flex flex-col gap-3 text-[15px] leading-relaxed text-muted-foreground">
        {children}
      </div>
    </section>
  )
}

export default function PoliticaDePrivacidade() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-10 px-6 py-16">
      <header className="flex flex-col gap-3 border-b border-border pb-8">
        <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
          SUNT Negócios Imobiliários · CRECI 9758-J
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">
          Política de Privacidade
        </h1>
        <p className="text-[15px] leading-relaxed text-muted-foreground">
          Esta política explica quais dados pessoais a SUNT coleta quando você fala com a
          gente pelo WhatsApp ou preenche um dos nossos formulários, para que usamos esses
          dados e quais são os seus direitos.
        </p>
        <p className="text-sm text-muted-foreground">Última atualização: {ATUALIZADA_EM}.</p>
      </header>

      <Secao titulo="1. Quem somos">
        <p>
          A SUNT Negócios Imobiliários (CRECI 9758-J) é uma imobiliária que atua no litoral
          de Santa Catarina. Somos a controladora dos dados pessoais tratados nas situações
          descritas abaixo, nos termos da Lei Geral de Proteção de Dados (Lei nº
          13.709/2018).
        </p>
      </Secao>

      <Secao titulo="2. Quais dados coletamos">
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>
            <strong className="font-medium text-foreground">Identificação e contato:</strong>{' '}
            nome, número de telefone/WhatsApp e e-mail, quando você informa.
          </li>
          <li>
            <strong className="font-medium text-foreground">Conteúdo das conversas:</strong>{' '}
            as mensagens trocadas com a gente no WhatsApp, incluindo textos, imagens e
            documentos que você enviar.
          </li>
          <li>
            <strong className="font-medium text-foreground">Interesse imobiliário:</strong>{' '}
            empreendimento, tipo de imóvel, faixa de valor e outras preferências que você
            nos contar.
          </li>
          <li>
            <strong className="font-medium text-foreground">Dados de formulários de anúncio:</strong>{' '}
            quando você preenche um formulário em um anúncio nosso no Facebook ou no
            Instagram, recebemos os dados que você forneceu ali.
          </li>
          <li>
            <strong className="font-medium text-foreground">Registros técnicos:</strong>{' '}
            data e hora das mensagens e status de entrega, para operar e auditar o
            atendimento.
          </li>
        </ul>
        <p>
          Não pedimos e não precisamos de dados sensíveis (como origem racial, religião,
          saúde ou dados biométricos). Pedimos que você não envie esse tipo de informação
          pelo nosso canal.
        </p>
      </Secao>

      <Secao titulo="3. Para que usamos">
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>Responder você e conduzir o atendimento.</li>
          <li>Encaminhar seu contato a um corretor da nossa equipe.</li>
          <li>Agendar e confirmar visitas a imóveis.</li>
          <li>
            Enviar informações sobre imóveis e empreendimentos relacionados ao interesse que
            você demonstrou.
          </li>
          <li>Cumprir obrigações legais e regulatórias da atividade imobiliária.</li>
        </ul>
        <p>
          Parte do primeiro atendimento pode ser feita por um assistente automatizado. Você
          pode pedir para falar com uma pessoa a qualquer momento.
        </p>
      </Secao>

      <Secao titulo="4. Com que base legal">
        <p>
          Tratamos seus dados com base no seu <strong className="font-medium text-foreground">consentimento</strong>{' '}
          (quando você nos procura ou preenche um formulário), na{' '}
          <strong className="font-medium text-foreground">execução de contrato e de procedimentos preliminares</strong>{' '}
          a seu pedido, no <strong className="font-medium text-foreground">cumprimento de obrigação legal</strong>{' '}
          e no <strong className="font-medium text-foreground">legítimo interesse</strong> de
          oferecer imóveis compatíveis com o que você buscou — sempre respeitando suas
          expectativas e seus direitos.
        </p>
      </Secao>

      <Secao titulo="5. Com quem compartilhamos">
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>
            <strong className="font-medium text-foreground">Nossos corretores</strong>, para
            que possam atender você.
          </li>
          <li>
            <strong className="font-medium text-foreground">Meta Platforms</strong>, que
            opera o WhatsApp e os formulários de anúncio pelos quais a conversa acontece.
          </li>
          <li>
            <strong className="font-medium text-foreground">Fornecedores de tecnologia</strong>{' '}
            que hospedam nossos sistemas e nosso banco de dados, contratualmente obrigados a
            proteger essas informações e a usá-las apenas para nos prestar o serviço.
          </li>
          <li>
            <strong className="font-medium text-foreground">Construtoras e incorporadoras</strong>{' '}
            do empreendimento de seu interesse, quando isso for necessário para avançar em
            uma proposta ou reserva.
          </li>
        </ul>
        <p className="font-medium text-foreground">Não vendemos os seus dados.</p>
      </Secao>

      <Secao titulo="6. Por quanto tempo guardamos">
        <p>
          Mantemos seus dados enquanto durar o relacionamento e, depois disso, pelo prazo
          necessário para cumprir obrigações legais e para defesa em eventual processo. Você
          pode pedir a exclusão antes disso, e atenderemos no que a lei permitir.
        </p>
      </Secao>

      <Secao titulo="7. Como parar de receber mensagens">
        <p>
          A qualquer momento, responda{' '}
          <strong className="font-medium text-foreground">SAIR</strong> ou{' '}
          <strong className="font-medium text-foreground">PARAR</strong> em qualquer conversa
          nossa no WhatsApp. Registramos o pedido e paramos os envios. Você também pode
          escrever para o e-mail no fim desta página.
        </p>
      </Secao>

      <Secao titulo="8. Seus direitos">
        <p>Pela LGPD, você pode nos pedir a qualquer momento:</p>
        <ul className="flex list-disc flex-col gap-2 pl-5">
          <li>confirmação de que tratamos seus dados e acesso a eles;</li>
          <li>correção de dados incompletos, inexatos ou desatualizados;</li>
          <li>anonimização, bloqueio ou eliminação de dados desnecessários ou excessivos;</li>
          <li>portabilidade a outro fornecedor;</li>
          <li>informação sobre com quem compartilhamos seus dados;</li>
          <li>revogação do consentimento.</li>
        </ul>
        <p>
          Basta escrever para o e-mail abaixo. Responderemos no prazo previsto em lei.
        </p>
      </Secao>

      <Secao titulo="9. Segurança">
        <p>
          Nossos sistemas usam conexão criptografada, credenciais guardadas de forma cifrada
          e acesso restrito por perfil — cada corretor enxerga apenas os contatos sob sua
          responsabilidade. Nenhum sistema é infalível; se ocorrer um incidente relevante,
          comunicaremos você e a Autoridade Nacional de Proteção de Dados conforme a lei
          exige.
        </p>
      </Secao>

      <Secao titulo="10. Mudanças nesta política">
        <p>
          Podemos atualizar esta política. A data da última atualização fica sempre no topo
          da página. Mudanças relevantes serão comunicadas pelos nossos canais.
        </p>
      </Secao>

      <Secao titulo="11. Fale com a gente">
        <p>
          Dúvidas sobre esta política ou sobre seus dados:{' '}
          <a
            href={`mailto:${CONTATO}`}
            className="font-medium text-foreground underline underline-offset-4"
          >
            {CONTATO}
          </a>
        </p>
      </Secao>

      <footer className="border-t border-border pt-8 text-sm text-muted-foreground">
        SUNT Negócios Imobiliários · CRECI 9758-J · Santa Catarina, Brasil
      </footer>
    </main>
  )
}
