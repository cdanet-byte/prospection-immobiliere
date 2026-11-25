# Radar Baud

Outil de prospection pour repérer, dans un rayon de 40 km autour de Baud (56150), les maisons et appartements dont le propriétaire a une raison de vendre, et chiffrer chaque bien avant d'appeler.

## Ce que fait l'outil

1. **Collecte** les logements dont le diagnostic énergétique (DPE) est public, étiquettes E, F et G (ADEME, adresses, surfaces, années).
2. **Estime** chaque bien avec les ventes réelles comparables (DVF, 5 ans) : même type, surface à plus ou moins 25 %, 36 derniers mois, commune puis 10 km puis rayon complet si trop peu de ventes. Il affiche la médiane, la fourchette (quartiles), le nombre de comparables, la fiabilité et les 5 ventes les plus proches.
3. **Classe** par priorité d'appel (score 0 à 100, motifs affichés) :

| Signal | Points (réglables dans `config.json`) |
|---|---|
| DPE G / F / E (calendrier d'interdiction de location : 2025 / 2028 / 2034) | 30 / 22 / 8 |
| DPE réalisé il y a moins de 12 mois (diagnostic de mise en vente ou en location probable) | 20 |
| DPE de 12 à 36 mois | 8 |
| Vendu il y a moins de 2 ans | moins 25 |
| Aucune vente trouvée à l'adresse depuis 2021 | 12 |
| Maison de 120 m² ou plus | 6 |
| Construit avant 1975 | 6 |

4. **Suivi** dans le navigateur : statut (À contacter, Courrier envoyé, Porte-à-porte fait, RDV estimation, Mandat signé, Pas intéressé), notes, export CSV pour un publipostage.

## Limites à connaître

- Le score classe, il ne prédit pas. Les poids sont des hypothèses de départ à ajuster avec vos résultats réels.
- Un DPE récent peut vouloir dire que le bien est déjà en annonce. Le signal est fort mais ambigu : vérifiez avant d'appeler.
- L'estimation est une médiane de prix au m² bâti. Elle ignore le terrain, l'état, les prestations et l'effet de l'étiquette énergie. Elle prépare un avis de valeur, elle ne le remplace pas.
- L'appariement DPE et DVF par adresse échoue sur certains lieux-dits : « aucune vente trouvée » est alors un indice, pas une preuve.
- Les noms de propriétaires ne sont pas en accès libre et l'outil n'en contient aucun. Contact : courrier « Propriétaire du bien » ou porte-à-porte, avec respect de Bloctel et des oppositions. Pas de démarchage par SMS ou e-mail sans consentement.
- Les annonces de portails (Leboncoin, SeLoger) ne sont pas utilisées : leurs conditions interdisent l'extraction automatique.

## Utilisation

```bash
python3 radar/build_data.py            # collecte complète (Python 3.9+, aucune dépendance)
python3 radar/build_data.py --radius 25
python3 -m http.server 8000 --directory radar
# puis ouvrir http://localhost:8000
```

La collecte garde un cache dans `radar/.cache` : en cas de coupure réseau, relancez, elle reprend. Les données générées sont dans `radar/data/`.

## Sources

- geo.api.gouv.fr (communes)
- DVF géolocalisées, Etalab (fichiers geo-dvf sur data.gouv.fr)
- DPE des logements existants, ADEME (data.ademe.fr)
