'use strict';
const KEY = 'immoprospect.v2';
const SOURCES = { pap: 'PAP', lbc: 'Leboncoin', expire: 'Mandat expiré', secteur: 'Propriétaire du secteur', reseau: 'Réseau' };
const STATUTS = ['Nouveau', 'Contacté', 'RDV estimation', 'Avis de valeur remis', 'Mandat signé', 'Perdu'];
const CLOSED = ['Mandat signé', 'Perdu'];
const GAPS = [2, 3, 9]; // J+2, J+5, J+14 après le premier contact
const TITLES = { today: "Aujourd'hui", leads: 'Prospects', pipeline: 'Pipeline', scripts: 'Scripts', data: 'Données' };

let leads = load();
let tab = 'today';
let editId = null;
let scriptLeadId = '';
let flt = { q: '', src: '', st: '' };
let lastTpl = [];

/* ---------- utilitaires ---------- */
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const diff = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const fr = s => (s ? parse(s).toLocaleDateString('fr-FR') : '');
const eur = n => (n ? Number(n).toLocaleString('fr-FR') + ' €' : '');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\W+/g, '-');

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } }
function save() { try { localStorage.setItem(KEY, JSON.stringify(leads)); } catch { toast('Sauvegarde impossible dans ce navigateur'); } }
function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 2200); }
const fullName = l => `${l.prenom} ${l.nom || ''}`.trim();

/* ---------- score de priorité (règles visibles) ---------- */
function score(l) {
  let s = { pap: 25, lbc: 25, expire: 30, secteur: 10, reseau: 15 }[l.source] ?? 10;
  const why = [SOURCES[l.source]];
  const t = today();
  if (l.dateAnnonce) {
    const j = diff(l.dateAnnonce, t);
    if (j >= 60) { s += 25; why.push(`annonce en ligne depuis ${j} jours`); }
    else if (j >= 30) { s += 20; why.push(`annonce en ligne depuis ${j} jours`); }
    else if (j >= 14) { s += 10; why.push(`annonce en ligne depuis ${j} jours`); }
  }
  if (l.finMandat) {
    const j = diff(l.finMandat, t);
    if (j < 0) { s -= 40; why.push('MANDAT ENCORE EN COURS, ne pas démarcher'); }
    else if (j <= 30) { s += 25; why.push('mandat expiré depuis moins de 30 jours'); }
    else if (j <= 90) { s += 15; why.push('mandat expiré depuis moins de 90 jours'); }
    else s += 5;
  } else if (l.source === 'expire') why.push('date de fin de mandat à vérifier');
  if (l.urgent) { s += 15; why.push('vente urgente'); }
  if (l.statut === 'RDV estimation') { s += 20; why.push('RDV pris'); }
  if (l.statut === 'Avis de valeur remis') { s += 15; why.push('avis de valeur remis, à conclure'); }
  if ((l.touches || 0) >= 4 && !['RDV estimation', 'Avis de valeur remis'].includes(l.statut)) { s -= 30; why.push('4 contacts sans suite'); }
  return { s: Math.max(0, Math.min(100, s)), why };
}
const isActive = l => !CLOSED.includes(l.statut);
const isDue = l => isActive(l) && l.nextAction && l.nextAction <= today();

/* ---------- actions ---------- */
function contactDone(id) {
  const l = leads.find(x => x.id === id); if (!l) return;
  l.touches = (l.touches || 0) + 1;
  l.history = [...(l.history || []), today()];
  if (l.statut === 'Nouveau') l.statut = 'Contacté';
  const gap = GAPS[l.touches - 1];
  if (gap !== undefined) { l.nextAction = addDays(today(), gap); toast(`Prochaine relance le ${fr(l.nextAction)}`); }
  else { l.nextAction = ''; toast('Séquence terminée. Décide : RDV, mandat ou classé perdu.'); }
  save(); render();
}
function setStatus(id, st) {
  const l = leads.find(x => x.id === id); if (!l) return;
  l.statut = st;
  if (CLOSED.includes(st)) l.nextAction = '';
  save(); render();
}

