# Monitor CMBH — Câmara Municipal de Belo Horizonte

## Visão geral
Monitor automático de proposições da CMBH via scraping HTML.
Roda 4x/dia via GitHub Actions e envia email com novidades.

## Stack
- Node.js + cheerio (scraping HTML) + nodemailer
- Endpoint: POST https://www.cmbh.mg.gov.br/sites/all/modules/proposicoes/pesquisar.php
- Autenticação: nenhuma. Campo stormCodex é estático: 410d41a2a8d879f46dc8675cb1ea8030

## Problema conhecido — PLs não aparecem
Causa: estado.json acumula IDs do primeiro run e bloqueia detecção de novidades por tipo.
Solução: zerar proposicoes_vistas no estado.json e fazer push.

## Campos por tipo de proposição
- Projeto de Lei → Ementa:
- Indicação → Assunto:
- Requerimento de Comissão → [Solicitação] Finalidade:
- Requerimento simples → Solicitação:
- Moção, PDL, PELO, Proj. Resolução → Ementa:

## UUIDs dos tipos (confirmados via DevTools)
- Projeto de Lei: 2c907f7801d41f2001024943e5ec004a
- Indicação: 2c907f7801d41f200102494ac9500054
- Requerimento: 2c907f7801d41f20010249482bef0051
- Requerimento de Comissão: 2c907f764335bd2b0143c0039e591b9b
- Moção: 2c907f7801d41f2001024948eeed0052
- Projeto de Decreto Legislativo: 2c907f78078f0f0001084488c4bf60c4
- Projeto de Resolução: 2c907f7801d41f20010249450ee0004d
- Proposta de Emenda à Lei Orgânica: 2c907f7801d41f2001024946b79b004f

## Paginação
7 itens por página. Script busca até 5 páginas por tipo, parando quando encontra ID já visto.

## Reset de estado
Se necessário reprocessar tudo:
echo '{"proposicoes_vistas":[],"ultima_execucao":""}' > estado.json
git add estado.json && git commit -m "fix: reset estado" && git push
