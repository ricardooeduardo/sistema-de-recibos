# Portal de colaboradores e recibos

O código usa Supabase (Auth, PostgreSQL e Storage) e Netlify Functions. Em 23/11/2026, a estrutura foi aplicada ao projeto `rlvumzfuramrtkrkwfof`: cinco tabelas com RLS, funções de assinatura e bucket privado `receipt-originals`. O cadastro público está desativado. Não execute novamente a migração inicial nesse projeto.

O site configurado é `https://resilient-rolypoly-801268.netlify.app`, com retorno de ativação em `/recibos?ativar=1`. A conta `suporteadm@rochacerqueira.com.br` foi criada pelo titular e recebeu o papel administrativo após confirmação. As URLs e a chave publicável foram cadastradas no Netlify. A chave secreta foi transferida com autorização para uma variável protegida, somente no contexto de produção. A publicação do código e a homologação online ainda estão pendentes.

O plano atual do Netlify não permite limitar variáveis a Functions: o segredo fica disponível no ambiente de build e nas funções, mas não usa prefixo `VITE_` nem é incorporado ao frontend. `SECRETS_SCAN_OMIT_KEYS` contém exclusivamente `VITE_SUPABASE_URL,SUPABASE_URL,APP_URL`, que são URLs públicas; a chave secreta continua sujeita à verificação.

## 1. Criar o projeto e aplicar o banco

1. Crie um projeto em https://supabase.com/dashboard.
2. No SQL Editor, execute uma vez `supabase/migrations/202611180001_portal.sql`. Alternativamente, vincule o Supabase CLI ao projeto e use `supabase db push`.
3. Em Authentication, desabilite o cadastro público de novos usuários. As contas serão criadas pela administração do sistema.
4. Configure a URL do site e permita o redirecionamento para `https://SEU_DOMINIO/recibos` e `https://SEU_DOMINIO/recibos?ativar=1`. Para desenvolvimento, adicione os equivalentes em `http://localhost:8888`.
5. Crie o primeiro administrador em Authentication > Users usando um e-mail sob seu controle e uma senha forte. Copie o UUID e execute:

```sql
insert into public.app_admins(user_id) values ('UUID_DO_ADMINISTRADOR');
```

Não use as antigas senhas fixas do HTML. Elas foram removidas. O papel de administrador é concedido somente por esse registro no banco; não por metadados editáveis pelo usuário ou pelo armazenamento do navegador.

## 2. Configurar as variáveis

Copie `.env.example` para `.env` apenas no ambiente local e preencha:

| Variável | Onde é usada |
| --- | --- |
| `VITE_SUPABASE_URL` | URL pública do projeto, usada pelo navegador |
| `VITE_SUPABASE_ANON_KEY` | Chave publicável (ou anon) do projeto |
| `SUPABASE_URL` | Mesma URL, usada no servidor |
| `SUPABASE_SERVICE_ROLE_KEY` | Chave secreta (ou service_role), exclusivamente no servidor |
| `APP_URL` | Endereço da aplicação, sem rota, por exemplo `https://seusistema.netlify.app` |

No Netlify, cadastre as duas variáveis `VITE_` no escopo de Build; as três restantes no escopo de Functions. **Nunca coloque a chave secreta em uma variável `VITE_`, no HTML ou no Git.** `.env` está ignorado pelo Git. Configure as variáveis antes de compilar: Vite incorpora as configurações públicas no build.

## 3. Executar e publicar

```sh
npm ci
npm test
npm run build
npx netlify-cli dev
```

Use `http://localhost:8888` para testar frontend e funções juntos. `npm run dev` sozinho serve apenas a interface, sem os endpoints de criação de contas/PDF. Se a porta 5173 estiver ocupada, encerre o servidor antigo antes de `netlify dev`.

O `netlify.toml` mantém `dist` como publicação e `netlify/functions` como diretório de funções. Use Node.js 22 ou superior no ambiente de build/runtime. A publicação continua dependendo do fluxo de deploy do projeto; nenhum deploy foi realizado nesta implementação.

## 4. Criar colaboradores e ativar o acesso

1. Entre com o administrador.
2. Cadastre nome, CPF, e-mail e cargo/vínculo.
3. O servidor cria automaticamente uma conta com senha aleatória desconhecida e associa o perfil pelo UUID da conta, não pelo nome.
4. Copie o link exibido e entregue-o ao titular pelo canal interno da empresa. **O sistema não envia e-mails automaticamente.**
5. Ao abrir o link, o colaborador define sua senha e acessa `/recibos`.
6. Links expirados ou esquecimentos de senha: use **Gerar acesso** na listagem. O prazo do link é definido nas configurações do Supabase Auth. O link é sensível e deve ser entregue apenas ao titular.

