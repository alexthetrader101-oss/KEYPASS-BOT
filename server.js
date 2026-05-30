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
  if (url.includes('lu.ma')) return 'luma';
  if (url.includes('partiful.com')) return 'partiful';
  if (url.includes('eventbrite.com')) return 'eventbrite';
  return null;
}

function extractURL(text) {
  const match = text.match(/https?:\/\/[^\s]+/);
  return match ? match[0] : null;
}

async function scrapeLuma(url) {
  const slug = url.replace(/\?.*$/, '').split('/').pop();
  console.log(`Luma slug: ${slug}`);
  const { data } = await axios.get(`https://api.lu.ma/public/v1/event/get?url_slug=${slug}`, {
    headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
  });
  console.log(`Luma API response: ${JSON.stringify(data).slice(0, 300)}`);
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
  return { name, date, time, location, description };
}

async function scrapePartiful(url) {
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const $ = cheerio.load(data);
  const name =
    $('meta[property="og:title"]').attr('content') ||
    $('h1').first().text().trim() ||
    'Party';
  const date =
    $('meta[property="event:start_time"]').attr('content') ||
    $('[class*="date"], [class*="time"]').first().text().trim() ||
    'See invite';
  const location =
    $('meta[property="event:location"]').attr('content') ||
    $('[class*="location"], [class*="address"]').first().text().trim() ||
    'See invite';
  const description =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    '';
  return { name, date, time: '', location, description };
}

async function scrapeEventbrite(url) {
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const $ = cheerio.load(data);
  const name =
    $('meta[property="og:title"]').attr('content') ||
    $('h1').first().text().trim() ||
    'Event';
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
        location =
          (json.location && json.location.name) ||
          (json.location && json.location.address && json.location.address.streetAddress) ||
          '';
      }
    } catch (e) {}
  });
  if (!date) date = $('[class*="date"], [class*="time"]').first().text().trim() || 'See event page';
  if (!location) location = $('[class*="location"], [class*="venue"]').first().text().trim() || 'See event page';
  const description =
    $('meta[property="og:description"]').attr('content') ||
    $('meta[name="description"]').attr('content') ||
    '';
  return { name, date, time, location, description };
}

async function generatePass(eventData, eventUrl) {
  const response = await axios.post(
    'https://api.walletwallet.dev/api/pkpass',
    {
      barcodeValue: eventUrl,
      barcodeFormat: 'QR',
      logoText: 'KEYPASS',
      description: eventData.name,
      organizationName: 'Keypass',
      headerFields: [
        { label: 'DATE', value: eventData.date }
      ],
      primaryFields: [
        { label: 'EVENT', value: eventData.name }
      ],
      secondaryFields: [
        { label: 'TIME', value: eventData.time || 'See event' },
        { label: 'LOCATION', value: eventData.location }
      ],
      backFields: [
        { label: 'EVENT LINK', value: eventUrl },
        { label: 'DATE & TIME', value: `${eventData.date} ${eventData.time}` },
        { label: 'LOCATION', value: eventData.location },
        { label: 'DETAILS', value: eventData.description.slice(0, 300) }
      ],
      colorPreset: 'blue',
      expirationDays: 30
    },
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
  console.log(`Raw body: ${JSON.stringify(req.body)}`);

  const url = extractURL(incomingMsg);
  const site = url ? detectSite(url) : null;

  console.log(`Extracted URL: ${url}, Site: ${site}`);

  if (!url || !site) {
    await twilioClient.messages.create({
      body: `👋 Send me a Luma, Partiful, or Eventbrite event link and I'll add it to your Apple Wallet!`,
      from: `whatsapp:${process.env.TWILIO_WHATSAPP_NUMBER}`,
      to: fromNumber
    });
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
  console.log(`Keypass bot running on port ${PORT}`);
});
