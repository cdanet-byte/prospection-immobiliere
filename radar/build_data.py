#!/usr/bin/env python3
"""Radar Baud : collecte et calcul des biens susceptibles d'être vendus.

Sources (toutes ouvertes, aucune donnée nominative) :
  - geo.api.gouv.fr           : communes et centres
  - geo-dvf (data.gouv.fr)    : ventes réelles (DVF), pour les prix et les comparables
  - ADEME (DPE logements existants) : adresses, étiquettes énergie, surfaces

Aucune bibliothèque externe : Python 3.9+ suffit.

Usage :
  python3 radar/build_data.py                 # 40 km autour de Baud
  python3 radar/build_data.py --radius 25     # rayon différent
"""
import argparse
import csv
import io
import json
import math
import re
import statistics
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
OUT = HERE / "data"

UA = {"User-Agent": "radar-baud/0.1 (prospection immobiliere)"}


# ----------------------------------------------------------------- réseau
CACHE = HERE / ".cache"


def get(url, retries=8, timeout=90, cache=True):
    """GET avec cache disque (reprise après coupure) et attentes croissantes."""
    import hashlib
    CACHE.mkdir(exist_ok=True)
    f = CACHE / hashlib.sha1(url.encode()).hexdigest()
    if cache and f.exists():
        return f.read_bytes()
    last = None
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
            if cache:
                f.write_bytes(data)
            return data
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise RuntimeError("404 " + url)
            last = e
        except Exception as e:  # noqa: BLE001
            last = e
        time.sleep(min(30, 2 * (i + 1)))
    raise RuntimeError(f"échec {url}: {last}")


def get_json(url):
    return json.loads(get(url).decode("utf-8"))


# ----------------------------------------------------------------- géo
def haversine(lat1, lon1, lat2, lon2):
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def lambert93_to_wgs84(x, y):
    """Conversion inverse Lambert-93 (EPSG:2154) vers WGS84 (précision métrique)."""
    e = 0.0818191910428158
    n = 0.7256077650532670
    c = 11754255.426096
    xs, ys = 700000.0, 12655612.049876
    lon0 = math.radians(3.0)
    dx, dy = x - xs, y - ys
    gamma = math.atan2(dx, -dy)
    r = math.hypot(dx, dy)
    lon = lon0 + gamma / n
    liso = -math.log(abs(r / c)) / n
    phi = 2 * math.atan(math.exp(liso)) - math.pi / 2
    for _ in range(12):
        phi = 2 * math.atan(
            math.exp(liso) * ((1 + e * math.sin(phi)) / (1 - e * math.sin(phi))) ** (e / 2)
        ) - math.pi / 2
    return math.degrees(phi), math.degrees(lon)


def communes_in_radius(center_lat, center_lon, radius_km):
    found = {}
    for dep in CONFIG["departements"]:
        url = (
            "https://geo.api.gouv.fr/departements/%s/communes?fields=nom,code,centre,population,codesPostaux"
            % dep
        )
        for c in get_json(url):
            if not c.get("centre"):
                continue
            lon, lat = c["centre"]["coordinates"]
            d = haversine(center_lat, center_lon, lat, lon)
            if d <= radius_km:
                found[c["code"]] = {
                    "code": c["code"],
                    "nom": c["nom"],
                    "dep": dep,
                    "lat": lat,
                    "lon": lon,
                    "distance_km": round(d, 1),
                    "population": c.get("population"),
                    "cp": (c.get("codesPostaux") or [""])[0],
                }
    return found


# ----------------------------------------------------------------- DVF
def fetch_dvf_commune(com):
    rows = []
    for year in CONFIG["dvf_years"]:
        url = "https://files.data.gouv.fr/geo-dvf/latest/csv/%d/communes/%s/%s.csv" % (
            year,
            com["dep"],
            com["code"],
        )
        try:
            raw = get(url, retries=3).decode("utf-8")
        except RuntimeError:
            continue  # pas de fichier cette année-là pour cette commune
        if raw.lstrip().startswith("<"):
            continue
        rows.extend(csv.DictReader(io.StringIO(raw)))
    return com["code"], rows


