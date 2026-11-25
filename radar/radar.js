(function () {
  'use strict';
  var STATUTS = ['À contacter', 'Courrier préparé', 'Courrier envoyé', 'Porte-à-porte fait', 'RDV estimation', 'Mandat signé', 'Pas intéressé'];
  var $ = function (id) { return document.getElementById(id); };
  var state = { biens: [], communes: null, meta: null, sort: { key: 'score', dir: -1 }, selected: null, suivi: {} };
  var map, layer, markers = {};

  function load(key, def) { try { return JSON.parse(localStorage.getItem(key)) || def; } catch (e) { return def; } }
  function save(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* stockage indisponible */ } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function eur(n) { return n == null ? '' : Math.round(n).toLocaleString('fr-FR') + ' €'; }
  function monthsSince(d) { var t = new Date(), x = new Date(d); return (t.getFullYear() - x.getFullYear()) * 12 + t.getMonth() - x.getMonth(); }
  function sClass(s) { return s >= 55 ? 's-hi' : s >= 35 ? 's-mid' : 's-lo'; }
  function sColor(s) { return s >= 55 ? '#2f7d4f' : s >= 35 ? '#e08a1e' : '#8a958e'; }
  function statutOf(b) { return (state.suivi[b.id] && state.suivi[b.id].statut) || ''; }

  Promise.all(['data/biens.json', 'data/communes.json', 'data/meta.json'].map(function (u) {
    return fetch(u).then(function (r) { if (!r.ok) throw new Error(u); return r.json(); });
  })).then(function (r) {
    state.biens = r[0]; state.communes = r[1]; state.meta = r[2];
    state.suivi = load('radar-suivi', {});
    init();
  }).catch(function () {
    $('meta').textContent = 'Données introuvables. Lancez : python3 radar/build_data.py, puis ouvrez cette page via un serveur (voir README).';
  });

  function init() {
    var m = state.meta;
    $('meta').textContent = m.nb_biens.toLocaleString('fr-FR') + ' logements E/F/G, rayon ' + m.rayon_km + ' km autour de ' + m.centre +
      ' · ' + m.nb_ventes_dvf.toLocaleString('fr-FR') + ' ventes DVF ' + Math.min.apply(null, m.annees_dvf) + '-' + Math.max.apply(null, m.annees_dvf) + ' · données du ' + m.genere_le;
    state.biens.forEach(function (b) { b.prix = b.estimation ? b.estimation.prix_median : null; });

    var cs = state.communes.communes.slice().sort(function (a, b) { return a.nom.localeCompare(b.nom, 'fr'); });
    var counts = {}; state.biens.forEach(function (b) { counts[b.commune] = (counts[b.commune] || 0) + 1; });
    $('commune').innerHTML = '<option value="">Toutes</option>' + cs.filter(function (c) { return counts[c.code]; }).map(function (c) {
      return '<option value="' + c.code + '">' + esc(c.nom) + ' (' + counts[c.code] + ')</option>';
    }).join('');
    $('statut').innerHTML = '<option value="">Tous</option><option value="_none">Sans statut</option>' + STATUTS.map(function (s) { return '<option>' + s + '</option>'; }).join('');

    ['q', 'commune', 'type', 'dpe', 'statut', 'hideRecent'].forEach(function (id) { $(id).addEventListener('input', render); });
    $('score').addEventListener('input', function () { $('scoreOut').textContent = this.value; render(); });
    $('dist').addEventListener('input', function () { $('distOut').textContent = this.value; render(); });
    $('exportBtn').addEventListener('click', exportCsv);
    $('lettersBtn').addEventListener('click', function () {
      var l = current.slice(0, 100);
      if (!l.length) return;
      if (confirm(l.length + ' courriers (100 maximum par lot) pour la sélection actuelle. Continuer ?')) openLetters(l);
    });
    document.querySelectorAll('th[data-sort]').forEach(function (th) {
      th.addEventListener('click', function () {
        var k = th.dataset.sort;
        state.sort = { key: k, dir: state.sort.key === k ? -state.sort.dir : (k === 'score' || k === 'prix' || k === 'surface' ? -1 : 1) };
        render();
      });
    });
    $('table').querySelector('tbody').addEventListener('click', function (e) {
      var tr = e.target.closest('tr'); if (tr) select(tr.dataset.id, true);
    });
    initMap();
    render();
  }

  function filtered() {
    var q = $('q').value.trim().toLowerCase(), c = $('commune').value, t = $('type').value, d = $('dpe').value,
      min = +$('score').value, dist = +$('dist').value, st = $('statut').value, hide = $('hideRecent').checked;
    var list = state.biens.filter(function (b) {
      if (q && b.adresse.toLowerCase().indexOf(q) < 0) return false;
      if (c && b.commune !== c) return false;
      if (t && b.type !== t) return false;
      if (d === 'G' && b.dpe !== 'G') return false;
      if (d === 'FG' && b.dpe === 'E') return false;
      if (b.score < min || b.distance_km > dist) return false;
      if (hide && monthsSince(b.date_dpe) <= 12) return false;
      if (st === '_none' && statutOf(b)) return false;
      if (st && st !== '_none' && statutOf(b) !== st) return false;
      return true;
    });
    var k = state.sort.key, dir = state.sort.dir;
    list.sort(function (a, b) {
      var x = a[k], y = b[k];
      if (x == null) return 1; if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y, 'fr') : x - y) * dir;
    });
    return list;
  }

  var current = [];
  function render() {
    current = filtered();
    $('count').textContent = current.length.toLocaleString('fr-FR') + ' biens' + (current.length > 300 ? ' (300 premiers affichés dans la liste)' : '');
    $('table').querySelector('tbody').innerHTML = current.slice(0, 300).map(function (b) {
      return '<tr data-id="' + b.id + '" class="' + (b.id === state.selected ? 'sel' : '') + '"><td><span class="badge ' + sClass(b.score) + '">' + b.score + '</span></td>' +
        '<td>' + esc(b.adresse.replace(/ \d{5} .*$/, '')) + '</td><td>' + esc(b.commune_nom) + '</td><td>' + esc(b.type) + '</td><td>' + b.surface + '</td>' +
        '<td><span class="dpe dpe-' + b.dpe + '">' + b.dpe + '</span></td><td>' + (b.prix ? eur(b.prix) : '<span class="range">n.c.</span>') + '</td><td>' + esc(statutOf(b)) + '</td></tr>';
    }).join('');
    drawMarkers();
  }

  function initMap() {
    if (typeof L === 'undefined') { $('map').style.display = 'none'; return; }
    var c = state.communes.centre;
    map = L.map('map').setView([c.lat, c.lon], 10);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map);
    L.circle([c.lat, c.lon], { radius: state.communes.rayon_km * 1000, color: '#2f7d4f', weight: 1, fill: false, dashArray: '6 6' }).addTo(map);
    layer = L.layerGroup().addTo(map);
  }
  function drawMarkers() {
    if (!map) return;
    layer.clearLayers(); markers = {};
    current.slice(0, 600).forEach(function (b) {
      if (!b.lat) return;
      var m = L.circleMarker([b.lat, b.lon], { radius: 5 + b.score / 25, color: '#fff', weight: 1, fillColor: sColor(b.score), fillOpacity: .9 });
      m.on('click', function () { select(b.id, false); });
      m.addTo(layer); markers[b.id] = m;
    });
  }

  function select(id, pan) {
    state.selected = id;
    var b = state.biens.find(function (x) { return x.id === id; });
    if (!b) return;
    document.querySelectorAll('#table tbody tr').forEach(function (tr) { tr.classList.toggle('sel', tr.dataset.id === id); });
    if (pan && map && b.lat) map.setView([b.lat, b.lon], Math.max(map.getZoom(), 14));
    var e = b.estimation, sv = state.suivi[id] || {}, recent = monthsSince(b.date_dpe) <= 12;
    var h = '<h2>' + esc(b.adresse) + '</h2><div class="range">' + esc(b.type) + ' · ' + b.surface + ' m²' + (b.annee_construction ? ' · construit en ' + b.annee_construction : '') + ' · à ' + b.distance_km + ' km de Baud</div>';
    h += '<p><span class="badge ' + sClass(b.score) + '">' + b.score + '</span> priorité d\'appel &nbsp; <span class="dpe dpe-' + b.dpe + '">' + b.dpe + '</span> ' + (b.conso_m2 ? Math.round(b.conso_m2) + ' kWh/m²/an' : '') + '</p>';
    if (recent) h += '<div class="warn">DPE de moins de 12 mois : le bien est peut-être déjà en vente ou en location. Vérifiez les annonces avant de démarcher.</div>';
    h += '<h3>Pourquoi ce bien</h3><ul class="motifs">' + b.motifs.map(function (m) { return '<li>' + esc(m) + '</li>'; }).join('') + '</ul>';
    h += '<h3>Valorisation indicative</h3>';
    if (e) {
      h += '<div class="price">' + eur(e.prix_median) + '</div><div class="range">Fourchette ' + eur(e.prix_bas) + ' à ' + eur(e.prix_haut) + ' · ' + eur(e.ppm2_median) + '/m² (médiane, quartiles ' + eur(e.ppm2_q1) + ' à ' + eur(e.ppm2_q3) + ')</div>';
      h += '<div class="range">' + e.nb_comparables + ' ventes comparables sur 36 mois, périmètre : ' + esc(e.perimetre) + ' · fiabilité ' + e.fiabilite + '</div>';
      h += '<div class="warn">Estimation brute sur le prix du m² bâti. Elle ne tient compte ni du terrain, ni de l\'état, ni de l\'étiquette énergie, ni des prestations : ajustez après la visite. Les 5 ventes ci-dessous sont les plus proches en surface.</div>';
      if (e.comparables.length) h += '<table class="comps"><tr><th>Date</th><th>Adresse</th><th>m²</th><th>Terrain</th><th>Prix</th><th>€/m²</th></tr>' + e.comparables.map(function (c) {
        return '<tr><td>' + c.date + '</td><td>' + esc(c.adresse) + '</td><td>' + c.surface + '</td><td>' + (c.terrain || '') + '</td><td>' + eur(c.prix) + '</td><td>' + eur(c.ppm2) + '</td></tr>';
      }).join('') + '</table>'; else h += '<p class="range">Détail des ventes comparables disponible pour les biens de score 30 et plus.</p>';
    } else h += '<p class="range">Pas assez de ventes comparables pour estimer.</p>';
    if (b.derniere_vente) h += '<h3>Dernière vente connue</h3><p>' + b.derniere_vente.date + ' · ' + eur(b.derniere_vente.prix) + ' · ' + b.derniere_vente.surface + ' m²</p>';
    h += '<h3>Suivi</h3><div class="row"><select id="stSel"><option value="">Sans statut</option>' + STATUTS.map(function (s) { return '<option' + (sv.statut === s ? ' selected' : '') + '>' + s + '</option>'; }).join('') + '</select>' +
      '<textarea id="stNote" rows="3" placeholder="Notes (échange, rappel à faire…)">' + esc(sv.note || '') + '</textarea></div>';
    h += '<p class="range">Le suivi reste dans ce navigateur uniquement.</p>';
    h += '<h3>Courrier au propriétaire</h3><div class="row"><button class="btn" id="letterBtn">Préparer le courrier</button><button class="btn" id="meBtn">Mes coordonnées</button></div>';
    if (b.lat) h += '<p><a target="_blank" rel="noopener" href="https://www.geoportail.gouv.fr/carte?c=' + b.lon + ',' + b.lat + '&z=19&l0=ORTHOIMAGERY.ORTHOPHOTOS::GEOPORTAIL:OGC:WMTS(1)&l1=CADASTRALPARCELS.PARCELLAIRE_EXPRESS::GEOPORTAIL:OGC:WMTS(1)&permalink=yes">Voir la parcelle (Géoportail, cadastre)</a></p>';
    $('detail').innerHTML = h;
    function persist() {
      state.suivi[id] = { statut: $('stSel').value, note: $('stNote').value };
      save('radar-suivi', state.suivi);
    }
    $('stSel').addEventListener('change', function () { persist(); render(); });
    $('stNote').addEventListener('change', persist);
    $('letterBtn').addEventListener('click', function () { openLetters([b]); });
    $('meBtn').addEventListener('click', editMe);
    if (markers[id] && map) markers[id].bringToFront();
  }


  // ---------- courrier ----------
  function me() { return load('radar-moi', { nom: 'Christophe Danet', tel: '', email: '', ville: '' }); }
  function editMe() {
    var m = me();
    var nom = prompt('Votre nom (signature)', m.nom); if (nom === null) return;
    var tel = prompt('Votre téléphone', m.tel); if (tel === null) return;
    var email = prompt('Votre e-mail professionnel', m.email); if (email === null) return;
    var ville = prompt('Ville (pour la date du courrier)', m.ville); if (ville === null) return;
    save('radar-moi', { nom: nom, tel: tel, email: email, ville: ville });
  }
  function letterHtml(b, m) {
    var e = b.estimation, lieu = b.commune_nom, adr = b.adresse.replace(/ \d{5} .*$/, '');
    var date = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    var p = [];
    p.push('<p>Madame, Monsieur,</p>');
    p.push('<p>Je suis conseiller immobilier indépendant du réseau EFFICITY et je travaille sur votre secteur, autour de ' + esc(lieu) + '. Je me permets de vous écrire au sujet de votre bien situé ' + esc(adr) + '.</p>');
    if (e && e.nb_comparables >= 6) {
      p.push('<p>À titre d\'information, ' + e.nb_comparables + ' ' + (b.type === 'maison' ? 'maisons' : 'appartements') + ' de surface comparable ont été vendu' + (b.type === 'maison' ? 'es' : 's') + ' ces trois dernières années autour de ' + esc(lieu) + ', entre ' + Math.round(e.ppm2_q1).toLocaleString('fr-FR') + ' et ' + Math.round(e.ppm2_q3).toLocaleString('fr-FR') + ' € du m², avec une valeur médiane de ' + Math.round(e.ppm2_median).toLocaleString('fr-FR') + ' € du m². Ce chiffre est une moyenne de marché : seule une visite permet de situer précisément votre bien (état, terrain, prestations, exposition).</p>');
    }
    if (b.dpe === 'F' || b.dpe === 'G') {
      p.push('<p>Les règles liées à la performance énergétique des logements évoluent et changent la valeur de certains biens. Je peux vous expliquer concrètement ce que cela représente pour le vôtre, que vous envisagiez de le vendre, de le louer ou de le garder.</p>');
    }
    p.push('<p>Si vous vous posez la question de la valeur de votre bien, je vous propose une estimation gratuite et sans engagement, avec visite, que je vous remets par écrit. Vous n\'avez aucune obligation de vendre ensuite.</p>');
    p.push('<p>Vous pouvez me joindre' + (m.tel ? ' au <strong>' + esc(m.tel) + '</strong>' : '') + (m.tel && m.email ? ' ou' : '') + (m.email ? ' par e-mail à <strong>' + esc(m.email) + '</strong>' : '') + '.</p>');
    p.push('<p>Dans l\'attente de votre retour, je vous prie d\'agréer, Madame, Monsieur, mes salutations distinguées.</p>');
    p.push('<p class="sig">' + esc(m.nom) + '<br>Conseiller immobilier indépendant EFFICITY</p>');
    p.push('<p class="rgpd">Votre adresse est issue de données publiques (diagnostics de performance énergétique et valeurs foncières). Aucun fichier de propriétaires n\'a été utilisé. Si vous ne souhaitez plus recevoir de courrier de ma part, un mot ou un e-mail suffit et votre adresse sera exclue de mes envois.</p>');
    return '<section class="letter"><div class="dest">Au propriétaire du bien<br>' + esc(adr) + '<br>' + esc(b.cp) + ' ' + esc(lieu).toUpperCase() + '</div>' +
      '<div class="date">' + (m.ville ? esc(m.ville) + ', le ' : 'Le ') + date + '</div>' +
      '<p class="obj"><strong>Objet : la valeur de votre bien à ' + esc(lieu) + '</strong></p>' + p.join('') + '</section>';
  }
  function openLetters(list) {
    var m = me();
    if (!m.tel && !m.email) { alert('Renseignez d\'abord vos coordonnées (bouton « Mes coordonnées »), sinon le courrier ne contient aucun moyen de vous joindre.'); return; }
    var w = window.open('', '_blank');
    if (!w) { alert('Autorisez les fenêtres pop-up pour imprimer.'); return; }
    var css = 'body{font:12pt/1.5 Georgia,serif;color:#111;margin:0}.letter{page-break-after:always;padding:22mm 22mm 16mm;min-height:250mm}' +
      '.dest{margin:0 0 14mm 95mm;line-height:1.4}.date{text-align:right;margin-bottom:8mm}.sig{margin-top:12mm}.rgpd{font-size:8.5pt;color:#444;margin-top:14mm;border-top:1px solid #aaa;padding-top:3mm}' +
      '@page{size:A4;margin:0}p{margin:0 0 4.5mm}';
    w.document.write('<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Courriers</title><style>' + css + '</style></head><body>' +
      list.map(function (b) { return letterHtml(b, m); }).join('') + '</body></html>');
    w.document.close();
    setTimeout(function () { w.focus(); w.print(); }, 300);
    list.forEach(function (b) {
      var s = state.suivi[b.id] || {};
      if (!s.statut) { state.suivi[b.id] = { statut: 'Courrier préparé', note: s.note || '' }; }
    });
    save('radar-suivi', state.suivi);
  }

  function exportCsv() {
    var head = ['score', 'adresse', 'commune', 'type', 'surface_m2', 'dpe', 'date_dpe', 'estimation_basse', 'estimation_mediane', 'estimation_haute', 'fiabilite', 'statut', 'note', 'motifs'];
    var rows = current.map(function (b) {
      var e = b.estimation || {}, sv = state.suivi[b.id] || {};
      return [b.score, b.adresse, b.commune_nom, b.type, b.surface, b.dpe, b.date_dpe, e.prix_bas, e.prix_median, e.prix_haut, e.fiabilite, sv.statut, sv.note, b.motifs.join(' | ')];
    });
    var csv = [head].concat(rows).map(function (r) {
      return r.map(function (v) { v = v == null ? '' : String(v); return /[;"\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(';');
    }).join('\n');
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }));
    a.download = 'radar-baud-' + new Date().toISOString().slice(0, 10) + '.csv';
    a.click();
  }
})();
