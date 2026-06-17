const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
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
    ssl: { rejectUnauthorized: false }
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
        console.log('✅ Base de données prête');
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
    { code: '2NDE',   label: '2nde',   ordre: 5,  lv2: true  },
    { code: '1ERE_A', label: '1ère A', ordre: 6,  lv2: true  },
    { code: '1ERE_C', label: '1ère C', ordre: 7,  lv2: false },
    { code: '1ERE_D', label: '1ère D', ordre: 8,  lv2: false },
    { code: 'TLE_A',  label: 'Tle A',  ordre: 9,  lv2: true  },
    { code: 'TLE_C',  label: 'Tle C',  ordre: 10, lv2: false },
    { code: 'TLE_D',  label: 'Tle D',  ordre: 11, lv2: false }
];
const NIVEAUX_PAR_CODE = Object.fromEntries(NIVEAUX.map(n => [n.code, n]));

// ===== MIDDLEWARE AUTH =====
function requireAuth(req, res, next) {
    const token = req.headers.authorization;
    if (!token || !sessions.has(token)) {
        return res.status(401).json({ error: 'Non autorisé' });
    }
    next();
}

// ===== ROUTES AUTH =====
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'Admin@123') {
        const token = 'admin_' + Date.now();
        sessions.set(token, { username, loginAt: new Date() });
        res.json({ token, message: 'Connecté' });
    } else {
        res.status(401).json({ error: 'Identifiants incorrects' });
    }
});

