const fs = require('fs');
const nodemailer = require('nodemailer');
const cheerio = require('cheerio');

const EMAIL_DESTINO = process.env.EMAIL_DESTINO;
const EMAIL_REMETENTE = process.env.EMAIL_REMETENTE;
const EMAIL_SENHA = process.env.EMAIL_SENHA;
const ARQUIVO_ESTADO = 'estado.json';
const RADAR03_URL = process.env.RADAR03_URL || 'https://doe.monitorlegislativo.com.br/controle03/';
const CASA_RADAR03 = process.env.CASA_RADAR03 || 'MG - Belo Horizonte';
const CONTROLE03_STATE_URL = process.env.CONTROLE03_STATE_URL || new URL('api/state', RADAR03_URL).toString();
const CONTROLE03_API_USER = process.env.CONTROLE03_API_USER || '';
const CONTROLE03_API_PASS = process.env.CONTROLE03_API_PASS || '';
const CONTROLE03_BASIC_AUTH = process.env.CONTROLE03_BASIC_AUTH || '';


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

function extrairEmenta($, el) {
  // Prioridade: Ementa → Assunto (Indicações) → Finalidade (+Solicitação) → Solicitação sozinha
  const ementa = extrairCampo($, el, 'Ementa:');
  if (ementa !== '-') return ementa;

  const assunto = extrairCampo($, el, 'Assunto:');
  if (assunto !== '-') return assunto;

  const finalidade = extrairCampo($, el, 'Finalidade:');
  const solicitacao = extrairCampo($, el, 'Solicitação:');

  if (finalidade !== '-') {
    return solicitacao !== '-' ? `[${solicitacao}] ${finalidade}` : finalidade;
  }
  if (solicitacao !== '-') return solicitacao;
  return '-';
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
    const ementa = extrairEmenta($, el);
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

function prioridadeTipoEmail(tipo) {
  const t = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .trim();

  if (/^(PL|PLO)(\b|$)/.test(t) || /^PROJETO DE LEI( ORDINARIA)?$/.test(t)) return 0;
  if (/^PLC(\b|$)/.test(t) || /^PROJETO DE LEI COMPLEMENTAR/.test(t)) return 1;
  if (/^PEC(\b|$)/.test(t) || /^(PROPOSTA|PROJETO) DE EMENDA (A )?CONSTITUCIONAL/.test(t)) return 2;
  return 10;
}

function compararTiposEmail(a, b) {
  const prioridadeA = prioridadeTipoEmail(a);
  const prioridadeB = prioridadeTipoEmail(b);
  if (prioridadeA !== prioridadeB) return prioridadeA - prioridadeB;
  return String(a || '').localeCompare(String(b || ''), 'pt-BR');
}


const CLIENTES_NOMES_PROPRIOS = [
  'FIRJAN', 'Red Bull', 'Sindicerv', 'Boticario',
  'Boticário', 'Grupo Boticario', 'Grupo Boticário', 'O Boticario',
  'O Boticário', 'Abrasel', 'Abrasel PB', 'Abrasel Paraíba',
  'ANBRASEL', 'Ambev', 'Heineken', 'Abralatas',
  'ABIR', 'Coca-Cola', 'Coca Cola', 'Coca-Cola Company',
  'Femsa', 'Solar', 'Grupo Simões', 'Grupo Simoes',
  'Andina', 'CVI', 'iFood', 'Zé Delivery',
  'Ze Delivery', 'Verde Brasil', 'JCRIG', 'Associação dos Cemitérios e Crematórios do Brasil',
  'Associacao dos Cemiterios e Crematorios do Brasil', 'Lalamove', 'Matrix', 'CVC',
  'Rei do Pitaco', 'Maersk', 'Mac Jee', 'Norte Energia',
  'Pacto Pela Fome', 'Sanofi', 'TikTok', 'Minalba',
  'Esmaltec', 'Nacional Gás', 'Nacional Gas', 'Syngenta',
  'Braskem', 'Ypê', 'Ype', 'VTal',
  'V.tal', 'Grupo EPR', 'EPR', 'Natural Energia',
  'DIAGEO', 'Alpargatas', 'Ternium', 'ABRADEE',
  'Eletrobras', 'Eletrobrás', 'MeetKai', 'IPQ',
  'Equatorial', 'EquatorialEnergia', 'Equatorial Energia', 'Equatorial Goiás',
  'Equatorial Goias', 'Equatorial Goiás Distribuidora de Energia', 'Equatorial Goias Distribuidora de Energia', 'CEA Equatorial',
  'CEA Equatorial Energia', 'Equtorial', 'Energisa', 'EnergisaLuz',
  'Neoenergia', 'ENEL', 'Ampla Energia', 'SABESP',
  'COMGAS', 'COMGÁS', 'AEGEA', 'Aegea Saneamento',
  'Águas de Teresina', 'Aguas de Teresina', 'Águas de Timon', 'Aguas de Timon',
  'Águas do Rio', 'Aguas do Rio', 'Águas do Rio 1', 'Águas do Rio 4',
  'Naturgy', 'Agenersa', 'Regenera', 'Comlurb',
  'Hekos', 'Orizon', 'Solvi', 'União Norte',
  'Uniao Norte', 'Vital', 'Eletromidia', 'Eletromídia',
  'AkzoNobel', 'Expedia', 'Hotels.com', 'Vrbo',
  'RTSC', 'Gramado Parks', 'Grupo Wish', 'Huawei',
  'Carrefour', 'Atacadão', 'Atacadao', 'Walmart',
  "Sam's Club", 'Sams Club', 'JBS', 'Friboi',
  'Seara', 'Swift', "Pilgrim's", 'Pilgrims',
  'Wild Fork', 'Ajinomoto', 'Vibra', 'Vibra Energia',
  'BR Distribuidora', 'Raízen', 'Raizen', 'Mindlab',
  'ABVTEX', 'Semove', 'Barcas', 'Seta',
  'Nova Infra', 'BRT'
];

function clientesCitadosNaProposicao(p) {
  const texto = [p.cliente, p.clientes, p.autor, p.autores, p.tipo, p.rotulo, p.titulo, p.identificacao, p.ementa]
    .filter(Boolean)
    .join(' ');
  const achados = [];
  for (const nome of CLIENTES_NOMES_PROPRIOS) {
    const escaped = nome.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])' + escaped + '([^A-Za-zÀ-ÿ0-9]|$)', 'i');
    if (re.test(texto) && !achados.some(a => a.toLowerCase() === nome.toLowerCase())) achados.push(nome);
  }
  return achados;
}

