const express = require('express');
const path = require('path');
const app = express();

// Configuración del motor de vistas
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

// Middleware para archivos estáticos (CSS, JS, imágenes)
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Ruta principal (Controlador)
app.get('/', (req, res) => {
    // Aquí en el futuro puedes hacer consultas a tu Modelo (Firebase) 
    // antes de renderizar la vista.
    res.render('index', { 
        titulo: 'Panel de Control - Pilates' 
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor corriendo en http://localhost:${PORT}`);
});