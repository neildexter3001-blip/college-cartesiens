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
        console.log('✅ Base de données prête');
    } catch (err) {
        console.error('❌ Erreur DB:', err.message);
    }
};

initDB();

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
app.post('/api/eleves/importer', requireAuth, async (req, res) => {
    const eleves = req.body.eleves;
    let importes = 0;
    let existants = 0;
    
    try {
        for (const e of eleves) {
            try {
                await pool.query(`
                    INSERT INTO eleves 
                    (matricule, nom, prenoms, sexe, date_naissance, lieu_naissance, nationalite,
                     classe, statut, qualite, lv2, regime,
                     nom_pere, prenoms_pere, contact_pere, nom_mere, prenoms_mere, contact_mere)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
                    ON CONFLICT (matricule) DO NOTHING
                `, [
                    e.matricule.toUpperCase(), e.nom, e.prenoms, e.sexe, e.date_naissance,
                    e.lieu_naissance, e.nationalite, e.classe, (e.statut || 'NAFF'), e.qualite,
                    e.lv2 || 'N/A', e.regime, e.nom_pere, e.prenoms_pere, e.contact_pere,
                    e.nom_mere, e.prenoms_mere, e.contact_mere
                ]);
                importes++;
            } catch (err) {
                if (err.code === '23505') existants++;
            }
        }
        res.json({ importes, existants, message: importes + ' élève(s) importé(s)' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
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

// DELETE - Supprimer (admin)
app.delete('/api/eleves/:matricule', requireAuth, async (req, res) => {
    try {
        await pool.query('DELETE FROM eleves WHERE matricule = $1', [req.params.matricule]);
        res.json({ message: 'Supprimé' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET - Exporter CSV (admin)
app.get('/api/eleves/export/csv', requireAuth, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM eleves ORDER BY date_creation DESC');
        const eleves = result.rows;
        
        let csv = 'Matricule;Nom;Prenoms;Sexe;Date_Naissance;Lieu_Naissance;Nationalite;Classe;Statut;Qualite;LV2;Regime;Nom_Pere;Prenoms_Pere;Contact_Pere;Nom_Mere;Prenoms_Mere;Contact_Mere;Date_Inscription\n';
        
        eleves.forEach(e => {
            csv += `${e.matricule};${e.nom};${e.prenoms};${e.sexe};${e.date_naissance || ''};${e.lieu_naissance || ''};${e.nationalite || ''};${e.classe || ''};${e.statut};${e.qualite || ''};${e.lv2};${e.regime || ''};${e.nom_pere || ''};${e.prenoms_pere || ''};${e.contact_pere || ''};${e.nom_mere || ''};${e.prenoms_mere || ''};${e.contact_mere || ''};${e.date_inscription || ''}\n`;
        });
        
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename=eleves_cartesiens_' + new Date().toISOString().split('T')[0] + '.csv');
        res.send(csv);
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