function anotarClientesCitados(proposicoes) {
  for (const p of proposicoes || []) {
    const clientes = clientesCitadosNaProposicao(p);
    p.clientesCitados = clientes;
    if (clientes.length && p.ementa && !String(p.ementa).includes('Cliente citado:')) {
      p.ementa = String(p.ementa).trim() + ' | Cliente citado: ' + clientes.join(', ');
    }
  }
}

function mlEscapeHtmlClienteDestaque(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function mlEscapeRegExpClienteDestaque(valor) {
  return String(valor).replace(/[.*+?^\${}()|[\]\\]/g, '\\$&');
}

function mlDestacarTermosClienteEmail(texto, clientes) {
  const nomes = Array.from(new Set([...(clientes || []), ...CLIENTES_NOMES_PROPRIOS]))
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!nomes.length) return mlEscapeHtmlClienteDestaque(texto);

  const regex = new RegExp('(^|[^A-Za-zÀ-ÿ0-9])(' + nomes.map(mlEscapeRegExpClienteDestaque).join('|') + ')(?=[^A-Za-zÀ-ÿ0-9]|$)', 'gi');
  return mlEscapeHtmlClienteDestaque(texto).replace(regex, (match, prefixo, termo) => {
    return prefixo + '<span style="background:#dbeafe;color:#1e3a8a;font-weight:700;border-radius:3px;padding:1px 3px">' + termo + '</span>';
  });
}

function renderizarEmentaCliente(p, renderBase) {
  const texto = String((p && p.ementa) || '-');
  const partes = texto.split(/\s+\|\s+Cliente citado:\s+/i);
  const ementa = renderBase
    ? renderBase(partes[0])
    : mlDestacarTermosClienteEmail(partes[0], p && p.clientesCitados);
  const clientes = partes.length > 1
    ? partes.slice(1).join(' | Cliente citado: ')
    : ((p && p.clientesCitados) || []).join(', ');

  if (!clientes) return ementa;
  return ementa + '<div style="margin-top:6px">' +
    '<span style="display:inline-block;background:#eef6ff;border:1px solid #bfdbfe;color:#1e3a8a;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700">' +
    'Cliente citado: ' + mlDestacarTermosClienteEmail(clientes, p && p.clientesCitados) +
    '</span></div>';
}