/* ---------- vues ---------- */
function leadCard(l, withActions = true) {
  const sc = score(l);
  const tel = l.tel ? `<a class="btn sm" href="tel:${esc(l.tel.replace(/\s/g, ''))}">Appeler ${esc(l.tel)}</a>` : '';
  const warn = sc.why.some(w => w.startsWith('MANDAT ENCORE'));
  return `<div class="card">
    <div class="top"><strong>${esc(fullName(l))}</strong><span class="tag">${esc(SOURCES[l.source])}</span><span class="tag">${esc(l.statut)}</span><span class="score">${sc.s}</span></div>
    <div class="why ${warn ? 'warn' : ''}">${esc([l.type, l.rue, l.commune].filter(Boolean).join(' · '))}${l.prix ? ' · ' + eur(l.prix) : ''}<br>${esc(sc.why.join(' · '))}</div>
    ${withActions ? `<div class="row">${tel}
      <button class="btn sm" data-act="contact" data-id="${l.id}">Contact fait</button>
      <button class="btn sm ghost" data-act="script" data-id="${l.id}">Message</button>
      <button class="btn sm ghost" data-act="edit" data-id="${l.id}">Ouvrir</button></div>` : ''}
  </div>`;
}

function viewToday() {
  const act = leads.filter(isActive);
  const due = leads.filter(isDue).sort((a, b) => score(b).s - score(a).s);
  const rdv = leads.filter(l => ['RDV estimation', 'Avis de valeur remis'].includes(l.statut)).length;
  const won = leads.filter(l => l.statut === 'Mandat signé').length;
  let h = `<div class="kpis">
    <div class="kpi"><b>${due.length}</b><span>à traiter aujourd'hui</span></div>
    <div class="kpi"><b>${act.length}</b><span>prospects actifs</span></div>
    <div class="kpi"><b>${rdv}</b><span>RDV et avis en cours</span></div>
    <div class="kpi"><b>${won}</b><span>mandats signés</span></div></div>`;
  h += `<h2>À traiter aujourd'hui, du plus chaud au plus froid</h2>`;
  h += due.length ? due.map(l => leadCard(l)).join('') : `<div class="empty">Rien à relancer. Ajoute des prospects avec le bouton en haut.</div>`;
  h += `<h2>Résultats par source</h2><table><tr><th>Source</th><th>Prospects</th><th>RDV ou avis</th><th>Mandats</th><th>Taux de mandat</th></tr>`;
  for (const [k, v] of Object.entries(SOURCES)) {
    const set = leads.filter(l => l.source === k);
    if (!set.length) continue;
    const r = set.filter(l => ['RDV estimation', 'Avis de valeur remis', 'Mandat signé'].includes(l.statut)).length;
    const m = set.filter(l => l.statut === 'Mandat signé').length;
    h += `<tr><td>${v}</td><td>${set.length}</td><td>${r}</td><td>${m}</td><td>${Math.round(m / set.length * 100)} %</td></tr>`;
  }
  return h + `</table>`;
}

