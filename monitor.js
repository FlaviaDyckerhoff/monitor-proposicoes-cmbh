const fs = require('fs');
const nodemailer = require('nodemailer');
const cheerio = require('cheerio');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';

const ENDPOINT = 'https://www.cmbh.mg.gov.br/sites/all/modules/proposicoes/pesquisar.php';
const STORM_CODEX = '410d41a2a8d879f46dc8675cb1ea8030';

const TIPOS = [
  { nome: 'Projeto de Lei',                      uuid: '2c907f7801d41f2001024943e5ec004a' },
  { nome: 'Indicação',                           uuid: '2c907f7801d41f200102494ac9500054' },
  { nome: 'Requerimento',                        uuid: '2c907f7801d41f20010249482bef0051' },
  { nome: 'Requerimento de Comissão',            uuid: '2c907f764335bd2b0143c0039e591b9b' },
  { nome: 'Moção',                               uuid: '2c907f7801d41f2001024948eeed0052' },
  { nome: 'Projeto de Decreto Legislativo',      uuid: '2c907f78078f0f0001084488c4bf60c4' },
  { nome: 'Projeto de Resolução',                uuid: '2c907f7801d41f20010249450ee0004d' },
  { nome: 'Proposta de Emenda à Lei Orgânica',   uuid: '2c907f7801d41f2001024946b79b004f' },
];

const MAX_PAGINAS_POR_TIPO = 5;

function carregarEstado() {
  if (fs.existsSync(ARQUIVO_ESTADO))
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf8'));
  return { proposicoes_vistas: [], ultima_execucao: '' };
}

function salvarEstado(estado) {
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function buscarPagina(pagina, ano, tipoUuid) {
  const params = new URLSearchParams({
    metodo: '',
    nomeProposicao: '',
    paginaRequerida: String(pagina),
    urlProposicao: '',
    idProposicao: '',
    buscarEmendas_proposicoes: '',
    idTipoEmenda: '',
    idTipoSubemenda: '',
    idTipoEmendaDeRedacao: '',
    drupalUsername: 'deslogado-anonimo',
    drupalEmail: '',
    buscaViaUrl: '',
    stormCodex: STORM_CODEX,
    mobile: '0',
    tipo: tipoUuid,
    numero: '[número]',
    ano: String(ano),
    buscarPorProtocolo: 'false',
    autor: '[autor]',
    assunto: '[assunto]',
    assunto2: '[assunto2]',
    fase: '[Selecione]',
    tramitando: 'Tanto faz',
  });

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'Referer': 'https://www.cmbh.mg.gov.br/atividade-legislativa/pesquisar-proposicoes',
      'Origin': 'https://www.cmbh.mg.gov.br',
      'Accept': 'text/html, */*; q=0.01',
      'Accept-Language': 'pt-BR,pt;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    console.error(`❌ Erro HTTP ${response.status}`);
    return null;
  }

  return await response.text();
}

function extrairIdDoCaminho(caminho) {
  const match = caminho && caminho.match(/[?&]id=([a-f0-9]+)/i);
  return match ? match[1] : null;
}

function extrairCampo($, el, label) {
  const p = $(el).find('p').filter((_, p) => $(p).find('strong').text().includes(label)).first();
  if (!p.length) return '-';
  return p.contents().filter((_, n) => n.type === 'text').text().trim().replace(/\s+/g, ' ') || '-';
}

function parsearHTML(html) {
  const $ = cheerio.load(html);
  const proposicoes = [];

  const resumo = $('.resumoResultados').text().trim();
  const matchTotal = resumo.match(/total de (\d+) itens/);
  const total = matchTotal ? parseInt(matchTotal[1]) : 0;

  $('ul.lista-pesquisas > li').each((_, el) => {
    const caminho = $(el).find('span.detalhar[data-caminho]').first().attr('data-caminho') || '';
    const id = extrairIdDoCaminho(caminho);
    if (!id) return;

    const titulo = $(el).find('h3 > span.detalhar').first().text().trim();
    const matchTitulo = titulo.match(/^(.+?)\s*-\s*(\d+)\/(\d+)$/);
    const tipo = matchTitulo ? matchTitulo[1].trim() : titulo;
    const numero = matchTitulo ? matchTitulo[2] : '';
    const ano = matchTitulo ? matchTitulo[3] : '';

    const autor = extrairCampo($, el, 'Autoria:');
    const fase = extrairCampo($, el, 'Fase Atual:');

    // PLs e similares têm "Ementa:"; REQ de Comissão tem "Finalidade:" + "Solicitação:"
    let ementa = extrairCampo($, el, 'Ementa:');
    if (ementa === '-') {
      const solicitacao = extrairCampo($, el, 'Solicitação:');
      const finalidade = extrairCampo($, el, 'Finalidade:');
      if (finalidade !== '-') {
        ementa = solicitacao !== '-' ? `[${solicitacao}] ${finalidade}` : finalidade;
      }
    }
    ementa = ementa.substring(0, 200);

    // Link direto para o SILAP (visualização pública da tramitação)
    const silLink = `http://cmbhsilint.cmbh.mg.gov.br/silinternet/servico/proposicao?id=${id}`;

    proposicoes.push({ id, tipo, numero, ano, autor, ementa, fase, silLink });
  });

  return { proposicoes, total };
}

