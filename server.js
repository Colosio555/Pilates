const express = require('express');
const path = require('path');
const app = express();

// Configuración del motor de vistas
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

// Middleware para archivos estáticos (CSS, JS, imágenes)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(path.join(__dirname, 'media')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://thwbvssolchywdwpndsc.supabase.co';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;

async function supabaseAdmin(pathname, options = {}) {
    if (!SUPABASE_SECRET_KEY) throw new Error('Falta configurar SUPABASE_SECRET_KEY en Vercel.');
    const response = await fetch(`${SUPABASE_URL}${pathname}`, {
        ...options,
        headers: {
            apikey: SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : null;
    if (!response.ok) throw new Error(data?.message || data?.msg || 'Error de Supabase.');
    return data;
}

async function authenticatedUser(req) {
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '');
    if (!token) throw new Error('Sesión requerida.');
    const response = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
        headers: { apikey: SUPABASE_SECRET_KEY, Authorization: `Bearer ${token}` }
    });
    if (!response.ok) throw new Error('Sesión no válida.');
    const user = await response.json();
    const profiles = await supabaseAdmin(`/rest/v1/profiles?select=role&id=eq.${user.id}`);
    return { user, role: profiles[0]?.role };
}

async function collection(key) {
    const rows = await supabaseAdmin(`/rest/v1/app_collections?select=payload&key=eq.${key}`);
    return rows[0]?.payload || [];
}

async function saveCollection(key, payload) {
    await supabaseAdmin(`/rest/v1/app_collections?key=eq.${key}`, {
        method: 'PATCH',
        headers: { Prefer: 'return=minimal' },
        body: JSON.stringify({ payload, updated_at: new Date().toISOString() })
    });
}

async function notifyClassChange(clientAuthIds, session) {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.EMAIL_FROM;
    if (!apiKey || !from) return { sent: 0, warning: 'No se enviaron correos: falta configurar RESEND_API_KEY y EMAIL_FROM en Vercel.' };
    const recipients = [...new Set(clientAuthIds)];
    const time = new Intl.DateTimeFormat('es-MX', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Mexico_City' }).format(new Date(session.starts_at));
    const title = String(session.title).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    let sent = 0;
    for (const userId of recipients) {
        try {
            const user = await supabaseAdmin(`/auth/v1/admin/users/${encodeURIComponent(userId)}`);
            const email = user?.email || user?.user?.email;
            if (!email) continue;
            const response = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    from,
                    to: [email],
                    subject: `Cambio en tu clase: ${session.title}`,
                    html: `<p>Tu clase <strong>${title}</strong> fue modificada.</p><p>Nuevo horario: <strong>${time}</strong>.</p><p>Te esperamos en el estudio.</p>`
                })
            });
            if (response.ok) sent++;
        } catch (error) { console.error('No se pudo avisar de la modificación de clase:', error.message); }
    }
    return { sent, warning: sent < recipients.length ? 'Algunos correos no pudieron enviarse; revisa la configuración de correo en Vercel.' : '' };
}

function clientPortalRecord(client, payments) {
    return {
        id: client.id, codigoUsuario: client.codigoUsuario, nombre: client.nombre,
        apellidoPaterno: client.apellidoPaterno, apellidoMaterno: client.apellidoMaterno,
        contacto: client.contacto, cumpleanos: client.cumpleanos, paquete: client.paquete,
        clasesContratadas: client.clasesContratadas, clasesRestantes: client.clasesRestantes,
        fechaVencimiento: client.fechaVencimiento, notas: client.notas,
        citas: client.citas || [],
        pagos: payments.filter(payment => payment.clienteId === client.id)
    };
}

app.post('/api/client-accounts', async (req, res) => {
    try {
        const { user, role } = await authenticatedUser(req);
        if (!['admin', 'trabajador'].includes(role)) throw new Error('Sin permisos para crear cuentas de cliente.');
        const { email, password } = req.body;
        if (!email || !password || password.length < 8) throw new Error('El correo y una contraseña temporal de al menos 8 caracteres son obligatorios.');
        const data = await supabaseAdmin('/auth/v1/admin/users', {
            method: 'POST',
            body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { role: 'cliente', created_by: user.id } })
        });
        res.status(201).json({ id: data.id, email: data.email });
    } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/portal', async (req, res) => {
    try {
        const { user, role } = await authenticatedUser(req);
        if (role !== 'cliente') throw new Error('Esta cuenta no corresponde a un cliente.');
        const [clients, payments] = await Promise.all([collection('clients'), collection('payments')]);
        const client = clients.find(item => item.authUserId === user.id);
        if (!client) throw new Error('Tu cuenta aún no está vinculada a un expediente.');
        res.json({ email: user.email, client: clientPortalRecord(client, payments) });
    } catch (error) { res.status(403).json({ error: error.message }); }
});

