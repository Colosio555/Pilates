const express = require('express');
const path = require('path');
const crypto = require('crypto');
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Configuración del motor de vistas
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'pug');

// Middleware para archivos estáticos (CSS, JS, imágenes)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(path.join(__dirname, 'media')));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb', parameterLimit: 100 }));
app.use('/api', (_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
});

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://thwbvssolchywdwpndsc.supabase.co';
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const MP_API_URL = 'https://api.mercadopago.com';
const PRIVACY_TERMS_VERSION = '2026-10-25-v1';

function mercadoPagoConfig() {
    const accessToken = process.env.MP_ACCESS_TOKEN;
    const environment = process.env.MP_ENVIRONMENT || 'test';
    if (!accessToken) throw new Error('Falta configurar MP_ACCESS_TOKEN como variable privada del servidor.');
    if (!['test', 'production'].includes(environment)) throw new Error('MP_ENVIRONMENT debe ser test o production.');
    return { accessToken, environment };
}

function publicAppUrl(req) {
    const configured = process.env.APP_BASE_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '');
    const base = configured || `${req.protocol}://${req.get('host')}`;
    const parsed = new URL(base);
    if (parsed.protocol !== 'https:') throw new Error('APP_BASE_URL debe ser la dirección HTTPS pública del sitio.');
    return parsed.origin;
}