async function buscarNovasPorTipo(tipoNome, tipoUuid, idsVistos, ano) {
  const novas = [];

  for (let pagina = 1; pagina <= MAX_PAGINAS_POR_TIPO; pagina++) {
    if (pagina > 1) await sleep(1200);

    const html = await buscarPagina(pagina, ano, tipoUuid);
    if (!html) break;

    const { proposicoes, total } = parsearHTML(html);
    if (proposicoes.length === 0) break;

    let encontrouConhecido = false;
    for (const p of proposicoes) {
      if (idsVistos.has(p.id)) {
        encontrouConhecido = true;
        break;
      }
      novas.push(p);
    }

    const totalPaginas = Math.ceil(total / 7);
    if (encontrouConhecido || pagina >= totalPaginas) break;
  }

  return novas;
}

async function buscarTodasNovas(idsVistos) {
  const ano = new Date().getFullYear();
  console.log(`🔍 Buscando novidades de ${ano} por tipo...`);

  const todasNovas = [];

  for (const { nome, uuid } of TIPOS) {
    process.stdout.write(`  🔎 ${nome}... `);
    const novas = await buscarNovasPorTipo(nome, uuid, idsVistos, ano);
    if (novas.length > 0) {
      console.log(`${novas.length} nova(s)`);
      todasNovas.push(...novas);
    } else {
      console.log('nenhuma');
    }
    await sleep(800);
  }

  console.log(`\n✅ Total de proposições novas: ${todasNovas.length}`);
  return todasNovas;
}

async function enviarEmail(novas) {
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_REMETENTE, pass: EMAIL_SENHA },
  });

  const porTipo = {};
  novas.forEach(p => {
    const tipo = p.tipo || 'OUTROS';
    if (!porTipo[tipo]) porTipo[tipo] = [];
    porTipo[tipo].push(p);
  });

  const linhas = Object.keys(porTipo).sort().map(tipo => {
    const header = `<tr><td colspan="5" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#003366;font-size:13px;border-top:2px solid #003366">${tipo} — ${porTipo[tipo].length} proposição(ões)</td></tr>`;
    const rows = porTipo[tipo]
      .sort((a, b) => (parseInt(b.numero) || 0) - (parseInt(a.numero) || 0))
      .map(p => `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap">
          <a href="${p.silLink}" style="color:#003366;font-weight:bold;text-decoration:none">${p.numero || '-'}/${p.ano || '-'}</a>
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.autor || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.ementa || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${p.fase || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">
          <a href="${p.silLink}" style="color:#003366">Ver tramitação</a>
        </td>
      </tr>`).join('');
    return header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:1000px;margin:0 auto">
      <h2 style="color:#003366;border-bottom:2px solid #003366;padding-bottom:8px">
        🏛️ CMBH — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666">Monitoramento automático — ${new Date().toLocaleString('pt-BR')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#003366;color:white">
            <th style="padding:10px;text-align:left">Número/Ano</th>
            <th style="padding:10px;text-align:left">Autor</th>
            <th style="padding:10px;text-align:left">Ementa / Finalidade</th>
            <th style="padding:10px;text-align:left">Fase</th>
            <th style="padding:10px;text-align:left">Link</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Acesse: <a href="https://www.cmbh.mg.gov.br/atividade-legislativa/pesquisar-proposicoes">cmbh.mg.gov.br</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor CMBH" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ CMBH: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
    html,
  });

  console.log(`✅ Email enviado com ${novas.length} proposições novas.`);
}

(async () => {
  console.log('🚀 Iniciando monitor CMBH...');
  console.log(`⏰ ${new Date().toLocaleString('pt-BR')}`);

  const estado = carregarEstado();
  const idsVistos = new Set(estado.proposicoes_vistas);

  const novas = await buscarTodasNovas(idsVistos);

  if (novas.length > 0) {
    await enviarEmail(novas);
    novas.forEach(p => idsVistos.add(p.id));
    estado.proposicoes_vistas = Array.from(idsVistos);
  } else {
    console.log('✅ Sem novidades.');
  }

  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
  console.log('✅ Estado salvo.');
})();
