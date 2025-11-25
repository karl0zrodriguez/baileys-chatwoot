// ==================== BAILEYS + CHATWOOT CUSTOM ====================
// Implementación completa con soporte de multimedia

const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

// ==================== CONFIGURACIÓN ====================
const CONFIG = {
  port: 3000,
  
  // Chatwoot
  chatwoot: {
    url: 'https://n8n-chatwoot.oyhnue.easypanel.host',
    accountId: '1',
    token: '59QACHXK18xfQMettvg5ZhSH',
    inboxId: '9'
  },
  
  // Almacenamiento
  mediaFolder: './media',
  authFolder: './auth_info',
  
  // URL pública donde se expondrán los archivos multimedia
  publicUrl: 'http://localhost:3000' // Cambiar por tu dominio público
};

// Crear carpetas si no existen
if (!fs.existsSync(CONFIG.mediaFolder)) fs.mkdirSync(CONFIG.mediaFolder, { recursive: true });
if (!fs.existsSync(CONFIG.authFolder)) fs.mkdirSync(CONFIG.authFolder, { recursive: true });

// ==================== VARIABLES GLOBALES ====================
let sock = null;
let qrCode = null;
let connectionStatus = 'disconnected';
const conversationCache = new Map(); // Cache de conversaciones

// ==================== EXPRESS SERVER ====================
const app = express();
app.use(express.json());
app.use('/media', express.static(CONFIG.mediaFolder)); // Servir archivos multimedia

// Endpoint: Estado
app.get('/status', (req, res) => {
  res.json({
    status: connectionStatus,
    qrCode: qrCode,
    hasConnection: sock !== null
  });
});

// Endpoint: QR Code
app.get('/qr', async (req, res) => {
  if (qrCode) {
    try {
      const qrImage = await QRCode.toDataURL(qrCode);
      res.send(`<img src="${qrImage}" alt="QR Code" />`);
    } catch (error) {
      res.status(500).json({ error: 'Error generating QR' });
    }
  } else {
    res.json({ message: 'No QR code available. Check /status' });
  }
});

