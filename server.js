const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const twilio = require('twilio');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

function detectSite(url) {
  if (url.includes('lu.ma') || url.includes('luma.com')) return 'luma';
  if (url.includes('partiful.com')) return 'partiful';
  if (url.includes('eventbrite.com')) return 'eventbrite';
  if (url.includes('dice.fm')) return 'dice';
  if (url.includes('songkick.com')) return 'songkick';
  if (url.includes('ra.co')) return 'ra';
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
    const image = event.cover_url || event.thumbnail_url || null;
    return { name, date, time, location, description, image };
  } catch (e) {
    console.log(`Luma API failed (${e.message}), falling back to scrape`);
    const { data } = await axios.get(url.replace(/,+$/, ''), {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const $ = cheerio.load(data);
    const name =
      $('meta[property="og:title"]').attr('content') ||
      $('h1').first().text().trim() ||
      'Event';
    const image = $('meta[property="og:image"]').attr('content') || null;
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
    const location =
      $('meta[property="event:location"]').attr('content') ||
      $('[class*="location"]').first().text().trim() ||
      'See event page';
    const description = $('meta[name="description"]').attr('content') || '';
    return { name, date, time, location, description, image };
  }
}

async function scrapePartiful(url) {
  const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const $ = cheerio.load(data);
  const name = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Party';
  const date = $('meta[property="event:start_time"]').attr('content') || 'See invite';
  const location = $('meta[property="event:location"]').attr('content') || 'See invite';
  const description = $('meta[property="og:description"]').attr('content') || '';
  const image = $('meta[property="og:image"]').attr('content') || null;
  return { name, date, time: '', location, description, image };
}

async function scrapeEventbrite(url) {
  const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const $ = cheerio.load(data);
  const name = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event';
  const image = $('meta[property="og:image"]').attr('content') || null;
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
  const description = $('meta[property="og:description"]').attr('content') || '';
  return { name, date, time, location, description, image };
}

async function scrapeDice(url) {
  const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const $ = cheerio.load(data);
  const name = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event';
  const image = $('meta[property="og:image"]').attr('content') || null;
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
  const description = $('meta[name="description"]').attr('content') || '';
  return { name, date, time, location, description, image };
}

async function scrapeSongkick(url) {
  const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const $ = cheerio.load(data);
  const name = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Concert';
  const image = $('meta[property="og:image"]').attr('content') || null;
  let date = '', time = '', location = '';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      if (json['@type'] === 'MusicEvent' || json['@type'] === 'Event') {
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
  const description = $('meta[name="description"]').attr('content') || '';
  return { name, date, time, location, description, image };
}

async function scrapeRA(url) {
  const { data } = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const $ = cheerio.load(data);
  const name = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event';
  const image = $('meta[property="og:image"]').attr('content') || null;
  let date = '', time = '', location = '';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      if (json['@type'] === 'DanceEvent' || json['@type'] === 'Event') {
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
  const description = $('meta[name="description"]').attr('content') || '';
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
    description: eventData.name,
    organizationName: 'Passify',
    headerFields: [
      { label: 'DATE', value: eventData.date }
    ],
    primaryFields: [
      { label: 'EVENT', value: eventData.name }
    ],
    secondaryFields: [
      { label: 'TIME', value: eventData.time || 'Doors Open' },
      { label: 'LOCATION', value: eventData.location }
    ],
    auxiliaryFields: [
      { label: 'SECTION', value: section },
      { label: 'GATE', value: gate },
      { label: 'TICKET', value: ticketNumber }
    ],
    backFields: [
      { label: 'TICKET NUMBER', value: ticketNumber },
      { label: 'EVENT', value: eventData.name },
      { label: 'DATE & TIME', value: `${eventData.date} ${eventData.time}` },
      { label: 'LOCATION', value: eventData.location },
      { label: 'SECTION', value: section },
      { label: 'GATE', value: gate },
      { label: 'EVENT LINK', value: eventUrl },
      { label: 'DETAILS', value: eventData.description.slice(0, 300) }
    ],
    color: '#0a0a0a',
    expirationDays: 30
  };

  // Add images if available
  if (eventData.image) {
    passPayload.stripImageUrl = eventData.image;
    passPayload.logoUrl = eventData.image;
  }

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
  const incomingMsg = (req.body.Body || '').trim();
  const fromNumber = req.body.From || '';

  console.log(`Received WhatsApp message from ${fromNumber}: ${incomingMsg}`);

  const url = extractURL(incomingMsg);
  const site = url ? detectSite(url) : null;

  console.log(`Extracted URL: ${url}, Site: ${site}`);

  if (!url || !site) {
    res.sendStatus(200);
    return;
  }

  try {
    await twilioClient.messages.create({
      body: `Got it! Building your pass now... 🎟️`,
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: fromNumber
    });

    let eventData;
    if (site === 'luma') eventData = await scrapeLuma(url);
    if (site === 'partiful') eventData = await scrapePartiful(url);
    if (site === 'eventbrite') eventData = await scrapeEventbrite(url);
    if (site === 'dice') eventData = await scrapeDice(url);
    if (site === 'songkick') eventData = await scrapeSongkick(url);
    if (site === 'ra') eventData = await scrapeRA(url);

    const passUrl = await generatePass(eventData, url);

    await twilioClient.messages.create({
      body: `✅ Here's your pass for "${eventData.name}"!\n\nTap to add to Apple Wallet:\n${passUrl}`,
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: fromNumber
    });

  } catch (err) {
    console.error('Error generating pass:', err.message);
    console.error(err.stack);
    await twilioClient.messages.create({
      body: `❌ Something went wrong: ${err.message}`,
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: fromNumber
    });
  }

  res.sendStatus(200);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Passify bot running on port ${PORT}`);
});
