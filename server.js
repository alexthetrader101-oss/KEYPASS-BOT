const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function sendMessage(chatId, text) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: text
  });
}

const SCRAPE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive'
};

function detectSite(url) {
  if (url.includes('lu.ma') || url.includes('luma.com')) return 'luma';
  if (url.includes('eventbrite.com')) return 'eventbrite';
  if (url.includes('dice.fm')) return 'dice';
  return null;
}

function extractURL(text) {
  const match = text.match(/https?:\/\/[^\s,]+/);
  return match ? match[0].replace(/[.,!?]+$/, '') : null;
}

function generateTicketNumber() {
  return 'TKT-' + Math.random().toString(36).toUpperCase().slice(2, 7);
}

function generateSection() {
  const sections = ['GA', 'FLOOR', 'SEC A', 'SEC B', 'VIP'];
  return sections[Math.floor(Math.random() * sections.length)];
}

function generateGate() {
  const gates = ['GATE 1', 'GATE 2', 'GATE 3', 'MAIN', 'SIDE'];
  return gates[Math.floor(Math.random() * gates.length)];
}

function generateRow() {
  const rows = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
  return rows[Math.floor(Math.random() * rows.length)];
}

function generateSeat() {
  return String(Math.floor(Math.random() * 30) + 1);
}

function cleanName(name) {
  if (!name) return 'Event';
  return name
    .replace(/\s*[\|·—]\s*(Partiful|Luma|Dice|Eventbrite).*$/i, '')
    .replace(/\s*[Tt]ickets.*$/, '')
    .trim()
    .slice(0, 100);
}

