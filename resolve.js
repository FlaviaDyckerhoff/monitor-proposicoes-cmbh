const cheerio = require('cheerio');

const ENDPOINT = 'https://www.cmbh.mg.gov.br/sites/all/modules/proposicoes/pesquisar.php';
const STORM_CODEX = '410d41a2a8d879f46dc8675cb1ea8030';
const TYPE_UUID = {
  PL: '2c907f7801d41f2001024943e5ec004a',
  REQCOM: '2c907f764335bd2b0143c0039e591b9b',
};

function parseTargets(raw) {
  return String(raw || '').split(/[\n,;]+/).map(v => v.trim()).filter(Boolean).map(value => {
    const match = value.match(/^(PL|REQCOM)\s*[:/]\s*(\d+)\s*[:/]\s*(\d{4})$/i);
    if (!match) throw new Error(`Alvo inválido: ${value}. Use PL:738:2026.`);
    return { type: match[1].toUpperCase(), number: match[2], year: match[3] };
  });
}

async function resolveTarget(target) {
  const params = new URLSearchParams({
    metodo: '', nomeProposicao: '', paginaRequerida: '1', urlProposicao: '', idProposicao: '',
    buscarEmendas_proposicoes: '', idTipoEmenda: '', idTipoSubemenda: '', idTipoEmendaDeRedacao: '',
    drupalUsername: 'deslogado-anonimo', drupalEmail: '', buscaViaUrl: '', stormCodex: STORM_CODEX,
    mobile: '0', tipo: TYPE_UUID[target.type], numero: target.number, ano: target.year,
    buscarPorProtocolo: 'false', autor: '[autor]', assunto: '[assunto]', assunto2: '[assunto2]',
    fase: '[Selecione]', tramitando: 'Tanto faz',
  });
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146 Safari/537.36',
      Referer: 'https://www.cmbh.mg.gov.br/atividade-legislativa/pesquisar-proposicoes',
      Origin: 'https://www.cmbh.mg.gov.br', Accept: 'text/html, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: params.toString(),
  });
  if (!response.ok) throw new Error(`${target.type} ${target.number}/${target.year}: HTTP ${response.status}`);
  const $ = cheerio.load(await response.text());
  const matches = [];
  $('ul.lista-pesquisas > li').each((_, el) => {
    const path = $(el).find('span.detalhar[data-caminho]').first().attr('data-caminho') || '';
    const id = (path.match(/[?&]id=([a-f0-9]{32})/i) || [])[1];
    const title = $(el).find('h3 > span.detalhar').first().text().trim();
    if (id && title.includes(`${target.number}/${target.year}`)) {
      matches.push({ id, title, source_url: `https://cmbhsilint.cmbh.mg.gov.br/silinternet/servico/proposicao?id=${id}` });
    }
  });
  return { ...target, status: matches.length === 1 ? 'RESOLVED' : matches.length ? 'AMBIGUOUS' : 'NOT_FOUND', matches };
}

async function main() {
  const targets = parseTargets(process.env.CMBH_TARGETS);
  if (!targets.length) throw new Error('Nenhum alvo informado.');
  const results = [];
  for (const target of targets) {
    const result = await resolveTarget(target);
    results.push(result);
    console.log(JSON.stringify(result));
  }
  require('fs').writeFileSync('resultado-resolver.json', JSON.stringify({ generated_at: new Date().toISOString(), results }, null, 2));
  if (results.some(row => row.status !== 'RESOLVED')) process.exitCode = 2;
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
