const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const userState = {};

// ─── Telegram helpers ────────────────────────────────────────────────────────

async function sendMessage(chatId, text) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: text
  });
}

async function sendInlineKeyboard(chatId, text, buttons) {
  await axios.post(`${TELEGRAM_API}/sendMessage`, {
    chat_id: chatId,
    text: text,
    reply_markup: {
      inline_keyboard: buttons
    }
  });
}

async function answerCallbackQuery(callbackQueryId) {
  await axios.post(`${TELEGRAM_API}/answerCallbackQuery`, {
    callback_query_id: callbackQueryId
  });
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

function cleanupOldPasses() {
  const tmpDir = '/tmp';
  const files = fs.readdirSync(tmpDir).filter(f => f.startsWith('pass_') && f.endsWith('.pkpass'));
  const now = Date.now();
  for (const file of files) {
    const filePath = path.join(tmpDir, file);
    const stat = fs.statSync(filePath);
    if (now - stat.mtimeMs > 24 * 60 * 60 * 1000) {
      fs.unlinkSync(filePath);
      console.log(`Deleted old pass: ${file}`);
    }
  }
}
setInterval(cleanupOldPasses, 60 * 60 * 1000);

// ─── Constants ───────────────────────────────────────────────────────────────

const SCRAPE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive'
};

const MOVIE_SITES = ['amc', 'cinemark'];
const CONCERT_SITES = ['luma', 'eventbrite', 'dice', 'fever'];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function detectSite(url) {
  if (url.includes('lu.ma') || url.includes('luma.com')) return 'luma';
  if (url.includes('eventbrite.com')) return 'eventbrite';
  if (url.includes('dice.fm')) return 'dice';
  if (url.includes('feverup.com') || url.includes('fever.com')) return 'fever';
  if (url.includes('amctheatres.com')) return 'amc';
  if (url.includes('cinemark.com')) return 'cinemark';

  return null;
}

function isMovieSite(site) {
  return MOVIE_SITES.includes(site);
}

function extractURLs(text) {
  const matches = text.match(/https?:\/\/[^\s,]+/g);
  if (!matches) return [];
  return matches.map(u => u.replace(/[.,!?]+$/, ''));
}

function colorForSite(site) {
  const map = {
    luma: 'blue',
    eventbrite: 'dark',
    dice: 'purple',
    fever: 'dark',
    amc: 'red',
    cinemark: 'red'
  };
  return map[site] || 'dark';
}

// safeVal: ensures NO empty strings ever reach WalletWallet
function safeVal(val, fallback = 'N/A') {
  if (val === null || val === undefined) return fallback;
  const str = String(val).trim();
  return str.length > 0 ? str : fallback;
}

// ─── Realistic generators ────────────────────────────────────────────────────

function generateTicketNumber(site) {
  const prefix = {
    amc: 'AMC', cinemark: 'CNM',
    luma: 'LMA', eventbrite: 'EVT', dice: 'DCE', fever: 'FVR'
  }[site] || 'TKT';
  const num = Math.floor(Math.random() * 90000) + 10000;
  const suffix = Math.random().toString(36).toUpperCase().slice(2, 4);
  return `${prefix}-${num}-${suffix}`;
}

function generateAuditorium() {
  return 'AUDITORIUM ' + String(Math.floor(Math.random() * 20) + 1);
}

function generateMovieSeat() {
  const audNum = Math.floor(Math.random() * 20) + 1;
  const row = ['A','B','C','D','E','F','G','H','J','K'][Math.floor(Math.random() * 10)];
  const seat = Math.floor(Math.random() * 20) + 1;
  return {
    auditorium: `AUDITORIUM ${audNum}`,
    row,
    seat: String(seat)
  };
}

function generateEventSeat() {
  const sections = ['GA', 'FLOOR', 'PIT', 'SEC 100', 'SEC 200', 'VIP', 'BALCONY', 'MEZZANINE'];
  const gates = ['GATE A', 'GATE B', 'GATE C', 'MAIN ENTRANCE', 'NORTH GATE', 'SOUTH GATE'];
  const rows = ['A','B','C','D','E','F','G','H','J','K','L','M'];
  const section = sections[Math.floor(Math.random() * sections.length)];
  const gate = gates[Math.floor(Math.random() * gates.length)];
  const row = rows[Math.floor(Math.random() * rows.length)];
  const seat = String(Math.floor(Math.random() * 30) + 1);
  return { section, gate, row, seat };
}

