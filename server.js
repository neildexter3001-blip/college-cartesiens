const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto'); // module natif Node (aucune installation) pour chiffrer les mots de passe
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Session simple en mémoire
const sessions = new Map();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Connexion PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 10
});

// Reconnexion automatique si la connexion est coupée (ex: après veille Render)
pool.on('error', (err) => {
    console.error('Pool PostgreSQL erreur inattendue:', err.message);
});

// Créer les tables au démarrage
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS eleves (
                id SERIAL PRIMARY KEY,
                matricule VARCHAR(20) UNIQUE NOT NULL,
                nom VARCHAR(100) NOT NULL,
                prenoms VARCHAR(200) NOT NULL,
                sexe VARCHAR(1) NOT NULL,
                date_naissance DATE,
                lieu_naissance VARCHAR(100),
                nationalite VARCHAR(10),
                classe VARCHAR(20),
                classe_precedente VARCHAR(50),
                statut VARCHAR(20) DEFAULT 'PRE_INSCRIT',
                qualite VARCHAR(10),
                lv2 VARCHAR(20) DEFAULT 'N/A',
                regime VARCHAR(20),
                nom_pere VARCHAR(100),
                prenoms_pere VARCHAR(200),
                contact_pere VARCHAR(20),
                nom_mere VARCHAR(100),
                prenoms_mere VARCHAR(200),
                contact_mere VARCHAR(20),
                bloque BOOLEAN DEFAULT FALSE,
                date_creation TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                date_inscription TIMESTAMP
            )
        `);

        // Migration : ajoute la colonne classe_precedente si la table "eleves"
        // existait déjà avant son introduction (sans cette ligne, les bases
        // déjà en production ne verraient jamais apparaître la colonne, car
        // CREATE TABLE IF NOT EXISTS ne modifie pas une table existante).
        await pool.query(`
            ALTER TABLE eleves ADD COLUMN IF NOT EXISTS classe_precedente VARCHAR(50)
        `);

        // Migration : ajoute date_preinscription si la table existait avant son introduction.
        // Poseé par la route /inscrire quand le parent soumet le formulaire.
        // Distinct de date_inscription (posé par l'admin lors de la validation).
        await pool.query(`
            ALTER TABLE eleves ADD COLUMN IF NOT EXISTS date_preinscription TIMESTAMP
        `);

        // Migration : ajoute valide_par pour stocker le nom complet (ou username)
        // de l'utilisateur qui a validé l'inscription. Affiché uniquement côté admin.
        await pool.query(`
            ALTER TABLE eleves ADD COLUMN IF NOT EXISTS valide_par VARCHAR(150)
        `);

        // Table des max par niveau (un seul enregistrement par niveau)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS niveaux_config (
                niveau VARCHAR(20) PRIMARY KEY,
                max_eleves INTEGER NOT NULL DEFAULT 40,
                date_modification TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Classes physiques de l'établissement (ex: 6EME_1, 6EME_2...).
        // Chaque niveau (6EME, 5EME...) peut être subdivisé par l'admin en
        // autant de classes que l'établissement en a réellement.
        await pool.query(`
            CREATE TABLE IF NOT EXISTS classes (
                id SERIAL PRIMARY KEY,
                niveau VARCHAR(20) NOT NULL,
                numero INTEGER NOT NULL,
                code VARCHAR(30) UNIQUE NOT NULL,
                label VARCHAR(50) NOT NULL,
                date_creation TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(niveau, numero)
            )
        `);

        // Migration : max_eleves par classe individuelle (NULL = utiliser le max du niveau)
        // IMPORTANT : cette ligne doit rester APRÈS le CREATE TABLE classes ci-dessus,
        // sinon sur une base neuve (table "classes" pas encore créée) ce ALTER TABLE
        // échoue avec "relation classes does not exist", ce qui interrompt tout le
        // reste de initDB() (niveaux_config, classes, users ne seraient alors jamais créées).
        await pool.query(`
            ALTER TABLE classes ADD COLUMN IF NOT EXISTS max_eleves INTEGER
        `);

        // Comptes utilisateurs autorisés à se connecter à l'espace admin.
        // - role : 'admin' (peut gérer les utilisateurs) ou 'user'.
        // - password : stocké chiffré (jamais en clair), au format "sel:empreinte".
        // - must_change_password : forcé à TRUE à la création / réinitialisation,
        //   ce qui oblige l'utilisateur à choisir un nouveau mot de passe à sa
        //   première connexion avec le mot de passe par défaut (0000).
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                nom_complet VARCHAR(150),
                role VARCHAR(20) DEFAULT 'user',
                must_change_password BOOLEAN DEFAULT TRUE,
                date_creation TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        console.log('✅ Base de données prête');

        // Nettoyage des classes dont le code niveau n'existe plus dans NIVEAUX
        // (ex: ancien '2NDE' générique remplacé par '2NDE_A' et '2NDE_C')
        const codesValides = NIVEAUX.map(n => n.code);
        const orphelines = await pool.query(
            'SELECT code, niveau FROM classes WHERE niveau != ALL($1)',
            [codesValides]
        );
        if (orphelines.rows.length > 0) {
            const codesOrphelins = orphelines.rows.map(r => r.code);
            await pool.query('DELETE FROM classes WHERE code = ANY($1)', [codesOrphelins]);
            console.log('🧹 Classes orphelines supprimées :', codesOrphelins.join(', '));
        }
    } catch (err) {
        console.error('❌ Erreur DB:', err.message);
    }
};

initDB();

// ===== NIVEAUX (filières fixes de l'établissement) =====
// Liste pédagogique fixe. Chaque niveau peut être subdivisé en plusieurs
// classes physiques par l'admin via /api/classes/generer (ex: 6EME → 6EME_1,
// 6EME_2... selon le nombre réel de classes de l'établissement). Le flag
// "lv2" indique si la LV2 est obligatoire pour ce niveau (repris en front
// pour la page d'inscription, au lieu de listes de codes en dur).
const NIVEAUX = [
    { code: '6EME',   label: '6ème',   ordre: 1,  lv2: false },
    { code: '5EME',   label: '5ème',   ordre: 2,  lv2: false },
    { code: '4EME',   label: '4ème',   ordre: 3,  lv2: true  },
    { code: '3EME',   label: '3ème',   ordre: 4,  lv2: true  },
    { code: '2NDE_A', label: '2nde A', ordre: 5,  lv2: true  },
    { code: '2NDE_C', label: '2nde C', ordre: 6,  lv2: false },
    { code: '1ERE_A', label: '1ère A', ordre: 7,  lv2: true  },
    { code: '1ERE_C', label: '1ère C', ordre: 8,  lv2: false },
    { code: '1ERE_D', label: '1ère D', ordre: 9,  lv2: false },
    { code: 'TLE_A',  label: 'Tle A',  ordre: 10, lv2: true  },
    { code: 'TLE_C',  label: 'Tle C',  ordre: 11, lv2: false },
    { code: 'TLE_D',  label: 'Tle D',  ordre: 12, lv2: false }
];
const NIVEAUX_PAR_CODE = Object.fromEntries(NIVEAUX.map(n => [n.code, n]));

// ===== MOTS DE PASSE & COMPTES =====
// Mot de passe par défaut donné à chaque nouvel utilisateur. À la première
// connexion avec ce mot de passe, le système oblige à en choisir un autre.
const DEFAULT_PASSWORD = '0000';

// Compte administrateur "maître" codé en dur : il fonctionne toujours, ne peut
// pas être supprimé ni bloqué. C'est le filet de sécurité pour ne jamais se
// retrouver enfermé dehors, même si la table users est vide.
const MASTER_ADMIN = { username: 'admin', password: 'Admin@123' };

// Chiffre un mot de passe avec un sel aléatoire (scrypt, natif Node).
// On ne stocke JAMAIS le mot de passe en clair : on garde "sel:empreinte".
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
    return salt + ':' + hash;
}

// Vérifie un mot de passe saisi contre l'empreinte stockée (comparaison
// résistante aux attaques de timing).
function verifyPassword(password, stored) {
    if (!stored || !stored.includes(':')) return false;
    const [salt, hash] = stored.split(':');
    const hashVerify = crypto.scryptSync(String(password), salt, 64).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(hashVerify, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ===== MIDDLEWARE AUTH =====
function requireAuth(req, res, next) {
    const token = req.headers.authorization;
    if (!token || !sessions.has(token)) {
        return res.status(401).json({ error: 'Non autorisé' });
    }
    next();
}

// Réservé aux administrateurs (gestion des utilisateurs)
function requireAdmin(req, res, next) {
    const token = req.headers.authorization;
    const sess = sessions.get(token);
    if (!sess) return res.status(401).json({ error: 'Non autorisé' });
    if (sess.role !== 'admin') return res.status(403).json({ error: 'Accès réservé aux administrateurs' });
    next();
}

// ===== ROUTES AUTH =====
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = String(username || '').trim();

    // 1) Compte administrateur maître (toujours valable, jamais bloqué)
    if (user.toLowerCase() === MASTER_ADMIN.username && password === MASTER_ADMIN.password) {
        const token = 'sess_' + crypto.randomBytes(16).toString('hex');
        sessions.set(token, { username: 'admin', role: 'admin', userId: null });
        return res.json({ token, role: 'admin', username: 'admin', nom_complet: 'Administrateur', mustChangePassword: false });
    }

    // 2) Comptes utilisateurs créés par l'admin (stockés en base)
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [user.toLowerCase()]);
        if (result.rows.length === 0 || !verifyPassword(password, result.rows[0].password)) {
            return res.status(401).json({ error: 'Identifiants incorrects' });
        }
        const u = result.rows[0];
        const token = 'sess_' + crypto.randomBytes(16).toString('hex');
        sessions.set(token, { username: u.username, role: u.role, userId: u.id });
        res.json({
            token,
            role: u.role,
            username: u.username,
            nom_complet: u.nom_complet,
            mustChangePassword: !!u.must_change_password
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/logout', (req, res) => {
    const token = req.headers.authorization;
    sessions.delete(token);
    res.json({ message: 'Déconnecté' });
});

// POST - Changer son propre mot de passe (après connexion). Utilisé notamment
// à la première connexion, quand le mot de passe par défaut doit être remplacé.
app.post('/api/change-password', requireAuth, async (req, res) => {
    const token = req.headers.authorization;
    const sess = sessions.get(token);
    const np = String((req.body && req.body.newPassword) || '');

    if (np.length < 4) {
        return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 4 caractères' });
    }
    if (np === DEFAULT_PASSWORD) {
        return res.status(400).json({ error: 'Choisissez un mot de passe différent du mot de passe par défaut' });
    }
    if (!sess.userId) {
        // Compte admin maître (codé en dur) : il ne se change pas ici
        return res.status(400).json({ error: 'Ce compte ne peut pas changer de mot de passe ici' });
    }

    try {
        await pool.query(
            'UPDATE users SET password = $1, must_change_password = FALSE WHERE id = $2',
            [hashPassword(np), sess.userId]
        );
        res.json({ message: 'Mot de passe modifié avec succès' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== ROUTES UTILISATEURS (réservées à l'admin) =====

// GET - Liste des utilisateurs (sans les mots de passe)
app.get('/api/users', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, username, nom_complet, role, must_change_password, date_creation FROM users ORDER BY date_creation DESC'
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST - Créer un utilisateur (mot de passe par défaut 0000, à changer à la 1re connexion)
app.post('/api/users', requireAdmin, async (req, res) => {
    let { username, nom_complet, role } = req.body;
    username = String(username || '').trim().toLowerCase();

    if (!username) return res.status(400).json({ error: 'Identifiant requis' });
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) {
        return res.status(400).json({ error: 'Identifiant invalide (3 à 30 caractères : lettres, chiffres, . _ -)' });
    }
    if (username === MASTER_ADMIN.username) {
        return res.status(400).json({ error: 'Cet identifiant est réservé' });
    }
    role = (role === 'admin') ? 'admin' : 'user';

    try {
        const exist = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
        if (exist.rows.length > 0) return res.status(409).json({ error: 'Cet identifiant existe déjà' });

        await pool.query(
            'INSERT INTO users (username, password, nom_complet, role, must_change_password) VALUES ($1,$2,$3,$4,TRUE)',
            [username, hashPassword(DEFAULT_PASSWORD), String(nom_complet || '').trim(), role]
        );
        res.json({ message: 'Utilisateur créé', username, defaultPassword: DEFAULT_PASSWORD });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT - Réinitialiser le mot de passe d'un utilisateur à la valeur par défaut (0000)
app.put('/api/users/:username/reset', requireAdmin, async (req, res) => {
    const username = String(req.params.username || '').toLowerCase();
    if (username === MASTER_ADMIN.username) return res.status(400).json({ error: 'Compte protégé' });
    try {
        const result = await pool.query(
            'UPDATE users SET password = $1, must_change_password = TRUE WHERE username = $2 RETURNING username',
            [hashPassword(DEFAULT_PASSWORD), username]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Utilisateur non trouvé' });
        res.json({ message: 'Mot de passe réinitialisé à ' + DEFAULT_PASSWORD });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE - Supprimer un utilisateur
app.delete('/api/users/:username', requireAdmin, async (req, res) => {
    const username = String(req.params.username || '').toLowerCase();
    if (username === MASTER_ADMIN.username) return res.status(400).json({ error: 'Compte protégé, non supprimable' });
    try {
        const result = await pool.query('DELETE FROM users WHERE username = $1 RETURNING username', [username]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Utilisateur non trouvé' });
        res.json({ message: 'Utilisateur supprimé' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== ROUTES ÉLÈVES =====

// Health check
app.get('/api/keepalive', (req, res) => {
    res.json({ status: 'alive', time: new Date() });
});

// GET - Tous les élèves (admin uniquement)
app.get('/api/eleves', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM eleves ORDER BY date_creation DESC'
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET - Vérifier si élève existe (PUBLIC - page inscription, SANS auth)
// Header JSON explicite pour éviter que la route * ne renvoie du HTML
//
// "bloque" sert désormais de VERROU DE MODIFICATION (et non plus de blocage
// total d'accès) : un élève inscrit ou pré-inscrit est verrouillé par défaut
// — le parent voit ses informations en lecture seule. L'admin peut déverrouiller
// ponctuellement (bouton cadenas du tableau) pour autoriser une modification ;
// dès que le parent re-soumet, le verrou se referme automatiquement
// (cf. /api/eleves/inscrire).
app.get('/api/eleves/verifier/:matricule', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    try {
        const result = await pool.query(
            'SELECT * FROM eleves WHERE matricule = $1',
            [req.params.matricule.toUpperCase()]
        );
        if (result.rows.length === 0) {
            return res.json({ existe: false });
        }
        const eleve = result.rows[0];
        // Verrouillé uniquement si une démarche a déjà été entamée (pré-inscrit
        // ou inscrit). Un élève "en attente" (jamais soumis) n'est jamais verrouillé,
        // même si bloque vaut true par erreur/héritage.
        const dejaSoumis = !!(eleve.date_preinscription || eleve.date_inscription);
        const verrouille = !!eleve.bloque && dejaSoumis;
        res.json({
            existe: true,
            verrouille,
            message: verrouille ? 'Vos informations sont verrouillées. Contactez l\'administration pour les modifier.' : undefined,
            eleve
        });
    } catch (err) {
        console.error('/api/eleves/verifier erreur:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET - Un élève (admin)
app.get('/api/eleves/:matricule', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM eleves WHERE matricule = $1',
            [req.params.matricule]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Élève non trouvé' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST - Importer élèves (admin)
// Convertit une date au format JJ/MM/AAAA (saisie courante en CSV/Excel en
// Côte d'Ivoire) vers AAAA-MM-JJ (seul format que PostgreSQL accepte de façon
// fiable avec un cast explicite ::date). Accepte aussi un format déjà ISO.
// Sans cette conversion, "30/03/2008" plante un cast ::date (PostgreSQL le
// lit en MDY par défaut, et il n'existe pas de mois 30).
// Tronque une valeur à une longueur max pour éviter qu'un champ VARCHAR(n)
// trop court (ex: deux numéros de téléphone collés par erreur dans le CSV
// source, comme "0143625727:::0777273987") ne fasse échouer toute la ligne
// à l'import. On préfère importer l'élève avec une donnée tronquée plutôt
// que de le perdre complètement.
function tronquer(valeur, max) {
    if (!valeur) return valeur;
    const v = String(valeur).trim();
    return v.length > max ? v.slice(0, max) : v;
}

function normaliserDateNaissance(valeur) {
    if (!valeur) return null;
    const v = String(valeur).trim();
    if (!v) return null;
    // Déjà au format AAAA-MM-JJ
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    // Format JJ/MM/AAAA ou JJ-MM-AAAA
    const m = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (m) {
        const jj = m[1].padStart(2, '0');
        const mm = m[2].padStart(2, '0');
        const aaaa = m[3];
        return `${aaaa}-${mm}-${jj}`;
    }
    return null; // format non reconnu : on importe sans date plutôt que de planter
}

app.post('/api/eleves/importer', requireAuth, async (req, res) => {
    const eleves = req.body.eleves;
    let importes = 0;
    let echoues = 0;
    const erreurs = []; // détail des lignes en échec, pour diagnostic

    // Import en LOTS (au lieu d'un INSERT par élève) : sur Render, des milliers
    // de requêtes SQL séquentielles peuvent dépasser le timeout du proxy HTTP
    // et couper la réponse en plein milieu, laissant une partie des élèves
    // non importés sans message d'erreur clair. Avec unnest(), un seul lot de
    // 200 élèves = une seule requête SQL, donc 2300 élèves = ~12 requêtes
    // au lieu de 2300 : largement sous n'importe quel timeout.
    const TAILLE_LOT = 200;
    const valides = [];

    eleves.forEach((e, i) => {
        const matricule = (e.matricule || '').toString().trim().toUpperCase();
        if (!matricule) {
            echoues++;
            erreurs.push({ ligne: i + 2, matricule: '(vide)', raison: 'Matricule manquant' });
            return;
        }
        valides.push({
            matricule, nom: e.nom, prenoms: e.prenoms, sexe: tronquer(e.sexe, 1),
            date_naissance: normaliserDateNaissance(e.date_naissance), lieu_naissance: e.lieu_naissance,
            nationalite: tronquer(e.nationalite, 10), classe: tronquer(e.classe, 20),
            classe_precedente: tronquer(e.classe_precedente, 50),
            statut: tronquer(e.statut || 'NAFF', 20), qualite: tronquer(e.qualite, 10),
            lv2: tronquer(e.lv2 || 'N/A', 20), regime: tronquer(e.regime, 20),
            nom_pere: e.nom_pere, prenoms_pere: e.prenoms_pere,
            contact_pere: tronquer(e.contact_pere, 20),
            nom_mere: e.nom_mere, prenoms_mere: e.prenoms_mere,
            contact_mere: tronquer(e.contact_mere, 20)
        });
    });

    for (let i = 0; i < valides.length; i += TAILLE_LOT) {
        const lot = valides.slice(i, i + TAILLE_LOT);
        try {
            const result = await pool.query(`
                INSERT INTO eleves
                (matricule, nom, prenoms, sexe, date_naissance, lieu_naissance, nationalite,
                 classe, classe_precedente, statut, qualite, lv2, regime,
                 nom_pere, prenoms_pere, contact_pere, nom_mere, prenoms_mere, contact_mere)
                SELECT * FROM unnest(
                    $1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[], $5::date[],
                    $6::varchar[], $7::varchar[], $8::varchar[], $9::varchar[], $10::varchar[],
                    $11::varchar[], $12::varchar[], $13::varchar[], $14::varchar[], $15::varchar[],
                    $16::varchar[], $17::varchar[], $18::varchar[], $19::varchar[]
                )
                ON CONFLICT (matricule) DO NOTHING
                RETURNING matricule
            `, [
                lot.map(e => e.matricule), lot.map(e => e.nom), lot.map(e => e.prenoms),
                lot.map(e => e.sexe), lot.map(e => e.date_naissance), lot.map(e => e.lieu_naissance),
                lot.map(e => e.nationalite), lot.map(e => e.classe), lot.map(e => e.classe_precedente),
                lot.map(e => e.statut), lot.map(e => e.qualite), lot.map(e => e.lv2), lot.map(e => e.regime),
                lot.map(e => e.nom_pere), lot.map(e => e.prenoms_pere), lot.map(e => e.contact_pere),
                lot.map(e => e.nom_mere), lot.map(e => e.prenoms_mere), lot.map(e => e.contact_mere)
            ]);
            importes += result.rowCount;
        } catch (err) {
            // Un lot entier a échoué (ex: une date invalide dans ce lot) :
            // on retombe en mode ligne-par-ligne POUR CE LOT UNIQUEMENT,
            // afin d'isoler précisément la ou les lignes fautives sans
            // perdre tout le lot ni interrompre les lots suivants.
            for (const e of lot) {
                try {
                    const r = await pool.query(`
                        INSERT INTO eleves
                        (matricule, nom, prenoms, sexe, date_naissance, lieu_naissance, nationalite,
                         classe, classe_precedente, statut, qualite, lv2, regime,
                         nom_pere, prenoms_pere, contact_pere, nom_mere, prenoms_mere, contact_mere)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
                        ON CONFLICT (matricule) DO NOTHING
                    `, [
                        e.matricule, e.nom, e.prenoms, e.sexe, e.date_naissance,
                        e.lieu_naissance, e.nationalite, e.classe, e.classe_precedente, e.statut, e.qualite,
                        e.lv2, e.regime, e.nom_pere, e.prenoms_pere, e.contact_pere,
                        e.nom_mere, e.prenoms_mere, e.contact_mere
                    ]);
                    importes += r.rowCount;
                } catch (errLigne) {
                    echoues++;
                    erreurs.push({ matricule: e.matricule, raison: errLigne.message });
                    console.error('❌ Import échoué pour ' + e.matricule + ' :', errLigne.message);
                }
            }
        }
    }

    const existants = valides.length - importes - echoues;
    res.json({
        importes,
        existants,
        echoues,
        erreurs: erreurs.slice(0, 50),
        message: importes + ' élève(s) importé(s), ' + existants + ' déjà existant(s), ' + echoues + ' échoué(s)'
    });
});



// POST - Valider inscription (public - parent)
//
// "bloque" agit comme verrou de modification : un élève déjà pré-inscrit ou
// inscrit qui est verrouillé (bloque = true) ne peut pas re-soumettre tant que
// l'admin n'a pas déverrouillé depuis le tableau. Une fois la soumission
// acceptée, le verrou se referme automatiquement (bloque = true), pour que le
// déverrouillage accordé par l'admin ne serve que pour cette unique modification.
app.post('/api/eleves/inscrire', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const data = req.body;
    const matricule = data.matricule.toUpperCase();
    
    try {
        // Vérifier si verrouillé (uniquement pertinent si une démarche a déjà
        // été entamée ; un élève "en attente" n'a jamais de verrou actif)
        const check = await pool.query(
            'SELECT bloque, date_preinscription, date_inscription FROM eleves WHERE matricule = $1',
            [matricule]
        );
        if (check.rows.length > 0) {
            const e = check.rows[0];
            const dejaSoumis = !!(e.date_preinscription || e.date_inscription);
            if (e.bloque && dejaSoumis) {
                return res.status(403).json({ error: 'Vos informations sont verrouillées. Contactez l\'administration pour les modifier.' });
            }
        }
        
        // Mettre à jour ou créer
        // Le parent ne modifie pas le statut (AFF/NAFF fixé par l'admin).
        // La prise en compte de la pré-inscription se fait via date_inscription NULL —>
        // tant que l'admin n'a pas validé, date_inscription est NULL.
        // bloque = TRUE à chaque soumission acceptée : reverrouille automatiquement
        // après usage du déverrouillage ponctuel accordé par l'admin.
        const result = await pool.query(`
            INSERT INTO eleves 
            (matricule, nom, prenoms, sexe, date_naissance, lieu_naissance, nationalite,
             classe, classe_precedente, statut, qualite, lv2, regime,
             nom_pere, prenoms_pere, contact_pere, nom_mere, prenoms_mere, contact_mere,
             date_preinscription, bloque)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),TRUE)
            ON CONFLICT (matricule) DO UPDATE SET
                nom = EXCLUDED.nom, prenoms = EXCLUDED.prenoms, sexe = EXCLUDED.sexe,
                date_naissance = EXCLUDED.date_naissance, lieu_naissance = EXCLUDED.lieu_naissance,
                nationalite = EXCLUDED.nationalite, classe = EXCLUDED.classe,
                classe_precedente = EXCLUDED.classe_precedente,
                qualite = EXCLUDED.qualite, lv2 = EXCLUDED.lv2,
                regime = EXCLUDED.regime, nom_pere = EXCLUDED.nom_pere,
                prenoms_pere = EXCLUDED.prenoms_pere, contact_pere = EXCLUDED.contact_pere,
                nom_mere = EXCLUDED.nom_mere, prenoms_mere = EXCLUDED.prenoms_mere,
                contact_mere = EXCLUDED.contact_mere,
                date_preinscription = NOW(),
                bloque = TRUE
            RETURNING *
        `, [
            matricule, data.nom, data.prenoms, data.sexe, data.date_naissance,
            data.lieu_naissance, data.nationalite, data.classe, data.classe_precedente,
            data.statut, data.qualite, data.lv2 || 'N/A', data.regime, data.nom_pere, data.prenoms_pere,
            data.contact_pere, data.nom_mere, data.prenoms_mere, data.contact_mere
        ]);
        
        res.json({ message: 'Inscription validée', eleve: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT - Modifier les données d'un élève (admin/utilisateur)
// Permet de corriger n'importe quel champ sans toucher à date_inscription
app.put('/api/eleves/:matricule', requireAuth, async (req, res) => {
    const matricule = req.params.matricule.toUpperCase();
    const d = req.body;
    try {
        const result = await pool.query(`
            UPDATE eleves SET
                nom = $1, prenoms = $2, sexe = $3, date_naissance = $4,
                lieu_naissance = $5, nationalite = $6, classe = $7,
                classe_precedente = $8, statut = $9, qualite = $10,
                lv2 = $11, regime = $12, nom_pere = $13, prenoms_pere = $14,
                contact_pere = $15, nom_mere = $16, prenoms_mere = $17,
                contact_mere = $18
            WHERE matricule = $19 RETURNING *
        `, [
            d.nom, d.prenoms, d.sexe, d.date_naissance || null,
            d.lieu_naissance, d.nationalite, d.classe,
            d.classe_precedente, d.statut, d.qualite,
            d.lv2 || 'N/A', d.regime, d.nom_pere, d.prenoms_pere,
            d.contact_pere, d.nom_mere, d.prenoms_mere,
            d.contact_mere, matricule
        ]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Élève non trouvé' });
        res.json({ message: 'Modifications enregistrées', eleve: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT - Valider l'inscription d'un élève (admin/utilisateur)
// Pose date_inscription = NOW() et valide_par = nom de l'utilisateur connecté
app.put('/api/eleves/:matricule/valider', requireAuth, async (req, res) => {
    const matricule = req.params.matricule.toUpperCase();
    const token = req.headers.authorization;
    const sess = sessions.get(token);

    // Récupérer le nom complet de celui qui valide
    let validePar = sess ? sess.username : 'Inconnu';
    if (sess && sess.userId) {
        try {
            const u = await pool.query('SELECT nom_complet FROM users WHERE id = $1', [sess.userId]);
            if (u.rows.length > 0 && u.rows[0].nom_complet) {
                validePar = u.rows[0].nom_complet;
            }
        } catch (_) {}
    } else if (sess && sess.username === 'admin') {
        validePar = 'Administrateur';
    }

    try {
        const result = await pool.query(
            `UPDATE eleves SET date_inscription = NOW(), valide_par = $1 WHERE matricule = $2 RETURNING *`,
            [validePar, matricule]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Élève non trouvé' });
        res.json({ message: 'Inscription validée', eleve: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT - Verrouiller/Déverrouiller la modification pour le parent (admin)
// bloque = TRUE  → le parent voit ses informations en lecture seule (verrouillé)
// bloque = FALSE → l'admin autorise ponctuellement le parent à modifier ;
//                  le verrou se referme automatiquement à la prochaine
//                  soumission (cf. /api/eleves/inscrire)
app.put('/api/eleves/:matricule/bloquer', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'UPDATE eleves SET bloque = NOT bloque WHERE matricule = $1 RETURNING *',
            [req.params.matricule]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Non trouvé' });
        res.json({ message: result.rows[0].bloque ? 'Verrouillé' : 'Déverrouillé', eleve: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE - Supprimer en masse (admin) - un seul aller-retour DB pour N matricules,
// au lieu de N requêtes HTTP séparées : indispensable pour des sélections de
// plusieurs centaines/milliers d'élèves (rapide, quel que soit le volume).
app.post('/api/eleves/supprimer-masse', requireAuth, async (req, res) => {
    const matricules = req.body.matricules;
    if (!Array.isArray(matricules) || matricules.length === 0) {
        return res.status(400).json({ error: 'Liste de matricules vide ou invalide' });
    }
    try {
        const matriculesMaj = matricules.map(m => String(m).toUpperCase());
        const result = await pool.query(
            'DELETE FROM eleves WHERE matricule = ANY($1) RETURNING matricule',
            [matriculesMaj]
        );
        res.json({
            supprimes: result.rowCount,
            message: result.rowCount + ' élève(s) supprimé(s)'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE - Supprimer (admin)
app.delete('/api/eleves/:matricule', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'DELETE FROM eleves WHERE matricule = $1 RETURNING matricule',
            [req.params.matricule.toUpperCase()]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Élève non trouvé : ' + req.params.matricule });
        }
        res.json({ message: 'Supprimé' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== UTILITAIRES CSV =====

// Formate une date (objet Date renvoyé par pg, ou string) en YYYY-MM-DD
// Évite que le Date.toString() JS ("Mon May 20 2012 00:00:00 GMT+0000 (...)")
// ne pollue le fichier CSV exporté.
function formatDateCSV(value) {
    if (!value) return '';
    const date = new Date(value);
    if (isNaN(date.getTime())) return '';
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

// Idem mais conserve l'heure (utile pour date_inscription, un TIMESTAMP)
function formatTimestampCSV(value) {
    if (!value) return '';
    const date = new Date(value);
    if (isNaN(date.getTime())) return '';
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

// Échappe une valeur pour un champ CSV séparé par ';'. Si la valeur contient
// le séparateur, des guillemets ou un retour à la ligne, elle est entourée
// de guillemets (et les guillemets internes doublés), comme le veut le CSV.
// Sans ça, un nom de lieu du type "Abidjan; Cocody" décalerait toutes les colonnes.
function csvEscape(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    if (str.includes(';') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

// GET - Exporter CSV (admin)
app.get('/api/eleves/export/csv', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM eleves ORDER BY date_creation DESC');
        const eleves = result.rows;

        const headers = [
            'Matricule', 'Nom', 'Prenoms', 'Sexe', 'Date_Naissance', 'Lieu_Naissance',
            'Nationalite', 'Classe', 'Classe_Precedente', 'Statut', 'Qualite', 'LV2', 'Regime',
            'Nom_Pere', 'Prenoms_Pere', 'Contact_Pere', 'Nom_Mere', 'Prenoms_Mere',
            'Contact_Mere', 'Date_Inscription'
        ];
        let csv = headers.join(';') + '\n';

        eleves.forEach(e => {
            const row = [
                e.matricule, e.nom, e.prenoms, e.sexe,
                formatDateCSV(e.date_naissance), e.lieu_naissance, e.nationalite,
                e.classe, e.classe_precedente, e.statut, e.qualite, e.lv2, e.regime,
                e.nom_pere, e.prenoms_pere, e.contact_pere,
                e.nom_mere, e.prenoms_mere, e.contact_mere,
                formatTimestampCSV(e.date_inscription)
            ].map(csvEscape);
            csv += row.join(';') + '\n';
        });

        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=eleves_cartesiens_' + new Date().toISOString().split('T')[0] + '.csv');
        // BOM UTF-8 : sans ça, Excel (très utilisé pour ouvrir ces CSV) affiche
        // les accents (é, è, à...) comme des caractères corrompus.
        res.send('\uFEFF' + csv);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== ROUTES NIVEAUX & CLASSES =====

// GET - Liste fixe des niveaux (public). Sert à la page d'inscription
// (regroupement du menu déroulant + règle LV2) et à l'admin (modal de
// gestion des classes, pour afficher tous les niveaux même sans classe créée).
app.get('/api/niveaux', (req, res) => {
    res.json(NIVEAUX);
});

// ===== LOGIQUE DE SUGGESTION DE CLASSES =====
// Retourne les classes candidates pour un élève en fonction de sa classe précédente.
// Règles :
//  - Même numéro d'abord (redoublement possible)
//  - Classe du niveau suivant : même numéro, si plein → même parité +2 +2...
//  - Parité du numéro source conservée partout (pair→pair, impair→impair)
//  - Max 40 élèves (PRE_INSCRIT + INSCRIT) par classe
//  - 3EME → propose 2NDE_A et 2NDE_C (deux filières distinctes)
//  - 2NDE_C → 1ERE_C et 1ERE_D (bifurcation)
//  - 2NDE_A → 1ERE_A uniquement
//  - 1ERE_A → TLE_A, 1ERE_C → TLE_C, 1ERE_D → TLE_D
//  - CM2 / classe inconnue → toutes les 6EME disponibles

const PROGRESSION = {
    '6EME':   ['5EME'],
    '5EME':   ['4EME'],
    '4EME':   ['3EME'],
    '3EME':   ['2NDE_A', '2NDE_C'],
    '2NDE_A': ['1ERE_A'],
    '2NDE_C': ['1ERE_C', '1ERE_D'],
    '1ERE_A': ['TLE_A'],
    '1ERE_C': ['TLE_C'],
    '1ERE_D': ['TLE_D'],
    'TLE_A':  [],
    'TLE_C':  [],
    'TLE_D':  []
};
const MAX_ELEVES_DEFAUT = 40;

// Retourne le max d'élèves pour une classe donnée :
// 1) max individuel de la classe si défini
// 2) sinon max du niveau si défini
// 3) sinon MAX_ELEVES_DEFAUT (40)
async function getMaxEleves(classeCode, niveauCode) {
    try {
        // 1) Max individuel de la classe
        const resClasse = await pool.query(
            'SELECT max_eleves FROM classes WHERE code = $1', [classeCode]
        );
        if (resClasse.rows.length > 0 && resClasse.rows[0].max_eleves !== null) {
            return resClasse.rows[0].max_eleves;
        }
        // 2) Max du niveau
        const resNiveau = await pool.query(
            'SELECT max_eleves FROM niveaux_config WHERE niveau = $1', [niveauCode]
        );
        if (resNiveau.rows.length > 0) {
            return resNiveau.rows[0].max_eleves;
        }
    } catch (_) {}
    // 3) Défaut
    return MAX_ELEVES_DEFAUT;
}

// Parse une classe précédente saisie librement ou stockée en base.
// Retourne { niveau, numero } ou null si non reconnu.
function parseClassePrecedente(classeStr) {
    if (!classeStr) return null;
    const s = String(classeStr).trim().toUpperCase();

    // Format code BD : ex "6EME_2", "2NDE_A_3", "1ERE_C_1"
    const matchCode = s.match(/^([A-Z0-9_]+?)_(\d+)$/);
    if (matchCode) {
        const niveau = matchCode[1];
        const numero = parseInt(matchCode[2], 10);
        if (NIVEAUX_PAR_CODE[niveau] && numero > 0) return { niveau, numero };
    }

    // Correspondances textuelles (saisies libres du parent)
    const ALIAS = {
        'CM2': null, 'CP': null, 'CE1': null, 'CE2': null, 'CM1': null, // primaire → 6EME
    };
    if (Object.prototype.hasOwnProperty.call(ALIAS, s)) return { niveau: 'PRIMAIRE', numero: 1 };

    // Format lisible : "6EME 2", "6ÈME 2", "4EME 3", "2NDE A 1", "1ERE D 2"...
    // Tentative de correspondance flexible
    for (const code of Object.keys(NIVEAUX_PAR_CODE)) {
        // On essaie de trouver le code dans la chaîne (avec tolérance accents)
        const normalized = s.replace(/[ÈÉÊË]/g, 'E').replace(/[ÀÂ]/g, 'A').replace(/[Ù]/g, 'U');
        // Chercher le label du niveau + un numéro
        const niv = NIVEAUX_PAR_CODE[code];
        const labelNorm = niv.label.toUpperCase().replace(/[ÈÉÊË]/g, 'E').replace(/[ÀÂ]/g, 'A');
        if (normalized.startsWith(labelNorm) || normalized.startsWith(code)) {
            const rest = normalized.startsWith(labelNorm)
                ? normalized.slice(labelNorm.length).trim()
                : normalized.slice(code.length).trim();
            const num = parseInt(rest, 10);
            if (!isNaN(num) && num > 0) return { niveau: code, numero: num };
        }
    }
    return null; // non reconnu → classes 6EME
}

// Compte les élèves actifs (PRE_INSCRIT ou ayant soumis) dans une classe
async function compterElevesClasse(classeCode) {
    const res = await pool.query(
        `SELECT COUNT(*) AS nb FROM eleves
         WHERE classe = $1
           AND (date_preinscription IS NOT NULL OR date_inscription IS NOT NULL)`,
        [classeCode]
    );
    return parseInt(res.rows[0].nb, 10);
}

// Trouve la première classe non pleine d'un niveau, en commençant par le numéro
// cible et en incrémentant de 'step' (2 pour parité conservée, 1 sinon).
async function trouverClasseDisponible(niveau, numeroDepart, step, classesExistantes) {
    const classesDuNiveau = classesExistantes
        .filter(c => c.niveau === niveau)
        .sort((a, b) => a.numero - b.numero);
    if (classesDuNiveau.length === 0) return null;

    const maxNumero = Math.max(...classesDuNiveau.map(c => c.numero));
    let n = numeroDepart;

    while (n <= maxNumero + step * 10) { // borne de sécurité
        const classeCode = niveau + '_' + n;
        const existe = classesDuNiveau.find(c => c.numero === n);
        if (!existe) {
            n += step;
            continue;
        }
        const nb = await compterElevesClasse(classeCode);
        const max = await getMaxEleves(classeCode, niveau);
        if (nb < max) return classeCode;
        n += step;
    }
    return null; // toutes pleines
}

// GET - Suggérer les classes candidates pour une classe précédente donnée
// Query param : ?classe_precedente=6EME_2  ou  ?classe_precedente=CM2
app.get('/api/classes/suggerer', async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const classePrec = req.query.classe_precedente || '';

    try {
        // Charger toutes les classes existantes une seule fois
        const result = await pool.query('SELECT * FROM classes ORDER BY niveau, numero');
        const classesExistantes = result.rows;

        const parsed = parseClassePrecedente(classePrec);

        // Cas : classe précédente primaire (CM2, etc.) ou non reconnue → toutes les 6EME
        if (!parsed || parsed.niveau === 'PRIMAIRE' || !NIVEAUX_PAR_CODE[parsed.niveau]) {
            const classes6eme = classesExistantes
                .filter(c => c.niveau === '6EME')
                .sort((a, b) => a.numero - b.numero);
            return res.json({
                classes_candidates: classes6eme.map(c => ({
                    code: c.code,
                    label: NIVEAUX_PAR_CODE['6EME'].label + ' ' + c.numero,
                    niveau: '6EME',
                    numero: c.numero
                })),
                classe_precedente_parsee: null
            });
        }

        const { niveau: niveauPrec, numero: numeroPrec } = parsed;
        const pariteStep = 2; // on incrémente de 2 pour garder la parité
        const suggestions = [];

        // 1) Même classe (redoublement)
        const memeClasseCode = niveauPrec + '_' + numeroPrec;
        const memeClasseExiste = classesExistantes.find(c => c.code === memeClasseCode);
        if (memeClasseExiste) {
            const nb = await compterElevesClasse(memeClasseCode);
            const max = await getMaxEleves(memeClasseCode, niveauPrec);
            if (nb < max) {
                suggestions.push({
                    code: memeClasseCode,
                    label: NIVEAUX_PAR_CODE[niveauPrec].label + ' ' + numeroPrec,
                    niveau: niveauPrec,
                    numero: numeroPrec,
                    type: 'redoublement'
                });
            }
        }

        // 2) Niveaux suivants selon la progression
        const niveauxSuivants = PROGRESSION[niveauPrec] || [];
        for (const niveauSuiv of niveauxSuivants) {
            if (!NIVEAUX_PAR_CODE[niveauSuiv]) continue;
            const classesCandidates = classesExistantes.filter(c => c.niveau === niveauSuiv);
            if (classesCandidates.length === 0) continue;

            // Cherche d'abord le même numéro, puis même parité
            let classeCode = await trouverClasseDisponible(niveauSuiv, numeroPrec, pariteStep, classesExistantes);

            // Si rien trouvé (parité inexistante dans ce niveau), chercher sans contrainte de parité
            if (!classeCode) {
                classeCode = await trouverClasseDisponible(niveauSuiv, 1, 1, classesExistantes);
            }

            if (classeCode) {
                const numSugg = parseInt(classeCode.split('_').pop(), 10);
                suggestions.push({
                    code: classeCode,
                    label: NIVEAUX_PAR_CODE[niveauSuiv].label + ' ' + numSugg,
                    niveau: niveauSuiv,
                    numero: numSugg,
                    type: 'progression'
                });
            }
        }

        // Dédupliquer (au cas où redoublement = même code qu'une progression)
        const seen = new Set();
        const dedup = suggestions.filter(s => {
            if (seen.has(s.code)) return false;
            seen.add(s.code);
            return true;
        });

        res.json({
            classes_candidates: dedup,
            classe_precedente_parsee: { niveau: niveauPrec, numero: numeroPrec }
        });

    } catch (err) {
        console.error('/api/classes/suggerer erreur:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// GET - Config max élèves de tous les niveaux (admin)
app.get('/api/niveaux/config', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM niveaux_config');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT - Définir le max élèves d'un niveau (admin)
app.put('/api/niveaux/:niveau/max', requireAuth, async (req, res) => {
    const niveau = req.params.niveau.toUpperCase();
    const max = parseInt(req.body.max_eleves, 10);
    if (!NIVEAUX_PAR_CODE[niveau]) return res.status(400).json({ error: 'Niveau inconnu' });
    if (isNaN(max) || max < 1 || max > 10000) return res.status(400).json({ error: 'Max invalide (entre 1 et 10000)' });
    try {
        await pool.query(`
            INSERT INTO niveaux_config (niveau, max_eleves, date_modification)
            VALUES ($1, $2, NOW())
            ON CONFLICT (niveau) DO UPDATE SET max_eleves = $2, date_modification = NOW()
        `, [niveau, max]);
        res.json({ message: 'Max mis à jour pour ' + niveau, max_eleves: max });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT - Définir le max élèves d'une classe individuelle (admin)
app.put('/api/classes/:code/max', requireAuth, async (req, res) => {
    const code = req.params.code;
    const max = req.body.max_eleves;
    // max peut être null (pour revenir au max du niveau) ou un entier
    if (max !== null && max !== undefined) {
        const n = parseInt(max, 10);
        if (isNaN(n) || n < 1 || n > 10000) return res.status(400).json({ error: 'Max invalide (entre 1 et 10000)' });
    }
    try {
        const result = await pool.query(
            'UPDATE classes SET max_eleves = $1 WHERE code = $2 RETURNING *',
            [max === null || max === '' ? null : parseInt(max, 10), code]
        );
        if (result.rowCount === 0) return res.status(404).json({ error: 'Classe non trouvée' });
        res.json({ message: 'Max mis à jour pour ' + code, classe: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET - Classes existantes, triées par ordre pédagogique puis numéro (public,
// utilisé par la page d'inscription pour remplir le menu "Classe").
app.get('/api/classes', async (req, res) => {
    // Header JSON explicite : même si Express échoue, jamais de HTML renvoyé
    res.setHeader('Content-Type', 'application/json');
    try {
        const result = await pool.query('SELECT * FROM classes ORDER BY niveau, numero');
        const classes = result.rows.map(c => {
            const niv = NIVEAUX_PAR_CODE[c.niveau] || { label: c.niveau, ordre: 999, lv2: false };
            return {
                code: c.code,
                niveau: c.niveau,
                numero: c.numero,
                label: c.label,
                niveau_label: niv.label,
                ordre: niv.ordre,
                lv2: niv.lv2,
                max_eleves: c.max_eleves  // null = utiliser le max du niveau
            };
        }).sort((a, b) => a.ordre - b.ordre || a.numero - b.numero);
        res.json(classes);
    } catch (err) {
        console.error('/api/classes erreur:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST - Crée/ajuste le nombre de classes d'un niveau (admin). Génère les
// classes manquantes (NIVEAU_1, NIVEAU_2...) et, si on diminue le nombre,
// supprime les classes en trop SAUF si des élèves y sont encore inscrits
// (dans ce cas on refuse, pour ne jamais perdre l'affectation d'un élève).
app.post('/api/classes/generer', requireAuth, async (req, res) => {
    const { niveau, nombre } = req.body;
    const niv = NIVEAUX_PAR_CODE[niveau];
    if (!niv) return res.status(400).json({ error: 'Niveau inconnu : ' + niveau });

    const n = parseInt(nombre, 10);
    if (isNaN(n) || n < 0 || n > 50) {
        return res.status(400).json({ error: 'Nombre de classes invalide (entre 0 et 50)' });
    }

    try {
        const existant = await pool.query(
            'SELECT numero, code FROM classes WHERE niveau = $1 ORDER BY numero',
            [niveau]
        );
        const numerosExistants = existant.rows.map(r => r.numero);
        const maxExistant = numerosExistants.length > 0 ? Math.max(...numerosExistants) : 0;

        // Réduction : on vérifie qu'aucun élève n'occupe les classes à retirer
        if (n < maxExistant) {
            const aSupprimer = existant.rows.filter(r => r.numero > n).map(r => r.code);
            const occupes = await pool.query(
                'SELECT classe, COUNT(*) AS nb FROM eleves WHERE classe = ANY($1) GROUP BY classe',
                [aSupprimer]
            );
            if (occupes.rows.length > 0) {
                const detail = occupes.rows.map(r => r.classe + ' (' + r.nb + ' élève(s))').join(', ');
                return res.status(409).json({
                    error: 'Impossible de réduire à ' + n + ' : des élèves sont encore dans ' + detail + '. Réaffectez-les avant de supprimer ces classes.'
                });
            }
            await pool.query('DELETE FROM classes WHERE niveau = $1 AND numero > $2', [niveau, n]);
        }

        // Création des classes manquantes (1 à n)
        for (let i = 1; i <= n; i++) {
            if (numerosExistants.includes(i)) continue;
            const code = niveau + '_' + i;
            const label = niv.label + ' ' + i;
            await pool.query(
                'INSERT INTO classes (niveau, numero, code, label) VALUES ($1,$2,$3,$4) ON CONFLICT (code) DO NOTHING',
                [niveau, i, code, label]
            );
        }

        const result = await pool.query('SELECT * FROM classes WHERE niveau = $1 ORDER BY numero', [niveau]);
        res.json({
            message: niv.label + ' : ' + n + ' classe(s) configurée(s)',
            classes: result.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE - Supprime une classe précise (admin). Refusé si des élèves y sont
// encore affectés, pour éviter de perdre silencieusement leur classe.
app.delete('/api/classes/:code', requireAuth, async (req, res) => {
    const code = req.params.code;
    try {
        const occupes = await pool.query('SELECT COUNT(*) AS nb FROM eleves WHERE classe = $1', [code]);
        const nb = parseInt(occupes.rows[0].nb, 10);
        if (nb > 0) {
            return res.status(409).json({
                error: nb + ' élève(s) sont encore dans cette classe. Réaffectez-les avant de la supprimer.'
            });
        }
        const result = await pool.query('DELETE FROM classes WHERE code = $1 RETURNING code', [code]);
        if (result.rowCount === 0) return res.status(404).json({ error: 'Classe non trouvée' });
        res.json({ message: 'Classe supprimée' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Servir les pages
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/inscription', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'inscription.html'));
});

// Route catch-all : exclure les appels /api/ pour ne jamais renvoyer du HTML à la place d'un JSON
app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
        return res.status(404).json({ error: 'Route API introuvable : ' + req.path });
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.listen(PORT, () => {
    console.log('🚀 Serveur démarré sur le port ' + PORT);
});