function viewLeads() {
  return `<div class="filters">
    <input id="fq" placeholder="Rechercher nom, commune, rue..." value="${esc(flt.q)}">
    <select id="fsrc"><option value="">Toutes sources</option>${Object.entries(SOURCES).map(([k, v]) => `<option value="${k}" ${flt.src === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
    <select id="fst"><option value="">Tous statuts</option>${STATUTS.map(s => `<option ${flt.st === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
  </div><div id="tbl"></div>`;
}
function renderTable() {
  const q = flt.q.toLowerCase();
  const rows = leads
    .filter(l => (!flt.src || l.source === flt.src) && (!flt.st || l.statut === flt.st) && `${fullName(l)} ${l.commune} ${l.rue} ${l.tel}`.toLowerCase().includes(q))
    .sort((a, b) => score(b).s - score(a).s);
  $('#tbl').innerHTML = rows.length
    ? `<table><tr><th>Score</th><th>Nom</th><th>Source</th><th>Commune</th><th>Prix</th><th>€/m²</th><th>Statut</th><th>Relance</th><th></th></tr>${rows.map(l => `<tr>
      <td><b>${score(l).s}</b></td><td>${esc(fullName(l))}</td><td>${esc(SOURCES[l.source])}</td><td>${esc(l.commune)}</td>
      <td>${eur(l.prix)}</td><td>${l.prix && l.surface ? Math.round(l.prix / l.surface).toLocaleString('fr-FR') : ''}</td>
      <td>${esc(l.statut)}</td><td>${fr(l.nextAction)}</td>
      <td><button class="btn sm ghost" data-act="edit" data-id="${l.id}">Ouvrir</button></td></tr>`).join('')}</table>`
    : `<div class="empty">Aucun prospect.</div>`;
}

function viewPipeline() {
  return `<div class="board">${STATUTS.map(s => {
    const set = leads.filter(l => l.statut === s).sort((a, b) => score(b).s - score(a).s);
    return `<div class="col"><h3>${s} · ${set.length}</h3>${set.map(l => `<div class="card">
      <strong>${esc(fullName(l))}</strong><div class="why">${esc([l.type, l.commune].filter(Boolean).join(' · '))}${l.prix ? '<br>' + eur(l.prix) : ''}</div>
      <select data-act="move" data-id="${l.id}">${STATUTS.map(x => `<option ${x === l.statut ? 'selected' : ''}>${x}</option>`).join('')}</select></div>`).join('')}</div>`;
  }).join('')}</div>`;
}

/* ---------- scripts ---------- */
const TPL = {
  annonce: [
    ['Message de première approche', `Bonjour {prenom},\nJe suis Christophe Danet, conseiller Efficity à {commune}. J'ai vu votre annonce pour votre {type}. Je ne vous écris pas pour vous retirer la vente. J'ai une question précise : [un point réel de l'annonce, par exemple l'étage, le DPE ou la date de mise en ligne]. Si vous le souhaitez, je vous donne mon avis sur le prix et sur ce qui peut accélérer la vente, sans engagement. Quand êtes-vous disponible pour en parler 10 minutes ?`],
    ['Première phrase au téléphone', `Bonjour, Christophe Danet, Efficity. Je vous appelle au sujet de votre annonce {rue}. Vous avez 2 minutes ?`],
    ['Relance J+2', `Bonjour {prenom}, Christophe Danet, Efficity. Je reviens vers vous au sujet de votre {type}. Je peux passer {jour} ou {jour} pour vous donner un avis de valeur écrit, gratuit et sans engagement. Qu'est-ce qui vous arrange ?`],
    ['Relance J+5 (appel)', `Bonjour {prenom}, Christophe Danet. Je voulais savoir où vous en êtes de la vente de votre {type}. Combien de visites avez-vous eues depuis la mise en ligne ?`],
    ['Dernier message J+14', `Bonjour {prenom}, une vente vient de se conclure dans votre secteur : [adresse, prix, délai de vente]. Si vous voulez que je vous explique ce que cela change pour votre {type}, je reste disponible. Christophe Danet, Efficity.`]
  ],
  expire: [
    ['Message de première approche', `Bonjour {prenom},\nJe suis Christophe Danet, conseiller indépendant Efficity. Je vois que votre {type} à {commune} n'est plus en vente ou que votre mandat est arrivé à terme. Je ne vous promets pas de miracle. Je vous propose de regarder avec vous pourquoi ça n'a pas fonctionné et ce que je ferais différemment. Je viens sur place, je vous remets un avis de valeur écrit, et vous décidez ensuite. Quel jour vous arrange ?`],
    ['Première phrase au téléphone', `Bonjour, Christophe Danet, Efficity. Votre bien était en vente, et je voulais comprendre ce qui avait bloqué. Vous avez un instant ?`],
    ['Questions à poser', `Combien de visites avez-vous eues ?\nQuels retours des visiteurs ?\nQuel était le prix de départ, et a-t-il baissé ?\nQu'est-ce que l'agence a fait concrètement (photos, diffusion, relances) ?\nQu'est-ce que vous attendez d'un nouvel accompagnement ?`],
    ['Relance J+2', `Bonjour {prenom}, Christophe Danet, Efficity. Je reviens vers vous pour votre {type}. Je peux passer {jour} ou {jour} avec une analyse du marché de votre secteur. Qu'est-ce qui vous arrange ?`],
    ['Dernier message J+14', `Bonjour {prenom}, je ne veux pas vous importuner. Voici simplement ce qui s'est vendu près de chez vous ces dernières semaines : [2 ou 3 ventes]. Si vous voulez en parler, vous avez mon numéro. Christophe Danet, Efficity.`]
  ],
  secteur: [
    ['Mail de première approche', `Objet : Votre bien {rue}, une estimation sérieuse, sans engagement\n\nBonjour {prenom},\nJe suis Christophe Danet, conseiller immobilier indépendant Efficity à {commune}. Je vends sur votre secteur et je peux vous donner une valeur réaliste de votre bien, appuyée sur les ventes récentes autour de chez vous. Je viens sur place, je visite, je vous remets un avis de valeur écrit avec le prix net vendeur, mes honoraires et le prix affiché. Vous gardez le document, que vous vendiez avec moi ou non. Dites-moi deux créneaux qui vous arrangent.\n\nBien cordialement,\nChristophe Danet, Efficity`],
    ['SMS', `Bonjour {prenom}, Christophe Danet, conseiller Efficity à {commune}. Si vous voulez connaître la valeur de votre bien, je fais une estimation écrite gratuite et sans engagement. Je peux passer {jour} ou {jour} ?`]
  ]
};
TPL.pap = TPL.lbc = TPL.annonce; TPL.reseau = TPL.secteur;

function fill(t, l) {
  const v = { prenom: l?.prenom || '[Prénom]', commune: l?.commune || '[commune]', type: l?.type || 'bien', rue: l?.rue ? 'au ' + l.rue : 'dans votre secteur', jour: '[jour]' };
  return t.replace(/\{(\w+)\}/g, (_, k) => v[k] ?? `{${k}}`);
}
function viewScripts() {
  const l = leads.find(x => x.id === scriptLeadId);
  const src = l ? l.source : (flt.scriptSrc || 'pap');
  lastTpl = TPL[src].map(([n, t]) => [n, fill(t, l)]);
  return `<div class="filters">
    <select id="sLead"><option value="">Sans prospect (modèle vierge)</option>${leads.filter(isActive).map(x => `<option value="${x.id}" ${x.id === scriptLeadId ? 'selected' : ''}>${esc(fullName(x))} (${esc(SOURCES[x.source])})</option>`).join('')}</select>
    ${l ? '' : `<select id="sSrc">${Object.entries(SOURCES).map(([k, v]) => `<option value="${k}" ${k === src ? 'selected' : ''}>${v}</option>`).join('')}</select>`}
  </div>
  <div class="note">Vérifie avant d'envoyer : démarchage par SMS ou mail soumis à l'accord préalable du particulier, appel soumis à Bloctel, et pas de contact tant qu'un mandat exclusif est en cours. Sur PAP et Leboncoin, utilise seulement la messagerie de la plateforme.</div>
  ${lastTpl.map(([n, t], i) => `<h2>${esc(n)}</h2><div class="tpl">${esc(t)}</div><button class="btn sm" data-act="copy" data-i="${i}">Copier</button>`).join('')}`;
}

/* ---------- données ---------- */
function viewData() {
  return `<div class="note">Tes données restent dans ce navigateur (stockage local). Aucun serveur, rien n'est envoyé. Fais un export régulier : si tu vides le navigateur, tout est perdu.</div>
  <div class="row">
    <button class="btn" data-act="exportJson">Exporter (JSON)</button>
    <button class="btn" data-act="exportCsv">Exporter (CSV pour Excel)</button>
    <label class="btn ghost" style="cursor:pointer;color:var(--ink)">Importer un JSON<input id="imp" type="file" accept="application/json" hidden></label>
    <button class="btn ghost danger" data-act="reset">Tout effacer</button>
  </div>
  <h2>Comment le score est calculé</h2>
  <div class="card">Base selon la source : mandat expiré 30, annonce PAP ou Leboncoin 25, réseau 15, propriétaire du secteur 10.<br>
  Annonce en ligne depuis 14 jours +10, 30 jours +20, 60 jours +25.<br>
  Mandat expiré depuis moins de 30 jours +25, moins de 90 jours +15, plus ancien +5. Mandat encore en cours : -40.<br>
  Vente urgente +15. RDV pris +20. Avis de valeur remis +15. Quatre contacts sans suite : -30.<br>
  Séquence de relance automatique : J0, J+2, J+5, J+14, puis arrêt.</div>`;
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); URL.revokeObjectURL(a.href);
}
function exportCsv() {
  const cols = ['prenom', 'nom', 'tel', 'email', 'source', 'statut', 'rue', 'commune', 'type', 'surface', 'prix', 'dateAnnonce', 'finMandat', 'nextAction', 'touches', 'notes'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  download('prospects.csv', '﻿' + [cols.join(';'), ...leads.map(l => cols.map(c => q(l[c])).join(';'))].join('\n'), 'text/csv');
}

/* ---------- rendu ---------- */
function render() {
  $('#title').textContent = TITLES[tab];
  document.querySelectorAll('#nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  const v = { today: viewToday, leads: viewLeads, pipeline: viewPipeline, scripts: viewScripts, data: viewData }[tab]();
  $('#view').innerHTML = v;
  if (tab === 'leads') renderTable();
}

/* ---------- formulaire ---------- */
function openForm(id) {
  editId = id || null;
  const f = $('#form'); f.reset();
  $('#statutSel').innerHTML = STATUTS.map(s => `<option>${s}</option>`).join('');
  const l = leads.find(x => x.id === id);
  $('#formTitle').textContent = l ? fullName(l) : 'Nouveau prospect';
  $('#delBtn').style.display = l ? '' : 'none';
  if (l) for (const [k, v] of Object.entries(l)) { const el = f.elements[k]; if (!el) continue; if (el.type === 'checkbox') el.checked = !!v; else el.value = v ?? ''; }
  else f.elements.nextAction.value = today();
  $('#dlg').showModal();
}
$('#form').addEventListener('submit', e => {
  e.preventDefault();
  const d = Object.fromEntries(new FormData(e.target));
  d.urgent = e.target.elements.urgent.checked;
  d.surface = d.surface ? Number(d.surface) : '';
  d.prix = d.prix ? Number(d.prix) : '';
  const l = leads.find(x => x.id === editId);
  if (l) Object.assign(l, d);
  else leads.unshift({ id: uid(), touches: 0, history: [], ...d });
  if (CLOSED.includes(d.statut)) (l || leads[0]).nextAction = '';
  save(); $('#dlg').close(); render(); toast('Enregistré');
});
$('#cancelBtn').onclick = () => $('#dlg').close();
$('#delBtn').onclick = () => {
  if (!confirm('Supprimer ce prospect ?')) return;
  leads = leads.filter(x => x.id !== editId); save(); $('#dlg').close(); render();
};
$('#newBtn').onclick = () => openForm();

/* ---------- événements ---------- */
$('#nav').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { tab = b.dataset.tab; render(); } });
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b || b.tagName === 'SELECT') return;
  const { act, id } = b.dataset;
  if (act === 'contact') contactDone(id);
  else if (act === 'edit') openForm(id);
  else if (act === 'script') { scriptLeadId = id; tab = 'scripts'; render(); }
  else if (act === 'copy') navigator.clipboard.writeText(lastTpl[+b.dataset.i][1]).then(() => toast('Copié'), () => toast('Copie impossible, sélectionne le texte'));
  else if (act === 'exportJson') download('prospects.json', JSON.stringify(leads, null, 2), 'application/json');
  else if (act === 'exportCsv') exportCsv();
  else if (act === 'reset') { if (confirm('Effacer tous les prospects de ce navigateur ?')) { leads = []; save(); render(); } }
});
document.addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.act === 'move') setStatus(t.dataset.id, t.value);
  else if (t.id === 'fsrc') { flt.src = t.value; renderTable(); }
  else if (t.id === 'fst') { flt.st = t.value; renderTable(); }
  else if (t.id === 'sLead') { scriptLeadId = t.value; render(); }
  else if (t.id === 'sSrc') { flt.scriptSrc = t.value; render(); }
  else if (t.id === 'imp' && t.files[0]) {
    t.files[0].text().then(txt => {
      try { const arr = JSON.parse(txt); if (!Array.isArray(arr)) throw 0; leads = arr; save(); render(); toast(`${arr.length} prospects importés`); }
      catch { toast('Fichier invalide'); }
    });
  }
});
document.addEventListener('input', e => { if (e.target.id === 'fq') { flt.q = e.target.value; renderTable(); } });

render();