app.patch('/api/portal/profile', async (req, res) => {
    try {
        const { user, role } = await authenticatedUser(req);
        if (role !== 'cliente') throw new Error('Sin permisos.');
        const clients = await collection('clients');
        const client = clients.find(item => item.authUserId === user.id);
        if (!client) throw new Error('Expediente no encontrado.');
        if (typeof req.body.contacto === 'string') client.contacto = req.body.contacto.trim();
        await saveCollection('clients', clients);
        res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
});

app.post('/api/portal/appointments', async (req, res) => {
    try {
        const { user, role } = await authenticatedUser(req);
        if (role !== 'cliente') throw new Error('Sin permisos.');
        const { fecha, hora } = req.body;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha || '') || !/^\d{2}:\d{2}$/.test(hora || '')) throw new Error('Selecciona una fecha y un horario válidos.');
        const clients = await collection('clients');
        const client = clients.find(item => item.authUserId === user.id);
        if (!client || !client.planId || client.fechaVencimiento < fecha) throw new Error('No tienes un plan vigente para esa fecha.');
        const future = (client.citas || []).filter(item => item.fecha >= new Date().toISOString().slice(0, 10));
        if ((client.clasesRestantes || 0) - future.length <= 0) throw new Error('Ya no tienes citas disponibles para agendar.');
        if (clients.some(item => (item.citas || []).some(appointment => appointment.fecha === fecha && appointment.hora === hora))) throw new Error('Ese horario ya está ocupado.');
        client.citas = client.citas || [];
        client.citas.push({ id: crypto.randomUUID(), fecha, hora });
        await saveCollection('clients', clients);
        res.status(201).json({ ok: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/sessions', async (req, res) => {
    try {
        const { role } = await authenticatedUser(req);
        if (!['admin', 'trabajador'].includes(role)) throw new Error('Sin permisos.');
        const [sessions, bookings, clients] = await Promise.all([
            supabaseAdmin('/rest/v1/class_sessions?select=*&order=starts_at.asc'),
            supabaseAdmin('/rest/v1/class_bookings?select=session_id,client_auth_id'),
            collection('clients')
        ]);
        res.json(sessions.map(session => {
            const enrolled = bookings.filter(item => item.session_id === session.id).map(item => {
                const client = clients.find(record => record.authUserId === item.client_auth_id);
                return { id: item.client_auth_id, name: client ? `${client.nombre} ${client.apellidoPaterno}` : 'Cliente', code: client?.codigoUsuario || '' };
            });
            return { ...session, reserved: enrolled.length, enrolled };
        }));
    } catch (error) { res.status(403).json({ error: error.message }); }
});

app.post('/api/sessions', async (req, res) => {
    try {
        const { user, role } = await authenticatedUser(req);
        if (!['admin', 'trabajador'].includes(role)) throw new Error('Sin permisos.');
        const { title, color, startsAt, endsAt, capacity } = req.body;
        const allowedColors = new Set(['azul', 'rojo', 'verde', 'amarillo', 'naranja', 'morado', 'rosa', 'cafe', 'gris']);
        const cleanTitle = typeof title === 'string' ? title.trim() : '';
        if (!cleanTitle || !startsAt || !endsAt || !Number.isInteger(+capacity) || +capacity < 1 || !allowedColors.has(color)) throw new Error('Completa el nombre, color, horario válido y cupo de la clase.');
        if (new Date(endsAt) <= new Date(startsAt)) throw new Error('La hora de fin debe ser posterior a la hora de inicio.');
        const rows = await supabaseAdmin('/rest/v1/class_sessions', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ title: cleanTitle, color, starts_at: startsAt, ends_at: endsAt, capacity: +capacity, created_by: user.id }) });
        res.status(201).json(rows[0]);
    } catch (error) {
        const message = error.message?.includes("Could not find the 'color' column")
            ? 'La agenda necesita actualizar la base de datos antes de guardar colores. Ejecuta la migración weekly-agenda-color-migration.sql en Supabase SQL Editor.'
            : error.message;
        res.status(400).json({ error: message });
    }
});