function radar03Numero(p) {
  const numero = String(p?.numero ?? p?.numero_proposicao ?? p?.num ?? '').trim();
  const ano = String(p?.ano ?? p?.ano_proposicao ?? '').trim();
  if (!numero) return '';
  if (numero.includes('/') || !ano) return numero;
  return numero + '/' + ano;
}

function radar03BlocoEmail(novas) {
  const seen = new Set();
  return (novas || []).map(p => {
    const tipo = String(p?.tipo ?? p?.sigla ?? p?.rotulo ?? '').trim();
    const numero = radar03Numero(p);
    if (!tipo || !numero) return '';
    const row = `${tipo} ${numero}`;
    const key = row.toUpperCase();
    if (seen.has(key)) return '';
    seen.add(key);
    return row;
  }).filter(Boolean).join(' | ');
}

function radar03PrimeiraFonte(novas) {
  const item = (novas || []).find(p => p?.link || p?.url || p?.fonte || p?.projeto_url);
  return item ? String(item.link || item.url || item.fonte || item.projeto_url || '') : '';
}


function radar03TipoControle(tipo) {
  const normal = String(tipo || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
  const mapa = {
    'PROJETO DE LEI': 'PL', 'PL': 'PL',
    'PROJETO DE LEI COMPLEMENTAR': 'PLC', 'PLC': 'PLC',
    'PROPOSTA DE EMENDA A CONSTITUICAO': 'PEC', 'PEC': 'PEC',
    'PROJETO DE DECRETO LEGISLATIVO': 'PDL', 'PDL': 'PDL',
    'PROJETO DE RESOLUCAO': 'PR', 'PR': 'PR',
    'INDICACAO': 'IND', 'MOCAO': 'MOC', 'REQUERIMENTO': 'REQ', 'REQ.': 'REQ',
    'REQUERIMENTO DE INFORMACAO': 'REQINF', 'RI': 'REQINF', 'VETO': 'VETO',
  };
  return mapa[normal] || String(tipo || '').trim().toUpperCase();
}

function radar03DiaUtilAtual() {
  const w = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short' }).format(new Date());
  const d = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[w] || 0;
  if (d === 0 || d === 6) return 4;
  return Math.max(0, Math.min(4, d - 1));
}

function radar03AuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  const token = CONTROLE03_BASIC_AUTH || (
    CONTROLE03_API_USER && CONTROLE03_API_PASS
      ? Buffer.from(CONTROLE03_API_USER + ':' + CONTROLE03_API_PASS).toString('base64')
      : ''
  );
  if (token) headers.Authorization = token.startsWith('Basic ') ? token : 'Basic ' + token;
  return headers;
}

function radar03AgruparNovidades(novas) {
  const porTipo = new Map();
  (novas || []).forEach(p => {
    const tipo = radar03TipoControle(p?.tipo || p?.sigla || p?.rotulo || '');
    const partes = radar03NumeroPartes(p);
    if (!tipo || !partes) return;
    const itemCaptado = {
      tipo,
      numeroInt: partes.numeroInt,
      numero: partes.numero,
      ano: partes.ano || String(p?.ano || ''),
      id: String(p?.id || p?.codigo || p?.projeto_id || p?.id_proposicao || ''),
      ementa: String(p?.ementa || p?.resumo || p?.titulo || '').trim(),
      link: String(p?.link || p?.url || p?.fonte || p?.projeto_url || '').trim(),
      clienteSugestao: Array.isArray(p?.clientesCitados) ? p.clientesCitados.join(', ') : '',
    };
    let atual = porTipo.get(tipo);
    if (!atual) {
      atual = { ...itemCaptado, itens: [] };
      porTipo.set(tipo, atual);
    }
    atual.itens.push(itemCaptado);
    if (partes.numeroInt > atual.numeroInt) {
      atual.numeroInt = partes.numeroInt;
      atual.numero = partes.numero;
      atual.ano = partes.ano || String(p?.ano || '');
      atual.id = itemCaptado.id;
      atual.ementa = itemCaptado.ementa;
      atual.link = itemCaptado.link;
      atual.clienteSugestao = itemCaptado.clienteSugestao;
    }
  });
  return Array.from(porTipo.values()).map(rec => {
    rec.itens.sort((a, b) => a.numeroInt - b.numeroInt);
    return rec;
  });
}

