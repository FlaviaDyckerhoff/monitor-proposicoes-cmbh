const fs = require('fs');
const nodemailer = require('nodemailer');
const cheerio = require('cheerio');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';

const ENDPOINT = 'https://www.cmbh.mg.gov.br/sites/all/modules/proposicoes/pesquisar.php';
const STORM_CODEX = '410d41a2a8d879f46dc8675cb1ea8030';

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

async function buscarPagina(pagina, ano) {
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
    tipo: '',
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
    console.error(`❌ Erro HTTP ${response.status} na página ${pagina}`);
    return null;
  }

  return await response.text();
}

function extrairIdDoCaminho(caminho) {
  // data-caminho="http://cmbhsilint.cmbh.mg.gov.br/silinternet/servico/proposicao?id=2c907f769d129050019d209cda670eea"
  const match = caminho && caminho.match(/[?&]id=([a-f0-9]+)/i);
  return match ? match[1] : null;
}

function parsearHTML(html) {
  const $ = cheerio.load(html);
  const proposicoes = [];

  const resumo = $('.resumoResultados').text().trim();
  const matchTotal = resumo.match(/total de (\d+) itens/);
  const total = matchTotal ? parseInt(matchTotal[1]) : null;

  $('ul.lista-pesquisas > li').each((_, el) => {
    // ID via data-caminho da span.detalhar
    const caminho = $(el).find('span.detalhar[data-caminho]').first().attr('data-caminho') || '';
    const id = extrairIdDoCaminho(caminho);

    // Tipo e número: "Projeto de Lei - 763/2026"
    const titulo = $(el).find('h3 > span.detalhar').first().text().trim();
    const matchTitulo = titulo.match(/^(.+?)\s*-\s*(\d+)\/(\d+)$/);
    const tipo = matchTitulo ? matchTitulo[1].trim() : titulo;
    const numero = matchTitulo ? matchTitulo[2] : '';
    const ano = matchTitulo ? matchTitulo[3] : '';

    const extrairCampo = (label) => {
      const p = $(el).find('p').filter((_, p) => $(p).find('strong').text().includes(label)).first();
      if (!p.length) return '-';
      // Pega apenas os nós de texto diretos do <p>, ignorando o <strong>
      return p.contents().filter((_, n) => n.type === 'text').text().trim().replace(/\s+/g, ' ') || '-';
    };

    const autor = extrairCampo('Autoria:');
    const ementa = extrairCampo('Ementa:').substring(0, 200);
    const fase = extrairCampo('Fase Atual:');

    if (id) {
      proposicoes.push({ id, tipo, numero, ano, autor, ementa, fase });
    }
  });

  return { proposicoes, total };
}

async function buscarTodasProposicoes() {
  const ano = new Date().getFullYear();
  console.log(`🔍 Buscando proposições de ${ano}...`);

  const html1 = await buscarPagina(1, ano);
  if (!html1) return [];

  const { proposicoes: pag1, total } = parsearHTML(html1);
  console.log(`📊 Total de proposições: ${total}`);

  if (!total || total === 0) {
    console.log('⚠️ Resposta: ', html1.substring(0, 200));
    return pag1;
  }

  const ITENS_POR_PAGINA = 7;
  const totalPaginas = Math.ceil(total / ITENS_POR_PAGINA);
  const MAX_PAGINAS = 30;
  const paginasABuscar = Math.min(totalPaginas, MAX_PAGINAS);

  console.log(`📄 Buscando ${paginasABuscar} de ${totalPaginas} páginas...`);

  const todas = [...pag1];

  for (let p = 2; p <= paginasABuscar; p++) {
    await sleep(1500);
    const html = await buscarPagina(p, ano);
    if (!html) break;
    const { proposicoes } = parsearHTML(html);
    todas.push(...proposicoes);
    process.stdout.write(`\r📄 Página ${p}/${paginasABuscar} — ${todas.length} proposições`);
  }

  console.log(`\n✅ Total coletado: ${todas.length} proposições`);
  return todas;
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
    const header = `<tr><td colspan="4" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#003366;font-size:13px;border-top:2px solid #003366">${tipo} — ${porTipo[tipo].length} proposição(ões)</td></tr>`;
    const rows = porTipo[tipo]
      .sort((a, b) => (parseInt(b.numero) || 0) - (parseInt(a.numero) || 0))
      .map(p => `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee"><strong>${p.numero || '-'}/${p.ano || '-'}</strong></td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.autor || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.ementa || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${p.fase || '-'}</td>
      </tr>`).join('');
    return header + rows;
  }).join('');

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:900px;margin:0 auto">
      <h2 style="color:#003366;border-bottom:2px solid #003366;padding-bottom:8px">
        🏛️ CMBH — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666">Monitoramento automático — ${new Date().toLocaleString('pt-BR')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#003366;color:white">
            <th style="padding:10px;text-align:left">Número/Ano</th>
            <th style="padding:10px;text-align:left">Autor</th>
            <th style="padding:10px;text-align:left">Ementa</th>
            <th style="padding:10px;text-align:left">Fase</th>
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

  const proposicoes = await buscarTodasProposicoes();

  if (proposicoes.length === 0) {
    console.log('⚠️ Nenhuma proposição encontrada.');
    process.exit(0);
  }

  const novas = proposicoes.filter(p => !idsVistos.has(p.id));
  console.log(`🆕 Proposições novas: ${novas.length}`);

  if (novas.length > 0) {
    await enviarEmail(novas);
    novas.forEach(p => idsVistos.add(p.id));
    estado.proposicoes_vistas = Array.from(idsVistos);
  }

  estado.ultima_execucao = new Date().toISOString();
  salvarEstado(estado);
  console.log('✅ Estado salvo.');
})();