async function mercadoPagoRequest(pathname, options = {}) {
    const { accessToken } = mercadoPagoConfig();
    const response = await fetch(`${MP_API_URL}${pathname}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!response.ok) {
        const error = new Error(data?.message || data?.error || 'Mercado Pago no pudo procesar la solicitud.');
        error.status = response.status;
        throw error;
    }
    return data;
}

function verifyMercadoPagoSignature(req, secret) {
    const signatureHeader = req.get('x-signature') || '';
    const requestId = req.get('x-request-id') || '';
    const dataId = String(req.query['data.id'] || req.body?.data?.id || '');
    const parts = Object.fromEntries(signatureHeader.split(',').map(part => part.trim().split('=', 2)).filter(part => part.length === 2));
    const timestamp = parts.ts;
    const suppliedHash = parts.v1;
    if (!dataId || !requestId || !timestamp || !/^[a-f0-9]{64}$/i.test(suppliedHash || '')) return false;
    const manifest = `id:${dataId};request-id:${requestId};ts:${timestamp};`;
    const expectedHash = crypto.createHmac('sha256', secret).update(manifest).digest();
    const actualHash = Buffer.from(suppliedHash, 'hex');
    return actualHash.length === expectedHash.length && crypto.timingSafeEqual(actualHash, expectedHash);
}

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

async function cleanupExpiredSessions() {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const deleted = await supabaseAdmin(`/rest/v1/class_sessions?ends_at=lt.${encodeURIComponent(cutoff)}`, {
        method: 'DELETE', headers: { Prefer: 'return=representation' }
    });
    return deleted?.length || 0;
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
        contacto: client.contacto, cumpleanos: client.cumpleanos, planId: client.planId, paquete: client.paquete,
        clasesContratadas: client.clasesContratadas, clasesRestantes: client.clasesRestantes,
        fechaVencimiento: client.fechaVencimiento,
        citas: client.citas || [],
        pagos: payments.filter(payment => payment.clienteId === client.id)
    };
}

app.get('/api/portal', async (req, res) => {
    try {
        const { user, role } = await authenticatedUser(req);
        if (role !== 'cliente') throw new Error('Esta cuenta no corresponde a un cliente.');
        const [clients, payments, plans, onlinePayments] = await Promise.all([
            collection('clients'), collection('payments'), collection('plans'),
            supabaseAdmin(`/rest/v1/online_payments?select=id,plan_name,amount,status,checkout_url,created_at,paid_at&client_auth_id=eq.${encodeURIComponent(user.id)}&order=created_at.desc&limit=20`)
        ]);
        const client = clients.find(item => item.authUserId === user.id);
        if (!client) throw new Error('Tu cuenta aún no está vinculada a un expediente.');
        const safePlans = plans.filter(plan => typeof plan.nombre === 'string' && Number.isFinite(+plan.costo))
            .map(plan => ({ id: String(plan.id), nombre: plan.nombre, costo: +plan.costo, clases: +plan.clases || 0, vigencia: +plan.vigencia || 0 }));
        res.json({ email: user.email, client: clientPortalRecord(client, payments), plans: safePlans, onlinePayments, checkoutEnabled: Boolean(process.env.MP_ACCESS_TOKEN && process.env.MP_WEBHOOK_SECRET && (process.env.APP_BASE_URL || process.env.VERCEL_URL)) });
    } catch (error) { res.status(403).json({ error: error.message }); }
});

app.post('/api/portal/checkout', async (req, res) => {
    let paymentId = null;
    try {
        const { user, role } = await authenticatedUser(req);
        if (role !== 'cliente') throw new Error('Solo los clientes pueden iniciar un pago.');
        const planId = typeof req.body.planId === 'string' ? req.body.planId : '';
        if (!planId || planId.length > 100) throw new Error('Selecciona un plan válido.');
        const plans = await collection('plans');
        const plan = plans.find(item => String(item.id) === planId);
        const amount = Number(plan?.costo), classes = Number(plan?.clases), validity = Number(plan?.vigencia);
        if (!plan || !Number.isFinite(amount) || amount <= 0 || amount > 100000 || !Number.isInteger(classes) || classes < 1 || classes > 1000 || !Number.isInteger(validity) || validity < 1 || validity > 3650) {
            throw new Error('El plan seleccionado no tiene un precio o vigencia válidos. Contacta al estudio.');
        }
        if (!process.env.MP_WEBHOOK_SECRET) throw new Error('El estudio aún está configurando la confirmación segura de pagos.');
        const baseUrl = publicAppUrl(req);
        const clients = await collection('clients');
        const client = clients.find(item => item.authUserId === user.id);
        if (!client) throw new Error('Tu cuenta aún no está vinculada a un expediente.');
        const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
        if (client.planId && client.fechaVencimiento >= today && (+client.clasesRestantes || 0) > 0) {
            throw new Error('Aún tienes un plan vigente con clases disponibles. Para evitar perderlas, podrás comprar otro cuando venza o agotes tus clases.');
        }
        const { environment } = mercadoPagoConfig();
        const activeRows = await supabaseAdmin(`/rest/v1/online_payments?select=id,status,checkout_url,created_at&client_auth_id=eq.${encodeURIComponent(user.id)}&status=in.%28pending%2Cin_process%29&order=created_at.desc&limit=1`);
        const activePayment = activeRows[0];
        if (activePayment?.status === 'in_process') throw new Error('Ya tienes un pago en proceso. Actualiza tu historial en un momento antes de iniciar otro.');
        if (activePayment?.status === 'pending') {
            const isStale = Date.now() - new Date(activePayment.created_at).getTime() > 24 * 60 * 60 * 1000;
            if (isStale) {
                await supabaseAdmin(`/rest/v1/online_payments?id=eq.${encodeURIComponent(activePayment.id)}`, {
                    method: 'PATCH', headers: { Prefer: 'return=minimal' },
                    body: JSON.stringify({ status: 'cancelled', updated_at: new Date().toISOString() })
                });
            } else if (activePayment.checkout_url) {
                return res.json({ checkoutUrl: activePayment.checkout_url, paymentId: activePayment.id });
            } else {
                throw new Error('Estamos preparando tu pago. Espera un momento y vuelve a intentar.');
            }
        }
        const externalReference = crypto.randomUUID();
        const fullName = `${client.nombre || ''} ${client.apellidoPaterno || ''} ${client.apellidoMaterno || ''}`.trim().slice(0, 200);
        const createdRows = await supabaseAdmin('/rest/v1/online_payments', {
            method: 'POST', headers: { Prefer: 'return=representation' },
            body: JSON.stringify({
                client_id: String(client.id), client_auth_id: user.id, client_name: fullName,
                plan_id: planId, plan_name: String(plan.nombre).slice(0, 120), plan_classes: classes,
                plan_validity_days: validity, amount: amount.toFixed(2), currency: 'MXN',
                status: 'pending', provider: 'mercadopago', external_reference: externalReference,
                created_by: user.id
            })
        });
        const payment = createdRows[0];
        if (!payment) throw new Error('No se pudo preparar el registro del pago.');
        paymentId = payment.id;
        const returnUrl = `${baseUrl}/?pago=resultado#clientePagos`;
        const order = await mercadoPagoRequest('/v1/orders', {
            method: 'POST',
            headers: { 'X-Idempotency-Key': externalReference },
            body: JSON.stringify({
                type: 'online', processing_mode: 'manual', capture_mode: 'automatic_async',
                expiration_time: 'P1D',
                total_amount: amount.toFixed(2), external_reference: externalReference,
                description: `Plan de Pilates: ${String(plan.nombre).slice(0, 100)}`,
                payer: { email: user.email },
                items: [{ title: `Plan de Pilates: ${String(plan.nombre).slice(0, 100)}`, unit_price: amount.toFixed(2), quantity: 1 }],
                config: { online: { success_url: returnUrl, failure_url: returnUrl, pending_url: returnUrl, auto_return: 'approved' } }
            })
        });
        if (!order?.id || !order.checkout_url || new URL(order.checkout_url).hostname !== 'www.mercadopago.com.mx') {
            throw new Error('Mercado Pago devolvió una respuesta de checkout no válida.');
        }
        await supabaseAdmin(`/rest/v1/online_payments?id=eq.${encodeURIComponent(payment.id)}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ provider_order_id: order.id, checkout_url: order.checkout_url, updated_at: new Date().toISOString() })
        });
        res.status(201).json({ checkoutUrl: order.checkout_url, environment, paymentId: payment.id });
    } catch (error) {
        if (paymentId) {
            try {
                await supabaseAdmin(`/rest/v1/online_payments?id=eq.${encodeURIComponent(paymentId)}`, {
                    method: 'PATCH', headers: { Prefer: 'return=minimal' },
                    body: JSON.stringify({ status: 'rejected', updated_at: new Date().toISOString() })
                });
            } catch (saveError) { console.error('No se pudo cerrar una orden de pago incompleta:', saveError.message); }
        }
        const status = error.status === 401 || error.status === 403 ? 503 : 400;
        if (status === 503) console.error('Error de configuración de Mercado Pago:', error.message);
        res.status(status).json({ error: status === 503 ? 'El pago en línea no está configurado todavía. Inténtalo más tarde.' : error.message });
    }
});

app.post('/api/mercadopago/webhook', async (req, res) => {
    const secret = process.env.MP_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: 'Webhook sin configurar.' });
    if (!verifyMercadoPagoSignature(req, secret)) return res.sendStatus(401);
    const orderId = String(req.query['data.id'] || req.body?.data?.id || '');
    if ((req.body?.type || req.query.type) !== 'order' || !orderId || orderId.length > 100) return res.sendStatus(200);
    try {
        const { environment } = mercadoPagoConfig();
        const order = await mercadoPagoRequest(`/v1/orders/${encodeURIComponent(orderId)}`);
        const expectedLiveMode = environment === 'production';
        if (order?.live_mode !== expectedLiveMode) return res.status(200).json({ ok: true });
        const externalReference = String(order.external_reference || '');
        if (!externalReference || externalReference.length > 100) return res.sendStatus(200);
        const rows = await supabaseAdmin(`/rest/v1/online_payments?select=id,amount,status,provider_order_id&external_reference=eq.${encodeURIComponent(externalReference)}&provider=eq.mercadopago&limit=1`);
        const payment = rows[0];
        if (!payment) return res.sendStatus(200);
        const orderAmount = Number(order.total_amount), expectedAmount = Number(payment.amount);
        if (order.id !== orderId || order.type !== 'online' || order.currency !== 'MXN' || !Number.isFinite(orderAmount) || Math.round(orderAmount * 100) !== Math.round(expectedAmount * 100)) {
            console.error('La orden de Mercado Pago no coincide con el pago interno:', orderId);
            return res.sendStatus(200);
        }
        if (payment.provider_order_id && payment.provider_order_id !== orderId) return res.sendStatus(200);
        const accredited = order.status === 'processed' && order.status_detail === 'accredited'
            && Number(order.total_paid_amount) >= expectedAmount;
        if (accredited) {
            const result = await supabaseAdmin('/rest/v1/rpc/apply_mercadopago_order', {
                method: 'POST',
                body: JSON.stringify({ target_external_reference: externalReference, target_provider_order_id: orderId, target_paid_at: new Date().toISOString() })
            });
            const paymentId = (order.transactions?.payments || []).find(item => item.status === 'processed' && item.status_detail === 'accredited')?.id;
            if (paymentId) {
                await supabaseAdmin(`/rest/v1/online_payments?external_reference=eq.${encodeURIComponent(externalReference)}`, {
                    method: 'PATCH', headers: { Prefer: 'return=minimal' },
                    body: JSON.stringify({ provider_payment_id: String(paymentId), updated_at: new Date().toISOString() })
                });
            }
            return res.status(200).json({ ok: true, applied: result === true });
        }
        const status = order.status === 'cancelled' || order.status === 'expired' ? 'cancelled'
            : order.status === 'refunded' ? 'refunded'
                : order.status === 'processed' ? 'rejected' : 'in_process';
        await supabaseAdmin(`/rest/v1/online_payments?external_reference=eq.${encodeURIComponent(externalReference)}`, {
            method: 'PATCH', headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ provider_order_id: orderId, status, updated_at: new Date().toISOString() })
        });
        res.sendStatus(200);
    } catch (error) {
        console.error('No se pudo procesar el webhook de Mercado Pago:', error.message);
        res.status(500).json({ error: 'No se pudo procesar la notificación.' });
    }
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
        try { await cleanupExpiredSessions(); } catch (error) { console.error('No se pudieron limpiar clases antiguas:', error.message); }
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

app.get('/api/cron/cleanup-sessions', async (req, res) => {
    const cronSecret = process.env.CRON_SECRET;
    if (!cronSecret || req.headers.authorization !== `Bearer ${cronSecret}`) return res.status(401).json({ error: 'No autorizado.' });
    try {
        const deleted = await cleanupExpiredSessions();
        res.json({ ok: true, deleted });
    } catch (error) {
        console.error('No se pudieron eliminar clases antiguas:', error.message);
        res.status(500).json({ error: 'No se pudieron eliminar las clases antiguas.' });
    }
});

app.post('/api/sessions', async (req, res) => {
    try {
        const { user, role } = await authenticatedUser(req);
        if (!['admin', 'trabajador'].includes(role)) throw new Error('Sin permisos.');
        const { title, color, startsAt, endsAt, capacity } = req.body;
        const allowedColors = new Set(['azul', 'rojo', 'verde', 'amarillo', 'naranja', 'morado', 'rosa', 'cafe', 'gris']);
        const cleanTitle = typeof title === 'string' ? title.trim() : '';
        const starts = new Date(startsAt), ends = new Date(endsAt);
        if (!cleanTitle || cleanTitle.length > 100 || Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || !Number.isInteger(+capacity) || +capacity < 1 || +capacity > 100 || !allowedColors.has(color)) throw new Error('Completa el nombre (máximo 100 caracteres), color, horario válido y cupo entre 1 y 100.');
        if (ends <= starts) throw new Error('La hora de fin debe ser posterior a la hora de inicio.');
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
        if (!cleanTitle || cleanTitle.length > 100 || !allowedColors.has(color) || !Number.isInteger(+capacity) || +capacity < 1 || +capacity > 100 || Number.isNaN(starts.getTime()) || Number.isNaN(ends.getTime()) || ends <= starts) throw new Error('Completa nombre, color, fecha, horario y cupo entre 1 y 100 válidos.');
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
        const now = new Date(), today = now.toISOString().slice(0, 10);
        if (!client || !client.planId || client.fechaVencimiento < today) throw new Error('No tienes un plan vigente.');
        const rows = await supabaseAdmin('/rest/v1/class_sessions?select=id,starts_at,capacity&id=eq.' + encodeURIComponent(req.params.id));
        const session = rows[0];
        if (!session) throw new Error('El horario ya no existe.');
        if (new Date(session.starts_at) <= now) throw new Error('Este horario ya comenzó o ya pasó.');
        const sessionDate = session.starts_at.slice(0, 10);
        if (client.fechaVencimiento < sessionDate) throw new Error('Tu plan no cubre la fecha de este horario.');
        const futureAppointments = (client.citas || []).filter(item => item.fecha >= today);
        const maxFutureBookings = Math.max(0, (+client.clasesRestantes || 0) - futureAppointments.length);
        if (!maxFutureBookings) throw new Error('Ya no tienes clases disponibles para reservar.');
        await supabaseAdmin('/rest/v1/rpc/book_class_session', {
            method: 'POST',
            body: JSON.stringify({ target_session: session.id, target_client_auth_id: user.id, max_future_bookings: maxFutureBookings })
        });
        res.status(201).json({ ok: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
});

// Ruta principal (Controlador)
app.get('/', (req, res) => {
    res.render('index', {
        titulo: 'Panel de Control - Pilates',
        termsVersion: PRIVACY_TERMS_VERSION,
        responsablePrivacidad: process.env.PRIVACY_CONTROLLER_NAME || 'Estudio Pilates (falta confirmar el nombre legal del responsable)',
        domicilioPrivacidad: process.env.PRIVACY_CONTROLLER_ADDRESS || 'Pendiente de configurar el domicilio físico del responsable.',
        contactoPrivacidad: process.env.PRIVACY_CONTACT_EMAIL || 'Pendiente de configurar un correo de contacto para privacidad y derechos ARCO.'
    });
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Servidor corriendo en http://localhost:${PORT}`);
    });
}

module.exports = app;
