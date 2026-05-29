const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const twilio = require('twilio');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// ─────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────

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

// ─────────────────────────────────────────
// SCRAPERS
// ─────────────────────────────────────────

async function scrapeLuma(url) {
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const $ = cheerio.load(data);

  const name = $('h1').first().text().trim() || 'Event';
  const date = $('[class*="date"], [class*="time"]').first().text().trim() || 'See event page';
  const location = $('[class*="location"], [class*="venue"]').first().text().trim() || 'See event page';
  const description = $('meta[name="description"]').attr('content') || '';

  return { name, date, location, description };
}

async function scrapePartiful(url) {
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const $ = cheerio.load(data);

  // Partiful stores event data in meta tags and JSON-LD
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

  return { name, date, location, description };
}

async function scrapeEventbrite(url) {
  const { data } = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  const $ = cheerio.load(data);

  // Eventbrite has good meta and structured data
  const name =
    $('meta[property="og:title"]').attr('content') ||
    $('h1').first().text().trim() ||
    'Event';

  // Try JSON-LD first (most reliable for Eventbrite)
  let date = '';
  let location = '';
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      if (json['@type'] === 'Event') {
        date = json.startDate || '';
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

  return { name, date, location, description };
}

// ─────────────────────────────────────────
// PASS GENERATOR (WalletWallet)
// ─────────────────────────────────────────

async function generatePass(eventData) {
  const response = await axios.post(
    'https://api.walletwallet.dev/passes',
    {
      type: 'eventTicket',
      organizationName: 'Keypass Bot',
      description: eventData.name,
      foregroundColor: 'rgb(255,255,255)',
      backgroundColor: 'rgb(0,0,0)',
      fields: {
        headerFields: [
          { key: 'event', label: 'EVENT', value: eventData.name }
        ],
        primaryFields: [
          { key: 'date', label: 'DATE & TIME', value: eventData.date }
        ],
        secondaryFields: [
          { key: 'location', label: 'LOCATION', value: eventData.location }
        ],
        auxiliaryFields: [
          { key: 'desc', label: 'INFO', value: eventData.description.slice(0, 100) }
        ]
      }
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.WALLETWALLET_API_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data.passUrl;
}

// ─────────────────────────────────────────
// WEBHOOK — incoming SMS/iMessage
// ─────────────────────────────────────────

app.post('/webhook/inbound', async (req, res) => {
  const incomingMsg = req.body.Body || '';
  const fromNumber = req.body.From || '';

  console.log(`Received message from ${fromNumber}: ${incomingMsg}`);

  const url = extractURL(incomingMsg);
  const site = url ? detectSite(url) : null;

  if (!url || !site) {
    await twilioClient.messages.create({
      body: `👋 Send me a Luma, Partiful, or Eventbrite event link and I'll add it to your Apple Wallet!`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: fromNumber
    });
    res.sendStatus(200);
    return;
  }

  try {
    await twilioClient.messages.create({
      body: `Got it! Building your pass now... 🎟️`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: fromNumber
    });

    let eventData;
    if (site === 'luma') eventData = await scrapeLuma(url);
    if (site === 'partiful') eventData = await scrapePartiful(url);
    if (site === 'eventbrite') eventData = await scrapeEventbrite(url);

    const passUrl = await generatePass(eventData);

    await twilioClient.messages.create({
      body: `✅ Here's your pass for "${eventData.name}"!\n\nTap to add to Apple Wallet:\n${passUrl}`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: fromNumber
    });

  } catch (err) {
    console.error('Error:', err.message);
    await twilioClient.messages.create({
      body: `❌ Something went wrong. Make sure the link is public and try again.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: fromNumber
    });
  }

  res.sendStatus(200);
});

// ─────────────────────────────────────────
// START SERVER
// ─────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Keypass bot running on port ${PORT}`);
});
