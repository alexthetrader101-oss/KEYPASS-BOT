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
  if (url.includes('partiful.com')) return 'partiful';
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

function generateSeat() {
  const sections = ['GA', 'FLOOR', 'SECTION A', 'SECTION B', 'VIP'];
  return sections[Math.floor(Math.random() * sections.length)];
}

function generateGate() {
  const gates = ['GATE 1', 'GATE 2', 'GATE 3', 'MAIN ENTRANCE', 'SIDE ENTRANCE'];
  return gates[Math.floor(Math.random() * gates.length)];
}

function cleanImageUrl(url) {
  if (!url) return null;
  // reject relative or encoded proxy URLs
  if (!url.startsWith('http')) return null;
  if (url.includes('/_next/image') || url.includes('/e/_next')) return null;
  return url;
}

async function scrapeLuma(url) {
  const slug = url.replace(/\?.*$/, '').replace(/,+$/, '').split('/').pop();
  console.log(`Luma slug: ${slug}`);
  try {
    const { data } = await axios.get(`https://api.lu.ma/public/v1/event/get?url_slug=${slug}`, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    });
    const event = data.event;
    const name = event.name || 'Event';
    const date = event.start_at
      ? new Date(event.start_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
      : 'See event page';
    const time = event.start_at
      ? new Date(event.start_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
      : '';
    const location = event.location_summary || (event.geo_address_info && event.geo_address_info.full_address) || 'See event page';
    const description = event.description || '';
    const image = cleanImageUrl(event.cover_url || event.thumbnail_url || null);
    console.log(`Luma image: ${image}`);
    return { name, date, time, location, description, image };
  } catch (e) {
    console.log(`Luma API failed (${e.message}), falling back to scrape`);
    const { data } = await axios.get(url.replace(/,+$/, ''), { headers: SCRAPE_HEADERS });
    const $ = cheerio.load(data);
    const name = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event';
    const image = cleanImageUrl($('meta[property="og:image"]').attr('content') || null);
    console.log(`Luma fallback image: ${image}`);
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
    const location = $('meta[property="event:location"]').attr('content') || $('[class*="location"]').first().text().trim() || 'See event page';
    const description = $('meta[name="description"]').attr('content') || '';
    return { name, date, time, location, description, image };
  }
}

async function scrapePartiful(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);
  const name = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Party';
  const image = cleanImageUrl($('meta[property="og:image"]').attr('content') || null);
  console.log(`Partiful image: ${image}`);

  // Parse date from meta or fallback to plain string
  let date = 'See invite';
  let time = '';
  const rawDate = $('meta[property="event:start_time"]').attr('content');
  if (rawDate) {
    try {
      const d = new Date(rawDate);
      date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      date = rawDate.slice(0, 50);
    }
  }

  const location = ($('meta[property="event:location"]').attr('content') || 'See invite').slice(0, 100);
  const description = ($('meta[property="og:description"]').attr('content') || '').slice(0, 300);
  return { name, date, time, location, description, image };
}

async function scrapeEventbrite(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);
  const name = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event';

  // Use structured data image instead of og:image which is often a proxy URL
  let image = null;
  let date = '';
  let time = '';
  let location = '';

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
        // Get image from structured data which is a real URL
        if (json.image && typeof json.image === 'string') image = cleanImageUrl(json.image);
        if (json.image && Array.isArray(json.image)) image = cleanImageUrl(json.image[0]);
      }
    } catch (e) {}
  });

  // fallback to og:image only if structured data had nothing
  if (!image) image = cleanImageUrl($('meta[property="og:image"]').attr('content') || null);
  console.log(`Eventbrite image: ${image}`);

  if (!date) date = 'See event page';
  if (!location) location = 'See event page';
  const description = ($('meta[property="og:description"]').attr('content') || '').slice(0, 300);
  return { name, date, time, location, description, image };
}

async function scrapeDice(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);

  // Clean up Dice event name — strip price and venue suffix
  let name = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event';
  // Dice titles look like "Event Name Tickets | $24 | May 30 @ Venue | DICE"
  // Strip everything from " Tickets" or " | " onward
  name = name.replace(/\s*[Tt]ickets.*$/, '').replace(/\s*\|.*$/, '').trim() || name;

  const image = cleanImageUrl($('meta[property="og:image"]').attr('content') || null);
  console.log(`Dice image: ${image}`);
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
  return { name, date, time, location, description, image };
}

async function generatePass(eventData, eventUrl) {
  const ticketNumber = generateTicketNumber();
  const section = generateSeat();
  const gate = generateGate();

  const passPayload = {
    barcodeValue: eventUrl,
    barcodeFormat: 'QR',
    logoText: 'PASSIFY',
    description: eventData.name.slice(0, 100),
    organizationName: 'Passify',
    colorPreset: 'dark',
    headerFields: [{ label: 'DATE', value: eventData.date }],
    primaryFields: [{ label: 'EVENT', value: eventData.name.slice(0, 100) }],
    secondaryFields: [
      { label: 'TIME', value: eventData.time || 'Doors Open' },
      { label: 'LOCATION', value: eventData.location.slice(0, 100) }
    ],
    auxiliaryFields: [
      { label: 'SECTION', value: section },
      { label: 'GATE', value: gate },
      { label: 'TICKET', value: ticketNumber }
    ],
    backFields: [
      { label: 'TICKET NUMBER', value: ticketNumber },
      { label: 'EVENT', value: eventData.name.slice(0, 100) },
      { label: 'DATE & TIME', value: `${eventData.date} ${eventData.time}`.trim() },
      { label: 'LOCATION', value: eventData.location.slice(0, 100) },
      { label: 'SECTION', value: section },
      { label: 'GATE', value: gate },
      { label: 'EVENT LINK', value: eventUrl },
      { label: 'DETAILS', value: eventData.description.slice(0, 300) }
    ]
  };

  if (eventData.image) {
    console.log(`Adding image to pass: ${eventData.image}`);
    passPayload.stripImageUrl = eventData.image;
    passPayload.thumbnailURL = eventData.image;
    passPayload.logoURL = eventData.image;
    passPayload.iconURL = eventData.image;
  }

  console.log(`Pass payload: ${JSON.stringify(passPayload).slice(0, 500)}`);

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
    if (site === 'partiful') eventData = await scrapePartiful(url);
    if (site === 'eventbrite') eventData = await scrapeEventbrite(url);
    if (site === 'dice') eventData = await scrapeDice(url);

    const passUrl = await generatePass(eventData, url);

    await sendMessage(chatId, `✅ Here's your pass for "${eventData.name}"!\n\nTap to add to Apple Wallet:\n${passUrl}`);

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
