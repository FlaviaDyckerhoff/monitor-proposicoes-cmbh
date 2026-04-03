# 🏛️ Monitor Proposições CMBH — Câmara Municipal de Belo Horizonte

Monitora automaticamente as proposições da CMBH e envia email quando há novidades. Roda **4x por dia** via GitHub Actions (8h, 12h, 17h e 21h, horário de Brasília).

---

## Como funciona

1. GitHub Actions roda o script nos horários configurados
2. Script faz POST para `cmbh.mg.gov.br/sites/all/modules/proposicoes/pesquisar.php`
3. Parseia o HTML de resposta com cheerio (sem browser headless)
4. Compara IDs das proposições com o `estado.json`
5. Se há novas → envia email organizado por tipo
6. Salva estado atualizado no repositório

---

## Estrutura

```
monitor-proposicoes-cmbh/
├── monitor.js          # Script principal
├── package.json        # Dependências (nodemailer + cheerio)
├── estado.json         # Estado salvo automaticamente
├── README.md
└── .github/workflows/monitor.yml
```

---

## Setup

### PARTE 1 — Gmail App Password
1. Acesse myaccount.google.com/security
2. Verifique que 2FA está ativo
3. Busque "Senhas de app" → Criar → nome `monitor-cmbh`
4. Copie a senha de 16 letras

### PARTE 2 — Repositório GitHub
1. github.com → + → New repository
2. Nome: `monitor-proposicoes-cmbh` | Private
3. Upload: `monitor.js`, `package.json`, `README.md`
4. Add file → Create new file → `.github/workflows/monitor.yml` → colar conteúdo

### PARTE 3 — Secrets
Settings → Secrets and variables → Actions → New repository secret:

| Name | Valor |
|------|-------|
| `EMAIL_REMETENTE` | seu Gmail |
| `EMAIL_SENHA` | App Password (sem espaços) |
| `EMAIL_DESTINO` | email de destino |

### PARTE 4 — Testar
Actions → Monitor Proposições CMBH → Run workflow → Run workflow

O primeiro run envia todas as proposições recentes (até 210) e salva o estado.
A partir do segundo, só envia novidades.

---

## Detalhes técnicos

- **Endpoint:** `POST https://www.cmbh.mg.gov.br/sites/all/modules/proposicoes/pesquisar.php`
- **Parser:** cheerio (HTML scraping, sem Playwright)
- **ID de deduplicação:** ID interno do SILAP (extraído do HTML)
- **Limite por run:** 30 páginas × 7 itens = 210 proposições mais recentes
- **Delay entre páginas:** 1,5 segundos (respeita o servidor)
- **stormCodex:** hardcoded (verificado como estático)

---

## Ponto de atenção

O `stormCodex` (`410d41a2a8d879f46dc8675cb1ea8030`) é um hash estático no PHP da CMBH.
Se o monitor parar de funcionar com erro 0 resultados, verifique se esse valor mudou:
1. Abra a página de pesquisa no Chrome com DevTools → Network → Fetch/XHR
2. Faça uma busca qualquer
3. Verifique o campo `stormCodex` no payload
4. Se diferente, atualize a constante `STORM_CODEX` no `monitor.js`

---

## Resetar estado
1. Clique em `estado.json` → lápis
2. Substitua por: `{"proposicoes_vistas":[],"ultima_execucao":""}`
3. Commit → rode manualmente