async function sincronizarRadar03(novas) {
  const resumo = radar03AgruparNovidades(novas);
  if (!resumo.length) return;
  try {
    const getResp = await fetch(CONTROLE03_STATE_URL, { headers: radar03AuthHeaders() });
    if (!getResp.ok) throw new Error('GET ' + getResp.status);
    const state = await getResp.json();
    if (!Array.isArray(state.data)) throw new Error('estado central vazio ou inválido');

    const data = state.data;
    let casa = data.find(item => item && item.casa === CASA_RADAR03);
    if (!casa) {
      casa = { casa: CASA_RADAR03, casaId: CASA_RADAR03, regiao: '', responsavel: '', risco: 'media', status: 'A conferir', week: ['off', 'off', 'off', 'off', 'off'], items: [] };
      data.push(casa);
    }
    if (!Array.isArray(casa.items)) casa.items = [];
    if (!Array.isArray(casa.week)) casa.week = ['off', 'off', 'off', 'off', 'off'];
    while (casa.week.length < 5) casa.week.push('off');

    resumo.forEach(rec => {
      const detalhes = Array.isArray(rec.itens) && rec.itens.length ? rec.itens : [rec];
      const existentesTipo = casa.items.filter(i => radar03TipoControle(i?.tipo || '') === rec.tipo);
      const baseAtual = existentesTipo.reduce((max, i) => {
        const n = Number.parseInt(String(i?.base || i?.mon || 0), 10) || 0;
        return Math.max(max, n);
      }, 0);

      detalhes.forEach(det => {
        let item = casa.items.find(i =>
          (det.id && i?.radar03Id === det.id) ||
          (radar03TipoControle(i?.tipo || '') === det.tipo &&
            Number.parseInt(String(i?.mon || 0), 10) === det.numeroInt &&
            String(i?.link || '') === String(det.link || ''))
        );
        if (!item) {
          item = { tipo: det.tipo, base: baseAtual, mon: det.numeroInt, radar03Id: det.id || '' };
          casa.items.push(item);
        }

        const base = Number.parseInt(String(item.base || baseAtual || 0), 10) || 0;
        item.tipo = det.tipo;
        item.mon = det.numeroInt;
        item.delta = det.numeroInt === base ? 0 : 1;
        item.sentido = det.numeroInt === base ? 'bate com o controle' : 'captado individualmente na fonte';
        item.fluxo = item.delta ? 'nao_consultado' : (item.fluxo || 'revisado');
        item.ementa = det.ementa || item.ementa || '';
        item.link = det.link || item.link || '';
        item.clienteSugestao = det.clienteSugestao || item.clienteSugestao || '';
        item.radar03Id = det.id || item.radar03Id || '';
        item.listaReal03 = true;
      });
    });

    casa.status = 'Atualizar 03';
    casa.week[radar03DiaUtilAtual()] = 'leva';
    if (!Array.isArray(casa.obs03)) casa.obs03 = [];
    casa.obs03.push({
      tipo: CASA_RADAR03,
      situacao: 'novo',
      label: 'Rodada sincronizada automaticamente na 03',
      base: resumo.map(item => item.tipo + ' ' + item.numero + (item.ano ? '/' + item.ano : '')).join(' | '),
      fonte: 'monitor-proposicoes',
      at: new Date().toISOString(),
    });

    const postResp = await fetch(CONTROLE03_STATE_URL, {
      method: 'POST', headers: radar03AuthHeaders(), body: JSON.stringify({ data }),
    });
    if (!postResp.ok) throw new Error('POST ' + postResp.status);
    console.log('✅ Radar 03 sincronizado: ' + CASA_RADAR03 + ' · ' + resumo.map(item => item.tipo + ' ' + item.numero + '/' + item.ano).join(' | '));
  } catch (err) {
    console.warn('⚠️ Não foi possível sincronizar o Radar 03 automaticamente: ' + err.message);
  }
}

