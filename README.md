# Nav 3D – navigation pour le navigateur Tesla

Application web (HTML/JS, sans serveur) : carte 3D, recherche d'adresse, guidage vocal et alertes trafic en temps réel.

## Sources de données (gratuites)

| Besoin | Source | Clé | Couverture |
|---|---|---|---|
| Carte 3D | OpenFreeMap (OpenStreetMap) | non | Monde |
| Itinéraire | Serveur OSRM public | non | Monde |
| Adresses | Base Adresse Nationale | non | France |
| Adresses | Photon (OpenStreetMap) | non | Europe/Monde |
| Alertes trafic + fluidité | TomTom Traffic | oui, gratuite | Europe |

Passer à l'Europe : dans ⚙ Réglages, choisir « Europe (Photon) » pour la recherche. Le reste couvre déjà l'Europe.

Limites de la version gratuite :
- Le serveur OSRM public est une démo, à utiliser raisonnablement. L'itinéraire ne tient pas compte du trafic (l'heure d'arrivée est approximative).
- TomTom gratuit : 2 500 requêtes d'alertes par jour (l'app en fait une toutes les 2 minutes au maximum) et 50 000 tuiles de fluidité par jour.

## Clé TomTom

1. Créer un compte sur https://developer.tomtom.com
2. Copier la clé « My first API key ».
3. Dans l'app : ⚙ → coller la clé → Enregistrer.
   (ou ouvrir l'URL une fois avec `?key=VOTRE_CLE`, elle est mémorisée.)
4. Conseillé : dans le tableau de bord TomTom, limiter la clé à votre domaine `xxx.github.io`.

## Mise en ligne sur GitHub Pages

1. Créer un dépôt public (par ex. `tesla-nav`) sur github.com.
2. Y déposer `index.html`, `app.js`, `style.css` (bouton « Add file → Upload files »).
3. Settings → Pages → Source : « Deploy from a branch », branche `main`, dossier `/ (root)` → Save.
4. L'app est disponible après une minute à `https://VOTRE_COMPTE.github.io/tesla-nav/`.

## Dans la Tesla

- Ouvrir l'adresse dans le navigateur, puis autoriser la localisation.
- Ajouter la page aux favoris.
- Mode démo (⚙) : simule le trajet pour tester à l'arrêt.

## Légal

- Pas de données Waze (aucune API publique).
- En France, la position exacte des radars et des contrôles ne peut pas être affichée : l'app ne le fait pas.
- Gardez les yeux sur la route : préparez l'itinéraire à l'arrêt.