def norm(s):
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = re.sub(r"[^a-z0-9 ]", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


VOIE_WORDS = {
    "rue", "avenue", "av", "chemin", "ch", "impasse", "imp", "route", "rte", "allee",
    "place", "pl", "boulevard", "bd", "bld", "venelle", "ruelle", "square", "cour",
    "lotissement", "lot", "residence", "res", "passage", "quai", "de", "du", "des",
    "la", "le", "les", "l", "d", "et", "sur", "aux", "au",
}


def voie_key(s):
    toks = [t for t in norm(s).split() if t not in VOIE_WORDS]
    return " ".join(toks)


def build_sales(rows_by_commune):
    """Ventes de maisons/appartements 'propres' : une seule habitation par mutation."""
    sales = []
    for code, rows in rows_by_commune.items():
        muts = {}
        for r in rows:
            if r.get("nature_mutation") != "Vente":
                continue
            muts.setdefault(r["id_mutation"], []).append(r)
        for mid, lines in muts.items():
            locaux = [l for l in lines if l.get("type_local") in ("Maison", "Appartement")]
            if len(locaux) != 1:
                continue  # ventes groupées : prix non attribuable à un bien
            l = locaux[0]
            try:
                val = float(l["valeur_fonciere"])
                surf = float(l["surface_reelle_bati"])
            except (ValueError, TypeError, KeyError):
                continue
            if val < 15000 or surf < 9:
                continue
            terrain = sum(
                float(x["surface_terrain"] or 0) for x in lines if x.get("surface_terrain")
            ) if l["type_local"] == "Maison" else 0
            ppm2 = val / surf
            if not (300 <= ppm2 <= 12000):
                continue  # valeurs aberrantes
            sales.append({
                "id": mid,
                "date": l["date_mutation"],
                "commune": code,
                "type": l["type_local"].lower(),
                "prix": round(val),
                "surface": round(surf),
                "pieces": int(float(l["nombre_pieces_principales"] or 0)),
                "terrain": round(terrain),
                "ppm2": round(ppm2),
                "adresse": ("%s %s" % (l.get("adresse_numero", ""), l.get("adresse_nom_voie", ""))).strip(),
                "num": (l.get("adresse_numero") or "").strip(),
                "voie": voie_key(l.get("adresse_nom_voie", "")),
                "lat": float(l["latitude"]) if l.get("latitude") else None,
                "lon": float(l["longitude"]) if l.get("longitude") else None,
            })
    return sales


# ----------------------------------------------------------------- DPE
DPE_FIELDS = ",".join([
    "numero_dpe", "date_etablissement_dpe", "etiquette_dpe", "etiquette_ges", "adresse_ban",
    "code_postal_ban", "nom_commune_ban", "code_insee_ban", "type_batiment",
    "surface_habitable_logement", "annee_construction", "periode_construction",
    "conso_5_usages_par_m2_ep", "coordonnee_cartographique_x_ban", "coordonnee_cartographique_y_ban",
])


def fetch_dpe_commune(com):
    qs = "code_insee_ban:%s AND etiquette_dpe:(%s) AND type_batiment:(maison OR appartement)" % (
        com["code"], " OR ".join(CONFIG["dpe_labels"]),
    )
    url = "https://data.ademe.fr/data-fair/api/v1/datasets/dpe03existant/lines?" + urllib.parse.urlencode(
        {"size": 1000, "qs": qs, "select": DPE_FIELDS}
    )
    out = []
    while url:
        data = get_json(url)
        out.extend(data.get("results", []))
        url = data.get("next")
        if url:
            time.sleep(0.2)
    return com["code"], out


def split_address(adr, cp):
    """'5 Avenue du Gourandel 56150 Baud' -> ('5', 'avenue du gourandel')"""
    a = adr or ""
    a = re.sub(r"\b%s\b.*$" % re.escape(cp or "00000"), "", a).strip()
    m = re.match(r"^(\d+)\s*(?:bis|ter|[a-z]\b)?\s+(.*)$", a, re.I)
    if m:
        return m.group(1), m.group(2), a
    return "", a, a


# ----------------------------------------------------------------- calculs
def quantile(vals, q):
    vals = sorted(vals)
    if not vals:
        return None
    k = (len(vals) - 1) * q
    f, c = math.floor(k), math.ceil(k)
    return vals[f] if f == c else vals[f] + (vals[c] - vals[f]) * (k - f)


def months_between(d1, d2):
    return (d2.year - d1.year) * 12 + (d2.month - d1.month)


def comparables(bien, sales, today, communes):
    """Ventes comparables : même type, surface ±25 %, 36 derniers mois.
    Élargit d'abord aux communes voisines (<= 10 km) si moins de 5 ventes."""
    lo, hi = bien["surface"] * 0.75, bien["surface"] * 1.25
    cutoff = date(today.year - 3, today.month, 1)
    base = [s for s in sales if s["type"] == bien["type"] and lo <= s["surface"] <= hi
            and datetime.strptime(s["date"], "%Y-%m-%d").date() >= cutoff]
    own = [s for s in base if s["commune"] == bien["commune"]]
    scope = "commune"
    if len(own) < 5:
        c0 = communes[bien["commune"]]
        near = [s for s in base if haversine(c0["lat"], c0["lon"], communes[s["commune"]]["lat"],
                                             communes[s["commune"]]["lon"]) <= 10]
        if len(near) > len(own):
            own, scope = near, "10 km"
    if len(own) < 5:
        scope = "rayon complet" if len(base) >= 5 else scope
        own = base if len(base) >= 5 else own
    return own, scope


def estimate(bien, comps, scope):
    if len(comps) < 3:
        return None
    pp = [c["ppm2"] for c in comps]
    med = statistics.median(pp)
    q1, q3 = quantile(pp, 0.25), quantile(pp, 0.75)
    fiab = "élevée" if len(comps) >= 12 else "moyenne" if len(comps) >= 6 else "faible"
    # 5 comparables les plus proches en surface
    top = sorted(comps, key=lambda c: abs(c["surface"] - bien["surface"]))[:5]
    return {
        "ppm2_median": round(med),
        "ppm2_q1": round(q1),
        "ppm2_q3": round(q3),
        "prix_bas": round(q1 * bien["surface"], -3),
        "prix_median": round(med * bien["surface"], -3),
        "prix_haut": round(q3 * bien["surface"], -3),
        "nb_comparables": len(comps),
        "perimetre": scope,
        "fiabilite": fiab,
        "comparables": [
            {k: c[k] for k in ("date", "adresse", "type", "surface", "prix", "ppm2", "terrain")}
            for c in top
        ],
    }


def score(bien, today):
    w = CONFIG["score"]
    pts, motifs = 0, []
    lab = bien["dpe"]
    if lab in w["dpe"]:
        pts += w["dpe"][lab]
        motifs.append({
            "G": "DPE G : location interdite depuis le 1er janvier 2025, le propriétaire doit agir",
            "F": "DPE F : location interdite à partir de 2028, pression croissante sur le propriétaire",
            "E": "DPE E : location interdite à partir de 2034",
        }[lab])
    age = months_between(datetime.strptime(bien["date_dpe"], "%Y-%m-%d").date(), today)
    if age <= 12:
        pts += w["dpe_recent_12m"]
        motifs.append("DPE réalisé il y a %d mois : diagnostic souvent fait en préparation de vente ou de location, "
                      "à vérifier avant d'appeler (mandat peut-être déjà donné)" % max(age, 0))
    elif age <= 36:
        pts += w["dpe_recent_36m"]
        motifs.append("DPE réalisé il y a %d mois" % age)
    h = bien.get("derniere_vente")
    if h:
        ans = months_between(datetime.strptime(h["date"], "%Y-%m-%d").date(), today) / 12
        if ans < 2:
            pts += w["vendu_moins_2_ans"]
            motifs.append("Vendu il y a moins de 2 ans (%s) : peu de chances de revendre" % h["date"][:4])
        else:
            motifs.append("Dernière vente connue : %s" % h["date"][:4])
    elif bien["adresse_appariee"]:
        pts += w["aucune_vente_depuis_debut_dvf"]
        motifs.append("Aucune vente enregistrée à cette adresse depuis %d : détention d'au moins %d ans"
                      % (min(CONFIG["dvf_years"]), today.year - min(CONFIG["dvf_years"])))
    if bien["type"] == "maison" and bien["surface"] >= w["grande_maison_m2"]:
        pts += w["grande_maison"]
        motifs.append("Grande maison (%d m²) : profil fréquent de vente après départ des enfants (hypothèse)" % bien["surface"])
    if bien.get("annee_construction") and bien["annee_construction"] < 1975:
        pts += w["avant_1975"]
        motifs.append("Construit en %d : travaux de rénovation lourds à prévoir" % bien["annee_construction"])
    return max(0, min(100, pts)), motifs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--radius", type=float, default=CONFIG["rayon_km"])
    ap.add_argument("--limit-communes", type=int, default=0, help="test rapide")
    args = ap.parse_args()
    today = date.today()
    ctr = CONFIG["centre"]

    print("Communes dans un rayon de %.0f km autour de %s..." % (args.radius, ctr["nom"]))
    communes = communes_in_radius(ctr["lat"], ctr["lon"], args.radius)
    if args.limit_communes:
        communes = dict(sorted(communes.items(), key=lambda kv: kv[1]["distance_km"])[: args.limit_communes])
    print("  %d communes" % len(communes))

    print("Ventes DVF (%s)..." % ", ".join(map(str, CONFIG["dvf_years"])))
    dvf_rows = {}
    with ThreadPoolExecutor(max_workers=3) as ex:
        for i, (code, rows) in enumerate(ex.map(fetch_dvf_commune, communes.values()), 1):
            dvf_rows[code] = rows
            if i % 20 == 0:
                print("  %d/%d communes" % (i, len(communes)))
    sales = build_sales(dvf_rows)
    print("  %d ventes exploitables" % len(sales))

    print("DPE ADEME (%s)..." % "/".join(CONFIG["dpe_labels"]))
    dpe = {}
    with ThreadPoolExecutor(max_workers=2) as ex:
        for i, (code, rows) in enumerate(ex.map(fetch_dpe_commune, communes.values()), 1):
            dpe[code] = rows
            if i % 20 == 0:
                print("  %d/%d communes" % (i, len(communes)))
    print("  %d diagnostics" % sum(len(v) for v in dpe.values()))

    # index DVF par adresse pour apparier
    by_addr = {}
    for s in sales:
        if s["num"] and s["voie"]:
            by_addr.setdefault((s["commune"], s["num"], s["voie"]), []).append(s)

    biens, seen = [], set()
    for code, rows in dpe.items():
        c = communes[code]
        for r in rows:
            surf = r.get("surface_habitable_logement")
            if not surf or surf < 15:
                continue
            num, voie_txt, adr_nue = split_address(r.get("adresse_ban"), r.get("code_postal_ban"))
            key = (code, num, voie_key(voie_txt), round(surf))
            if key in seen:
                continue  # même logement diagnostiqué plusieurs fois : on garde le premier (le plus récent n'est pas garanti)
            seen.add(key)
            x, y = r.get("coordonnee_cartographique_x_ban"), r.get("coordonnee_cartographique_y_ban")
            lat = lon = None
            if x and y:
                lat, lon = lambert93_to_wgs84(x, y)
                if not (46 < lat < 49 and -5 < lon < -1):
                    lat = lon = None
            bien = {
                "id": r["numero_dpe"],
                "adresse": r.get("adresse_ban"),
                "commune": code,
                "commune_nom": c["nom"],
                "cp": r.get("code_postal_ban"),
                "type": r["type_batiment"],
                "surface": round(surf),
                "annee_construction": r.get("annee_construction"),
                "dpe": r["etiquette_dpe"],
                "ges": r.get("etiquette_ges"),
                "conso_m2": r.get("conso_5_usages_par_m2_ep"),
                "date_dpe": r["date_etablissement_dpe"],
                "lat": round(lat, 5) if lat else None,
                "lon": round(lon, 5) if lon else None,
                "distance_km": c["distance_km"],
                "adresse_appariee": False,
                "derniere_vente": None,
            }
            hist = by_addr.get((code, num, voie_key(voie_txt))) if num else None
            if num and voie_key(voie_txt):
                bien["adresse_appariee"] = True
            if hist:
                last = max(hist, key=lambda s: s["date"])
                bien["derniere_vente"] = {"date": last["date"], "prix": last["prix"], "surface": last["surface"]}
            biens.append(bien)

    print("Estimation et score de %d biens..." % len(biens))
    for b in biens:
        comps, scope = comparables(b, sales, today, communes)
        b["estimation"] = estimate(b, comps, scope)
        b["score"], b["motifs"] = score(b, today)
    for b in biens:
        if b["estimation"] and b["score"] < 30:
            b["estimation"]["comparables"] = []  # allège le fichier : détail gardé pour les biens prioritaires
    biens.sort(key=lambda b: -b["score"])

    stats = {}
    for code, c in communes.items():
        for t in ("maison", "appartement"):
            pp = [s["ppm2"] for s in sales if s["commune"] == code and s["type"] == t]
            stats["%s|%s" % (code, t)] = {
                "n": len(pp),
                "ppm2_median": round(statistics.median(pp)) if pp else None,
            }

    OUT.mkdir(exist_ok=True)
    (OUT / "biens.json").write_text(json.dumps(biens, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "communes.json").write_text(json.dumps(
        {"centre": ctr, "rayon_km": args.radius, "communes": list(communes.values()), "stats": stats},
        ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (OUT / "meta.json").write_text(json.dumps({
        "genere_le": today.isoformat(),
        "nb_biens": len(biens),
        "nb_ventes_dvf": len(sales),
        "annees_dvf": CONFIG["dvf_years"],
        "etiquettes_dpe": CONFIG["dpe_labels"],
        "rayon_km": args.radius,
        "centre": ctr["nom"],
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print("Terminé : %d biens, %d ventes. Fichiers dans %s" % (len(biens), len(sales), OUT))


if __name__ == "__main__":
    sys.exit(main())