function getExpirationDate(eventDateStr) {
  if (!eventDateStr) return null;
  try {
    const d = new Date(eventDateStr);
    if (isNaN(d.getTime()) || d.getFullYear() < 2020) return null;
    d.setDate(d.getDate() + 1);
    return d.toISOString();
  } catch (e) {}
  return null;
}

// ─── Name cleaner ─────────────────────────────────────────────────────────────

function cleanName(name) {
  if (!name) return 'Event';
  return name
    .replace(/\s*[\|·—]\s*(Partiful|Luma|Dice|Eventbrite|Fever|AMC|Cinemark).*$/i, '')
    .replace(/\s*[Tt]ickets.*$/, '')
    .replace(/\s*[-–]\s*Buy.*$/i, '')
    .trim()
    .slice(0, 100);
}

// ─── Scrapers ─────────────────────────────────────────────────────────────────

async function scrapeLuma(url) {
  const slug = url.replace(/\?.*$/, '').replace(/,+$/, '').split('/').pop();
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
      : 'See event page';
    const location = (event.location_summary || (event.geo_address_info && event.geo_address_info.full_address) || 'See event page').slice(0, 100);
    const description = (event.description || 'N/A').slice(0, 200);
    const rawDate = event.start_at || null;
    return { name, date, time, location, description, rawDate };
  } catch (e) {
    const { data } = await axios.get(url.replace(/,+$/, ''), { headers: SCRAPE_HEADERS });
    const $ = cheerio.load(data);
    const name = cleanName($('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event');
    let date = 'See event page', time = 'See event page', rawDate = null;
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const json = JSON.parse($(el).html());
        if (json['@type'] === 'Event' && json.startDate) {
          rawDate = json.startDate;
          const d = new Date(json.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
      } catch (err) {}
    });
    const location = ($('meta[property="event:location"]').attr('content') || 'See event page').slice(0, 100);
    const description = ($('meta[name="description"]').attr('content') || 'N/A').slice(0, 200);
    return { name, date, time, location, description, rawDate };
  }
}

async function scrapeEventbrite(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);
  const name = cleanName($('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event');
  let date = 'See event page', time = 'See event page', location = 'See event page', rawDate = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      if (json['@type'] === 'Event') {
        if (json.startDate) {
          rawDate = json.startDate;
          const d = new Date(json.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        location = (json.location && json.location.name) || (json.location && json.location.address && json.location.address.streetAddress) || 'See event page';
      }
    } catch (e) {}
  });
  const description = ($('meta[property="og:description"]').attr('content') || 'N/A').slice(0, 200);
  return { name, date, time, location: location.slice(0, 100), description, rawDate };
}

async function scrapeDice(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);
  const name = cleanName($('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event');
  let date = 'See event page', time = 'See event page', location = 'See event page', rawDate = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      if (json['@type'] === 'Event') {
        if (json.startDate) {
          rawDate = json.startDate;
          const d = new Date(json.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        location = (json.location && json.location.name) || 'See event page';
      }
    } catch (e) {}
  });
  const description = ($('meta[name="description"]').attr('content') || 'N/A').slice(0, 200);
  return { name, date, time, location: location.slice(0, 100), description, rawDate };
}