function radar03ReviewUrl(novas) {
  const params = new URLSearchParams({
    casa: CASA_RADAR03,
    bloco: radar03BlocoEmail(novas),
    fonte: radar03PrimeiraFonte(novas),
  });
  return `${RADAR03_URL}?${params.toString()}`;
}

function radar03Escape(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderRadar03EmailButton(novas) {
  const bloco = radar03BlocoEmail(novas);
  if (!bloco) return '';
  return `
    <div style="background:#ecfdf3;border:1px solid #bbf7d0;border-radius:6px;padding:12px 14px;margin:14px 0;color:#14532d;font-size:13px">
      <div style="font-weight:bold;margin-bottom:6px">Radar 03 | Novas Proposições</div>
      <div style="margin-bottom:9px;color:#166534">${radar03Escape(CASA_RADAR03)} · ${radar03Escape(bloco)}</div>
      <a href="${radar03Escape(radar03ReviewUrl(novas))}" style="display:inline-block;background:#166534;color:white;text-decoration:none;border-radius:4px;padding:8px 11px;font-size:12px;font-weight:bold">Revisar no Radar 03</a>
      <span style="font-size:12px;color:#64748b;margin-left:8px">abre preenchido para confirmação</span>
    </div>
  `;
}


async function enviarEmail(novas) {
  anotarClientesCitados(novas);
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

  const linhas = Object.keys(porTipo).sort(compararTiposEmail).map(tipo => {
    const header = `<tr><td colspan="5" style="padding:10px 8px 4px;background:#f0f4f8;font-weight:bold;color:#003366;font-size:13px;border-top:2px solid #003366">${tipo} — ${porTipo[tipo].length} proposição(ões)</td></tr>`;
    const rows = porTipo[tipo]
      .sort((a, b) => (parseInt(b.numero) || 0) - (parseInt(a.numero) || 0))
      .map(p => `<tr>
        <td style="padding:8px;border-bottom:1px solid #eee;white-space:nowrap">
          <a href="${p.silLink}" style="color:#003366;font-weight:bold;text-decoration:none">${p.numero || '-'}/${p.ano || '-'}</a>
        </td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${p.autor || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px">${renderizarEmentaCliente(p)}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">${p.fase || '-'}</td>
        <td style="padding:8px;border-bottom:1px solid #eee;font-size:12px;white-space:nowrap">
          <a href="${p.silLink}" style="color:#003366">Ver tramitação</a>
        </td>
      </tr>`).join('');
    return header + rows;
  }).join('');

  const html = `
      ${renderRadar03EmailButton(novas)}
    <div style="font-family:Arial,sans-serif;max-width:1000px;margin:0 auto">
      <h2 style="color:#003366;border-bottom:2px solid #003366;padding-bottom:8px">
        🏛️ Câmara Municipal de Belo Horizonte — ${novas.length} nova(s) proposição(ões)
      </h2>
      <p style="color:#666">Monitoramento automático — ${new Date().toLocaleString('pt-BR')}</p>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#003366;color:white">
            <th style="padding:10px;text-align:left">Número/Ano</th>
            <th style="padding:10px;text-align:left">Autor</th>
            <th style="padding:10px;text-align:left">Ementa / Solicitação</th>
            <th style="padding:10px;text-align:left">Fase</th>
            <th style="padding:10px;text-align:left">Link</th>
          </tr>
        </thead>
        <tbody>${linhas}</tbody>
      </table>
      <p style="margin-top:20px;font-size:12px;color:#999">
        Acesse: <a href="https://www.cmbh.mg.gov.br/atividade-legislativa/pesquisar-proposicoes">Câmara Municipal de Belo Horizonte</a>
      </p>
    </div>
  `;

  await transporter.sendMail({
    from: `"Monitor Belo Horizonte" <${EMAIL_REMETENTE}>`,
    to: EMAIL_DESTINO,
    subject: `🏛️ Belo Horizonte: ${novas.length} nova(s) proposição(ões) — ${new Date().toLocaleDateString('pt-BR')}`,
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
    await sincronizarRadar03(novas);
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