// Endpoint: Enviar mensaje
app.post('/send', async (req, res) => {
  const { phone, message } = req.body;
  
  if (!sock) {
    return res.status(400).json({ error: 'WhatsApp not connected' });
  }
  
  try {
    const jid = `${phone}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true, message: 'Message sent' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==================== FUNCIONES CHATWOOT ====================

async function getOrCreateContact(phone, name) {
  try {
    // Buscar contacto
    const search = await axios.get(
      `${CONFIG.chatwoot.url}/api/v1/accounts/${CONFIG.chatwoot.accountId}/contacts/search`,
      {
        params: { q: phone },
        headers: { 'api_access_token': CONFIG.chatwoot.token }
      }
    );
    
    if (search.data.payload.length > 0) {
      return search.data.payload[0].id;
    }
    
    // Crear contacto
    const create = await axios.post(
      `${CONFIG.chatwoot.url}/api/v1/accounts/${CONFIG.chatwoot.accountId}/contacts`,
      {
        inbox_id: CONFIG.chatwoot.inboxId,
        name: name || phone,
        phone_number: `+${phone}`,
        identifier: `${phone}@s.whatsapp.net`
      },
      {
        headers: { 
          'api_access_token': CONFIG.chatwoot.token,
          'Content-Type': 'application/json'
        }
      }
    );
    
    return create.data.payload.contact.id;
  } catch (error) {
    console.error('Error creating contact:', error.message);
    return null;
  }
}

async function getOrCreateConversation(contactId, sourceId) {
  // Verificar cache
  if (conversationCache.has(sourceId)) {
    return conversationCache.get(sourceId);
  }
  
  try {
    // Buscar conversación existente
    const search = await axios.get(
      `${CONFIG.chatwoot.url}/api/v1/accounts/${CONFIG.chatwoot.accountId}/conversations`,
      {
        params: { inbox_id: CONFIG.chatwoot.inboxId },
        headers: { 'api_access_token': CONFIG.chatwoot.token }
      }
    );
    
    const existing = search.data.data.payload.find(
      conv => conv.meta?.sender?.id === contactId
    );
    
    if (existing) {
      conversationCache.set(sourceId, existing.id);
      return existing.id;
    }
    
    // Crear conversación
    const create = await axios.post(
      `${CONFIG.chatwoot.url}/api/v1/accounts/${CONFIG.chatwoot.accountId}/conversations`,
      {
        inbox_id: CONFIG.chatwoot.inboxId,
        contact_id: contactId,
        source_id: sourceId
      },
      {
        headers: { 
          'api_access_token': CONFIG.chatwoot.token,
          'Content-Type': 'application/json'
        }
      }
    );
    
    conversationCache.set(sourceId, create.data.id);
    return create.data.id;
  } catch (error) {
    console.error('Error creating conversation:', error.message);
    return null;
  }
}

async function sendMessageToChatwoot(conversationId, content, attachments = [], isFromMe = false) {
  try {
    await axios.post(
      `${CONFIG.chatwoot.url}/api/v1/accounts/${CONFIG.chatwoot.accountId}/conversations/${conversationId}/messages`,
      {
        content: content,
        message_type: isFromMe ? 'outgoing' : 'incoming',
        private: false,
        attachments: attachments
      },
      {
        headers: { 
          'api_access_token': CONFIG.chatwoot.token,
          'Content-Type': 'application/json'
        }
      }
    );
    
    return true;
  } catch (error) {
    console.error('Error sending to Chatwoot:', error.response?.data || error.message);
    return false;
  }
}

// ==================== DESCARGA Y ALMACENAMIENTO DE MULTIMEDIA ====================

async function downloadAndSaveMedia(message) {
  try {
    const buffer = await downloadMediaMessage(
      message,
      'buffer',
      {},
      { logger: pino({ level: 'silent' }) }
    );
    
    // Generar nombre único
    const timestamp = Date.now();
    const messageId = message.key.id;
    let extension = 'bin';
    let mimeType = 'application/octet-stream';
    
    // Determinar extensión según tipo
    if (message.message.imageMessage) {
      extension = 'jpg';
      mimeType = message.message.imageMessage.mimetype || 'image/jpeg';
    } else if (message.message.videoMessage) {
      extension = 'mp4';
      mimeType = message.message.videoMessage.mimetype || 'video/mp4';
    } else if (message.message.audioMessage) {
      extension = message.message.audioMessage.mimetype?.includes('ogg') ? 'ogg' : 'mp3';
      mimeType = message.message.audioMessage.mimetype || 'audio/mpeg';
    } else if (message.message.documentMessage) {
      const fileName = message.message.documentMessage.fileName || 'document';
      extension = fileName.split('.').pop() || 'pdf';
      mimeType = message.message.documentMessage.mimetype || 'application/pdf';
    }
    
    const filename = `${timestamp}_${messageId}.${extension}`;
    const filepath = path.join(CONFIG.mediaFolder, filename);
    
    // Guardar archivo
    fs.writeFileSync(filepath, buffer);
    
    // Retornar URL pública y metadata
    return {
      url: `${CONFIG.publicUrl}/media/${filename}`,
      filename: filename,
      mimeType: mimeType,
      size: buffer.length
    };
  } catch (error) {
    console.error('Error downloading media:', error);
    return null;
  }
}

// ==================== PROCESAMIENTO DE MENSAJES ====================

async function handleIncomingMessage(message) {
  try {
    const remoteJid = message.key.remoteJid;
    const isFromMe = message.key.fromMe;
    
    // Ignorar mensajes de grupos (opcional)
    if (remoteJid.includes('@g.us')) return;
    
    // Extraer número de teléfono
    const phone = remoteJid.replace('@s.whatsapp.net', '');
    
    // Obtener nombre
    const pushName = message.pushName || phone;
    
    console.log(`📩 Mensaje de ${pushName} (${phone})`);
    
    // Crear o obtener contacto
    const contactId = await getOrCreateContact(phone, pushName);
    if (!contactId) return;
    
    // Crear o obtener conversación
    const conversationId = await getOrCreateConversation(contactId, remoteJid);
    if (!conversationId) return;
    
    // Procesar contenido del mensaje
    let content = '';
    let attachments = [];
    
    const msg = message.message;
    
    // Texto simple
    if (msg?.conversation) {
      content = msg.conversation;
    } else if (msg?.extendedTextMessage?.text) {
      content = msg.extendedTextMessage.text;
    }
    
    // Multimedia con descarga
    if (msg?.imageMessage) {
      const media = await downloadAndSaveMedia(message);
      if (media) {
        content = msg.imageMessage.caption || '📷 Imagen';
        attachments.push({
          file_type: 'image',
          external_url: media.url
        });
      }
    } else if (msg?.videoMessage) {
      const media = await downloadAndSaveMedia(message);
      if (media) {
        content = msg.videoMessage.caption || '🎥 Video';
        attachments.push({
          file_type: 'video',
          external_url: media.url
        });
      }
    } else if (msg?.audioMessage) {
      const media = await downloadAndSaveMedia(message);
      if (media) {
        content = '🎵 Audio';
        attachments.push({
          file_type: 'audio',
          external_url: media.url
        });
      }
    } else if (msg?.documentMessage) {
      const media = await downloadAndSaveMedia(message);
      if (media) {
        content = `📎 ${msg.documentMessage.fileName || 'Documento'}`;
        attachments.push({
          file_type: 'file',
          external_url: media.url
        });
      }
    }
    
    // Enviar a Chatwoot
    if (content || attachments.length > 0) {
      await sendMessageToChatwoot(conversationId, content, attachments, isFromMe);
      console.log(`✅ Enviado a Chatwoot`);
    }
    
  } catch (error) {
    console.error('Error handling message:', error);
  }
}

// ==================== BAILEYS CONNECTION ====================

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.authFolder);
  
  sock = makeWASocket({
  auth: state,
  logger: pino({ level: 'silent' }),
  browser: ['Baileys Custom', 'Chrome', '1.0.0'],
  // Configuración adicional para evitar loops
  connectTimeoutMs: 60_000,
  defaultQueryTimeoutMs: 60_000,
  keepAliveIntervalMs: 30_000
});
  
  // Guardar credenciales
  sock.ev.on('creds.update', saveCreds);
  
  // Manejar actualización de conexión
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      qrCode = qr;
      console.log('🔲 QR Code disponible en /qr');
    }
    
    if (connection === 'close') {
  const shouldReconnect = (lastDisconnect?.error instanceof Boom) 
    ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut
    : true;
  
  const statusCode = lastDisconnect?.error?.output?.statusCode;
  console.log('❌ Conexión cerrada. Status:', statusCode, 'Reconectando:', shouldReconnect);
  connectionStatus = 'disconnected';
  
  if (shouldReconnect) {
    // Esperar 5 segundos antes de reconectar para evitar loops
    console.log('⏳ Esperando 5 segundos antes de reconectar...');
    setTimeout(() => {
      console.log('🔄 Intentando reconectar...');
      connectToWhatsApp();
    }, 5000);
  }
} else if (connection === 'open') {
      console.log('✅ Conectado a WhatsApp!');
      connectionStatus = 'connected';
      qrCode = null;
    }
  });
  
  // Manejar mensajes entrantes
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type === 'notify') {
      for (const message of messages) {
        if (!message.key.fromMe || message.key.fromMe) { // Procesar todos
          await handleIncomingMessage(message);
        }
      }
    }
  });
}

// ==================== INICIAR ====================

app.listen(CONFIG.port, () => {
  console.log(`🚀 Servidor corriendo en http://localhost:${CONFIG.port}`);
  console.log(`📊 Status: http://localhost:${CONFIG.port}/status`);
  console.log(`🔲 QR Code: http://localhost:${CONFIG.port}/qr`);
  console.log(`\n🔌 Conectando a WhatsApp...`);
  
  connectToWhatsApp();
});
