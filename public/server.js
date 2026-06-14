const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Connexion PostgreSQL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Créer la table au démarrage
const initDB = async () => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS inscriptions (
                id SERIAL PRIMARY KEY,
                matricule VARCHAR(20) UNIQUE NOT NULL,
                nom VARCHAR(100) NOT NULL,
                prenoms VARCHAR(200) NOT NULL,
                sexe VARCHAR(1) NOT NULL,
                date_naissance DATE NOT NULL,
                lieu_naissance VARCHAR(100) NOT NULL,
                nationalite VARCHAR(10) NOT NULL,
                classe VARCHAR(20) NOT NULL,
                statut VARCHAR(10) NOT NULL,
                qualite VARCHAR(10) NOT NULL,
                lv2 VARCHAR(20) DEFAULT 'N/A',
                regime VARCHAR(20) NOT NULL,
                nom_pere VARCHAR(100) NOT NULL,
                prenoms_pere VARCHAR(200) NOT NULL,
                contact_pere VARCHAR(20) NOT NULL,
                nom_mere VARCHAR(100) NOT NULL,
                prenoms_mere VARCHAR(200) NOT NULL,
                contact_mere VARCHAR(20) NOT NULL,
                date_inscription DATE DEFAULT CURRENT_DATE
            )
        `);
        console.log('✅ Base de données prête');
    } catch (err) {
        console.error('❌ Erreur DB:', err.message);
    }
};

initDB();

// ===== ROUTES API =====

// Garder le serveur réveillé
app.get('/api/keepalive', (req, res) => {
    res.json({ status: 'alive', time: new Date() });
});

// GET - Tous les élèves
app.get('/api/inscriptions', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM inscriptions ORDER BY date_inscription DESC'
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET - Un élève
app.get('/api/inscriptions/:matricule', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM inscriptions WHERE matricule = $1',
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

// POST - Ajouter
app.post('/api/inscriptions', async (req, res) => {
    const data = req.body;
    try {
        const result = await pool.query(`
            INSERT INTO inscriptions 
            (matricule, nom, prenoms, sexe, date_naissance, lieu_naissance, nationalite, 
             classe, statut, qualite, lv2, regime, 
             nom_pere, prenoms_pere, contact_pere, nom_mere, prenoms_mere, contact_mere)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
            RETURNING *
        `, [
            data.matricule, data.nom, data.prenoms, data.sexe, data.date_naissance,
            data.lieu_naissance, data.nationalite, data.classe, data.statut,
            data.qualite, data.lv2 || 'N/A', data.regime,
            data.nom_pere, data.prenoms_pere, data.contact_pere,
            data.nom_mere, data.prenoms_mere, data.contact_mere
        ]);
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Matricule déjà existant' });
        }
        res.status(500).json({ error: err.message });
    }
});

// PUT - Modifier
app.put('/api/inscriptions/:matricule', async (req, res) => {
    const data = req.body;
    try {
        const result = await pool.query(`
            UPDATE inscriptions SET
                nom=$1, prenoms=$2, sexe=$3, date_naissance=$4, lieu_naissance=$5,
                nationalite=$6, classe=$7, statut=$8, qualite=$9, lv2=$10, regime=$11,
                nom_pere=$12, prenoms_pere=$13, contact_pere=$14,
                nom_mere=$15, prenoms_mere=$16, contact_mere=$17
            WHERE matricule=$18
            RETURNING *
        `, [
            data.nom, data.prenoms, data.sexe, data.date_naissance, data.lieu_naissance,
            data.nationalite, data.classe, data.statut, data.qualite, data.lv2 || 'N/A',
            data.regime, data.nom_pere, data.prenoms_pere, data.contact_pere,
            data.nom_mere, data.prenoms_mere, data.contact_mere,
            req.params.matricule
        ]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Élève non trouvé' });
        }
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE - Un élève
app.delete('/api/inscriptions/:matricule', async (req, res) => {
    try {
        const result = await pool.query(
            'DELETE FROM inscriptions WHERE matricule = $1 RETURNING *',
            [req.params.matricule]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Élève non trouvé' });
        }
        res.json({ message: 'Supprimé' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE - Plusieurs élèves
app.delete('/api/inscriptions', async (req, res) => {
    try {
        await pool.query(
            'DELETE FROM inscriptions WHERE matricule = ANY($1)',
            [req.body.matricules]
        );
        res.json({ message: 'Supprimés' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Page HTML
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log('🚀 Serveur démarré sur le port ' + PORT);
});