O e-mail não é alterável pelo formulário de edição para evitar trocar indevidamente a titularidade da conta. A ação **Acesso** desativa ou reativa o perfil. Os recibos e assinaturas continuam no banco. Marque **Mostrar também colaboradores inativos** para reativar alguém.

## 5. Migrar os colaboradores existentes

Os nomes e CPFs que antes estavam embutidos no JavaScript foram preservados no arquivo local **`migration/legacy-collaborators.json`**, ignorado pelo Git e fora da pasta `dist`. Guarde esse backup em local restrito.

Na área de colaboradores, abra **Migrar cadastros da versão anterior**:

- No mesmo navegador/domínio da versão antiga, use **Ler cadastros deste navegador** para recuperar alterações salvas em `localStorage`.
- Ou selecione o backup JSON local.
- Escolha uma pessoa, complete seu e-mail e salve. Isso cria o acesso associado.

O backup do código representa apenas a lista que estava embutida no repositório. Alterações feitas em outros navegadores precisam ser recuperadas nesses navegadores. A migração não apaga o armazenamento antigo.

## 6. Emitir, consultar e assinar

- Ao emitir um PDF, ele é arquivado no Storage privado e associado ao colaborador, competência, data de recebimento e valor. O download local só é feito após o arquivamento confirmado.
- PDFs antigos podem ser incluídos em **Histórico de recibos > Importar PDF de outro mês**, informando os metadados do documento. O limite é 3 MB. A administração deve conferir se os dados informados correspondem ao PDF.
- O histórico permite filtrar mês e situação. O administrador consulta todos; o colaborador consulta apenas seus próprios documentos.
- Ao abrir um recibo pendente, o usuário visualiza o PDF, digita o CPF e marca a declaração confirmando o recebimento e a data/hora apresentadas pelo servidor.
- A confirmação expira em 5 minutos. O CPF deve corresponder ao destinatário registrado no momento da emissão. Após cinco erros, novas tentativas ficam bloqueadas por 15 minutos.
- A assinatura é registrada no PostgreSQL com horário efetivo do servidor, conta autenticada, nome, últimos quatro dígitos do CPF, texto/versão do aceite e SHA-256 do PDF original.
- O PDF original é preservado. Ao baixar um recibo assinado, o servidor confere o SHA-256 e acrescenta uma página com o registro de assinatura.

Este fluxo implementa confirmação eletrônica dentro da conta; não implementa certificado ICP-Brasil, integração Gov.br, assinatura desenhada ou carimbo de tempo de uma autoridade externa.

## 7. Validações e limites

`npm test` executa os testes do formulário/gerador, validação do servidor e a migração SQL em PostgreSQL local via PGlite. Os testes de banco simulam `auth.uid()` e verificam RLS, bloqueio de escrita direta, segregação de contas, CPF, consentimento, expiração, repetição e desativação. Não substituem a homologação de Auth, Storage e Netlify reais.

Antes de liberar aos colaboradores, teste no projeto configurado com duas contas fictícias: criar/ativar, entrar em `/recibos`, emitir para cada pessoa, verificar isolamento, confirmar CPF, baixar PDF assinado, desativar e reativar o acesso. Teste também links expirados e reenvio após falha de rede.

Cada tentativa de arquivamento usa um UUID: repetir a mesma requisição não cria um segundo registro. Se a resposta de rede se perder, o botão reenvia o mesmo documento enquanto a página permanecer aberta. Após recarregar, consulte o histórico antes de reemitir. Em falha entre upload e registro, a função tenta remover o objeto órfão; um encerramento abrupto do servidor pode exigir limpeza administrativa de arquivos não referenciados.

O novo portal usa as dependências de PDF/fontes/Tailwind externas que já existiam no projeto. A ausência dessas bibliotecas pode impedir renderização ou geração do PDF; o recibo não é marcado como emitido se o arquivamento falhar.

Referências: [Supabase Auth](https://supabase.com/docs/reference/javascript/auth-admin-generatelink), [políticas RLS](https://supabase.com/docs/guides/database/postgres/row-level-security), [funções PostgreSQL](https://supabase.com/docs/guides/database/functions), [Netlify Functions](https://docs.netlify.com/build/functions/configuration/).