app.patch('/api/sessions/:id', async (req, res) => {
    try {
        const { role } = await authenticatedUser(req);
        if (role !== 'admin') throw new Error('Solo el administrador puede modificar clases.');
        const sessionId = encodeURIComponent(req.params.id);
        const current = await supabaseAdmin(`/rest/v1/class_sessions?select=*&id=eq.${sessionId}`);
        if (!current[0]) throw new Error('La clase no existe.');
        if (new Date(current[0].starts_at) <= new Date()) throw new Error('Solo se pueden modificar clases futuras.');
        const { title, color, startsAt, endsAt, capacity } = req.body;
        const allowedColors = new Set(['azul', 'rojo', 'verde', 'amarillo', 'naranja', 'morado', 'rosa', 'cafe', 'gris']);
        const cleanTitle = typeof title === 'string' ? title.trim() : '';
        const starts = new Date(startsAt), ends = new Date(endsAt);
        if (!cleanTitle || !allowedColors.has(color) || !Number.isInteger(+capacity) || +capacity < 1 || Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || ends <= starts) throw new Error('Completa nombre, color, fecha, horario y cupo válidos.');
        if (starts <= new Date()) throw new Error('La nueva fecha y hora deben ser futuras.');
        const bookings = await supabaseAdmin(`/rest/v1/class_bookings?select=client_auth_id&session_id=eq.${sessionId}`);
        if (+capacity < bookings.length) throw new Error(`El cupo no puede ser menor que los ${bookings.length} clientes ya inscritos.`);
        const rows = await supabaseAdmin(`/rest/v1/class_sessions?id=eq.${sessionId}`, {
            method: 'PATCH', headers: { Prefer: 'return=representation' },
            body: JSON.stringify({ title: cleanTitle, color, starts_at: startsAt, ends_at: endsAt, capacity: +capacity })
        });
        const notification = await notifyClassChange(bookings.map(item => item.client_auth_id), rows[0]);
        res.json({ session: rows[0], emailsSent: notification.sent, emailWarning: notification.warning });
    } catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/portal/sessions', async (req, res) => {
    try {
        const { user, role } = await authenticatedUser(req);
        if (role !== 'cliente') throw new Error('Sin permisos.');
        const sessions = await supabaseAdmin(`/rest/v1/class_sessions?select=*&starts_at=gte.${encodeURIComponent(new Date().toISOString())}&order=starts_at.asc`);
        const bookings = await supabaseAdmin('/rest/v1/class_bookings?select=session_id,client_auth_id');
        res.json(sessions.map(session => ({ ...session, reserved: bookings.filter(item => item.session_id === session.id).length, joined: bookings.some(item => item.session_id === session.id && item.client_auth_id === user.id) })));
    } catch (error) { res.status(403).json({ error: error.message }); }
});

app.post('/api/portal/sessions/:id/book', async (req, res) => {
    try {
        const { user, role } = await authenticatedUser(req);
        if (role !== 'cliente') throw new Error('Sin permisos.');
        const clients = await collection('clients'), client = clients.find(item => item.authUserId === user.id);
        if (!client || !client.planId || client.fechaVencimiento < new Date().toISOString().slice(0, 10)) throw new Error('No tienes un plan vigente.');
        const future = (client.citas || []).filter(item => item.fecha >= new Date().toISOString().slice(0, 10));
        const booked = await supabaseAdmin(`/rest/v1/class_bookings?select=session_id&client_auth_id=eq.${user.id}`);
        if ((client.clasesRestantes || 0) - future.length - booked.length <= 0) throw new Error('Ya no tienes clases disponibles para reservar.');
        const rows = await supabaseAdmin('/rest/v1/class_sessions?select=starts_at&id=eq.' + req.params.id);
        if (!rows[0]) throw new Error('El horario ya no existe.');
        const sessionDate = rows[0].starts_at.slice(0, 10);
        if (client.fechaVencimiento < sessionDate) throw new Error('Tu plan no cubre la fecha de este horario.');
        await supabaseAdmin('/rest/v1/class_bookings', { method: 'POST', body: JSON.stringify({ session_id: req.params.id, client_auth_id: user.id }) });
        res.status(201).json({ ok: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
});

// Ruta principal (Controlador)
app.get('/', (req, res) => {
    // Aquí en el futuro puedes hacer consultas a tu Modelo (Firebase) 
    // antes de renderizar la vista.
    res.render('index', { 
        titulo: 'Panel de Control - Pilates' 
    });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });
}

module.exports = app;