app.post('/api/logout', (req, res) => {
    const token = req.headers.authorization;
    sessions.delete(token);
    res.json({ message: 'Déconnecté' });
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

// GET - Vérifier si élève existe (public - pour inscription)
app.get('/api/eleves/verifier/:matricule', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM eleves WHERE matricule = $1',
            [req.params.matricule.toUpperCase()]
        );
        if (result.rows.length === 0) {
            return res.json({ existe: false });
        }
        const eleve = result.rows[0];
        if (eleve.bloque) {
            return res.json({ existe: true, bloque: true, message: 'Inscription bloquée. Contactez l\'administration.' });
        }
        res.json({ existe: true, bloque: false, eleve });
    } catch (err) {
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
                 classe, statut, qualite, lv2, regime,
                 nom_pere, prenoms_pere, contact_pere, nom_mere, prenoms_mere, contact_mere)
                SELECT * FROM unnest(
                    $1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[], $5::date[],
                    $6::varchar[], $7::varchar[], $8::varchar[], $9::varchar[], $10::varchar[],
                    $11::varchar[], $12::varchar[], $13::varchar[], $14::varchar[], $15::varchar[],
                    $16::varchar[], $17::varchar[], $18::varchar[]
                )
                ON CONFLICT (matricule) DO NOTHING
                RETURNING matricule
            `, [
                lot.map(e => e.matricule), lot.map(e => e.nom), lot.map(e => e.prenoms),
                lot.map(e => e.sexe), lot.map(e => e.date_naissance), lot.map(e => e.lieu_naissance),
                lot.map(e => e.nationalite), lot.map(e => e.classe), lot.map(e => e.statut),
                lot.map(e => e.qualite), lot.map(e => e.lv2), lot.map(e => e.regime),
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
                         classe, statut, qualite, lv2, regime,
                         nom_pere, prenoms_pere, contact_pere, nom_mere, prenoms_mere, contact_mere)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                        ON CONFLICT (matricule) DO NOTHING
                    `, [
                        e.matricule, e.nom, e.prenoms, e.sexe, e.date_naissance,
                        e.lieu_naissance, e.nationalite, e.classe, e.statut, e.qualite,
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
app.post('/api/eleves/inscrire', async (req, res) => {
    const data = req.body;
    const matricule = data.matricule.toUpperCase();
    
    try {
        // Vérifier si bloqué
        const check = await pool.query('SELECT bloque FROM eleves WHERE matricule = $1', [matricule]);
        if (check.rows.length > 0 && check.rows[0].bloque) {
            return res.status(403).json({ error: 'Inscription bloquée' });
        }
        
        // Mettre à jour ou créer
        const result = await pool.query(`
            INSERT INTO eleves 
            (matricule, nom, prenoms, sexe, date_naissance, lieu_naissance, nationalite,
             classe, statut, qualite, lv2, regime,
             nom_pere, prenoms_pere, contact_pere, nom_mere, prenoms_mere, contact_mere, date_inscription)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
            ON CONFLICT (matricule) DO UPDATE SET
                nom = EXCLUDED.nom, prenoms = EXCLUDED.prenoms, sexe = EXCLUDED.sexe,
                date_naissance = EXCLUDED.date_naissance, lieu_naissance = EXCLUDED.lieu_naissance,
                nationalite = EXCLUDED.nationalite, classe = EXCLUDED.classe,
                statut = EXCLUDED.statut, qualite = EXCLUDED.qualite, lv2 = EXCLUDED.lv2,
                regime = EXCLUDED.regime, nom_pere = EXCLUDED.nom_pere,
                prenoms_pere = EXCLUDED.prenoms_pere, contact_pere = EXCLUDED.contact_pere,
                nom_mere = EXCLUDED.nom_mere, prenoms_mere = EXCLUDED.prenoms_mere,
                contact_mere = EXCLUDED.contact_mere, date_inscription = NOW()
            RETURNING *
        `, [
            matricule, data.nom, data.prenoms, data.sexe, data.date_naissance,
            data.lieu_naissance, data.nationalite, data.classe, data.statut, data.qualite,
            data.lv2 || 'N/A', data.regime, data.nom_pere, data.prenoms_pere,
            data.contact_pere, data.nom_mere, data.prenoms_mere, data.contact_mere
        ]);
        
        res.json({ message: 'Inscription validée', eleve: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT - Bloquer/Débloquer (admin)
app.put('/api/eleves/:matricule/bloquer', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'UPDATE eleves SET bloque = NOT bloque WHERE matricule = $1 RETURNING *',
            [req.params.matricule]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Non trouvé' });
        res.json({ message: result.rows[0].bloque ? 'Bloqué' : 'Débloqué', eleve: result.rows[0] });
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
            'Nationalite', 'Classe', 'Statut', 'Qualite', 'LV2', 'Regime',
            'Nom_Pere', 'Prenoms_Pere', 'Contact_Pere', 'Nom_Mere', 'Prenoms_Mere',
            'Contact_Mere', 'Date_Inscription'
        ];
        let csv = headers.join(';') + '\n';

        eleves.forEach(e => {
            const row = [
                e.matricule, e.nom, e.prenoms, e.sexe,
                formatDateCSV(e.date_naissance), e.lieu_naissance, e.nationalite,
                e.classe, e.statut, e.qualite, e.lv2, e.regime,
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

// GET - Classes existantes, triées par ordre pédagogique puis numéro (public,
// utilisé par la page d'inscription pour remplir le menu "Classe").
app.get('/api/classes', async (req, res) => {
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
                lv2: niv.lv2
            };
        }).sort((a, b) => a.ordre - b.ordre || a.numero - b.numero);
        res.json(classes);
    } catch (err) {
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

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.listen(PORT, () => {
    console.log('🚀 Serveur démarré sur le port ' + PORT);
});const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
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
    ssl: { rejectUnauthorized: false }
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
        console.log('✅ Base de données prête');
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
    { code: '2NDE',   label: '2nde',   ordre: 5,  lv2: true  },
    { code: '1ERE_A', label: '1ère A', ordre: 6,  lv2: true  },
    { code: '1ERE_C', label: '1ère C', ordre: 7,  lv2: false },
    { code: '1ERE_D', label: '1ère D', ordre: 8,  lv2: false },
    { code: 'TLE_A',  label: 'Tle A',  ordre: 9,  lv2: true  },
    { code: 'TLE_C',  label: 'Tle C',  ordre: 10, lv2: false },
    { code: 'TLE_D',  label: 'Tle D',  ordre: 11, lv2: false }
];
const NIVEAUX_PAR_CODE = Object.fromEntries(NIVEAUX.map(n => [n.code, n]));

// ===== MIDDLEWARE AUTH =====
function requireAuth(req, res, next) {
    const token = req.headers.authorization;
    if (!token || !sessions.has(token)) {
        return res.status(401).json({ error: 'Non autorisé' });
    }
    next();
}

// ===== ROUTES AUTH =====
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'Admin@123') {
        const token = 'admin_' + Date.now();
        sessions.set(token, { username, loginAt: new Date() });
        res.json({ token, message: 'Connecté' });
    } else {
        res.status(401).json({ error: 'Identifiants incorrects' });
    }
});

app.post('/api/logout', (req, res) => {
    const token = req.headers.authorization;
    sessions.delete(token);
    res.json({ message: 'Déconnecté' });
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

// GET - Vérifier si élève existe (public - pour inscription)
app.get('/api/eleves/verifier/:matricule', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM eleves WHERE matricule = $1',
            [req.params.matricule.toUpperCase()]
        );
        if (result.rows.length === 0) {
            return res.json({ existe: false });
        }
        const eleve = result.rows[0];
        if (eleve.bloque) {
            return res.json({ existe: true, bloque: true, message: 'Inscription bloquée. Contactez l\'administration.' });
        }
        res.json({ existe: true, bloque: false, eleve });
    } catch (err) {
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
                 classe, statut, qualite, lv2, regime,
                 nom_pere, prenoms_pere, contact_pere, nom_mere, prenoms_mere, contact_mere)
                SELECT * FROM unnest(
                    $1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[], $5::date[],
                    $6::varchar[], $7::varchar[], $8::varchar[], $9::varchar[], $10::varchar[],
                    $11::varchar[], $12::varchar[], $13::varchar[], $14::varchar[], $15::varchar[],
                    $16::varchar[], $17::varchar[], $18::varchar[]
                )
                ON CONFLICT (matricule) DO NOTHING
                RETURNING matricule
            `, [
                lot.map(e => e.matricule), lot.map(e => e.nom), lot.map(e => e.prenoms),
                lot.map(e => e.sexe), lot.map(e => e.date_naissance), lot.map(e => e.lieu_naissance),
                lot.map(e => e.nationalite), lot.map(e => e.classe), lot.map(e => e.statut),
                lot.map(e => e.qualite), lot.map(e => e.lv2), lot.map(e => e.regime),
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
                         classe, statut, qualite, lv2, regime,
                         nom_pere, prenoms_pere, contact_pere, nom_mere, prenoms_mere, contact_mere)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                        ON CONFLICT (matricule) DO NOTHING
                    `, [
                        e.matricule, e.nom, e.prenoms, e.sexe, e.date_naissance,
                        e.lieu_naissance, e.nationalite, e.classe, e.statut, e.qualite,
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
app.post('/api/eleves/inscrire', async (req, res) => {
    const data = req.body;
    const matricule = data.matricule.toUpperCase();
    
    try {
        // Vérifier si bloqué
        const check = await pool.query('SELECT bloque FROM eleves WHERE matricule = $1', [matricule]);
        if (check.rows.length > 0 && check.rows[0].bloque) {
            return res.status(403).json({ error: 'Inscription bloquée' });
        }
        
        // Mettre à jour ou créer
        const result = await pool.query(`
            INSERT INTO eleves 
            (matricule, nom, prenoms, sexe, date_naissance, lieu_naissance, nationalite,
             classe, statut, qualite, lv2, regime,
             nom_pere, prenoms_pere, contact_pere, nom_mere, prenoms_mere, contact_mere, date_inscription)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
            ON CONFLICT (matricule) DO UPDATE SET
                nom = EXCLUDED.nom, prenoms = EXCLUDED.prenoms, sexe = EXCLUDED.sexe,
                date_naissance = EXCLUDED.date_naissance, lieu_naissance = EXCLUDED.lieu_naissance,
                nationalite = EXCLUDED.nationalite, classe = EXCLUDED.classe,
                statut = EXCLUDED.statut, qualite = EXCLUDED.qualite, lv2 = EXCLUDED.lv2,
                regime = EXCLUDED.regime, nom_pere = EXCLUDED.nom_pere,
                prenoms_pere = EXCLUDED.prenoms_pere, contact_pere = EXCLUDED.contact_pere,
                nom_mere = EXCLUDED.nom_mere, prenoms_mere = EXCLUDED.prenoms_mere,
                contact_mere = EXCLUDED.contact_mere, date_inscription = NOW()
            RETURNING *
        `, [
            matricule, data.nom, data.prenoms, data.sexe, data.date_naissance,
            data.lieu_naissance, data.nationalite, data.classe, data.statut, data.qualite,
            data.lv2 || 'N/A', data.regime, data.nom_pere, data.prenoms_pere,
            data.contact_pere, data.nom_mere, data.prenoms_mere, data.contact_mere
        ]);
        
        res.json({ message: 'Inscription validée', eleve: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT - Bloquer/Débloquer (admin)
app.put('/api/eleves/:matricule/bloquer', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'UPDATE eleves SET bloque = NOT bloque WHERE matricule = $1 RETURNING *',
            [req.params.matricule]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Non trouvé' });
        res.json({ message: result.rows[0].bloque ? 'Bloqué' : 'Débloqué', eleve: result.rows[0] });
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
            'Nationalite', 'Classe', 'Statut', 'Qualite', 'LV2', 'Regime',
            'Nom_Pere', 'Prenoms_Pere', 'Contact_Pere', 'Nom_Mere', 'Prenoms_Mere',
            'Contact_Mere', 'Date_Inscription'
        ];
        let csv = headers.join(';') + '\n';

        eleves.forEach(e => {
            const row = [
                e.matricule, e.nom, e.prenoms, e.sexe,
                formatDateCSV(e.date_naissance), e.lieu_naissance, e.nationalite,
                e.classe, e.statut, e.qualite, e.lv2, e.regime,
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

// GET - Classes existantes, triées par ordre pédagogique puis numéro (public,
// utilisé par la page d'inscription pour remplir le menu "Classe").
app.get('/api/classes', async (req, res) => {
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
                lv2: niv.lv2
            };
        }).sort((a, b) => a.ordre - b.ordre || a.numero - b.numero);
        res.json(classes);
    } catch (err) {
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

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.listen(PORT, () => {
    console.log('🚀 Serveur démarré sur le port ' + PORT);
});const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
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
    ssl: { rejectUnauthorized: false }
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
        console.log('✅ Base de données prête');
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
    { code: '2NDE',   label: '2nde',   ordre: 5,  lv2: true  },
    { code: '1ERE_A', label: '1ère A', ordre: 6,  lv2: true  },
    { code: '1ERE_C', label: '1ère C', ordre: 7,  lv2: false },
    { code: '1ERE_D', label: '1ère D', ordre: 8,  lv2: false },
    { code: 'TLE_A',  label: 'Tle A',  ordre: 9,  lv2: true  },
    { code: 'TLE_C',  label: 'Tle C',  ordre: 10, lv2: false },
    { code: 'TLE_D',  label: 'Tle D',  ordre: 11, lv2: false }
];
const NIVEAUX_PAR_CODE = Object.fromEntries(NIVEAUX.map(n => [n.code, n]));

// ===== MIDDLEWARE AUTH =====
function requireAuth(req, res, next) {
    const token = req.headers.authorization;
    if (!token || !sessions.has(token)) {
        return res.status(401).json({ error: 'Non autorisé' });
    }
    next();
}

// ===== ROUTES AUTH =====
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'admin' && password === 'Admin@123') {
        const token = 'admin_' + Date.now();
        sessions.set(token, { username, loginAt: new Date() });
        res.json({ token, message: 'Connecté' });
    } else {
        res.status(401).json({ error: 'Identifiants incorrects' });
    }
});

app.post('/api/logout', (req, res) => {
    const token = req.headers.authorization;
    sessions.delete(token);
    res.json({ message: 'Déconnecté' });
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

// GET - Vérifier si élève existe (public - pour inscription)
app.get('/api/eleves/verifier/:matricule', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM eleves WHERE matricule = $1',
            [req.params.matricule.toUpperCase()]
        );
        if (result.rows.length === 0) {
            return res.json({ existe: false });
        }
        const eleve = result.rows[0];
        if (eleve.bloque) {
            return res.json({ existe: true, bloque: true, message: 'Inscription bloquée. Contactez l\'administration.' });
        }
        res.json({ existe: true, bloque: false, eleve });
    } catch (err) {
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
                 classe, statut, qualite, lv2, regime,
                 nom_pere, prenoms_pere, contact_pere, nom_mere, prenoms_mere, contact_mere)
                SELECT * FROM unnest(
                    $1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[], $5::date[],
                    $6::varchar[], $7::varchar[], $8::varchar[], $9::varchar[], $10::varchar[],
                    $11::varchar[], $12::varchar[], $13::varchar[], $14::varchar[], $15::varchar[],
                    $16::varchar[], $17::varchar[], $18::varchar[]
                )
                ON CONFLICT (matricule) DO NOTHING
                RETURNING matricule
            `, [
                lot.map(e => e.matricule), lot.map(e => e.nom), lot.map(e => e.prenoms),
                lot.map(e => e.sexe), lot.map(e => e.date_naissance), lot.map(e => e.lieu_naissance),
                lot.map(e => e.nationalite), lot.map(e => e.classe), lot.map(e => e.statut),
                lot.map(e => e.qualite), lot.map(e => e.lv2), lot.map(e => e.regime),
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
                         classe, statut, qualite, lv2, regime,
                         nom_pere, prenoms_pere, contact_pere, nom_mere, prenoms_mere, contact_mere)
                        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                        ON CONFLICT (matricule) DO NOTHING
                    `, [
                        e.matricule, e.nom, e.prenoms, e.sexe, e.date_naissance,
                        e.lieu_naissance, e.nationalite, e.classe, e.statut, e.qualite,
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
app.post('/api/eleves/inscrire', async (req, res) => {
    const data = req.body;
    const matricule = data.matricule.toUpperCase();
    
    try {
        // Vérifier si bloqué
        const check = await pool.query('SELECT bloque FROM eleves WHERE matricule = $1', [matricule]);
        if (check.rows.length > 0 && check.rows[0].bloque) {
            return res.status(403).json({ error: 'Inscription bloquée' });
        }
        
        // Mettre à jour ou créer
        const result = await pool.query(`
            INSERT INTO eleves 
            (matricule, nom, prenoms, sexe, date_naissance, lieu_naissance, nationalite,
             classe, statut, qualite, lv2, regime,
             nom_pere, prenoms_pere, contact_pere, nom_mere, prenoms_mere, contact_mere, date_inscription)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,NOW())
            ON CONFLICT (matricule) DO UPDATE SET
                nom = EXCLUDED.nom, prenoms = EXCLUDED.prenoms, sexe = EXCLUDED.sexe,
                date_naissance = EXCLUDED.date_naissance, lieu_naissance = EXCLUDED.lieu_naissance,
                nationalite = EXCLUDED.nationalite, classe = EXCLUDED.classe,
                statut = EXCLUDED.statut, qualite = EXCLUDED.qualite, lv2 = EXCLUDED.lv2,
                regime = EXCLUDED.regime, nom_pere = EXCLUDED.nom_pere,
                prenoms_pere = EXCLUDED.prenoms_pere, contact_pere = EXCLUDED.contact_pere,
                nom_mere = EXCLUDED.nom_mere, prenoms_mere = EXCLUDED.prenoms_mere,
                contact_mere = EXCLUDED.contact_mere, date_inscription = NOW()
            RETURNING *
        `, [
            matricule, data.nom, data.prenoms, data.sexe, data.date_naissance,
            data.lieu_naissance, data.nationalite, data.classe, data.statut, data.qualite,
            data.lv2 || 'N/A', data.regime, data.nom_pere, data.prenoms_pere,
            data.contact_pere, data.nom_mere, data.prenoms_mere, data.contact_mere
        ]);
        
        res.json({ message: 'Inscription validée', eleve: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT - Bloquer/Débloquer (admin)
app.put('/api/eleves/:matricule/bloquer', requireAuth, async (req, res) => {
    try {
        const result = await pool.query(
            'UPDATE eleves SET bloque = NOT bloque WHERE matricule = $1 RETURNING *',
            [req.params.matricule]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Non trouvé' });
        res.json({ message: result.rows[0].bloque ? 'Bloqué' : 'Débloqué', eleve: result.rows[0] });
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
            'Nationalite', 'Classe', 'Statut', 'Qualite', 'LV2', 'Regime',
            'Nom_Pere', 'Prenoms_Pere', 'Contact_Pere', 'Nom_Mere', 'Prenoms_Mere',
            'Contact_Mere', 'Date_Inscription'
        ];
        let csv = headers.join(';') + '\n';

        eleves.forEach(e => {
            const row = [
                e.matricule, e.nom, e.prenoms, e.sexe,
                formatDateCSV(e.date_naissance), e.lieu_naissance, e.nationalite,
                e.classe, e.statut, e.qualite, e.lv2, e.regime,
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

// GET - Classes existantes, triées par ordre pédagogique puis numéro (public,
// utilisé par la page d'inscription pour remplir le menu "Classe").
app.get('/api/classes', async (req, res) => {
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
                lv2: niv.lv2
            };
        }).sort((a, b) => a.ordre - b.ordre || a.numero - b.numero);
        res.json(classes);
    } catch (err) {
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

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.listen(PORT, () => {
    console.log('🚀 Serveur démarré sur le port ' + PORT);
});
