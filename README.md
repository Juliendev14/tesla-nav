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

## Clé TomTom (sans rien taper dans la Tesla)

Dans la Tesla, le copier/coller n'est pas pratique. Le plus simple : mettre la clé
**une seule fois, depuis un ordinateur**, dans le fichier `config.js`.

1. Créer un compte gratuit sur https://developer.tomtom.com et copier la clé « My first API key ».
2. Sur l'ordinateur, ouvrir le dépôt sur github.com, cliquer sur le fichier **config.js**,
   puis sur le crayon ✏️ (« Edit this file »).
3. Coller la clé entre les guillemets : `tomtomKey: 'VOTRE_CLE',`
4. Cliquer sur **Commit changes…** puis encore **Commit changes**.
5. Attendre 1 à 2 minutes. Dans la Tesla, ouvrir simplement
   `juliendev14.github.io/tesla-nav` et l'ajouter aux favoris (⭐). C'est tout.

**Protéger la clé (important)** : le dépôt est public, donc la clé est visible.
Dans le tableau de bord TomTom (Dashboard → Keys → votre clé), activer la restriction
par domaine et n'autoriser que `juliendev14.github.io`. Ainsi, personne ne peut l'utiliser
depuis un autre site.

Autres façons (facultatif) :
- ⚙ Réglages → coller une clé : elle remplace celle de `config.js` sur cet appareil.
- Ouvrir une fois l'adresse avec `?key=VOTRE_CLE` : la clé est mémorisée puis retirée de l'adresse.

## Mise en ligne sur GitHub Pages

1. Créer un dépôt public (par ex. `tesla-nav`) sur github.com.
2. Y déposer `index.html`, `app.js`, `style.css`, `config.js` (bouton « Add file → Upload files »).
3. Settings → Pages → Source : « Deploy from a branch », branche `main`, dossier `/ (root)` → Save.
4. L'app est disponible après une minute à `https://VOTRE_COMPTE.github.io/tesla-nav/`.

## Dans la Tesla

- Taper l'adresse courte `juliendev14.github.io/tesla-nav` (pas besoin de Gmail), puis autoriser la localisation.
- Ajouter la page aux favoris (⭐) : ensuite, un seul appui suffit.
- Mode démo (⚙) : simule le trajet pour tester à l'arrêt.

## Légal

- Pas de données Waze (aucune API publique).
- En France, la position exacte des radars et des contrôles ne peut pas être affichée : l'app ne le fait pas.
- Gardez les yeux sur la route : préparez l'itinéraire à l'arrêt.