async function scrapeFever(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);
  const name = cleanName($('meta[property="og:title"]').attr('content') || $('h1').first().text().trim() || 'Event');
  let date = 'See event page', time = 'See event page', location = 'See event page', rawDate = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const event = Array.isArray(json) ? json.find(j => j['@type'] === 'Event') : (json['@type'] === 'Event' ? json : null);
      if (event) {
        if (event.startDate) {
          rawDate = event.startDate;
          const d = new Date(event.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        location = (event.location && event.location.name) || (event.location && event.location.address && event.location.address.streetAddress) || 'See event page';
      }
    } catch (e) {}
  });
  if (date === 'See event page') {
    const ogDate = $('meta[property="event:start_time"]').attr('content') || $('meta[name="date"]').attr('content');
    if (ogDate) {
      rawDate = ogDate;
      const d = new Date(ogDate);
      date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
  }
  if (location === 'See event page') {
    location = ($('meta[property="og:street-address"]').attr('content') || $('meta[property="event:location"]').attr('content') || 'See event page').slice(0, 100);
  }
  const description = ($('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || 'N/A').slice(0, 200);
  return { name, date, time, location: location.slice(0, 100), description, rawDate };
}

async function scrapeAMC(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);
  let name = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim();
  if (!name || name.toLowerCase().includes('amc theatres') || name.toLowerCase() === 'amc') {
    const urlMatch = url.match(/\/movies\/([^\/\?]+)/i);
    if (urlMatch) {
      name = urlMatch[1].replace(/-\d+$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
  }
  name = cleanName(name || 'Movie');
  let date = 'See movie page', time = 'See movie page', location = 'AMC Theatres', rating = '', runtime = '', rawDate = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const item = Array.isArray(json) ? json.find(j => j['@type'] === 'Movie' || j['@type'] === 'ScreeningEvent') : json;
      if (item) {
        if (item.startDate) {
          rawDate = item.startDate;
          const d = new Date(item.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        location = (item.location && item.location.name) || 'AMC Theatres';
        rating = item.contentRating || '';
        if (item.duration) {
          const match = item.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
          if (match) runtime = ((match[1] ? `${match[1]}h ` : '') + (match[2] ? `${match[2]}m` : '')).trim();
        }
      }
    } catch (e) {}
  });
  if (location === 'AMC Theatres') {
    const theaterMatch = $('title').text().match(/at\s+(.+?)(\s*[-|]|$)/i);
    if (theaterMatch) location = theaterMatch[1].trim().slice(0, 100);
  }
  const ratingRuntime = [rating, runtime].filter(Boolean).join(' · ') || 'N/A';
  const description = ($('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || 'N/A').slice(0, 200);
  return { name, date, time, location: location.slice(0, 100), description, ratingRuntime, rawDate };
}

async function scrapeCinemark(url) {
  const { data } = await axios.get(url, { headers: SCRAPE_HEADERS });
  const $ = cheerio.load(data);
  let name = $('meta[property="og:title"]').attr('content') || $('h1').first().text().trim();
  if (!name || name.toLowerCase().includes('cinemark')) {
    const urlMatch = url.match(/\/movies\/([^\/\?]+)/i);
    if (urlMatch) {
      name = urlMatch[1].replace(/-\d+$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    }
  }
  name = cleanName(name || 'Movie');
  let date = 'See movie page', time = 'See movie page', location = 'Cinemark', rating = '', runtime = '', rawDate = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const json = JSON.parse($(el).html());
      const item = Array.isArray(json) ? json.find(j => j['@type'] === 'Movie' || j['@type'] === 'ScreeningEvent') : json;
      if (item) {
        if (item.startDate) {
          rawDate = item.startDate;
          const d = new Date(item.startDate);
          date = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
          time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
        }
        location = (item.location && item.location.name) || 'Cinemark';
        rating = item.contentRating || '';
        if (item.duration) {
          const match = item.duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
          if (match) runtime = ((match[1] ? `${match[1]}h ` : '') + (match[2] ? `${match[2]}m` : '')).trim();
        }
      }
    } catch (e) {}
  });
  if (location === 'Cinemark') {
    const theaterMatch = url.match(/\/theatre\/([^\/]+)/i);
    if (theaterMatch) location = theaterMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).slice(0, 100);
  }
  const ratingRuntime = [rating, runtime].filter(Boolean).join(' · ') || 'N/A';
  const description = ($('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || 'N/A').slice(0, 200);
  return { name, date, time, location: location.slice(0, 100), description, ratingRuntime, rawDate };
}

async function scrapeByUrl(url) {
  const site = detectSite(url);
  if (!site) return null;
  const scrapers = {
    luma: scrapeLuma, eventbrite: scrapeEventbrite, dice: scrapeDice, fever: scrapeFever,
    amc: scrapeAMC, cinemark: scrapeCinemark
  };
  const scraper = scrapers[site];
  if (!scraper) return null;
  const eventData = await scraper(url);
  return { eventData, site };
}

// ─── Pass generator ───────────────────────────────────────────────────────────

async function generatePass(eventData, eventUrl, site, passholder = null) {
  const isMovie = isMovieSite(site);
  const color = colorForSite(site);
  const ticketNumber = generateTicketNumber(site);
  const passholderVal = safeVal(passholder ? passholder.toUpperCase() : null, 'N/A');

  // Generate seat details
  const movieSeat = generateMovieSeat();
  const eventSeat = generateEventSeat();

  // Pass expiry: event date + 1 day
  const expirationDate = getExpirationDate(eventData.rawDate);

  // Build payload — every single value goes through safeVal
  const passPayload = {
    barcodeValue: safeVal(eventUrl, 'https://keypass.app'),
    barcodeFormat: 'QR',
    logoText: 'KEYPASS',
    description: safeVal(eventData.name, 'Event'),
    organizationName: 'Keypass',
    colorPreset: color,
    headerFields: [
      { label: 'DATE', value: safeVal(eventData.date, 'See page') },
      { label: 'NAME', value: passholderVal }
    ],
    primaryFields: [
      { label: isMovie ? 'FILM' : 'EVENT', value: safeVal(eventData.name, 'Event') }
    ],
    secondaryFields: isMovie
      ? [
          { label: 'AUDITORIUM', value: safeVal(movieSeat.auditorium) },
          { label: 'ROW', value: safeVal(movieSeat.row) },
          { label: 'SEAT', value: safeVal(movieSeat.seat) }
        ]
      : [
          { label: 'SECTION', value: safeVal(eventSeat.section) },
          { label: 'ROW', value: safeVal(eventSeat.row) },
          { label: 'SEAT', value: safeVal(eventSeat.seat) }
        ],
    auxiliaryFields: isMovie
      ? [
          { label: 'TIME', value: safeVal(eventData.time, 'See page') },
          { label: 'THEATER', value: safeVal(eventData.location, 'See page') },
          { label: 'TICKET', value: safeVal(ticketNumber) }
        ]
      : [
          { label: 'TIME', value: safeVal(eventData.time, 'Doors Open') },
          { label: 'GATE', value: safeVal(eventSeat.gate) },
          { label: 'TICKET', value: safeVal(ticketNumber) }
        ],
    // Strictly 10 backFields — no conditionals that can push over
    backFields: isMovie
      ? [
          { label: 'TICKET NUMBER', value: safeVal(ticketNumber) },
          { label: 'PASSHOLDER', value: passholderVal },
          { label: 'FILM', value: safeVal(eventData.name, 'Movie') },
          { label: 'DATE', value: safeVal(eventData.date, 'See page') },
          { label: 'TIME', value: safeVal(eventData.time, 'See page') },
          { label: 'THEATER', value: safeVal(eventData.location, 'See page') },
          { label: 'AUDITORIUM', value: safeVal(movieSeat.auditorium) },
          { label: 'ROW', value: safeVal(movieSeat.row) },
          { label: 'SEAT', value: safeVal(movieSeat.seat) },
          { label: 'RATING / RUNTIME', value: safeVal(eventData.ratingRuntime, 'N/A') }
        ]
      : [
          { label: 'TICKET NUMBER', value: safeVal(ticketNumber) },
          { label: 'PASSHOLDER', value: passholderVal },
          { label: 'EVENT', value: safeVal(eventData.name, 'Event') },
          { label: 'DATE', value: safeVal(eventData.date, 'See page') },
          { label: 'TIME', value: safeVal(eventData.time, 'See page') },
          { label: 'LOCATION', value: safeVal(eventData.location, 'See page') },
          { label: 'SECTION', value: safeVal(eventSeat.section) },
          { label: 'ROW', value: safeVal(eventSeat.row) },
          { label: 'SEAT', value: safeVal(eventSeat.seat) },
          { label: 'GATE', value: safeVal(eventSeat.gate) }
        ]
  };

  // Only add expirationDate if we actually have a valid one
  if (expirationDate) {
    passPayload.expirationDate = expirationDate;
  }

  // Validate payload before sending — catch issues before they hit the API
  validatePayload(passPayload);

  let response;
  try {
    response = await axios.post(
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
  } catch (err) {
    if (err.response) {
      const errorBody = Buffer.from(err.response.data).toString('utf8');
      console.error('WalletWallet error body:', errorBody);
      console.error('Payload sent:', JSON.stringify(passPayload, null, 2));
      throw new Error(`Pass generation failed: ${errorBody}`);
    }
    throw err;
  }

  const fileName = `pass_${Date.now()}.pkpass`;
  const filePath = path.join('/tmp', fileName);
  fs.writeFileSync(filePath, response.data);

  const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`;

  return {
    passUrl: `${baseUrl}/passes/${fileName}`,
    ticketNumber,
    movieSeat,
    eventSeat,
    isMovie
  };
}

// Pre-flight payload validator — catches empty values before they reach WalletWallet
function validatePayload(payload) {
  const fieldGroups = ['headerFields', 'primaryFields', 'secondaryFields', 'auxiliaryFields', 'backFields'];
  for (const group of fieldGroups) {
    if (!payload[group]) continue;
    if (payload[group].length > 10) {
      throw new Error(`${group} has ${payload[group].length} items — max is 10`);
    }
    for (const field of payload[group]) {
      if (!field.label || !field.label.trim()) throw new Error(`Empty label in ${group}`);
      if (!field.value || !field.value.trim()) throw new Error(`Empty value for label "${field.label}" in ${group}`);
    }
  }
  const topLevel = ['barcodeValue', 'logoText', 'description', 'organizationName', 'colorPreset'];
  for (const key of topLevel) {
    if (!payload[key] || !String(payload[key]).trim()) throw new Error(`Empty top-level field: ${key}`);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/passes/:filename', (req, res) => {
  const filePath = path.join('/tmp', req.params.filename);
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'application/vnd.apple.pkpass');
    res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
    res.sendFile(filePath);
  } else {
    res.status(404).send('Pass not found');
  }
});

// ─── Webhook ──────────────────────────────────────────────────────────────────

app.post('/webhook/inbound', async (req, res) => {
  res.sendStatus(200);

  // Handle inline keyboard button presses
  if (req.body.callback_query) {
    const cb = req.body.callback_query;
    const chatId = cb.message.chat.id;
    const data = cb.data;
    await answerCallbackQuery(cb.id);

    if (data === 'type_movie' || data === 'type_concert') {
      const type = data === 'type_movie' ? 'movie' : 'concert';
      userState[chatId] = { ...userState[chatId], selectedType: type, waitingForUrl: true };
      const msg = type === 'movie'
        ? `🎬 Movie pass selected!\n\nSupported sites:\n• AMC Theatres\n• Cinemark\n\nSend me the link!`
        : `🎤 Concert / Event pass selected!\n\nSupported sites:\n• Fever Up\n• lu.ma\n• Eventbrite\n• Dice\n\nSend me the link!`;
      await sendMessage(chatId, msg);
    }
    return;
  }

  const message = req.body.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const incomingMsg = message.text.trim();

  console.log(`[${chatId}] ${incomingMsg}`);

  // ── Commands ──
  if (incomingMsg === '/start' || incomingMsg === '/new') {
    userState[chatId] = {};
    await sendInlineKeyboard(
      chatId,
      `🎟️ Welcome to Keypass!\n\nWhat kind of pass do you need?\n\n🎬 MOVIES\nAMC · Cinemark\n\n🎤 CONCERTS & EVENTS\nFever Up · lu.ma · Eventbrite · Dice`,
      [
        [
          { text: '🎬 Movie', callback_data: 'type_movie' },
          { text: '🎤 Concert / Event', callback_data: 'type_concert' }
        ]
      ]
    );
    return;
  }

  if (incomingMsg === '/last') {
    const last = userState[chatId]?.lastPassUrl;
    if (last) {
      await sendMessage(chatId, `🎟️ Your last pass:\n${last}`);
    } else {
      await sendMessage(chatId, `No pass generated yet. Send /start to begin.`);
    }
    return;
  }

  if (incomingMsg === '/help') {
    await sendMessage(chatId,
      `🎟️ Keypass Bot\n\n` +
      `🎬 Movie sites:\n• amctheatres.com\n• cinemark.com\n\n` +
      `🎤 Concert / Event sites:\n• lu.ma\n• eventbrite.com\n• dice.fm\n• feverup.com\n\n` +
      `Commands:\n/start — new pass\n/last — resend last pass\n/help — this message`
    );
    return;
  }

  // ── If no type selected yet, show the menu ──
  if (!userState[chatId]?.selectedType) {
    userState[chatId] = {};
    await sendInlineKeyboard(
      chatId,
      `What kind of pass do you need?\n\n🎬 MOVIES\nAMC · Cinemark\n\n🎤 CONCERTS & EVENTS\nFever Up · lu.ma · Eventbrite · Dice`,
      [
        [
          { text: '🎬 Movie', callback_data: 'type_movie' },
          { text: '🎤 Concert / Event', callback_data: 'type_concert' }
        ]
      ]
    );
    return;
  }

  // ── Waiting for name ──
  if (userState[chatId]?.waitingForName) {
    const name = incomingMsg.toLowerCase() === 'skip' ? null : incomingMsg;
    const pending = userState[chatId].pendingPasses;
    userState[chatId].waitingForName = false;
    userState[chatId].pendingPasses = null;

    await sendMessage(chatId, `Generating ${pending.length} pass${pending.length > 1 ? 'es' : ''}... 🎟️`);

    for (const { eventData, url, site } of pending) {
      try {
        const { passUrl, ticketNumber, movieSeat, eventSeat, isMovie } = await generatePass(eventData, url, site, name);
        userState[chatId].lastPassUrl = passUrl;

        const details = isMovie
          ? `${movieSeat.auditorium} · ROW ${movieSeat.row} · SEAT ${movieSeat.seat} · ${ticketNumber}`
          : `${eventSeat.section} · ROW ${eventSeat.row} · SEAT ${eventSeat.seat} · ${eventSeat.gate} · ${ticketNumber}`;

        await sendMessage(chatId, `✅ ${eventData.name}\n${details}\n\nTap to add to Apple Wallet:\n${passUrl}`);
      } catch (err) {
        console.error(err);
        await sendMessage(chatId, `❌ Failed for ${url}:\n${err.message}`);
      }
    }

    // Reset type so next /start or message shows the menu again
    userState[chatId].selectedType = null;
    userState[chatId].waitingForUrl = false;
    return;
  }

  // ── Waiting for URL ──
  if (userState[chatId]?.waitingForUrl) {
    const urls = extractURLs(incomingMsg);
    const validUrls = urls.filter(u => detectSite(u));

    if (validUrls.length === 0) {
      await sendMessage(chatId, `⚠️ I didn't find a supported URL in that message. Please send a link from a supported site.`);
      return;
    }

    // Validate URL matches the selected type
    const selectedType = userState[chatId].selectedType;
    const wrongType = validUrls.filter(u => {
      const site = detectSite(u);
      const urlIsMovie = isMovieSite(site);
      return selectedType === 'movie' ? !urlIsMovie : urlIsMovie;
    });

    if (wrongType.length > 0 && wrongType.length === validUrls.length) {
      const expected = selectedType === 'movie' ? '🎬 movie' : '🎤 concert/event';
      await sendMessage(chatId, `⚠️ That link doesn't look like a ${expected} site. Please send the right kind of link, or send /start to pick again.`);
      return;
    }

    await sendMessage(chatId, `Fetching details for ${validUrls.length} link${validUrls.length > 1 ? 's' : ''}...`);

    const results = [];
    for (const url of validUrls) {
      try {
        const result = await scrapeByUrl(url);
        if (result) results.push({ ...result, url });
      } catch (err) {
        await sendMessage(chatId, `⚠️ Couldn't scrape ${url}: ${err.message}`);
      }
    }

    if (results.length === 0) return;

    let preview = `Here's what I found:\n\n`;
    for (const { eventData, site } of results) {
      const isMovie = isMovieSite(site);
      preview += `🎟️ ${eventData.name}\n`;
      preview += `📅 ${eventData.date}`;
      if (eventData.time && eventData.time !== 'See event page' && eventData.time !== 'See movie page') {
        preview += ` @ ${eventData.time}`;
      }
      preview += `\n📍 ${eventData.location}\n`;
      if (isMovie && eventData.ratingRuntime && eventData.ratingRuntime !== 'N/A') {
        preview += `🎬 ${eventData.ratingRuntime}\n`;
      }
      preview += `\n`;
    }

    preview += `What name should go on the pass?\nReply with a name or type "skip"`;
    await sendMessage(chatId, preview);

    userState[chatId].waitingForName = true;
    userState[chatId].waitingForUrl = false;
    userState[chatId].pendingPasses = results;
    return;
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Keypass bot running on port ${PORT}`);
  const webhookUrl = `${process.env.RENDER_EXTERNAL_URL}/webhook/inbound`;
  try {
    await axios.post(`${TELEGRAM_API}/setWebhook`, { url: webhookUrl });
    console.log(`Telegram webhook set to ${webhookUrl}`);
  } catch (e) {
    console.error('Failed to set Telegram webhook:', e.message);
  }
});
