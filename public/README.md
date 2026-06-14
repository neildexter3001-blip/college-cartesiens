# 🎓 Collège Privé Les Cartésiens - API

## Déploiement sur Render

### Étape 1 : Récupérer l'URL de la base de données
1. Sur Render, va dans ton **PostgreSQL**
2. Copie l'**Internal Database URL**

### Étape 2 : Créer le Web Service
1. Clique **"New +"** → **"Web Service"**
2. Connecte ton **GitHub** et sélectionne ce repo

### Étape 3 : Configurer les variables d'environnement
Dans les **Environment Variables** :

DATABASE_URL = postgresql://cartesiens_user:Q7oq36OePqZyx8vcE2dMosb2ENt9hsTY@dpg-d8muqa4vikkc73cb8dog-a/cartesiens

### Étape 4 : Deploy !
Clique sur **"Create Web Service"** 🚀

## API Endpoints

| Méthode | URL | Action |
|---------|-----|--------|
| GET | /api/inscriptions | Liste tous les élèves |
| GET | /api/inscriptions/:matricule | Un élève |
| POST | /api/inscriptions | Ajouter un élève |
| PUT | /api/inscriptions/:matricule | Modifier un élève |
| DELETE | /api/inscriptions/:matricule | Supprimer un élève |
| DELETE | /api/inscriptions | Supprimer plusieurs |
| GET | /api/keepalive | Garder le serveur réveillé |