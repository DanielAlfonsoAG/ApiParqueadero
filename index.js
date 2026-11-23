require("dotenv").config();

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const { Pool } = require("pg");
const multer = require("multer");
const Tesseract = require("tesseract.js");
const fs = require("fs");
const sharp = require("sharp");
const axios = require("axios");
const FormData = require("form-data");

const app = express();

app.use(cors());
app.use(express.json());

const upload = multer({
  dest: "uploads/"
});

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_NAME,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

// Verificar conexión BD
pool.connect()
  .then(() => console.log("Conectado a PostgreSQL"))
  .catch(err => console.error("Error PostgreSQL:", err));

function validarPlaca(placa) {
  const regex = /^(?=(?:.*[A-Za-z]){3,})(?=(?:.*\d){3,})[A-Za-z0-9]{6}$/;
  return regex.test(placa);
}


// ================= VEHÍCULOS =================

// Obtener vehículos
app.get("/vehiculos", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM vehiculos WHERE estado='dentro'"
    );

    res.json(result.rows);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  }
});


// Registrar ingreso
app.post("/vehiculos", async (req, res) => {
  try {

    const { placa, tipo } = req.body;

    const placaLimpia = placa
      .trim()
      .toUpperCase()
      .replace(/-/g, ""); // QUITA EL GUION

    if (!validarPlaca(placaLimpia)) {
      return res.status(400).json({
        error: "Placa inválida"
      });
    }

    const existe = await pool.query(
      "SELECT * FROM vehiculos WHERE placa=$1 AND estado='dentro'",
      [placaLimpia]
    );

    if (existe.rows.length > 0) {
      return res.status(400).json({
        error: "Vehículo ya está dentro"
      });
    }

    const result = await pool.query(
      "INSERT INTO vehiculos (placa,tipo) VALUES($1,$2) RETURNING *",
      [placaLimpia, tipo]
    );

    res.json(result.rows[0]);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  }
});


// Registrar salida
app.put("/vehiculos/:id", async (req, res) => {

  try {

    const { id } = req.params;

    const vehiculo = await pool.query(
      "SELECT * FROM vehiculos WHERE id=$1",
      [id]
    );

    if (vehiculo.rows.length === 0) {
      return res.status(404).json({
        error: "No encontrado"
      });
    }

    const data = vehiculo.rows[0];

    const horaEntrada = new Date(data.hora_entrada);
    const horaSalida = new Date();

    const diferenciaMs = horaSalida - horaEntrada;
    const minutos = Math.ceil(
      diferenciaMs / (1000 * 60)
    );

    let base = 0;
    let valorMinuto = 0;

    if (data.tipo === "carro") {
      base = 3000;
      valorMinuto = 100;
    }
    else if (data.tipo === "moto") {
      base = 2000;
      valorMinuto = 50;
    }

    const valor = base + (minutos * valorMinuto);

    const result = await pool.query(
      `UPDATE vehiculos
       SET hora_salida=$1,
       estado='fuera',
       valor=$2
       WHERE id=$3
       RETURNING *`,
      [horaSalida, valor, id]
    );

    res.json(result.rows[0]);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: error.message
    });

  }

});


// Historial
app.get("/historial", async (req, res) => {

  try {

    const result = await pool.query(
      "SELECT * FROM vehiculos WHERE estado='fuera' ORDER BY hora_salida DESC"
    );

    res.json(result.rows);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: error.message
    });

  }

});


// ================= USUARIOS =================

// Registro
app.post("/usuarios", async (req, res) => {

  try {

    const { username, password } = req.body;

    const existe = await pool.query(
      "SELECT * FROM usuarios WHERE username=$1",
      [username]
    );

    if (existe.rows.length > 0) {
      return res.status(400).json({
        error: "Usuario ya existe"
      });
    }

    const hashedPassword =
      await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO usuarios
      (username,password,rol)
      VALUES($1,$2,$3)
      RETURNING *`,
      [username, hashedPassword, "ADMIN"]
    );

    res.json(result.rows[0]);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: error.message
    });

  }

});


// Login
app.get("/usuarios", async (req, res) => {

  try {

    const { username, password } = req.query;

    const result = await pool.query(
      "SELECT * FROM usuarios WHERE username=$1",
      [username]
    );

    if (result.rows.length === 0) {
      return res.json([]);
    }

    const user = result.rows[0];

    const validPassword =
      await bcrypt.compare(
        password,
        user.password
      );

    if (!validPassword) {
      return res.json([]);
    }

    res.json([user]);

  } catch (error) {

    console.error(error);

    res.status(500).json({
      error: error.message
    });

  }

});
// ================= DETECCIÓN OCR =================
app.post("/detectar", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image" });
    }

    const form = new FormData();
    form.append("image", fs.createReadStream(req.file.path));

    const URL_FLASK = process.env.URL_FLASK;
    console.log("URL_FLASK =", process.env.URL_FLASK);

    let response;

    try {
      response = await axios.post(
        `${URL_FLASK}/detect`,
        form,
        { headers: form.getHeaders() }
      );

      console.log("FLASK RESPONSE:", response.data);

    } catch (err) {
      console.error("🔥 FLASK ERROR FULL:");
      console.error(err.response?.data || err.message);
      return res.status(500).json({ error: "Error en Flask" });
    }

    if (!response.data.ok) {
      return res.status(400).json({ error: "OCR falló en Flask" });
    }

    // 🔥 TEXTO COMPLETO DEL FLASK
    const textoCompleto = response.data.text;

    console.log("TEXTO FLASK:", textoCompleto);

    // 🔥 BUSCAR PLACA (FORMATO COLOMBIA: AAA-123)
    const match = textoCompleto.match(/[A-Z]{3}-?\d{3}/);

    const placa = match ? match[0].replace("-","") : "No detectada";

    fs.unlinkSync(req.file.path);

    return res.json({ placa });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// Railway
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});