async function scrapeLuma(url) {
  const slug = url.replace(/\?.*$/, '').replace(/,+$/, '').split('/').pop();
  console.log(`Luma slug: ${slug}`);
  try {
    const { data } = await axios.get(`https://api.lu.ma/public/v1/event/get?url_slug=${slug}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    const event = data.event;
    const name = cleanName(event.name);
    const date = event.start_at
      ? new Date(event.start_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
      : 'See event page';
    const time = event.start_at
      ? new Date(event.start_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : '';
    const location = (event.location_summary || (event.geo_address_info && event.geo_address_info.full_address) || 'See event page').slice(0, 100);
    const description = (event.description || '').slice(0, 300);
    return { name, date, time, location, description };
  } catch (e) {
    console.log(`Luma API failed (${e.message}), falling back to scrape`);
    const { data } = await axios.get(url.replace(/,+$/, ''), { headers: SCRAPE_HEADERS });
    const $ = cheerio.load(data);
    const name = cleanName($('meta[property="og:title"]').attr('content') || $('h1').first().text().trim());
    let date = 'See event page';
    let time = '';
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html());
        if (json['@type'] === 'Event' && json.startDate) {
          const d = new Date(json.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
      } catch (err) {}
    });
    const location = ($('meta[property="event:location"]').attr('content') || 'See event page').slice(0, 100);
    const description = ($('meta[name="description"]').attr('content') || '').slice(0, 300);
    return { name, date, time, location, description };
  }
}

async function scrapeEventbrite(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);
  const name = cleanName($('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event');
  let date = '', time = '', location = '';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      if (json['@type'] === 'Event') {
        if (json.startDate) {
          const d = new Date(json.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        location = (json.location && json.location.name) || (json.location && json.location.address && json.location.address.streetAddress) || '';
      }
    } catch (e) {}
  });
  if (!date) date = 'See event page';
  if (!location) location = 'See event page';
  const description = ($('meta[property="og:description"]').attr('content') || '').slice(0, 300);
  return { name, date, time, location: location.slice(0, 100), description };
}

async function scrapeDice(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);
  const name = cleanName($('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event');
  let date = '', time = '', location = '';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      if (json['@type'] === 'Event') {
        if (json.startDate) {
          const d = new Date(json.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        location = (json.location && json.location.name) || '';
      }
    } catch (e) {}
  });
  if (!date) date = 'See event page';
  if (!location) location = 'See event page';
  const description = ($('meta[name="description"]').attr('content') || '').slice(0, 300);
  return { name, date, time, location: location.slice(0, 100), description };
}

async function generatePass(eventData, eventUrl) {
  const ticketNumber = generateTicketNumber();
  const section = generateSection();
  const gate = generateGate();
  const row = generateRow();
  const seat = generateSeat();

  const passPayload = {
    barcodeValue: eventUrl,
    barcodeFormat: 'QR',
    logoText: 'PASSIFY',
    description: eventData.name,
    organizationName: 'Passify',
    colorPreset: 'dark',
    headerFields: [
      { label: 'DATE', value: eventData.date }
    ],
    primaryFields: [
      { label: 'EVENT', value: eventData.name }
    ],
    secondaryFields: [
      { label: 'SECTION', value: section },
      { label: 'ROW', value: row },
      { label: 'SEAT', value: seat }
    ],
    auxiliaryFields: [
      { label: 'TIME', value: eventData.time || 'Doors Open' },
      { label: 'GATE', value: gate },
      { label: 'TICKET', value: ticketNumber }
    ],
    backFields: [
      { label: 'TICKET NUMBER', value: ticketNumber },
      { label: 'EVENT', value: eventData.name },
      { label: 'DATE & TIME', value: `${eventData.date} ${eventData.time}`.trim() },
      { label: 'LOCATION', value: eventData.location },
      { label: 'SECTION', value: section },
      { label: 'ROW', value: row },
      { label: 'SEAT', value: seat },
      { label: 'GATE', value: gate },
      { label: 'EVENT LINK', value: eventUrl },
      { label: 'DETAILS', value: eventData.description }
    ]
  };

  const response = await axios.post(
    'https://api.walletwallet.dev/api/pkpass',
    passPayload,
    {
      headers: {
        Authorization: `Bearer ${process.env.WALLETWALLET_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer'
    }
  );

  const fs = require('fs');
  const path = require('path');
  const fileName = `pass_${Date.now()}.pkpass`;
  const filePath = path.join('/tmp', fileName);
  fs.writeFileSync(filePath, response.data);

  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;
  return `${baseUrl}/passes/${fileName}`;
}

app.get('/passes/:filename', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const filePath = path.join('/tmp', req.params.filename);
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
    res.sendFile(filePath);
  } else {
    res.status(404).send('Pass not found');
  }
});

app.post('/webhook/inbound', async (req, res) => {
  res.sendStatus(200);
  const message = req.body.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const incomingMsg = message.text.trim();

  console.log(`Received Telegram message from ${chatId}: ${incomingMsg}`);

  const url = extractURL(incomingMsg);
  const site = url ? detectSite(url) : null;

  console.log(`Extracted URL: ${url}, Site: ${site}`);

  if (!url || !site) return;

  try {
    await sendMessage(chatId, `Got it! Building your pass now... 🎟️`);

    let eventData;
    if (site === 'luma') eventData = await scrapeLuma(url);
    if (site === 'eventbrite') eventData = await scrapeEventbrite(url);
    if (site === 'dice') eventData = await scrapeDice(url);

    const passUrl = await generatePass(eventData, url);

    await sendMessage(chatId, `✅ Here's your pass for "${eventData.name}"!\n\nSECTION: ${section} | ROW: ${row} | SEAT: ${seat} | GATE: ${gate}\n\nTap to add to Apple Wallet:\n${passUrl}`);

  } catch (err) {
    console.error('Error generating pass:', err.message);
    console.error(err.stack);
    await sendMessage(chatId, `❌ Something went wrong: ${err.message}`);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Passify bot running on port ${PORT}`);
  const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook/inbound`;
  try {
    await axios.post(`${TELEGRAM_API}/setWebhook`, { url: webhookUrl });
    console.log(`Telegram webhook set to ${webhookUrl}`);
  } catch (e) {
    console.error('Failed to set Telegram webhook:', e.message);
  }
});
